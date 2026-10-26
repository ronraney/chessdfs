// Contest config schema + loader (salary cap, field size, payouts, and the
// Task 20 entry-size tiers used to suggest an opening by family rank).
// Ported from dfs_chess/config.py.
//
// The engine stays I/O-free (web/src/engine has no DOM, no I/O): unlike
// Python's load_contest_config(path), which opens the file itself,
// loadContestConfig here takes already-parsed JSON data, same as
// loadSportConfig.

import { FieldTier } from "./models";
import { generatePayoutCurve } from "./sim/payouts";
import type { SportConfig } from "./sport";

export const FIELD_TIER_MID_MIN = 2000;
export const FIELD_TIER_LARGE_MIN = 10000;

// Task 20 "Field-size tiers": XL's upper entries bound (its rank upper
// bound is "last" -- however many families openings.rankFamilies actually
// ranks, resolved by the caller, not a fixed number here).
export const DEFAULT_MAX_ENTRIES_SCALE = 416_171;

export const DEFAULT_SMALL_MAX_ENTRIES = 1_000;
export const DEFAULT_MID_MAX_ENTRIES = 5_000;
export const DEFAULT_LARGE_MAX_ENTRIES = 100_000;
export const DEFAULT_SMALL_MAX_RANK = 9;
export const DEFAULT_MID_MAX_RANK = 29;
export const DEFAULT_LARGE_MAX_RANK = 60;

export interface PayoutTierFields {
  rank: number;
  amount: number;
}

export class PayoutTier {
  readonly rank: number;
  readonly amount: number;

  constructor(fields: PayoutTierFields) {
    this.rank = fields.rank;
    this.amount = fields.amount;
  }
}

export interface EntryTierFields {
  name: string;
  lowEntries: number;
  highEntries: number;
  lowRank: number;
  highRank: number;
}

// One of Task 20's four tiers (Small/Mid/Large/XL), resolved against a
// specific contest: its name, the [lowEntries, highEntries] total-contest-
// entries range it covers, and the [lowRank, highRank] family-rank range an
// opening suggestion is drawn from within it.
export class EntryTier {
  readonly name: string;
  readonly lowEntries: number;
  readonly highEntries: number;
  readonly lowRank: number;
  readonly highRank: number;

  constructor(fields: EntryTierFields) {
    this.name = fields.name;
    this.lowEntries = fields.lowEntries;
    this.highEntries = fields.highEntries;
    this.lowRank = fields.lowRank;
    this.highRank = fields.highRank;
  }
}

// Python's round() is round-half-to-even; JS's Math.round rounds half away
// from zero. targetRank's `raw` is extremely unlikely to land on an exact
// .5 tie (it comes out of a log fraction), but matching Python exactly per
// CLAUDE.md means not relying on that.
function roundHalfToEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

export interface ContestConfigFields {
  fieldSize: number;
  payouts: readonly PayoutTier[];
  cap?: number | null; // null/omitted -> defaults to the sport's salaryCap
  maxEntriesScale?: number;
  smallMaxEntries?: number;
  midMaxEntries?: number;
  largeMaxEntries?: number;
  smallMaxRank?: number;
  midMaxRank?: number;
  largeMaxRank?: number;
}

export class ContestConfig {
  readonly fieldSize: number;
  readonly payouts: readonly PayoutTier[];
  readonly cap: number | null;
  readonly maxEntriesScale: number;
  readonly smallMaxEntries: number;
  readonly midMaxEntries: number;
  readonly largeMaxEntries: number;
  readonly smallMaxRank: number;
  readonly midMaxRank: number;
  readonly largeMaxRank: number;

  constructor(fields: ContestConfigFields) {
    this.fieldSize = fields.fieldSize;
    this.payouts = fields.payouts;
    this.cap = fields.cap ?? null;
    this.maxEntriesScale = fields.maxEntriesScale ?? DEFAULT_MAX_ENTRIES_SCALE;
    this.smallMaxEntries = fields.smallMaxEntries ?? DEFAULT_SMALL_MAX_ENTRIES;
    this.midMaxEntries = fields.midMaxEntries ?? DEFAULT_MID_MAX_ENTRIES;
    this.largeMaxEntries = fields.largeMaxEntries ?? DEFAULT_LARGE_MAX_ENTRIES;
    this.smallMaxRank = fields.smallMaxRank ?? DEFAULT_SMALL_MAX_RANK;
    this.midMaxRank = fields.midMaxRank ?? DEFAULT_MID_MAX_RANK;
    this.largeMaxRank = fields.largeMaxRank ?? DEFAULT_LARGE_MAX_RANK;
  }

