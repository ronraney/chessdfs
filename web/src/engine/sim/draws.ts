// Outcome draws + per-game Gaussian-copula correlation engine. Replaces
// the old latent-factor model (zGame/zTeam shared factors + shootout/
// script regime shocks + a DST-splash side channel) with a measured
// role x role correlation matrix (config/real_correlation_targets.json,
// 2021-2025 nflverse season-to-date role ranking) and a per-game Cholesky
// draw. This INTENTIONALLY DIVERGES from nfl-dfs's own sim_draws.js --
// not a port of this part any more (drawOutcome itself still is, see its
// own doc comment).
//
// Roles: each player is ranked by DK PROJECTION (not real-world season-to-
// date volume -- that ranking lives only in the measurement script that
// built the targets file) within their own team+position: QB1, RB1/RB2,
// WR1/WR2/WR3, TE1/TE2, DST. Anyone else (a punt-value FLEX-only
// WR4/RB3/etc, or a position the targets file doesn't model) is "other"
// -- correlation 0 with every other player, including other "other"
// players on the same team.
//
// Per game: the two teams' own filled roles (whichever of the 9 a team
// actually has a player at -- a team with only 2 real WRs simply has no
// WR3 slot that game) are assembled into one joint correlation matrix:
// same-team pairs from `same_team_matrix`, cross-team pairs from
// `opponent_matrix`. This is always a PRINCIPAL SUBMATRIX of the full
// 18x18 (9 roles x 2 teams) template -- and a principal submatrix of a
// positive-semidefinite matrix is itself always PSD -- so correcting the
// FULL template once (see TEMPLATE_PSD_REPORT below) is sufficient; no
// per-game correction is mathematically possible to need, and
// gameCholesky() throws (rather than silently mis-drawing) if that
// invariant is ever somehow violated.
//
// Vegas/dome/spread: all three now shift a player's Z-MEAN directly
// (additive, pre-correlation) rather than feeding a shared latent
// factor's own mean the way zGame/zTeam used to -- there is no more
// per-position loading (wg/wt) to dilute them through, so the same
// constants (VEGAS_WEIGHT, SPREAD_WEIGHT, the dome bump) now apply
// UNDILUTED to every player in the affected game/team, "other" players
// included. That is a real, reported behavior change (a stronger
// per-player effect at the same constant value), not a silent one -- see
// this task's own session log for the measured sizes.
//
// Removed entirely (this task's own "remove the latent game/team/regime
// shocks"): zGame, zTeam, the per-position g/t loadings, the shootout/
// script regime draws, and the DST-splash side channel (a rare stochastic
// override bypassing the percentile draw outright) -- the last of these
// isn't named explicitly in the task, but it is exactly the kind of ad
// hoc "regime shock" the new architecture replaces, and has no principled
// place in a measured-correlation copula; flagged here as a judgment
// call, not a silent drop.
import correlationTargets from "../../data/config/real_correlation_targets.json";
import type { SeededRandom } from "../rng";
import type { Player } from "../models";

// Right-tail extension multiplier. nfl-dfs's SIM_TAIL_K_DEFAULT_ -- lowered
// from an original, never-calibrated 1.5 to 1.0 per that project's own
// session history. Reproduced as-is; not re-tuned here.
const TAIL_K = 1.0;
const DST_POS_MIN = -5;

const FLOOR_PCT = 0.15;
const CEILING_PCT = 0.85;

/**
 * Converts a percentile u in [0, 1) to fantasy points via piecewise-linear
 * interpolation through the three ETR anchor points (DK Floor = P15, DK
 * Proj = P50, DK Ceiling = P85), plus a right-tail extension beyond P85.
 * Ported one-for-one from nfl-dfs's drawOutcome_ -- unchanged by this
 * task (only the z/percentile that feeds it changed).
 */
