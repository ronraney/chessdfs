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
// part of how nfl-dfs computes those caps today, not a diagnostic), and
// the Minimum Exposure Floor's per-solve catch-up boost. NOT ported (not
// named in this task's "keep" list, and genuinely separate mechanisms in
// nfl-dfs's own code): stack targeting (naked-QB rate, stack-team retry),
// Field Pace Slack, Dynamic Floor Relaxation, and nfl-dfs's own salary
// FLOOR (FIELD_MIN_SALARY_) -- this port only enforces the cap, matching
// the task's own "salary cap" framing and its "under the cap" test spec.
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

export interface SimulatedField {
  readonly lineups: readonly (readonly Player[])[];
  // entrants / sampleSize, per this task's own spec (nfl-dfs itself
  // divides by lineups.length instead -- that only differs here when an
  // attempt comes back infeasible and is skipped, see the main loop).
  readonly lineupWeight: number;
}

function positionOf(p: Player): string {
  return p.positions[0];
}

// Builds and solves one attempt's MILP: a plain (unstacked) best-lineup
// solve over `pool` with `objective` as each player's own perturbed
// score. Returns null on an infeasible attempt (e.g. exposure caps have
// thinned a position below what a legal roster needs) -- skipped by the
// caller, no retry/relaxation.
function solveOneLineup(pool: readonly Player[], objective: ReadonlyMap<string, number>, cap: number): Player[] | null {
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
    variables.set(p.id, coeffs);
  }

  const constraints = new Map<string, { equal?: number; min?: number; max?: number }>([
    ["salary", { max: cap }],
    ["qb", { equal: 1 }],
    ["dst", { equal: 1 }],
    ["rb", { min: 2, max: 3 }],
    ["wr", { min: 3, max: 4 }],
    ["te", { min: 1, max: 2 }],
    ["skill", { equal: 7 }],
  ]);

  const result = solve({ direction: "maximize", objective: "obj", constraints, variables, binaries: true });
  if (result.status !== "optimal") return null;

  const selectedIds = new Set<string>();
  for (const [id, value] of result.variables) {
    if (value > 0.5) selectedIds.add(id);
  }
  return pool.filter((p) => selectedIds.has(p.id));
}

/**
 * Generates a simulated field of `sampleSize` lineups: the contest's
 * OTHER entrants, not the current build -- the pool passed in is every
 * available player, with no awareness of (or filtering by) whatever
 * either side has locked in the current chess-dfs build.
 */
export function generateSimulatedField(
  players: readonly Player[],
  contest: ContestConfig,
  sport: SportConfig,
  sampleSize: number,
  rng: SeededRandom,
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

  const lineups: Player[][] = [];

  for (let attempt = 0; attempt < sampleSize; attempt++) {
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

    const lineup = solveOneLineup(pool, objective, cap);
    if (lineup === null) continue; // infeasible this attempt -- skipped, no retry/relaxation

    lineups.push(lineup);

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

  return { lineups, lineupWeight: contest.fieldSize / sampleSize };
}
