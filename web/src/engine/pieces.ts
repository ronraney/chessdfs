// Piece classification -- see CLAUDE.md "Piece rules" (source of truth).
// Ported from dfs_chess/pieces.py.
//
// A player belongs to the pool of every piece band they qualify for (not
// just the first match) -- a move's pick list is the available players in
// the moved piece's pool. Bands come from a SportConfig, not hardcoded
// constants here, per CLAUDE.md "Multi-sport ready". loadSportConfig
// rejects any config that leaves a real position with a salary gap no band
// covers, so every real player classifies into at least one pool.
//
// Once a player is locked, their piece for display/captures/"Player |
// Field" is whichever one the locking move actually recorded (Move.piece),
// not a fresh call to classify -- a multi-pool player's *locked* identity
// doesn't change just because classify would also return other pools today.

import type { PieceSymbol } from "chess.js";
import type { Player } from "./models";
import { Piece } from "./models";
import type { SportConfig } from "./sport";

const CHESS_PIECE_TYPES: Record<PieceSymbol, Piece> = {
  k: Piece.KING,
  q: Piece.QUEEN,
  r: Piece.ROOK,
  b: Piece.BISHOP,
  n: Piece.KNIGHT,
  p: Piece.PAWN,
};

// Maps a real chess.js piece type to our salary-tier Piece -- the board piece
// that moves IS the tier (a real knight move is a Knight-band pick). This
// mapping is chess-inherent, not sport-specific, so it isn't part of the
// sport config.
export function pieceForChessType(pieceType: PieceSymbol): Piece {
  return CHESS_PIECE_TYPES[pieceType];
}

// Every piece band `player` qualifies for, by position + salary -- empty
// only if `sport`'s config is broken (loadSportConfig should have rejected
// it before this ever runs).
//
// `qbTeam` is the moving side's own currently locked QB's team, if any
// (RULES.md piece table, Rook: "RB/WR/TE on your QB's team, any
// salary"). A `teamRestricted` band (Rook) only matches when `qbTeam` is
// null (no QB locked yet -- "list all RB/WR/TE") or equals
// `player.team`; every other band ignores `qbTeam` entirely.
export function classify(player: Player, sport: SportConfig, qbTeam: string | null = null): ReadonlySet<Piece> {
  const positions = new Set(player.positions.map((p) => p.toUpperCase()));
  const pieces = new Set<Piece>();
  for (const band of sport.pieceBands) {
    if (!band.matches(positions, player.salary)) continue;
    if (band.teamRestricted && qbTeam !== null && player.team !== qbTeam) continue;
    pieces.add(band.piece);
  }
  return pieces;
}