export function drawOutcome(
  floor: number,
  median: number,
  ceiling: number,
  posMin: number,
  u: number,
  k: number = TAIL_K,
): number {
  if (u >= CEILING_PCT) {
    const t = (u - CEILING_PCT) / (1 - CEILING_PCT);
    return ceiling + (ceiling - median) * k * t;
  }
  if (u >= 0.5) {
    const t = (u - 0.5) / (CEILING_PCT - 0.5);
    return median + (ceiling - median) * t;
  }
  if (u >= FLOOR_PCT) {
    const t = (u - FLOOR_PCT) / (0.5 - FLOOR_PCT);
    return floor + (median - floor) * t;
  }
  const t = u / FLOOR_PCT;
  return posMin + (floor - posMin) * t;
}

// Box-Muller transform: one standard-normal sample. Ported from
// sim_foundations.js's randNormal_(), with the injected rng in place of
// Math.random().
function randNormal(rng: SeededRandom): number {
  let u1: number;
  do {
    u1 = rng.next();
  } while (u1 === 0); // guard: log(0) = -Infinity
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Standard normal CDF: Abramowitz-Stegun approximation. Ported from
// sim_correlation.js's normCDF_() -- pure math, no randomness, reproduced
// verbatim.
function normCDF(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t *
    (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

function isFiniteNum(v: number | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function popStdDev(values: readonly number[], avg: number): number {
  return Math.sqrt(values.reduce((a, v) => a + (v - avg) ** 2, 0) / values.length);
}

function canonicalGameKey(teamA: string, teamB: string): string {
  return teamA <= teamB ? `${teamA}@${teamB}` : `${teamB}@${teamA}`;
}

/** Optional Vegas input for one team: this team's own signed spread (see
 * module header for sign convention) and the game's over/under total. */
export interface GameVegas {
  total?: number;
  spread?: number;
}

/** Per-slate Vegas input, keyed by team abbreviation (one entry per team,
 * mirroring nfl-dfs's own per-team Vegas sheet). Any team, or the whole
 * map, may be omitted -- missing total/spread falls back to a neutral
 * default on a per-game basis. */
export type SlateVegas = ReadonlyMap<string, GameVegas>;

const EMPTY_DOME_TEAMS: ReadonlySet<string> = new Set();

interface GameGroup {
  key: string;
  teamX: string;
  teamY: string;
  // Whichever team's players report isHome -- undefined if no player in
  // this game does (e.g. a synthetic test pool that never set it), in
  // which case dome status can't be determined and defaults to false.
  homeTeam?: string;
}

interface ResolvedGameVegas {
  total?: number;
  spreadX?: number; // teamX's own signed spread; teamY's is its negation
}

function buildGameGroups(players: readonly Player[]): GameGroup[] {
  const groups = new Map<string, GameGroup>();
  for (const p of players) {
    const [teamX, teamY] = p.team <= p.opp ? [p.team, p.opp] : [p.opp, p.team];
    const key = canonicalGameKey(teamX, teamY);
    let g = groups.get(key);
    if (!g) {
      g = { key, teamX, teamY };
      groups.set(key, g);
    }
    if (p.isHome) g.homeTeam = p.team;
  }
  return [...groups.values()];
}

function resolveGameVegas(teamX: string, teamY: string, games: SlateVegas): ResolvedGameVegas {
  const vx = games.get(teamX);
  const vy = games.get(teamY);
  const total = isFiniteNum(vx?.total) ? vx.total : isFiniteNum(vy?.total) ? vy.total : undefined;
  const spreadX = isFiniteNum(vx?.spread)
    ? vx.spread
    : isFiniteNum(vy?.spread)
      ? -vy.spread
      : undefined;
  return { total, spreadX };
}

// ---------------------------------------------------------------------
// Role assignment: DK-projection rank within team+position.
// ---------------------------------------------------------------------

// How many ranked roles each position carries -- QB1 only, RB1/RB2,
// WR1/WR2/WR3, TE1/TE2, and DST (unranked -- a roster only ever has one,
// but ranked defensively by proj in case a pool somehow has >1).
const ROLE_RANK_COUNT: Readonly<Record<string, number>> = { QB: 1, RB: 2, WR: 3, TE: 2, DST: 1 };

function roleNameFor(position: string, rank: number): string {
  return position === "DST" ? "DST" : `${position}${rank}`;
}

/** Maps player id -> role name ("QB1", "RB2", ..., "DST") for every
 * player who qualifies for one of the 9 measured roles; a player with no
 * entry is "other" (zero correlation with everyone, including other
 * "other" players). Ties (equal proj) keep the pool's own original
 * order -- Array.prototype.sort is a stable sort (guaranteed since
 * ES2019), same tie-break convention the real-correlation-targets
 * measurement script used (pandas' rank(method="first")). */
export function assignRoles(players: readonly Player[]): ReadonlyMap<string, string> {
  const byTeamPos = new Map<string, Player[]>();
  for (const p of players) {
    const pos = p.positions[0] ?? "WR";
    const key = `${p.team}|${pos}`;
    const list = byTeamPos.get(key) ?? [];
    list.push(p);
    byTeamPos.set(key, list);
  }
  const roleOf = new Map<string, string>();
  for (const [key, list] of byTeamPos) {
    const pos = key.split("|")[1];
    const rankCount = ROLE_RANK_COUNT[pos];
    if (!rankCount) continue; // unmodeled position (e.g. K) -- stays "other"
    const sorted = [...list].sort((a, b) => b.proj - a.proj);
    for (let i = 0; i < Math.min(rankCount, sorted.length); i++) {
      roleOf.set(sorted[i].id, roleNameFor(pos, i + 1));
    }
  }
  return roleOf;
}

// ---------------------------------------------------------------------
// Measured role x role correlation matrices (config/real_correlation_
// targets.json) + the small linear-algebra kit (Cholesky, and a Jacobi-
// eigendecomposition-based nearest-PSD fallback) needed to turn them into
// a per-game draw. No new dependency: hand-rolled, same spirit as
// randNormal/normCDF above.
// ---------------------------------------------------------------------

const ROLES: readonly string[] = correlationTargets.roles;
const ROLE_INDEX = new Map(ROLES.map((r, i) => [r, i]));
const SAME_TEAM_MATRIX: readonly (readonly number[])[] = correlationTargets.same_team_matrix;
const OPPONENT_MATRIX: readonly (readonly number[])[] = correlationTargets.opponent_matrix;

function sameTeamCorr(roleA: string, roleB: string): number {
  return SAME_TEAM_MATRIX[ROLE_INDEX.get(roleA)!][ROLE_INDEX.get(roleB)!];
}

function opponentCorr(roleA: string, roleB: string): number {
  return OPPONENT_MATRIX[ROLE_INDEX.get(roleA)!][ROLE_INDEX.get(roleB)!];
}

// Cholesky-Banachiewicz. Returns null (not PSD/positive-definite, within
// `epsilon`) instead of throwing -- the caller decides whether to attempt
// a nearest-PSD correction or treat null as a hard error. Exported (along
// with nearestPSD below) so both can be unit-tested directly against
// hand-built matrices, not just indirectly through drawSlateOutcomes's
// own statistical checks -- same "export it so correctness can be tested
// against fixtures" precedent as drawOutcome above.
export function tryCholesky(a: readonly (readonly number[])[], epsilon = 1e-9): number[][] | null {
  const n = a.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum <= epsilon) return null;
        L[i][j] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}

// Classical cyclic Jacobi eigenvalue algorithm for a real symmetric
// matrix -- only ever invoked (see TEMPLATE_PSD_REPORT below) if the raw
// measured template itself isn't PSD, which it currently isn't expected
// to need (see that constant's own report). Small matrices only (this
// module never feeds it anything bigger than 18x18), so plain cyclic
// sweeps (no off-diagonal-magnitude threshold scheme) converge plenty
// fast without added complexity.
function jacobiEigen(a: readonly (readonly number[])[]): { values: number[]; vectors: number[][] } {
  const n = a.length;
  const A = a.map((row) => [...row]);
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  const MAX_SWEEPS = 100;
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let offDiagSumSq = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) offDiagSumSq += A[i][j] * A[i][j];
    if (offDiagSumSq < 1e-20) break;

    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-15) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        const app = A[p][p];
        const aqq = A[q][q];
        const apq = A[p][q];
        A[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
        A[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
        A[p][q] = 0;
        A[q][p] = 0;
        for (let k = 0; k < n; k++) {
          if (k === p || k === q) continue;
          const akp = A[k][p];
          const akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[p][k] = A[k][p];
          A[k][q] = s * akp + c * akq;
          A[q][k] = A[k][q];
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: Array.from({ length: n }, (_, i) => A[i][i]), vectors: V };
}

/** Eigen-decomposes `a`, floors every eigenvalue to a tiny positive
 * epsilon (so the result is strictly positive-definite, not merely PSD --
 * Cholesky-safe), reconstructs, and rescales to a unit diagonal (the
 * standard single-pass nearest-correlation-matrix approximation).
 * Returns the corrected matrix and the largest entrywise absolute change
 * from `a`, for reporting. */
export function nearestPSD(a: readonly (readonly number[])[]): { matrix: number[][]; largestChange: number } {
  const n = a.length;
  const { values, vectors } = jacobiEigen(a);
  const floored = values.map((v) => Math.max(v, 1e-9));
  const recon: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += vectors[i][k] * floored[k] * vectors[j][k];
      recon[i][j] = sum;
    }
  }
  const d = recon.map((row, i) => Math.sqrt(Math.max(row[i], 1e-12)));
  const corrected: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  let largestChange = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      corrected[i][j] = recon[i][j] / (d[i] * d[j]);
      largestChange = Math.max(largestChange, Math.abs(corrected[i][j] - a[i][j]));
    }
  }
  return { matrix: corrected, largestChange };
}

