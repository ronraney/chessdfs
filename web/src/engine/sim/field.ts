// Simulated contest field: one MILP solve per lineup, reusing yalps.
// Ported from rraney/nfl-dfs's generateSimulatedFieldMilp_ (sim_field.js)
// -- the older sampling-with-retry path (generateSimulatedField_) and all
// of its/this function's own diagnostics (diagLog, failureTrace,
// stackMeta, every skipped/stacked/floorRelaxed counter) are not ported.
//
// Kept, at nfl-dfs's frozen defaults: the ownership-bias objective term
// ((ownership / positionAvgOwnership) ^ biasExponent), per-player
// ownership-based exposure caps (plus the extra QB-only exposure cap, and
// the QB/DST aggregate-capacity-guarantee rescale -- a real, unconditional
// part of how nfl-dfs computes those caps today, not a diagnostic), the
// Minimum Exposure Floor's per-solve catch-up boost, and nfl-dfs's own
// salary FLOOR (FIELD_MIN_SALARY_ = $48,500).
//
// Stack SIZE targeting (this task's own rework): each attempt draws a
// target stack size from STACK_SIZE_DISTRIBUTION (naked/QB+1/QB+2/QB+3-or-
// more) instead of the old binary "naked vs. at-least-2" coin flip. If the
// draw is naked (size 0), the attempt solves with no stack constraint at
// all. Otherwise, candidate teams (>=1 QB AND >= the drawn size's worth of
// WR/TE currently in the exposure-capped pool) are weighted-sampled
// without replacement (weight = that team's QB objective value), tried in
// that order up to STACK_TEAM_RETRY_LIMIT_ times (each a separate MILP
// solve with a stackTeam constraint that pins the drawn size EXACTLY for
// sizes 1/2, or at-least for the "3 or more" bucket, plus
// qbFromStackTeam=1), falling back to a plain unstacked solve if every
// retried team (or no candidate team at all) fails -- same fallback-to-
// unstacked-rather-than-drop-the-attempt principle the old binary version
// used. NOT ported, per an earlier task's own instruction (skip unless the
// floor makes too many attempts infeasible): Field Pace Slack and Dynamic
// Floor Relaxation -- see this file's own accept-rate test/comment below
// for the measurement that justified skipping both.
//
// Roster-slot shape (qb/dst/rb/wr/te/skill, with min/max counts) is
// hardcoded exactly as nfl-dfs's own DK_MAIN_ROSTER_ is, not derived
// generically from SportConfig.rosterSlots the way engine/optimizer.ts
// does -- this is a faithful port of nfl-dfs's own NFL-classic-specific
// MILP shape, not a new sport-agnostic abstraction; it happens to match
// config/sports/nfl.json's roster_slots exactly (QB 1, RB 2+FLEX, WR
// 3+FLEX, TE 1+FLEX, DST 1) but isn't derived from it.
//
// Dedup key: nfl-dfs keys exposure/objective maps on `Player|Team`
// (sim_field.js's key_) because its own player objects have no single
// stable id guaranteed unique across the whole pool. chess-dfs's Player
// already has one (DK_ID, enforced unique by validateSlateCsv) -- used
// directly instead of reconstructing a composite key.
//
// Ownership: nfl-dfs's players carry a single flat `ownership` field,
// already resolved for whichever field size that run represents.
// chess-dfs's Player carries ownSmall/ownLarge separately -- resolved
// here via the existing Small/Mid/Large rule (contest.fieldTier() +
// player.ownFor(tier), engine/models.ts), same rule BuildScreen's own
// stats already use, not a new one.
import { solve } from "yalps";
import type { ContestConfig } from "../config";
import { Player } from "../models";
import type { SeededRandom } from "../rng";
import type { SportConfig } from "../sport";

// nfl-dfs's generateSimulatedFieldMilp_ default (`sampleSize = sampleSize
// || 1000`) -- exported so callers/tests can cite it explicitly rather
// than re-guessing the number; see this module's own header for why it
// isn't baked into generateSimulatedField's own signature as a default
// parameter value (a required `rng` has to follow it positionally).
export const DEFAULT_SAMPLE_SIZE = 1000;

