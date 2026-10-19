"""Core data models: Player, Piece, Side, Move, BuildState."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

import chess


class Side(Enum):
    WHITE = "WHITE"
    BLACK = "BLACK"


class Piece(Enum):
    KING = "KING"
    QUEEN = "QUEEN"
    ROOK = "ROOK"
    BISHOP = "BISHOP"
    KNIGHT = "KNIGHT"
    PAWN = "PAWN"


class FieldTier(Enum):
    SMALL = "SMALL"
    MID = "MID"
    LARGE = "LARGE"


class KingMode(Enum):
    """RULES.md "King modes" — chosen at setup, before the opening."""

    EMERGE = "EMERGE"  # the King (QB) is locked only by a King move or castling
    PLACED = "PLACED"  # the QB is picked before move 1; see King modes


@dataclass(frozen=True)
class Player:
    id: str
    name: str
    positions: tuple[str, ...]  # eligible positions (e.g. ("RB", "WR")); NFL players have one
    team: str
    opp: str
    salary: int
    proj: float
    own_small: float
    own_large: float
    floor: float
    ceiling: float

    def own_for(self, tier: FieldTier) -> float:
        if tier is FieldTier.SMALL:
            return self.own_small
        if tier is FieldTier.LARGE:
            return self.own_large
        return (self.own_small + self.own_large) / 2


@dataclass(frozen=True)
class Move:
    side: Side
    piece: Piece
    san: str
    player: Player


@dataclass
class BuildState:
    board: chess.Board = field(default_factory=chess.Board)
    white_moves: list[Move] = field(default_factory=list)
    black_moves: list[Move] = field(default_factory=list)
    locked_player_ids: set[str] = field(default_factory=set)
    # Which players each currently-on-the-board piece has locked, keyed by
    # its current square — a piece can hold several (it moved more than
    # once); a capture transfers only the most recent (RULES.md).
    piece_locks: dict[chess.Square, list[Player]] = field(default_factory=dict)
    # The full SAN move list of the book line Black has committed to
    # while out of an explicit template (RULES.md "Black (the field)") —
    # None if Black hasn't committed to one right now. Carried through
    # White's own moves unchanged; only `build.play_black_move` sets it.
    black_committed_line: tuple[str, ...] | None = None
    # Whether each side has already castled this build (Task 14: in
    # PLACED king mode, a locked King is always present from setup, so
    # `can_castle` can no longer tell "already castled" apart from "King
    # locked" by piece type alone — these flags make that explicit for
    # both king modes).
    white_castled: bool = False
    black_castled: bool = False
