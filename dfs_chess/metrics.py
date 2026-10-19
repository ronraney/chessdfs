"""Pick-list sort metrics -- see RULES.md's piece table (source of truth
for which metric sorts which piece's pick list, highest first).
"""
from __future__ import annotations

from .config import ContestConfig
from .models import Piece, Player


def value(player: Player) -> float:
    """Projection per $1,000 of salary -- Pawn's own metric, and the base
    `leverage` discounts by ownership. Computed, never read off the ETR
    export's own "DK Value" column (points above a salary baseline,
    mostly negative -- a different thing entirely).
    """
    return player.proj / player.salary * 1000


def floor_value(player: Player) -> float:
    """Floor per $1,000 of salary -- Knight's own metric."""
    return player.floor / player.salary * 1000


def leverage(player: Player, contest: ContestConfig) -> float:
    """`value` discounted by the contest's own field-size ownership --
    Bishop's own metric."""
    return value(player) * (1 - player.own_for(contest.field_tier()))


def sort_metric(piece: Piece, player: Player, contest: ContestConfig) -> float:
    """`player`'s own value for whichever metric sorts `piece`'s pick
    list, highest first: King/Rook by projection (King unchanged; Rook
    per the correlation rework), Queen by ceiling, Bishop by leverage,
    Knight by floor value, Pawn by value.
    """
    if piece is Piece.QUEEN:
        return player.ceiling
    if piece is Piece.BISHOP:
        return leverage(player, contest)
    if piece is Piece.KNIGHT:
        return floor_value(player)
    if piece is Piece.PAWN:
        return value(player)
    return player.proj  # KING, ROOK