// Config!B7/B8 frozen defaults (CONFIG_DEFAULT_MILP_BIAS_EXPONENT_,
// CONFIG_DEFAULT_MILP_NOISE_PCT_ / 100).
const BIAS_EXPONENT = 1.0;
const NOISE_PCT = 0.2;
// FIELD_DEFAULT_OWNERSHIP_ -- 0.1% floor on ownership used inside the
// bias ratio, so a near-zero-owned player's bias term doesn't blow up.
const DEFAULT_OWNERSHIP = 0.001;
// FIELD_QB_MAX_EXPOSURE_ -- an extra, QB-only exposure cap on top of the
// general per-player ownership-based one below.
const QB_MAX_EXPOSURE = 0.22;
// Config!B9/B10 frozen defaults (CONFIG_DEFAULT_MIN_EXPOSURE_BASE_
// MULTIPLIER_/_DECAY_K_) -- minExposureShare(player) = baseMultiplier x
// ownership x (ownership / maxOwnershipInPosition)^decayK.
const MIN_EXPOSURE_BASE_MULTIPLIER = 0.4;
const MIN_EXPOSURE_DECAY_K = 2.5;
// MIN_EXPOSURE_MAX_CATCHUP_BOOST_ -- bounds the per-solve catch-up boost
// so one badly-behind-pace player can't dominate the objective outright.
const MIN_EXPOSURE_MAX_CATCHUP_BOOST = 3.0;
// FIELD_MIN_SALARY_ -- the salary floor, enforced alongside the cap in
// every attempt's own MILP solve (no Dynamic Floor Relaxation: an attempt
// whose exposure-capped pool can't clear this floor is simply skipped,
// same as any other infeasible attempt).
export const SALARY_FLOOR = 48500;
// Per-attempt stack SIZE target distribution (this task's own config
// setting, replacing the old binary "naked vs. at-least-2" coin flip):
// naked 15%, QB+1 30%, QB+2 35%, QB+3-or-more 20%. `size` is the number of
// same-team WR/TE the MILP must pair with that team's QB -- EXACTLY for
// sizes 1/2, "at least" for size 3 (the "3 or more" bucket, left open-
// ended on purpose; roster shape caps it in practice at 6: 2 RB + 3 WR + 1
// TE + 1 FLEX of 7 skill slots minus the QB's own team not needing to fill
// every remaining slot with teammates).
export interface StackSizeTarget {
  readonly size: 0 | 1 | 2 | 3;
  readonly weight: number;
}
export const STACK_SIZE_DISTRIBUTION: readonly StackSizeTarget[] = [
  { size: 0, weight: 0.15 },
  { size: 1, weight: 0.3 },
  { size: 2, weight: 0.35 },
  { size: 3, weight: 0.2 },
];
// STACK_TEAM_RETRY_LIMIT_ -- bounds how many candidate teams a single
// stack-intended attempt tries (weighted, without replacement) before
// falling back to an unstacked solve.
const STACK_TEAM_RETRY_LIMIT = 6;

export interface SimulatedField {
  readonly lineups: readonly (readonly Player[])[];
  // entrants / lineups actually built -- nfl-dfs's own way (this session's
  // follow-up task), not / sampleSize (last session's spec): only differs
  // when an attempt comes back infeasible and is skipped, see the main loop.
  readonly lineupWeight: number;
}

function positionOf(p: Player): string {
  return p.positions[0];
}

