// Piece classification -- see CLAUDE.md "Piece rules" (source of truth).
// Ported from dfs_chess/pieces.py.
//
// Bands come from a SportConfig (checked in order; first match wins) rather
// than hardcoded constants here, per CLAUDE.md "Multi-sport ready".
// loadSportConfig rejects any config with no catch-all band, so every player
// classifies here -- no thrown errors in practice.

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

export function classify(player: Player, sport: SportConfig): Piece {
  const positions = new Set(player.positions.map((p) => p.toUpperCase()));
  for (const band of sport.pieceBands) {
    if (band.matches(positions, player.salary)) {
      return band.piece;
    }
  }
  throw new Error("no piece band matched -- loadSportConfig should have rejected this config");
}
