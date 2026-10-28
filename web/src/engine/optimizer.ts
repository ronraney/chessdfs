// Exact best-lineup solver: the best legal DK Classic lineup by total
// projection, subject to `sport`'s own roster slots (FLEX included, via
// each slot's own eligible positions -- no FLEX-specific logic here, same
// "sport-agnostic, config-driven" shape rules.ts's maxAssignable/
// assignRosterSlots already use) and a salary cap, optionally forcing a
// set of players in (White's locks) and excluding others (players Black has
// already taken).
//
// This is a weighted roster-slot assignment problem, not a plain knapsack:
// a greedy "take the best projection per slot" can miss the true optimum
// whenever two slots compete for the same salary (RULES.md never asked for
// "optimal," so no earlier code in this engine solves this -- maxAssignable
// only proves a roster CAN be completed, it doesn't choose the best one).
// Modeled as a 0/1 MILP and solved exactly by yalps (a small, dependency-
// free, pure-TypeScript LP/MILP solver): one binary variable per (player,
// eligible slot) pair, one "exactly `slot.count`" constraint per roster
// slot, one "at most/exactly one slot" constraint per player, and one
// salary constraint overall.
import { solve } from "yalps";
import type { Player } from "./models";
import type { RosterSlot, SportConfig } from "./sport";

export interface OptimizerOptions {
  // Forced into the lineup (RULES.md: a locked player is never reconsidered
  // -- "White's locked players forced in"). Assumed already eligible for
  // some roster slot (every real lock only ever happens via a classify()
  // match) and disjoint from `excludeIds`; not defended against otherwise.
  readonly locked?: readonly Player[];
  // Not offered to the solver at all -- "players taken by Black excluded."
  readonly excludeIds?: ReadonlySet<string>;
}

export interface OptimizerResult {
  readonly total: number;
  readonly lineup: readonly Player[];
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const item of a) {
    if (b.has(item)) return true;
  }
  return false;
}

// A player can fill more than one slot (e.g. an RB fills either the RB slot
// or FLEX) -- one variable per eligible (player, slot) pair, keyed so it
// can be split back apart once the solver returns which ones were chosen.
// Assumption: no real player id contains "::" (DK's own IDs are plain
// numbers/hyphenated numbers; roster slot names are short config-defined
// words like "RB"/"FLEX") -- flagging since this isn't enforced anywhere.
const KEY_SEP = "::";

function variableKey(playerId: string, slotName: string): string {
  return `${playerId}${KEY_SEP}${slotName}`;
}

function playerIdFromKey(key: string): string {
  return key.slice(0, key.indexOf(KEY_SEP));
}

// Q dominates P (P is safe to drop in its favor) if Q costs no more AND
// projects no less -- with a deterministic id tiebreak when the two are
// otherwise identical, so a block of exact duplicates doesn't all
// "mutually dominate" each other down to nothing (see pruneDominated).
function dominates(q: Player, p: Player): boolean {
  if (q.id === p.id) return false;
  if (q.salary > p.salary || q.proj < p.proj) return false;
  if (q.salary === p.salary && q.proj === p.proj) return q.id < p.id;
  return true;
}