// Builds the full 18x18 (9 roles x 2 teams: [[same, opp],[opp^T, same]])
// template once and PSD-corrects it if needed -- exported so a caller
// (this task's own validation report, and a dedicated unit test) can
// confirm whether real_correlation_targets.json's measured matrices
// needed correction, and by how much.
function buildFullTemplate(): number[][] {
  const n = ROLES.length;
  const full: number[][] = Array.from({ length: 2 * n }, () => new Array(2 * n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      full[i][j] = SAME_TEAM_MATRIX[i][j];
      full[n + i][n + j] = SAME_TEAM_MATRIX[i][j];
      full[i][n + j] = OPPONENT_MATRIX[i][j];
      full[n + i][j] = OPPONENT_MATRIX[j][i];
    }
  }
  return full;
}

export interface PsdReport {
  readonly wasAlreadyPsd: boolean;
  readonly largestChange: number;
}

const RAW_FULL_TEMPLATE = buildFullTemplate();
const RAW_TEMPLATE_IS_PSD = tryCholesky(RAW_FULL_TEMPLATE) !== null;
const TEMPLATE_CORRECTION = RAW_TEMPLATE_IS_PSD ? null : nearestPSD(RAW_FULL_TEMPLATE);

/** Whichever of the raw or PSD-corrected 18x18 template is actually safe
 * to slice per game. */