  effectiveCap(sport: SportConfig): number {
    return this.cap ?? sport.salaryCap;
  }

  fieldTier(): FieldTier {
    if (this.fieldSize < FIELD_TIER_MID_MIN) return FieldTier.SMALL;
    if (this.fieldSize < FIELD_TIER_LARGE_MIN) return FieldTier.MID;
    return FieldTier.LARGE;
  }

  // All four tiers, in order, using this contest's own configured
  // boundaries -- defaults: Small 2-1,000 -> ranks 1-9; Mid 1,000-5,000 ->
  // 10-29; Large 5,000-100,000 -> 30-60; XL 100,000+ -> 61-`lastRank`. Each
  // tier's low bound is the previous tier's high bound, both in entries and
  // in rank -- boundary entries sizes belong to the lower tier (entryTier/
  // targetRank below both rely on that). `lastRank` (the number of families
  // Task 20's openings.rankFamilies actually ranked) resolves XL's open
  // "...-last" rank bound, since this config has no visibility into that
  // count itself.
  entryTiers(lastRank: number): readonly EntryTier[] {
    return [
      new EntryTier({
        name: "Small",
        lowEntries: 2,
        highEntries: this.smallMaxEntries,
        lowRank: 1,
        highRank: this.smallMaxRank,
      }),
      new EntryTier({
        name: "Mid",
        lowEntries: this.smallMaxEntries,
        highEntries: this.midMaxEntries,
        lowRank: this.smallMaxRank + 1,
        highRank: this.midMaxRank,
      }),
      new EntryTier({
        name: "Large",
        lowEntries: this.midMaxEntries,
        highEntries: this.largeMaxEntries,
        lowRank: this.midMaxRank + 1,
        highRank: this.largeMaxRank,
      }),
      new EntryTier({
        name: "XL",
        lowEntries: this.largeMaxEntries,
        highEntries: this.maxEntriesScale,
        lowRank: this.largeMaxRank + 1,
        highRank: lastRank,
      }),
    ];
  }

  // This contest's own tier, by its fieldSize (boundary sizes belong to the
  // lower tier).
  entryTier(lastRank: number): EntryTier {
    const tiers = this.entryTiers(lastRank);
    for (const tier of tiers.slice(0, -1)) {
      if (this.fieldSize <= tier.highEntries) return tier;
    }
    return tiers[tiers.length - 1];
  }

  // Which tier `rank` nominally falls under, independent of this contest's
  // own tier -- for tagging an off-tier pick in the CLI (e.g. "XL-style").
  rankTier(rank: number, lastRank: number): EntryTier {
    const tiers = this.entryTiers(lastRank);
    for (const tier of tiers.slice(0, -1)) {
      if (rank <= tier.highRank) return tier;
    }
    return tiers[tiers.length - 1];
  }

  // Task 20's target-rank formula: round(lowRank + (ln(entries) -
  // ln(tierLow)) / (ln(tierHigh) - ln(tierLow)) * (highRank - lowRank)),
  // within this contest's own tier -- e.g. 2 entries -> rank 1 (Small's own
  // low bound). 0 if nothing is ranked at all; otherwise clamped to
  // [1, lastRank].
  targetRank(lastRank: number): number {
    if (lastRank <= 0) return 0;
    const tier = this.entryTier(lastRank);
    if (tier.highEntries <= tier.lowEntries) {
      return Math.max(1, Math.min(lastRank, tier.lowRank));
    }
    const fraction =
      (Math.log(this.fieldSize) - Math.log(tier.lowEntries)) /
      (Math.log(tier.highEntries) - Math.log(tier.lowEntries));
    const raw = tier.lowRank + fraction * (tier.highRank - tier.lowRank);
    return Math.max(1, Math.min(lastRank, roundHalfToEven(raw)));
  }
}

export interface RawPayoutTier {
  rank: number;
  amount: number;
}

export interface RawContestConfig {
  field_size: number;
  payouts: RawPayoutTier[];
  cap?: number | null;
  max_entries_scale?: number;
  small_max_entries?: number;
  mid_max_entries?: number;
  large_max_entries?: number;
  small_max_rank?: number;
  mid_max_rank?: number;
  large_max_rank?: number;
}