// Drops every player who can never be part of ANY optimal lineup, so the
// solver never has to branch over them -- a real NFL slate's few hundred
// rows are mostly bench/replacement-level players at the same price point
// as somebody strictly better (a "known-answer" scale test can't surface
// this; a real ~300-player slate took 2+ seconds without it, measured
// against this project's own sample CSV, well past "feel instant").
//
// Players eligible for the exact same set of roster slots (e.g. every RB
// -- RB's own slot plus FLEX) can need as many as `need` of them at once,
// not just one -- so a player is only safe to drop once at least `need`
// OTHER players in that same group each individually dominate it (cost no
// more, project no less). This can never remove the true optimum: in any
// legal lineup using a dropped player, swapping it for any one of its (at
// least `need`) dominators not already used elsewhere in that same group
// is always possible (pigeonhole: `need` picks are being made from the
// group, so at least one of the `need` dominators is free) and never
// lowers the total projection or breaks the salary cap. A locked player is
// never dropped, dominated or not -- it's forced in regardless.
function pruneDominated(pool: readonly Player[], rosterSlots: readonly RosterSlot[], lockedIds: ReadonlySet<string>): Player[] {
  const slotCounts = new Map(rosterSlots.map((slot) => [slot.name, slot.count]));
  const groups = new Map<string, { need: number; players: Player[] }>();
  for (const player of pool) {
    if (lockedIds.has(player.id)) continue;
    const positions = new Set(player.positions.map((p) => p.toUpperCase()));
    const slotNames = rosterSlots
      .filter((slot) => intersects(slot.positions, positions))
      .map((slot) => slot.name)
      .sort();
    if (slotNames.length === 0) continue; // no eligible slot at all -- never selectable anyway
    const key = slotNames.join(",");
    let group = groups.get(key);
    if (group === undefined) {
      const need = slotNames.reduce((sum, name) => sum + (slotCounts.get(name) ?? 0), 0);
      group = { need, players: [] };
      groups.set(key, group);
    }
    group.players.push(player);
  }

  const dominated = new Set<string>();
  for (const { need, players } of groups.values()) {
    for (const p of players) {
      let dominators = 0;
      for (const q of players) {
        if (dominates(q, p)) {
          dominators++;
          if (dominators >= need) break;
        }
      }
      if (dominators >= need) dominated.add(p.id);
    }
  }

  return dominated.size === 0 ? [...pool] : pool.filter((p) => !dominated.has(p.id));
}

// Builds and solves the MILP for exactly the given candidate pool (already
// filtered for exclusions) -- the one shared code path for both "no locks,
// no exclusions" (slate optimal) and "locks forced, exclusions removed"
// (best completion).
function solveLineup(
  pool: readonly Player[],
  rosterSlots: readonly RosterSlot[],
  cap: number,
  lockedIds: ReadonlySet<string>,
): OptimizerResult | null {
  const variables = new Map<string, Map<string, number>>();
  const slotKeysByPlayer = new Map<string, string[]>();

  for (const player of pool) {
    const positions = new Set(player.positions.map((p) => p.toUpperCase()));
    const keys: string[] = [];
    for (const slot of rosterSlots) {
      if (!intersects(slot.positions, positions)) continue;
      const key = variableKey(player.id, slot.name);
      variables.set(
        key,
        new Map([
          ["obj", player.proj],
          ["salary", player.salary],
          [`slot:${slot.name}`, 1],
          [`player:${player.id}`, 1],
        ]),
      );
      keys.push(key);
    }
    if (keys.length > 0) slotKeysByPlayer.set(player.id, keys);
  }

  const constraints = new Map<string, { equal?: number; max?: number }>([["salary", { max: cap }]]);
  for (const slot of rosterSlots) {
    constraints.set(`slot:${slot.name}`, { equal: slot.count });
  }
  for (const playerId of slotKeysByPlayer.keys()) {
    constraints.set(`player:${playerId}`, lockedIds.has(playerId) ? { equal: 1 } : { max: 1 });
  }

  const solution = solve(
    {
      direction: "maximize",
      objective: "obj",
      constraints,
      variables,
      binaries: true,
    },
    // tolerance: 0 (the default) means only the true optimum is ever
    // accepted -- "must be exact (not greedy)."
  );

  if (solution.status !== "optimal") return null;

  const selectedIds = new Set<string>();
  for (const [key, value] of solution.variables) {
    if (value > 0.5) selectedIds.add(playerIdFromKey(key));
  }
  const lineup = pool.filter((p) => selectedIds.has(p.id));
  return { total: lineup.reduce((sum, p) => sum + p.proj, 0), lineup };
}

// "Slate optimal" (no locks, no exclusions) never changes for a given
// players array + cap -- "compute once per slate/contest," not on every
// pick. Keyed by the players array's own identity (same WeakMap-by-
// reference pattern rules.ts's findLegalMove cache uses for a board), so a
// caller that keeps reusing the same slate/contest (BuildScreen's own
// useMemo already does this once per component instance, but repeated
// "Start again" builds against the same slate -- and this project's own
// test suite, which renders many BuildScreen instances against the exact
// same sample CSV -- hit this cache too) never re-solves it from scratch.
const slateOptimalCache = new WeakMap<readonly Player[], Map<number, OptimizerResult | null>>();

