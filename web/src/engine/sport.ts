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
  excludePositions: ReadonlySet<string> | null; // null = no exclusions
  minSalary: number | null; // null = no floor
  maxSalary: number | null; // null = no ceiling (exclusive)
  // RULES.md piece table, Rook: eligibility is relative to the moving
  // side's own locked QB (if any), not a fixed salary/position band --
  // `matches` itself stays position/salary-only; `pieces.classify` is
  // what applies the team filter for a band with this set.
  teamRestricted?: boolean;
}

export class PieceBand {
  readonly piece: Piece;
  readonly positions: ReadonlySet<string> | null;
  readonly excludePositions: ReadonlySet<string> | null;
  readonly minSalary: number | null;
  readonly maxSalary: number | null;
  readonly teamRestricted: boolean;

  constructor(fields: PieceBandFields) {
    this.piece = fields.piece;
    this.positions = fields.positions;
    this.excludePositions = fields.excludePositions;
    this.minSalary = fields.minSalary;
    this.maxSalary = fields.maxSalary;
    this.teamRestricted = fields.teamRestricted ?? false;
  }

  matches(positions: ReadonlySet<string>, salary: number): boolean {
    if (this.positions !== null && !intersects(this.positions, positions)) return false;
    if (this.excludePositions !== null && intersects(this.excludePositions, positions)) return false;
    if (this.minSalary !== null && salary < this.minSalary) return false;
    if (this.maxSalary !== null && salary >= this.maxSalary) return false;
    return true;
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
  // Per-piece cap on how many candidates a pick list ever shows -- a
  // piece missing here has no cap (RULES.md "List cap": default 12 for
  // Queen/Rook/Bishop/Knight, none for King/Pawn -- but that default
  // lives in each sport's own config data, not hardcoded here).
  listCaps?: ReadonlyMap<Piece, number>;
}

export class SportConfig {
  readonly sport: string;
  readonly salaryCap: number;
  readonly pieceBands: readonly PieceBand[];
  readonly rosterSlots: readonly RosterSlot[];
  readonly listCaps: ReadonlyMap<Piece, number>;

  constructor(fields: SportConfigFields) {
    this.sport = fields.sport;
    this.salaryCap = fields.salaryCap;
    this.pieceBands = fields.pieceBands;
    this.rosterSlots = fields.rosterSlots;
    this.listCaps = fields.listCaps ?? new Map();
  }

  get rosterSize(): number {
    return this.rosterSlots.reduce((sum, slot) => sum + slot.count, 0);
  }

  listCapFor(piece: Piece): number | null {
    return this.listCaps.get(piece) ?? null;
  }
}

interface RawPieceBand {
  piece: string;
  positions: string[] | null;
  exclude_positions?: string[] | null;
  min_salary: number | null;
  max_salary: number | null;
  team_restricted?: boolean;
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
  list_caps?: Record<string, number>;
}

function pieceFromName(name: string): Piece {
  if (!Object.prototype.hasOwnProperty.call(Piece, name)) {
    throw new Error(`invalid piece name: ${name}`);
  }
  return Piece[name as keyof typeof Piece];
}

// Whether every possible salary for `position` matches at least one band --
// i.e. the bands relevant to `position` (by positions/excludePositions),
// merged by salary range, cover [0, infinity) with no gap. Rejects pools
// "the piece that locked him" could ever fail to find.
function positionFullyCovered(position: string, pieceBands: readonly PieceBand[]): boolean {
  const relevant = pieceBands.filter(
    (band) =>
      (band.positions === null || band.positions.has(position)) &&
      (band.excludePositions === null || !band.excludePositions.has(position)),
  );
  const intervals = relevant
    .map((band): [number, number] => [band.minSalary ?? 0, band.maxSalary ?? Infinity])
    .sort((a, b) => a[0] - b[0]);

  let coveredTo = 0;
  for (const [lo, hi] of intervals) {
    if (lo > coveredTo) return false;
    coveredTo = Math.max(coveredTo, hi);
  }
  return coveredTo === Infinity;
}

export function loadSportConfig(data: RawSportConfig): SportConfig {
  const pieceBands = data.piece_bands.map(
    (band) =>
      new PieceBand({
        piece: pieceFromName(band.piece),
        positions: band.positions != null ? new Set(band.positions) : null,
        excludePositions: band.exclude_positions != null ? new Set(band.exclude_positions) : null,
        minSalary: band.min_salary,
        maxSalary: band.max_salary,
        teamRestricted: band.team_restricted ?? false,
      }),
  );

  const rosterSlots = data.roster_slots.map(
    (slot) =>
      new RosterSlot({
        name: slot.name,
        positions: new Set(slot.positions),
        count: slot.count,
      }),
  );

  const allPositions = new Set(rosterSlots.flatMap((slot) => [...slot.positions]));
  const uncovered = [...allPositions].filter((p) => !positionFullyCovered(p, pieceBands)).sort();
  if (uncovered.length > 0) {
    throw new Error(
      `piece_bands leave a salary gap for position(s) ${uncovered.join(", ")} -- ` +
        "some player at that position would classify as no piece at all",
    );
  }

  const listCaps = new Map<Piece, number>(
    Object.entries(data.list_caps ?? {}).map(([name, cap]) => [pieceFromName(name), cap]),
  );

  return new SportConfig({
    sport: data.sport,
    salaryCap: data.salary_cap,
    pieceBands,
    rosterSlots,
    listCaps,
  });
}