const FULL_TEMPLATE: readonly (readonly number[])[] = TEMPLATE_CORRECTION?.matrix ?? RAW_FULL_TEMPLATE;

/** Whether real_correlation_targets.json's measured matrices needed a
 * nearest-PSD correction, and the largest single entry the correction
 * changed (0 if none was needed) -- this task's own "report the largest
 * change." Computed once at module load, not per game/trial: a principal
 * submatrix of a PSD matrix is itself always PSD, so correcting the full
 * template once is sufficient for every game this module will ever slice
 * from it. */
export const TEMPLATE_PSD_REPORT: PsdReport = {
  wasAlreadyPsd: RAW_TEMPLATE_IS_PSD,
  largestChange: TEMPLATE_CORRECTION?.largestChange ?? 0,
};

function templateCorr(teamIndexA: 0 | 1, roleA: string, teamIndexB: 0 | 1, roleB: string): number {
  const n = ROLES.length;
  const i = teamIndexA * n + ROLE_INDEX.get(roleA)!;
  const j = teamIndexB * n + ROLE_INDEX.get(roleB)!;
  return FULL_TEMPLATE[i][j];
}

interface RoleSlot {
  playerId: string;
  teamIndex: 0 | 1;
  role: string;
}

/** Cholesky factor of one game's own role x role matrix -- always a
 * principal submatrix of the (already PSD) FULL_TEMPLATE, so this can
 * never legitimately fail; a null result means real_correlation_targets.
 * json or this module's own slicing logic is broken, not a recoverable
 * per-game data problem, so it throws rather than silently drawing
 * uncorrelated noise. */