export function loadContestConfig(data: RawContestConfig): ContestConfig {
  return new ContestConfig({
    cap: data.cap ?? null,
    fieldSize: data.field_size,
    payouts: data.payouts.map((tier) => new PayoutTier({ rank: tier.rank, amount: tier.amount })),
    maxEntriesScale: data.max_entries_scale ?? DEFAULT_MAX_ENTRIES_SCALE,
    smallMaxEntries: data.small_max_entries ?? DEFAULT_SMALL_MAX_ENTRIES,
    midMaxEntries: data.mid_max_entries ?? DEFAULT_MID_MAX_ENTRIES,
    largeMaxEntries: data.large_max_entries ?? DEFAULT_LARGE_MAX_ENTRIES,
    smallMaxRank: data.small_max_rank ?? DEFAULT_SMALL_MAX_RANK,
    midMaxRank: data.mid_max_rank ?? DEFAULT_MID_MAX_RANK,
    largeMaxRank: data.large_max_rank ?? DEFAULT_LARGE_MAX_RANK,
  });
}

// Task 31/32: config/contests.json's own shape -- a list of named contest
// presets (a display name, its entries/buy-in, plus any RawContestConfig
// field) with no Python original to port from. `entries` is each preset's
// field_size under its own name, matching how "H2H (2 entries)" already
// reads elsewhere in this codebase. The real file (Task 32) is generated
// from data/samples/NFL Weekly DFS System - Sim_Contest.csv, whose columns
// beyond name/entries/buy-in (type, prize_pool, pct_to_first, min_cash,
// cash_line, max_entries_per_user) are typed here as part of the JSON's
// documented shape but not threaded through loadContestPresets below --
// "extra fields for later," not yet consumed.
export interface RawContestPreset {
  name: string;
  entries: number;
  buy_in: number;
  type?: string;
  prize_pool?: number;
  pct_to_first?: number;
  min_cash?: number;
  cash_line?: number;
  max_entries_per_user?: number;
  cap?: number | null;
  payouts: RawPayoutTier[];
  max_entries_scale?: number;
  small_max_entries?: number;
  mid_max_entries?: number;
  large_max_entries?: number;
  small_max_rank?: number;
  mid_max_rank?: number;
  large_max_rank?: number;
}

export interface ContestPreset {
  name: string;
  buyIn: number;
  contest: ContestConfig;
}

// Builds a real payout table from a preset's four summary anchors
// (prize_pool/pct_to_first/min_cash/cash_line) when the preset hasn't
// already been given an explicit one -- real (non-empty) `payouts` data on
// a preset always wins, same as nfl-dfs's own "real data coexists with
// synthetic" convention for Sim_Payout_Curve. contests.json currently has
// `payouts: []` for every preset, so every one of them is synthesized
// today; a future preset with a real table typed in directly would be
// left untouched. min_cash is back as a required anchor (round 2 of this
// task): generatePayoutCurve now pins it as the bottom-of-the-ladder floor
// instead of letting it drift, so all four fields are load-bearing again.
// Required together -- isFinite on each, not just "truthy" (none of these
// is ever legitimately 0 for a real contest, but a missing field reads as
// `undefined`, which isFinite correctly rejects).
function presetPayouts(preset: RawContestPreset): RawPayoutTier[] {
  if (preset.payouts.length > 0) return preset.payouts;
  const { prize_pool, pct_to_first, min_cash, cash_line } = preset;
  if (
    !(typeof prize_pool === "number" && isFinite(prize_pool)) ||
    !(typeof pct_to_first === "number" && isFinite(pct_to_first)) ||
    !(typeof min_cash === "number" && isFinite(min_cash)) ||
    !(typeof cash_line === "number" && isFinite(cash_line))
  ) {
    return preset.payouts; // still empty -- not enough real data to synthesize from
  }
  return generatePayoutCurve(prize_pool, pct_to_first, min_cash, cash_line);
}

export function loadContestPresets(data: readonly RawContestPreset[]): ContestPreset[] {
  return data.map((preset) => ({
    name: preset.name,
    buyIn: preset.buy_in,
    contest: loadContestConfig({
      field_size: preset.entries,
      payouts: presetPayouts(preset),
      cap: preset.cap,
      max_entries_scale: preset.max_entries_scale,
      small_max_entries: preset.small_max_entries,
      mid_max_entries: preset.mid_max_entries,
      large_max_entries: preset.large_max_entries,
      small_max_rank: preset.small_max_rank,
      mid_max_rank: preset.mid_max_rank,
      large_max_rank: preset.large_max_rank,
    }),
  }));
}
