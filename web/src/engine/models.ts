// Core data models: Player, Piece, Side, Move, BuildState. Ported from
// dfs_chess/models.py.
//
// "enum" is unavailable under this project's erasableSyntaxOnly tsconfig, so
// each Python Enum below is a frozen const object plus a derived union type —
// the standard erasable substitute. Member access (e.g. Piece.KING) and
// equality checks (e.g. tier === FieldTier.SMALL) read the same as the
// Python call sites.

import type { Square } from "chess.js";
import { Chess } from "chess.js";

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

export interface BuildStateFields {
  board?: Chess;
  whiteMoves?: Move[];
  blackMoves?: Move[];
  lockedPlayerIds?: Set<string>;
  // Which players each currently-on-the-board piece has locked, keyed by
  // its current square -- a piece can hold several (it moved more than
  // once); a capture transfers only the most recent (RULES.md).
  pieceLocks?: Map<Square, Player[]>;
  // The full SAN move list of the book line Black has committed to while
  // out of an explicit template (RULES.md "Black (the field)") -- null if
  // Black hasn't committed to one right now. Carried through White's own
  // moves unchanged; only build.ts's play_black_move equivalent sets it
  // (not yet ported).
  blackCommittedLine?: readonly string[] | null;
  // Whether each side has already castled this build (Task 14: in PLACED
  // king mode, a locked King is always present from setup, so can_castle
  // can no longer tell "already castled" apart from "King locked" by
  // piece type alone -- these flags make that explicit for both king
  // modes).
  whiteCastled?: boolean;
  blackCastled?: boolean;
}

// Not frozen -- mirrors dfs_chess.models.BuildState, a plain (mutable)
// dataclass: castle() (not yet ported) flips white_castled/black_castled
// on an already-constructed instance rather than rebuilding it.
export class BuildState {
  board: Chess;
  whiteMoves: Move[];
  blackMoves: Move[];
  lockedPlayerIds: Set<string>;
  pieceLocks: Map<Square, Player[]>;
  blackCommittedLine: readonly string[] | null;
  whiteCastled: boolean;
  blackCastled: boolean;

  constructor(fields: BuildStateFields = {}) {
    this.board = fields.board ?? new Chess();
    this.whiteMoves = fields.whiteMoves ?? [];
    this.blackMoves = fields.blackMoves ?? [];
    this.lockedPlayerIds = fields.lockedPlayerIds ?? new Set();
    this.pieceLocks = fields.pieceLocks ?? new Map();
    this.blackCommittedLine = fields.blackCommittedLine ?? null;
    this.whiteCastled = fields.whiteCastled ?? false;
    this.blackCastled = fields.blackCastled ?? false;
  }
}
