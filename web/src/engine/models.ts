// Core data models: Player, Piece, Side, Move. Ported from dfs_chess/models.py.
//
// BuildState is not ported here: it wraps a chess board/square representation
// that belongs with rules.ts/build.ts, which Task 22 explicitly defers.
//
// "enum" is unavailable under this project's erasableSyntaxOnly tsconfig, so
// each Python Enum below is a frozen const object plus a derived union type —
// the standard erasable substitute. Member access (e.g. Piece.KING) and
// equality checks (e.g. tier === FieldTier.SMALL) read the same as the
// Python call sites.

export const Side = {
  WHITE: "WHITE",
  BLACK: "BLACK",
} as const;
export type Side = (typeof Side)[keyof typeof Side];

export const Piece = {
  KING: "KING",
  QUEEN: "QUEEN",
  ROOK: "ROOK",
  BISHOP: "BISHOP",
  KNIGHT: "KNIGHT",
  PAWN: "PAWN",
} as const;
export type Piece = (typeof Piece)[keyof typeof Piece];

export const FieldTier = {
  SMALL: "SMALL",
  MID: "MID",
  LARGE: "LARGE",
} as const;
export type FieldTier = (typeof FieldTier)[keyof typeof FieldTier];

// RULES.md "King modes" -- chosen at setup, before the opening.
export const KingMode = {
  EMERGE: "EMERGE", // the King (QB) is locked only by a King move or castling
  PLACED: "PLACED", // the QB is picked before move 1; see King modes
} as const;
export type KingMode = (typeof KingMode)[keyof typeof KingMode];

export interface PlayerFields {
  id: string;
  name: string;
  positions: readonly string[]; // eligible positions (e.g. ["RB", "WR"]); NFL players have one
  team: string;
  opp: string;
  salary: number;
  proj: number;
  ownSmall: number;
  ownLarge: number;
}

export class Player {
  readonly id: string;
  readonly name: string;
  readonly positions: readonly string[];
  readonly team: string;
  readonly opp: string;
  readonly salary: number;
  readonly proj: number;
  readonly ownSmall: number;
  readonly ownLarge: number;

  constructor(fields: PlayerFields) {
    this.id = fields.id;
    this.name = fields.name;
    this.positions = fields.positions;
    this.team = fields.team;
    this.opp = fields.opp;
    this.salary = fields.salary;
    this.proj = fields.proj;
    this.ownSmall = fields.ownSmall;
    this.ownLarge = fields.ownLarge;
  }

  ownFor(tier: FieldTier): number {
    if (tier === FieldTier.SMALL) return this.ownSmall;
    if (tier === FieldTier.LARGE) return this.ownLarge;
    return (this.ownSmall + this.ownLarge) / 2;
  }
}

export interface MoveFields {
  side: Side;
  piece: Piece;
  san: string;
  player: Player;
}

export class Move {
  readonly side: Side;
  readonly piece: Piece;
  readonly san: string;
  readonly player: Player;

  constructor(fields: MoveFields) {
    this.side = fields.side;
    this.piece = fields.piece;
    this.san = fields.san;
    this.player = fields.player;
  }
}