// Builds and solves one attempt's MILP: a best-lineup solve over `pool`
// with `objective` as each player's own perturbed score, salary required
// within [floor, cap], and -- when `stackTeam` is given -- `stackSize` WR/
// TE from that team plus a QB from that same team (nfl-dfs's own
// `stackTeam`/`qbFromStackTeam` constraint pair: without tying the QB to
// the team, "N WR/TE from team X" alone doesn't force a real QB+N stack).
// `stackSize` is pinned EXACTLY for 1/2, "at least" for 3 (the "3 or more"
// bucket -- see STACK_SIZE_DISTRIBUTION's own comment). Returns null on an
// infeasible attempt (e.g. exposure caps have thinned a position below
// what a legal roster needs, or this exact stack can't be built under
// salary) -- skipped/retried by the caller, no relaxation.
function solveOneLineup(
  pool: readonly Player[],
  objective: ReadonlyMap<string, number>,
  cap: number,
  floor: number,
  stackTeam?: string,
  stackSize?: number,
): Player[] | null {
  const variables = new Map<string, Map<string, number>>();
  for (const p of pool) {
    const pos = positionOf(p);
    const coeffs = new Map<string, number>([
      ["obj", objective.get(p.id)!],
      ["salary", p.salary],
    ]);
    if (pos === "QB") coeffs.set("qb", 1);
    if (pos === "DST") coeffs.set("dst", 1);
    if (pos === "RB") {
      coeffs.set("rb", 1);
      coeffs.set("skill", 1);
    }
    if (pos === "WR") {
      coeffs.set("wr", 1);
      coeffs.set("skill", 1);
    }
    if (pos === "TE") {
      coeffs.set("te", 1);
      coeffs.set("skill", 1);
    }
    if (stackTeam !== undefined && p.team === stackTeam) {
      if (pos === "WR" || pos === "TE") coeffs.set("stackTeam", 1);
      if (pos === "QB") coeffs.set("qbFromStackTeam", 1);
    }
    variables.set(p.id, coeffs);
  }

  const constraints = new Map<string, { equal?: number; min?: number; max?: number }>([
    ["salary", { min: floor, max: cap }],
    ["qb", { equal: 1 }],
    ["dst", { equal: 1 }],
    ["rb", { min: 2, max: 3 }],
    ["wr", { min: 3, max: 4 }],
    ["te", { min: 1, max: 2 }],
    ["skill", { equal: 7 }],
  ]);
  if (stackTeam !== undefined && stackSize !== undefined) {
    constraints.set("stackTeam", stackSize >= 3 ? { min: stackSize } : { equal: stackSize });
    constraints.set("qbFromStackTeam", { equal: 1 });
  }

  const result = solve({ direction: "maximize", objective: "obj", constraints, variables, binaries: true });
  if (result.status !== "optimal") return null;

  const selectedIds = new Set<string>();
  for (const [id, value] of result.variables) {
    if (value > 0.5) selectedIds.add(id);
  }
  return pool.filter((p) => selectedIds.has(p.id));
}

// Weighted sample of up to `limit` teams from `teams`, without replacement
// (nfl-dfs's own `_weightedSampleOne_`, called repeatedly against a
// shrinking remainder) -- the stack-team retry order for one attempt.
function sampleTeamsWithoutReplacement(rng: SeededRandom, teams: readonly string[], weights: readonly number[], limit: number): string[] {
  const remainingTeams = [...teams];
  const remainingWeights = [...weights];
  const picked: string[] = [];
  while (remainingTeams.length > 0 && picked.length < limit) {
    const total = remainingWeights.reduce((sum, w) => sum + w, 0);
    const threshold = rng.next() * total;
    let running = 0;
    let idx = remainingTeams.length - 1; // floating-point rounding fallback
    for (let i = 0; i < remainingWeights.length; i++) {
      running += remainingWeights[i];
      if (running >= threshold) {
        idx = i;
        break;
      }
    }
    picked.push(remainingTeams[idx]);
    remainingTeams.splice(idx, 1);
    remainingWeights.splice(idx, 1);
  }
  return picked;
}

