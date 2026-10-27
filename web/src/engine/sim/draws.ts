// Outcome draws + per-game Gaussian-copula correlation engine.
//
// Mean shifts REMOVED (this task): Vegas total/spread and dome used to
// shift a player's z-mean before the percentile draw. That double-
// counted real-world game-environment information the ETR projections
// (floor/proj/ceiling) already bake in -- Vegas/dome aren't separate
// unknowns on top of proj, they're part of what produced it. `games:
// SlateVegas` stays in this function's own signature (Admin's Vegas
// upload -- vegasCsv.ts/vegasStore.ts -- stays wired end to end) but is
// now genuinely unused by the draw itself; see sessions/HANDOFF.md for
// the note. `domeTeams` is gone from the signature entirely (it was the
// trailing parameter and had no other use once its one consumer -- the
// dome mean shift -- was removed; run.ts's own call site updated to
// match).
//
// drawOutcome FIXED (this task): previously, the piecewise floor/proj/
// ceiling curve's median (u=0.5) was pinned to proj, which left its
// MEAN biased above proj whenever the curve isn't symmetric around its
// own median -- the normal case, since real ceiling-proj gaps usually
// run wider than proj-floor gaps, and the right-tail extension (k) adds
// expected value on the upper side with no left-side counterpart.
// Confirmed empirically in the prior diagnosis task (a non-dome control
// player's simulated mean ran +1.3 over proj even with every other
// distortion removed). Fixed by solving, per player, for the INTERNAL
// anchor value that makes the curve's own expected value (not its
// median) equal the target mean (DK Proj) -- see
// `internalAnchorForTargetMean`'s own doc comment for the closed form.
// P15=floor and P85=ceiling are untouched (those percentile cut points
// don't depend on the anchor at all), so "~15% below floor, ~15% above
// ceiling" holds automatically once there's no mean shift upstream to
// skew it (u is then exactly Uniform(0,1) for every player, role or
// "other" -- a Cholesky row's own self-correlation is 1 by construction,
// so a role player's pre-draw z is itself exactly N(0,1), same as an
// "other" player's plain randNormal draw).
//
// Right tail reshaped (this task): TAIL_K lowered 1.0 -> 0.5 -- the old
// value put P95/P99 25-45% above a player's own stated ceiling (reported
// in the prior diagnosis), which read as unrealistically fat for a
// "ceiling" meant to anchor P85. Still a genuine, deliberately open-
// ended tail (real boom weeks do exceed a modest ceiling estimate), just
// a more modest one -- see this task's own session log for the resulting
// P95/P99 figures against the same 5 sample players as before.
import correlationTargets from "../../data/config/real_correlation_targets.json";
import type { SeededRandom } from "../rng";
import type { Player } from "../models";

// Right-tail extension multiplier. Was nfl-dfs's SIM_TAIL_K_DEFAULT_
// (1.0, itself already lowered from an original, never-calibrated 1.5);
// lowered again this task to 0.5 -- see module header.
const TAIL_K = 0.5;
const DST_POS_MIN = -5;

const FLOOR_PCT = 0.15;
const CEILING_PCT = 0.85;

/**
 * Solves for the internal curve anchor `m` (the value drawOutcome treats
 * as its own u=0.5 point) such that E[drawOutcome(Z)] for a standard
 * normal Z equals `targetMean`, given fixed floor/ceiling/posMin/k.
 *
 * drawOutcome is piecewise-linear in its anchor argument at every fixed
 * u (each of the 4 segments is an affine function of the anchor, with a
 * SLOPE that doesn't depend on floor/ceiling/posMin/anchor itself -- only
 * on which segment u falls in), and u = Phi(Z) is exactly Uniform(0,1)
 * for a standard normal Z. That makes E[drawOutcome(Z); anchor] an EXACT
 * affine function of `anchor` -- closed-form solvable, no iteration:
 *
 *   E[outcome] = 0.075*posMin + 0.25*floor + (0.325 + 0.075k)*ceiling
 *                + (0.35 - 0.075k) * anchor
 *
 * (each coefficient is the plain integral of that segment's own
 * anchor-coefficient over its own u-range, since u is uniform -- derived
 * once by hand, not approximated). Solving for anchor given a target
 * mean:
 *
 *   anchor = [targetMean - 0.075*posMin - 0.25*floor
 *             - (0.325 + 0.075k)*ceiling] / (0.35 - 0.075k)
 *
 * P15 (floor) and P85 (ceiling) never depend on `anchor` at all -- only
 * where the curve's OWN u=0.5 point lands shifts, trading "median exactly
 * at the anchor" for "mean exactly at targetMean" (the task's own
 * "average draw = DK Proj, not median"). Exported for direct unit
 * testing of the closed form itself, same "export pure math for fixture
 * testing" precedent as drawOutcome/tryCholesky/nearestPSD.
 */
export function internalAnchorForTargetMean(
  floor: number,
  targetMean: number,
  ceiling: number,
  posMin: number,
  k: number = TAIL_K,
): number {
  const denom = 0.35 - 0.075 * k;
  return (targetMean - 0.075 * posMin - 0.25 * floor - (0.325 + 0.075 * k) * ceiling) / denom;
}