function gameCholesky(slots: readonly RoleSlot[]): number[][] {
  const n = slots.length;
  const m: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      m[i][j] = i === j ? 1 : templateCorr(slots[i].teamIndex, slots[i].role, slots[j].teamIndex, slots[j].role);
    }
  }
  const L = tryCholesky(m);
  if (L === null) {
    throw new Error(
      "drawSlateOutcomes: a per-game role correlation matrix was not positive-definite -- " +
        "this should be impossible given an already-PSD template (a principal submatrix of a " +
        "PSD matrix is always PSD); check real_correlation_targets.json for a malformed matrix.",
    );
  }
  return L;
}

// Vegas total deviation weight, and spread weight -- SAME constants/
// formulas as the old latent-factor model's totalShift/spreadShift, now
// applied directly as a player's own z-MEAN (additive, pre-correlation)
// instead of a shared zGame/zTeam factor's mean. Undiluted by any
// per-position loading (there is none left) -- a real, stronger-at-the-
// same-constant-value effect than before; see this module's own header.
const VEGAS_WEIGHT = 0.5;
const SPREAD_WEIGHT = 0.3;
// Dome bump: the old model's DOME_WGAME_SCALE (1.15x) multiplied the
// shared-game loading; reused here at the same size (1.15 - 1 = 0.15) as
// a flat z-mean bump for every player in a dome game instead.
const DOME_MEAN_SHIFT = 0.15;
// Composite Z clip -- purely a numerical safety bound on the normCDF
// approximation (two very different z values both saturating to ~0/1
// would otherwise quietly lose their relative correlation in the tail),
// not a regime mechanic; same value/reasoning as before, just no longer
// needed to counteract regime boosts specifically since those are gone.
const Z_CLIP = 3.9;

/**
 * Draws one full-slate set of correlated fantasy-point outcomes for one
 * trial via a per-game Gaussian copula (see module header): role
 * assignment by DK-projection rank, a measured role x role correlation
 * matrix per game (config/real_correlation_targets.json), Cholesky-drawn
 * correlated normals, Vegas/dome/spread as direct mean shifts, mapped
 * onto each player's own floor/proj/ceiling curve via drawOutcome.
 * `domeTeams` defaults to empty (every game non-dome).
 */