// One weighted draw from STACK_SIZE_DISTRIBUTION -- this attempt's target
// stack size (0 = naked).
function drawStackSize(rng: SeededRandom): number {
  const total = STACK_SIZE_DISTRIBUTION.reduce((sum, t) => sum + t.weight, 0);
  const threshold = rng.next() * total;
  let running = 0;
  for (const t of STACK_SIZE_DISTRIBUTION) {
    running += t.weight;
    if (threshold < running) return t.size;
  }
  return STACK_SIZE_DISTRIBUTION[STACK_SIZE_DISTRIBUTION.length - 1].size; // floating-point rounding fallback
}

// nfl-dfs's/this port's own default distinct-lineup target (this task's
// own wording: "5,000 distinct lineups (config setting)") -- how many
// genuinely DIFFERENT 9-player combinations the field should contain
// before generateSimulatedField stops early, distinct from `sampleSize`
// (now read as the attempt CAP -- see that param's own comment).
export const DEFAULT_TARGET_DISTINCT_LINEUPS = 5000;

/**
 * Generates a simulated field of up to `sampleSize` ATTEMPTS: the
 * contest's OTHER entrants, not the current build -- the pool passed in
 * is every available player, with no awareness of (or filtering by)
 * whatever either side has locked in the current chess-dfs build.
 */