/**
 * Converts a percentile u in [0, 1) to fantasy points via piecewise-linear
 * interpolation through floor (P15) and ceiling (P85), plus a right-tail
 * extension beyond P85, anchored so that its EXPECTED value over a
 * standard-normal-driven u equals `targetMean` (DK Proj) -- not its
 * median, per this task's own fix (see internalAnchorForTargetMean's own
 * doc comment for the derivation). The piecewise shape itself is
 * otherwise unchanged from nfl-dfs's own drawOutcome_.
 */
export function drawOutcome(
  floor: number,
  targetMean: number,
  ceiling: number,
  posMin: number,
  u: number,
  k: number = TAIL_K,
): number {
  const m = internalAnchorForTargetMean(floor, targetMean, ceiling, posMin, k);
  if (u >= CEILING_PCT) {
    const t = (u - CEILING_PCT) / (1 - CEILING_PCT);
    return ceiling + (ceiling - m) * k * t;
  }
  if (u >= 0.5) {
    const t = (u - 0.5) / (CEILING_PCT - 0.5);
    return m + (ceiling - m) * t;
  }
  if (u >= FLOOR_PCT) {
    const t = (u - FLOOR_PCT) / (0.5 - FLOOR_PCT);
    return floor + (m - floor) * t;
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

function canonicalGameKey(teamA: string, teamB: string): string {
  return teamA <= teamB ? `${teamA}@${teamB}` : `${teamB}@${teamA}`;
}

/** Optional Vegas input for one team: this team's own signed spread and
 * the game's over/under total. No longer consumed by drawSlateOutcomes
 * (see module header) -- kept so Admin's Vegas upload still has a type
 * to produce. */
export interface GameVegas {
  total?: number;
  spread?: number;
}

/** Per-slate Vegas input, keyed by team abbreviation. Still accepted by
 * drawSlateOutcomes for API stability (Admin's upload still produces
 * one), but no longer read by it -- see module header. */
export type SlateVegas = ReadonlyMap<string, GameVegas>;

interface GameGroup {
  key: string;
  teamX: string;
  teamY: string;
}

function buildGameGroups(players: readonly Player[]): GameGroup[] {
  const groups = new Map<string, GameGroup>();
  for (const p of players) {
    const [teamX, teamY] = p.team <= p.opp ? [p.team, p.opp] : [p.opp, p.team];
    const key = canonicalGameKey(teamX, teamY);
    if (!groups.has(key)) groups.set(key, { key, teamX, teamY });
  }
  return [...groups.values()];
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
  // Explicit number[][] annotation: without it, TS infers the ternary's
  // own literal-type union (1 | 0) for the inner array, which then
  // rejects every later plain-`number` assignment below (a pre-existing
  // type error this task's own `tsc -b` run surfaced -- `npm run test`
  // alone doesn't type-check, so it had gone uncaught).
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
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
 * changed (0 if none was needed). Computed once at module load, not per
 * game/trial: a principal submatrix of a PSD matrix is itself always
 * PSD, so correcting the full template once is sufficient for every game
 * this module will ever slice from it. */
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

// Composite Z clip -- purely a numerical safety bound on the normCDF
// approximation (two very different z values both saturating to ~0/1
// would otherwise quietly lose their relative correlation in the tail).
const Z_CLIP = 3.9;

/**
 * Draws one full-slate set of correlated fantasy-point outcomes for one
 * trial via a per-game Gaussian copula (see module header): role
 * assignment by DK-projection rank, a measured role x role correlation
 * matrix per game (config/real_correlation_targets.json), Cholesky-drawn
 * correlated normals, mapped onto each player's own floor/proj/ceiling
 * curve via drawOutcome -- no Vegas/dome mean shift (removed; see module
 * header). `_games` is accepted for API stability (Admin's Vegas upload
 * still produces one, and callers still pass it through) but genuinely
 * unused -- underscore-prefixed per this project's own lint rule
 * (`noUnusedParameters`), not silently dropped.
 */
export function drawSlateOutcomes(players: readonly Player[], _games: SlateVegas, rng: SeededRandom): Map<string, number> {
  const groups = buildGameGroups(players);
  const roleOf = assignRoles(players);

  const teamIndexInGame = new Map<string, 0 | 1>(); // team -> 0 (teamX) or 1 (teamY), per its own game
  for (const g of groups) {
    teamIndexInGame.set(g.teamX, 0);
    teamIndexInGame.set(g.teamY, 1);
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
    const z = Math.max(-Z_CLIP, Math.min(Z_CLIP, correlatedZByPlayer.get(p.id) ?? randNormal(rng))); // "other": independent draw
    const u = normCDF(z);
    const posMin = position === "DST" ? DST_POS_MIN : 0;
    outcomes.set(p.id, drawOutcome(p.floor, p.proj, p.ceiling, posMin, u, TAIL_K));
  }

  return outcomes;
}
