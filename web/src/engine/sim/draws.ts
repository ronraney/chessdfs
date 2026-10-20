// Outcome draws + latent-factor correlation engine. Ported from
// rraney/nfl-dfs's sim_draws.js (Part A: drawOutcome_, Part B:
// drawSlateOutcomes_) -- Part C (calibrateCorrelation and its diagnostic
// harness) is explicitly out of scope and not ported, along with
// sim_correlation.js and sim_foundations.js as whole files. The two pure
// math helpers those files hold that Part B actually calls --
// randNormal_()'s Box-Muller transform and normCDF_()'s Abramowitz-Stegun
// approximation -- are reproduced below instead, with Math.random()
// replaced by the injected SeededRandom so the whole module stays pure
// and deterministic (no I/O, no unseeded randomness).
//
// Dome: nfl-dfs's SIM_DOME_TEAMS_ (a static team list, not weekly Vegas
// data) now lives in sport config (config/sports/nfl.json's dome_teams,
// SportConfig.domeTeams) and is passed in as drawSlateOutcomes' own
// `domeTeams` parameter -- defaults to an empty set, so every existing
// caller that predates this parameter still draws every game as non-dome.
// Dome status is exactly nfl-dfs's own check (SIM_DOME_TEAMS_.has(homeTeam)):
// a game is dome iff its HOME team is a dome team. Player.isHome (see
// models.ts) is the real home/away signal, derived in loadEtrCsv from the
// ETR "Opp" column's own "@" convention -- not an approximation.
//
// Scope note: nfl-dfs's grouping of pool entries by real player identity
// (_showdownPlayerKey_) exists to let a Showdown slate's CPT/FLEX pair for
// one real player share a single draw. chess-dfs has no Showdown contest
// type -- one entry per real player always -- so that grouping step is
// skipped; this is a no-op simplification, not a behavior change (nfl-dfs's
// own comment calls the Main Slate case of that grouping a no-op too).
//
// Vegas input shape: keyed by TEAM abbreviation (not by game), one
// optional { total, spread } per team -- mirroring nfl-dfs's own Vegas
// sheet, which is one row per team (Team, Opponent, Rank, Implied Total,
// Spread, O/U; see readVegas(), readers_dkfd_etr.js). `total` is the
// game's Vegas over/under in real NFL points (shared by both teams in a
// game); `spread` is that TEAM's own signed spread in real NFL points --
// negative means that team is favored (giving points), positive means
// that team is the underdog (getting points) -- the standard American
// odds convention, confirmed directly from nfl-dfs's own comment ("
// homeTeamSpread < 0 means home is favored (giving points)").
//
// The Vegas spread/script-regime math below still uses alphabetical team
// order (teamX/teamY) rather than Player.isHome, deliberately -- nfl-dfs's
// own math doesn't actually depend on which side is "home" here: its
// homeShift calculation reduces to "the favored team's own spread sign",
// already what each team's own signed Spread value gives directly
// regardless of label. Swapping in isHome here would relabel teamX/teamY
// as home/away without changing a single computed value -- dome is the
// one place in this file where the actual home team matters.
//
// players is `readonly Player[]` (chess-dfs's existing engine/models.ts
// type) rather than a separate sim-only type: Player already carries the
// id/team/opp/floor/proj/ceiling fields drawSlateOutcomes needs, and the
// task's own wording ("Group players into games from Team/Opp") names
// those fields directly. positions[0] is used as the single DK position
// (QB/RB/WR/TE/DST) a real player's latent weights/posMin/splash
// eligibility key off of -- loadEtrCsv always produces a single-element
// positions array for a real ETR row.

import type { SeededRandom } from "../rng";
import type { Player } from "../models";

// Right-tail extension multiplier. nfl-dfs's SIM_TAIL_K_DEFAULT_ -- lowered
// from an original, never-calibrated 1.5 to 1.0 per that project's own
// session history. Reproduced as-is; not re-tuned here.
const TAIL_K = 1.0;
const VEGAS_WEIGHT = 0.5;
const SPREAD_WEIGHT = 0.3;
const DST_POS_MIN = -5;
// Dome: multiply a player's wGame loading by this before renormalizing.
const DOME_WGAME_SCALE = 1.15;
// Composite Z clip -- regime boosts can push |Z| past ~3, where normCDF
// saturates to exactly 0/1 and the piecewise draw stops carrying shared-
// random-variable correlation. nfl-dfs's frozen sweepRegimeParams() value.
const Z_CLIP = 3.9;

const FLOOR_PCT = 0.15;
const CEILING_PCT = 0.85;

const SHOOTOUT_PROB_BASE = 0.187;
const SHOOTOUT_PROB_CAP = 0.9;
const SHOOTOUT_GAME_BOOST = 3.16;
const SHOOTOUT_TEAM_BOOST = 3.16;
const SHOOTOUT_WG_SCALE = 1.4;
const SCRIPT_PROB_BASE = 0.105;
const SCRIPT_PROB_CAP = 0.9;
const SCRIPT_BOOST = 3.17;
const SCRIPT_SUPP = -1.585;
const SCRIPT_WT_SCALE = 1.4;