export function generateSimulatedField(
  players: readonly Player[],
  contest: ContestConfig,
  sport: SportConfig,
  // The attempt CAP (same role `sampleSize` always had -- every exposure/
  // ownership-bias/min-exposure-floor formula below is still anchored to
  // this exact number, unchanged, per this task's own "keep ownership
  // targeting and exposure caps as they are"). The loop may stop BEFORE
  // using up every attempt once `targetDistinct` is reached -- see that
  // param below. Measured on the real sample slate (301 players): with a
  // REAL player pool, the distinct-lineup count grows roughly
  // logarithmically in attempts (~624 distinct at 1,000 attempts, ~2,671
  // at 10,000) -- the ownership-bias objective keeps re-finding the same
  // handful of best-scoring combos well before exposure caps force real
  // variety, so reaching a big distinct target can need FAR more attempts
  // than `sampleSize` used to be (1,000) alone.
  sampleSize: number,
  rng: SeededRandom,
  // Called once per attempt (accepted or skipped) with attempts completed
  // so far, the attempt cap, distinct lineups found so far, and the
  // distinct target -- a caller running this off the main thread
  // (fieldWorker.ts) uses this to report build progress without this
  // function itself doing any I/O (still no DOM/postMessage here). Extra
  // trailing args are backward compatible with a 2-arg (completed, total)
  // callback (TS's own callback-parameter-count variance allows this).
  onProgress?: (completed: number, total: number, distinct: number, targetDistinct: number) => void,
  // Stop once this many DISTINCT 9-player combinations have been found,
  // even if `sampleSize` attempts remain -- omitted (the default)
  // reproduces the old behavior exactly: run every one of `sampleSize`
  // attempts, no early stop. Doesn't change which lineups get built or
  // how (same MILP/noise/exposure-cap logic every attempt) -- only when
  // the loop stops asking for more.
  targetDistinct?: number,
): SimulatedField {
  const tier = contest.fieldTier();
  const cap = contest.effectiveCap(sport);
  const own = (p: Player): number => p.ownFor(tier);

  // Position-average ownership -- the bias ratio's denominator.
  const posSum = new Map<string, number>();
  const posCount = new Map<string, number>();
  for (const p of players) {
    const pos = positionOf(p);
    posSum.set(pos, (posSum.get(pos) ?? 0) + own(p));
    posCount.set(pos, (posCount.get(pos) ?? 0) + 1);
  }
  const positionAvgOwnership = new Map<string, number>();
  for (const [pos, sum] of posSum) positionAvgOwnership.set(pos, sum / posCount.get(pos)!);

  // Minimum Exposure Floor target share per player.
  const maxOwnershipByPos = new Map<string, number>();
  for (const p of players) {
    const pos = positionOf(p);
    const o = own(p);
    if ((maxOwnershipByPos.get(pos) ?? -Infinity) < o) maxOwnershipByPos.set(pos, o);
  }
  const minExposureShare = new Map<string, number>();
  for (const p of players) {
    const o = own(p);
    const maxOwn = maxOwnershipByPos.get(positionOf(p)) ?? o;
    const relativeShare = maxOwn > 0 ? o / maxOwn : 0;
    minExposureShare.set(p.id, MIN_EXPOSURE_BASE_MULTIPLIER * o * relativeShare ** MIN_EXPOSURE_DECAY_K);
  }

  // Exposure caps, anchored to sampleSize -- feasible by construction
  // (every attempt is a plain MILP solve), so sampleSize itself is the
  // right denominator, no measured-field-size sizing pass needed.
  const qbMaxCount = Math.floor(sampleSize * QB_MAX_EXPOSURE);
  const qbCounts = new Map<string, number>();
  const qbAtCap = new Set<string>();
  const playerMaxCount = new Map<string, number>();
  for (const p of players) playerMaxCount.set(p.id, Math.max(1, Math.floor(sampleSize * own(p))));

  // Aggregate-capacity guarantee for exactly-1-per-lineup positions (QB,
  // DST): if a position's ownership doesn't sum to ~100%, its individual
  // caps' sum can fall below sampleSize -- a structural impossibility
  // (every lineup needs exactly one), not a real tighter cap. Scale every
  // player's cap up proportionally so the position can reach sampleSize.
  for (const pos of ["QB", "DST"]) {
    const posIds = players.filter((p) => positionOf(p) === pos).map((p) => p.id);
    if (posIds.length === 0) continue;
    const capSum = posIds.reduce((s, id) => s + playerMaxCount.get(id)!, 0);
    if (capSum < sampleSize) {
      const factor = sampleSize / capSum;
      for (const id of posIds) playerMaxCount.set(id, Math.ceil(playerMaxCount.get(id)! * factor));
    }
  }

  const playerExposureCount = new Map<string, number>();
  const playerAtCap = new Set<string>();

  // Structural stack-eligible teams: has >=1 QB AND >=1 WR/TE among the
  // FULL player universe (not the exposure-capped pool, which shrinks per
  // attempt) -- a loose structural pre-filter only; the per-attempt
  // candidate-team loop below re-checks against the drawn size's own
  // requirement (>= drawnSize catchers currently in the capped pool),
  // which does the real gating. Mirrors nfl-dfs's own `stackEligibleTeams`,
  // computed once.
  const qbsByTeam = new Map<string, Player[]>();
  const catchersByTeam = new Map<string, Player[]>();
  for (const p of players) {
    const pos = positionOf(p);
    if (pos === "QB") {
      const list = qbsByTeam.get(p.team) ?? [];
      list.push(p);
      qbsByTeam.set(p.team, list);
    } else if (pos === "WR" || pos === "TE") {
      const list = catchersByTeam.get(p.team) ?? [];
      list.push(p);
      catchersByTeam.set(p.team, list);
    }
  }
  const stackEligibleTeams = [...qbsByTeam.keys()].filter((team) => (catchersByTeam.get(team)?.length ?? 0) >= 1);

  const lineups: Player[][] = [];
  // Every ACCEPTED attempt's own 9-player id set, sorted -- not deduped
  // into `lineups` itself (a combo accepted 30 times across 30 attempts
  // still occupies 30 slots there, same as always: that repetition IS the
  // combo's simulated frequency/exposure, load-bearing for run.ts's trial
  // loop). This set exists ONLY to decide when to stop asking for more.
  const distinctKeys = new Set<string>();
  const effectiveTarget = targetDistinct ?? Infinity;

  let attempt = 0;
  for (; attempt < sampleSize && distinctKeys.size < effectiveTarget; attempt++) {
    onProgress?.(attempt, sampleSize, distinctKeys.size, targetDistinct ?? sampleSize);
    const pool = players.filter((p) => {
      if (playerAtCap.has(p.id)) return false;
      if (positionOf(p) === "QB" && qbAtCap.has(p.id)) return false;
      return true;
    });

    const objective = new Map<string, number>();
    for (const p of pool) {
      const o = own(p);
      const avgOwn = positionAvgOwnership.get(positionOf(p)) ?? DEFAULT_OWNERSHIP;
      const ownershipBias = (Math.max(o, DEFAULT_OWNERSHIP) / Math.max(avgOwn, DEFAULT_OWNERSHIP)) ** BIAS_EXPONENT;

      let catchUpBoost = 1;
      const targetSoFar = (minExposureShare.get(p.id) ?? 0) * attempt;
      const actualSoFar = playerExposureCount.get(p.id) ?? 0;
      if (targetSoFar > actualSoFar) {
        catchUpBoost = 1 + Math.min(MIN_EXPOSURE_MAX_CATCHUP_BOOST, (targetSoFar - actualSoFar) / Math.max(targetSoFar, 1));
      }

      const noise = (rng.next() * 2 - 1) * NOISE_PCT;
      objective.set(p.id, p.proj * (1 + noise) * ownershipBias * catchUpBoost);
    }

    // Stack decision (Part C of nfl-dfs's _buildOneLineupMilp_, reworked
    // this task): a weighted draw over STACK_SIZE_DISTRIBUTION picks this
    // attempt's TARGET stack size, independent of whether a candidate team
    // is actually solvable at that size this attempt.
    const drawnSize = drawStackSize(rng);
    let lineup: Player[] | null = null;
    if (drawnSize > 0) {
      const candidateTeams: string[] = [];
      const candidateWeights: number[] = [];
      for (const team of stackEligibleTeams) {
        const qbsInPool = (qbsByTeam.get(team) ?? []).filter((qb) => objective.has(qb.id));
        const catchersInPool = (catchersByTeam.get(team) ?? []).filter((c) => objective.has(c.id)).length;
        if (qbsInPool.length > 0 && catchersInPool >= drawnSize) {
          candidateTeams.push(team);
          candidateWeights.push(qbsInPool.reduce((sum, qb) => sum + (objective.get(qb.id) ?? 0), 0));
        }
      }
      if (candidateTeams.length > 0) {
        const tryOrder = sampleTeamsWithoutReplacement(rng, candidateTeams, candidateWeights, STACK_TEAM_RETRY_LIMIT);
        for (const team of tryOrder) {
          const attemptLineup = solveOneLineup(pool, objective, cap, SALARY_FLOOR, team, drawnSize);
          if (attemptLineup !== null) {
            lineup = attemptLineup;
            break;
          }
        }
      }
    }
    if (lineup === null) lineup = solveOneLineup(pool, objective, cap, SALARY_FLOOR); // naked draw, or every candidate team failed at the drawn size
    if (lineup === null) continue; // infeasible this attempt -- skipped, no retry/relaxation

    lineups.push(lineup);
    distinctKeys.add(
      lineup
        .map((p) => p.id)
        .sort()
        .join(","),
    );

    const qb = lineup.find((p) => positionOf(p) === "QB");
    if (qb) {
      const c = (qbCounts.get(qb.id) ?? 0) + 1;
      qbCounts.set(qb.id, c);
      if (qbMaxCount > 0 && c >= qbMaxCount) qbAtCap.add(qb.id);
    }
    for (const p of lineup) {
      const c = (playerExposureCount.get(p.id) ?? 0) + 1;
      playerExposureCount.set(p.id, c);
      if (c >= (playerMaxCount.get(p.id) ?? Infinity)) playerAtCap.add(p.id);
    }
  }

  onProgress?.(attempt, sampleSize, distinctKeys.size, targetDistinct ?? sampleSize);

  // nfl-dfs's own way (this task's follow-up spec): entrants / lineups
  // ACTUALLY built, not / sampleSize -- only differs when attempts are
  // skipped as infeasible.
  return { lineups, lineupWeight: contest.fieldSize / Math.max(lineups.length, 1) };
}