// The best legal lineup from `players` under `cap`, or null if no legal
// lineup exists at all (e.g. `locked` already overflows the cap, or isn't
// jointly completable) -- shouldn't happen for a real build (RULES.md: the
// core is always completable), but the caller displays "--" rather than
// assuming it can't.
export function optimalLineup(
  players: readonly Player[],
  sport: SportConfig,
  cap: number,
  options: OptimizerOptions = {},
): OptimizerResult | null {
  const excludeIds = options.excludeIds ?? new Set<string>();
  const lockedIds = new Set((options.locked ?? []).map((p) => p.id));
  const isSlateOptimal = (options.locked ?? []).length === 0 && excludeIds.size === 0;

  if (isSlateOptimal) {
    let byCap = slateOptimalCache.get(players);
    if (byCap === undefined) {
      byCap = new Map();
      slateOptimalCache.set(players, byCap);
    }
    if (byCap.has(cap)) return byCap.get(cap)!;
    const pool = pruneDominated(players, sport.rosterSlots, lockedIds);
    const result = solveLineup(pool, sport.rosterSlots, cap, lockedIds);
    byCap.set(cap, result);
    return result;
  }

  const pool = pruneDominated(
    players.filter((p) => !excludeIds.has(p.id)),
    sport.rosterSlots,
    lockedIds,
  );
  return solveLineup(pool, sport.rosterSlots, cap, lockedIds);
}

// Rule change "Tight-finish alerts: new levels + Go back" -- step 3
// ("barely completable") needs the floor: the cheapest a side could
// possibly still finish its OPEN slots for, from whoever's genuinely left
// to draft. Same weighted-assignment shape as solveLineup above (a plain
// per-slot "take the cheapest" is wrong for the same reason a greedy
// projection pick is -- two still-open slots can compete for the same
// cheap player), just minimizing salary instead of maximizing projection,
// and over only the slots `openSlots` (rules.openRosterSlots' own output)
// names as still unfilled -- a side's own already-locked players aren't
// part of this sub-problem at all (their slots are already excluded from
// `openSlots`), so there's no "forced in" set and no cap constraint of its
// own (the whole point is finding the floor, not a lineup that fits under
// anything). Returns 0 with no solve at all once every slot is filled.
// Null if no legal assignment exists -- too few eligible players left in
// `availablePlayers` for some open slot; shouldn't happen against a real
// slate (same caveat optimalLineup's own null carries), so the caller
// treats it as "unknown," not an error.
export function cheapestCompletionCost(
  availablePlayers: readonly Player[],
  openSlots: Readonly<Record<string, number>>,
  rosterSlots: readonly RosterSlot[],
): number | null {
  const slotsToFill = rosterSlots.filter((slot) => (openSlots[slot.name] ?? 0) > 0);
  if (slotsToFill.length === 0) return 0;

  const variables = new Map<string, Map<string, number>>();
  const playerIds = new Set<string>();
  for (const player of availablePlayers) {
    const positions = new Set(player.positions.map((p) => p.toUpperCase()));
    for (const slot of slotsToFill) {
      if (!intersects(slot.positions, positions)) continue;
      variables.set(
        variableKey(player.id, slot.name),
        new Map([
          ["obj", player.salary],
          [`slot:${slot.name}`, 1],
          [`player:${player.id}`, 1],
        ]),
      );
      playerIds.add(player.id);
    }
  }

  const constraints = new Map<string, { equal?: number; max?: number }>();
  for (const slot of slotsToFill) {
    constraints.set(`slot:${slot.name}`, { equal: openSlots[slot.name] });
  }
  for (const playerId of playerIds) {
    constraints.set(`player:${playerId}`, { max: 1 });
  }

  const solution = solve({ direction: "minimize", objective: "obj", constraints, variables, binaries: true });
  return solution.status === "optimal" ? solution.result : null;
}