const DST_SPLASH_PROB = 0.07;
const DST_SPLASH_BONUS_MIN = 15.0;
const DST_SPLASH_BONUS_MAX = 28.0;

// g = wGame loading (game environment factor, shared by both teams in a
// game); t = wTeam loading (team-specific passing-volume factor); wInd
// (individual noise loading) is sqrt(1 - g^2 - t^2), computed at draw
// time. DST's negative g is the single structural choice nfl-dfs relies on
// to reproduce the validated DST<->RB correlation asymmetry: a high-
// scoring game (zGame drawn high) pulls DST's percentile DOWN.
const LATENT_WEIGHTS: Record<string, { g: number; t: number }> = {
  QB: { g: 0.55, t: 0.6 },
  WR: { g: 0.55, t: 0.6 },
  TE: { g: 0.4, t: 0.6 },
  RB: { g: 0.35, t: 0.5 },
  DST: { g: -0.4, t: 0.5 },
  K: { g: 0.2, t: 0.2 },
};

/**
 * Converts a percentile u in [0, 1) to fantasy points via piecewise-linear
 * interpolation through the three ETR anchor points (DK Floor = P15, DK
 * Proj = P50, DK Ceiling = P85), plus a right-tail extension beyond P85.
 * Ported one-for-one from nfl-dfs's drawOutcome_.
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

// Erlang(shapeK=1) scale draw, i.e. a single Exponential(mean) sample --
// the shapeK=1 special case of nfl-dfs's general drawGammaScale_(mean,
// shapeK), which this port's fixed (non-overridable) regime parameters
// always invoke at shapeK=1.
function drawExpScale(rng: SeededRandom, mean: number): number {
  return -mean * Math.log(rng.next());
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
 * map, may be omitted -- missing total/spread falls back to nfl-dfs's own
 * neutral defaults on a per-game basis. */
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

