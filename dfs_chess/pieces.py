"""Piece classification — see CLAUDE.md "Piece rules" (source of truth).

A player belongs to the pool of every piece band they qualify for (not just
the first match) — a move's pick list is the available players in the
moved piece's pool. Bands come from a `SportConfig`, not hardcoded
constants here, per CLAUDE.md "Multi-sport ready". `load_sport_config`
rejects any config that leaves a real position with a salary gap no band
covers, so every real player classifies into at least one pool.

Once a player is locked, their piece for display/captures/`Player | Field`
is whichever one the locking move actually recorded (`Move.piece`), not a
fresh call to `classify` — a multi-pool player's *locked* identity doesn't
change just because `classify` would also return other pools today.
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


def classify(player: Player, sport: SportConfig) -> frozenset[Piece]:
    """Every piece band `player` qualifies for, by position + salary --
    empty only if `sport`'s config is broken (load_sport_config should have
    rejected it before this ever runs).
    """
    positions = {p.upper() for p in player.positions}
    return frozenset(band.piece for band in sport.piece_bands if band.matches(positions, player.salary))