export function drawSlateOutcomes(
  players: readonly Player[],
  games: SlateVegas,
  rng: SeededRandom,
  domeTeams: ReadonlySet<string> = EMPTY_DOME_TEAMS,
): Map<string, number> {
  const groups = buildGameGroups(players);
  const roleOf = assignRoles(players);

  const gameVegas = new Map<string, ResolvedGameVegas>();
  const resolvedTotals: number[] = [];
  const domeByGame = new Map<string, boolean>();
  const teamIndexInGame = new Map<string, 0 | 1>(); // team -> 0 (teamX) or 1 (teamY), per its own game
  for (const g of groups) {
    const v = resolveGameVegas(g.teamX, g.teamY, games);
    gameVegas.set(g.key, v);
    if (isFiniteNum(v.total) && v.total > 0) resolvedTotals.push(v.total);
    domeByGame.set(g.key, g.homeTeam !== undefined && domeTeams.has(g.homeTeam));
    teamIndexInGame.set(g.teamX, 0);
    teamIndexInGame.set(g.teamY, 1);
  }
  const avgTotal = resolvedTotals.length > 0 ? mean(resolvedTotals) : 45;
  const totalStd = resolvedTotals.length > 1 ? popStdDev(resolvedTotals, avgTotal) : 5;

  // Per-player mean shift (Vegas total + dome + spread), all additive,
  // all applied to every player in the affected game/team regardless of
  // role.
  const meanShiftByTeam = new Map<string, number>();
  for (const g of groups) {
    const v = gameVegas.get(g.key)!;
    const totalShift = isFiniteNum(v.total) && totalStd > 0 ? (VEGAS_WEIGHT * (v.total - avgTotal)) / totalStd : 0;
    const domeShift = domeByGame.get(g.key) ? DOME_MEAN_SHIFT : 0;
    const gameShift = totalShift + domeShift;

    const spreadX = isFiniteNum(v.spreadX) ? v.spreadX : 0;
    const spreadMag = Math.min(Math.abs(spreadX) / 14, 1.0) * SPREAD_WEIGHT;
    const spreadShiftX = spreadX < 0 ? spreadMag : -spreadMag; // favorite (negative spread) shifts up
    const spreadShiftY = -spreadShiftX;

    meanShiftByTeam.set(g.teamX, gameShift + spreadShiftX);
    meanShiftByTeam.set(g.teamY, gameShift + spreadShiftY);
  }

  // Group role-players by game, preserving ROLES order within each team
  // (gameCholesky's own slot order only needs to be consistent with how
  // the resulting z-vector is read back below, which it is).
  const roleSlotsByGame = new Map<string, RoleSlot[]>();
  for (const g of groups) roleSlotsByGame.set(g.key, []);
  for (const p of players) {
    const role = roleOf.get(p.id);
    if (role === undefined) continue;
    const gameKey = canonicalGameKey(p.team, p.opp);
    const slots = roleSlotsByGame.get(gameKey);
    if (!slots) continue; // defensive -- every player's game is in `groups` by construction
    const teamIndex = teamIndexInGame.get(p.team) ?? 0;
    slots.push({ playerId: p.id, teamIndex, role });
  }

  const correlatedZByPlayer = new Map<string, number>();
  for (const slots of roleSlotsByGame.values()) {
    if (slots.length === 0) continue;
    // Stable order (ROLES order, teamX then teamY) so a given slate's own
    // draw sequence is deterministic given the seed -- not load-bearing
    // for correctness, just reproducibility.
    slots.sort((a, b) => (a.teamIndex !== b.teamIndex ? a.teamIndex - b.teamIndex : ROLE_INDEX.get(a.role)! - ROLE_INDEX.get(b.role)!));
    const L = gameCholesky(slots);
    const noise = slots.map(() => randNormal(rng));
    for (let i = 0; i < slots.length; i++) {
      let z = 0;
      for (let k = 0; k <= i; k++) z += L[i][k] * noise[k];
      correlatedZByPlayer.set(slots[i].playerId, z);
    }
  }

  const outcomes = new Map<string, number>();
  for (const p of players) {
    const position = p.positions[0] ?? "WR";
    const meanShift = meanShiftByTeam.get(p.team) ?? 0;
    const correlatedZ = correlatedZByPlayer.get(p.id) ?? randNormal(rng); // "other": independent draw
    const z = Math.max(-Z_CLIP, Math.min(Z_CLIP, meanShift + correlatedZ));
    const u = normCDF(z);
    const posMin = position === "DST" ? DST_POS_MIN : 0;
    outcomes.set(p.id, drawOutcome(p.floor, p.proj, p.ceiling, posMin, u, TAIL_K));
  }

  return outcomes;
}