interface GameRegime {
  isShootout: boolean;
  shootoutScale: number;
  isScript: boolean;
  scriptWinner: string | null;
  scriptLoser: string | null;
  scriptScale: number;
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

/**
 * Draws one full-slate set of correlated fantasy-point outcomes for one
 * trial. Ported from nfl-dfs's drawSlateOutcomes_ -- see module header for
 * the scope notes (no Showdown CPT/FLEX grouping, Vegas keyed by team,
 * dome from the home team only, via Player.isHome) that distinguish this
 * port from the original. `domeTeams` defaults to empty (every game
 * non-dome) -- pass `sport.domeTeams` for the real nfl-dfs dome boost.
 */
export function drawSlateOutcomes(
  players: readonly Player[],
  games: SlateVegas,
  rng: SeededRandom,
  domeTeams: ReadonlySet<string> = EMPTY_DOME_TEAMS,
): Map<string, number> {
  const groups = buildGameGroups(players);

  const gameVegas = new Map<string, ResolvedGameVegas>();
  const resolvedTotals: number[] = [];
  const domeByGame = new Map<string, boolean>();
  for (const g of groups) {
    const v = resolveGameVegas(g.teamX, g.teamY, games);
    gameVegas.set(g.key, v);
    if (isFiniteNum(v.total) && v.total > 0) resolvedTotals.push(v.total);
    domeByGame.set(g.key, g.homeTeam !== undefined && domeTeams.has(g.homeTeam));
  }
  const avgTotal = resolvedTotals.length > 0 ? mean(resolvedTotals) : 45;
  const totalStd = resolvedTotals.length > 1 ? popStdDev(resolvedTotals, avgTotal) : 5;

  // Per-game regime draw: shootout (game environment) and script (which
  // team controls the game) are independent axes, each rolled separately.
  const regimeByGame = new Map<string, GameRegime>();
  for (const g of groups) {
    const v = gameVegas.get(g.key)!;
    const spreadX = isFiniteNum(v.spreadX) ? v.spreadX : 0;
    const spreadAbs = Math.abs(spreadX);

    const totalRatio = isFiniteNum(v.total) && avgTotal > 0 ? v.total / avgTotal : 1.0;
    const pShootout = Math.min(SHOOTOUT_PROB_BASE * totalRatio, SHOOTOUT_PROB_CAP);
    const isShootout = rng.next() < pShootout;
    const shootoutScale = isShootout ? drawExpScale(rng, 1) : 0;

    const pScript = Math.min(SCRIPT_PROB_BASE * (1 + spreadAbs / 14), SCRIPT_PROB_CAP);
    const isScript = rng.next() < pScript;
    let scriptWinner: string | null = null;
    let scriptLoser: string | null = null;
    let scriptScale = 0;
    if (isScript) {
      const pXFav =
        spreadX < 0
          ? Math.min(0.5 + spreadAbs * 0.025, 0.95)
          : Math.max(0.5 - spreadAbs * 0.025, 0.05);
      const xWins = rng.next() < pXFav;
      scriptWinner = xWins ? g.teamX : g.teamY;
      scriptLoser = xWins ? g.teamY : g.teamX;
      scriptScale = drawExpScale(rng, 1);
    }

    regimeByGame.set(g.key, { isShootout, shootoutScale, isScript, scriptWinner, scriptLoser, scriptScale });
  }

  // zGame per game (mean-shifted by total vs. slate avg + shootout regime).
  const zGameByKey = new Map<string, number>();
  for (const g of groups) {
    const v = gameVegas.get(g.key)!;
    const regime = regimeByGame.get(g.key)!;
    const totalShift =
      isFiniteNum(v.total) && totalStd > 0 ? (VEGAS_WEIGHT * (v.total - avgTotal)) / totalStd : 0;
    const regimeShift = regime.isShootout ? SHOOTOUT_GAME_BOOST * regime.shootoutScale : 0;
    zGameByKey.set(g.key, randNormal(rng) + totalShift + regimeShift);
  }

  // zTeam per team (mean-shifted by spread + regime).
  const zTeamByTeam = new Map<string, number>();
  for (const g of groups) {
    const v = gameVegas.get(g.key)!;
    const regime = regimeByGame.get(g.key)!;
    const spreadX = isFiniteNum(v.spreadX) ? v.spreadX : 0;
    const spreadMag = Math.min(Math.abs(spreadX) / 14, 1.0) * SPREAD_WEIGHT;
    const baseShiftX = spreadX < 0 ? spreadMag : -spreadMag;
    const baseShiftY = -baseShiftX;

    let shiftX = baseShiftX;
    let shiftY = baseShiftY;
    if (regime.isShootout) {
      shiftX += SHOOTOUT_TEAM_BOOST * regime.shootoutScale;
      shiftY += SHOOTOUT_TEAM_BOOST * regime.shootoutScale;
    }
    if (regime.isScript) {
      const wBoost = SCRIPT_BOOST * regime.scriptScale;
      const lSupp = SCRIPT_SUPP * regime.scriptScale;
      if (regime.scriptWinner === g.teamX) {
        shiftX += wBoost;
        shiftY += lSupp;
      } else {
        shiftX += lSupp;
        shiftY += wBoost;
      }
    }

    zTeamByTeam.set(g.teamX, randNormal(rng) + shiftX);
    zTeamByTeam.set(g.teamY, randNormal(rng) + shiftY);
  }

  // Per-player draw.
  const outcomes = new Map<string, number>();
  for (const p of players) {
    const position = p.positions[0] ?? "WR";

    // DST splash: a true side-channel override, rolled once per player --
    // fully bypasses the z-composite/percentile draw when it fires.
    if (position === "DST" && rng.next() < DST_SPLASH_PROB) {
      const bonus = DST_SPLASH_BONUS_MIN + rng.next() * (DST_SPLASH_BONUS_MAX - DST_SPLASH_BONUS_MIN);
      outcomes.set(p.id, p.proj + bonus);
      continue;
    }

    const w = LATENT_WEIGHTS[position] ?? LATENT_WEIGHTS.WR;
    const gameKey = canonicalGameKey(p.team, p.opp);
    const regime = regimeByGame.get(gameKey);

    const domeWgMult = domeByGame.get(gameKey) ? DOME_WGAME_SCALE : 1.0;
    const regimeWgMult = regime?.isShootout ? SHOOTOUT_WG_SCALE : 1.0;
    const regimeWtMult = regime?.isScript && regime.scriptWinner === p.team ? SCRIPT_WT_SCALE : 1.0;

    const wgRaw = w.g * domeWgMult * regimeWgMult;
    const wtRaw = w.t * regimeWtMult;
    const wIndRaw = Math.sqrt(Math.max(0, 1 - w.g * w.g - w.t * w.t));
    const norm = Math.sqrt(wgRaw * wgRaw + wtRaw * wtRaw + wIndRaw * wIndRaw);
    const wg = wgRaw / norm;
    const wt = wtRaw / norm;
    const wInd = wIndRaw / norm;

    const zGameVal = zGameByKey.get(gameKey) ?? 0;
    const zTeamVal = zTeamByTeam.get(p.team) ?? 0;
    const zIndVal = randNormal(rng);
    const zRaw = wg * zGameVal + wt * zTeamVal + wInd * zIndVal;
    const z = Math.max(-Z_CLIP, Math.min(Z_CLIP, zRaw));
    const u = normCDF(z);
    const posMin = position === "DST" ? DST_POS_MIN : 0;

    outcomes.set(p.id, drawOutcome(p.floor, p.proj, p.ceiling, posMin, u, TAIL_K));
  }

  return outcomes;
}
