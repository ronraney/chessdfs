"""Piece classification — see CLAUDE.md "Piece rules" (source of truth).

Bands come from a `SportConfig` (checked in order; first match wins) rather
than hardcoded constants here, per CLAUDE.md "Multi-sport ready".
`load_sport_config` rejects any config with no catch-all band, so every
player classifies here — no raised exceptions.
"""
from __future__ import annotations

import chess

from .models import Piece, Player
from .sport import SportConfig

_CHESS_PIECE_TYPES = {
    chess.KING: Piece.KING,
    chess.QUEEN: Piece.QUEEN,
    chess.ROOK: Piece.ROOK,
    chess.BISHOP: Piece.BISHOP,
    chess.KNIGHT: Piece.KNIGHT,
    chess.PAWN: Piece.PAWN,
}


def piece_for_chess_type(piece_type: chess.PieceType) -> Piece:
    """Maps a real chess piece type to our salary-tier Piece — the board
    piece that moves IS the tier (a real knight move is a Knight-band pick).
    This mapping is chess-inherent, not sport-specific, so it isn't part of
    the sport config.
    """
    return _CHESS_PIECE_TYPES[piece_type]


def classify(player: Player, sport: SportConfig) -> Piece:
    positions = {p.upper() for p in player.positions}
    for band in sport.piece_bands:
        if band.matches(positions, player.salary):
            return band.piece
