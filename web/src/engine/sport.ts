// Sport config schema + loader: piece bands, roster slots, salary cap.
// Ported from dfs_chess/sport.py.
//
// Per CLAUDE.md "Multi-sport ready" -- sport-specific rules live in data
// (config/sports/*.json), not in code. pieces.ts and (eventually) rules.ts
// read a SportConfig; neither hardcodes a position string or a salary band.
//
// The engine stays I/O-free (web/src/engine has no DOM, no I/O): unlike
// Python's load_sport_config(path), which opens the file itself,
// loadSportConfig here takes already-parsed JSON data. The caller (a test,
// or app startup code outside engine/) is responsible for reading the file
// -- e.g. importing web/src/data/config/sports/nfl.json directly.

import { Piece } from "./models";

export interface PieceBandFields {
  piece: Piece;
  positions: ReadonlySet<string> | null; // null = any position
  minSalary: number | null; // null = no floor
  maxSalary: number | null; // null = no ceiling (exclusive)
}

export class PieceBand {
  readonly piece: Piece;
  readonly positions: ReadonlySet<string> | null;
  readonly minSalary: number | null;
  readonly maxSalary: number | null;

  constructor(fields: PieceBandFields) {
    this.piece = fields.piece;
    this.positions = fields.positions;
    this.minSalary = fields.minSalary;
    this.maxSalary = fields.maxSalary;
  }

  matches(positions: ReadonlySet<string>, salary: number): boolean {
    if (this.positions !== null && !intersects(this.positions, positions)) return false;
    if (this.minSalary !== null && salary < this.minSalary) return false;
    if (this.maxSalary !== null && salary >= this.maxSalary) return false;
    return true;
  }

  get isCatchAll(): boolean {
    return this.positions === null && this.minSalary === null && this.maxSalary === null;
  }
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const item of a) {
    if (b.has(item)) return true;
  }
  return false;
}

export interface RosterSlotFields {
  name: string;
  positions: ReadonlySet<string>;
  count: number;
}

export class RosterSlot {
  readonly name: string;
  readonly positions: ReadonlySet<string>;
  readonly count: number;

  constructor(fields: RosterSlotFields) {
    this.name = fields.name;
    this.positions = fields.positions;
    this.count = fields.count;
  }
}

export interface SportConfigFields {
  sport: string;
  salaryCap: number;
  pieceBands: readonly PieceBand[];
  rosterSlots: readonly RosterSlot[];
}

export class SportConfig {
  readonly sport: string;
  readonly salaryCap: number;
  readonly pieceBands: readonly PieceBand[];
  readonly rosterSlots: readonly RosterSlot[];

  constructor(fields: SportConfigFields) {
    this.sport = fields.sport;
    this.salaryCap = fields.salaryCap;
    this.pieceBands = fields.pieceBands;
    this.rosterSlots = fields.rosterSlots;
  }

  get rosterSize(): number {
    return this.rosterSlots.reduce((sum, slot) => sum + slot.count, 0);
  }
}

interface RawPieceBand {
  piece: string;
  positions: string[] | null;
  min_salary: number | null;
  max_salary: number | null;
}

interface RawRosterSlot {
  name: string;
  positions: string[];
  count: number;
}

export interface RawSportConfig {
  sport: string;
  salary_cap: number;
  piece_bands: RawPieceBand[];
  roster_slots: RawRosterSlot[];
}

function pieceFromName(name: string): Piece {
  if (!Object.prototype.hasOwnProperty.call(Piece, name)) {
    throw new Error(`invalid piece name: ${name}`);
  }
  return Piece[name as keyof typeof Piece];
}

export function loadSportConfig(data: RawSportConfig): SportConfig {
  const pieceBands = data.piece_bands.map(
    (band) =>
      new PieceBand({
        piece: pieceFromName(band.piece),
        positions: band.positions != null ? new Set(band.positions) : null,
        minSalary: band.min_salary,
        maxSalary: band.max_salary,
      }),
  );

  if (!pieceBands.some((band) => band.isCatchAll)) {
    throw new Error(
      "piece_bands has no catch-all band (positions, min_salary, and max_salary all null) -- " +
        "every player must be classifiable",
    );
  }

  const rosterSlots = data.roster_slots.map(
    (slot) =>
      new RosterSlot({
        name: slot.name,
        positions: new Set(slot.positions),
        count: slot.count,
      }),
  );

  return new SportConfig({
    sport: data.sport,
    salaryCap: data.salary_cap,
    pieceBands,
    rosterSlots,
  });
}
