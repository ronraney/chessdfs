"""Pick lists -- see RULES.md "List cap" and the piece table's sort
column. A pick list is the eligible, unlocked, roster/salary-feasible
players for a piece, sorted by that piece's own metric (`metrics.
sort_metric`) and capped to `sport`'s own per-piece list cap, if any.
This is the one list White's pick modal shows and Black's placeholder
pick takes the top of (RULES.md: "Black ... picks the top of the moved
piece's (capped) list instead of highest projection").
"""
from __future__ import annotations

from .config import ContestConfig
from .metrics import sort_metric
from .models import Piece, Player
from .pieces import classify
from .rules import lineup_still_completable
from .sport import SportConfig


def pick_list(
    piece: Piece,
    players_pool: list[Player],
    locked_player_ids: set[str],
    current_players: list[Player],
    sport: SportConfig,
    contest: ContestConfig,
    qb_team: str | None = None,
) -> list[Player]:
    """`current_players` is whichever side is picking's own roster so far
    (never including a hypothetical candidate) -- feasibility is checked
    as "would `current_players` plus this ONE candidate still be
    completable," same as every other lock in the build. `qb_team` only
    matters for Rook (see `pieces.classify`); every other piece ignores it.
    """
    cap = contest.effective_cap(sport)
    candidates = [
        p
        for p in players_pool
        if p.id not in locked_player_ids
        and piece in classify(p, sport, qb_team)
        and lineup_still_completable(current_players + [p], sport, cap)
    ]
    candidates.sort(key=lambda p: sort_metric(piece, p, contest), reverse=True)
    list_cap = sport.list_cap_for(piece)
    return candidates if list_cap is None else candidates[:list_cap]


def castle_qb_candidates(
    players_pool: list[Player],
    locked_player_ids: set[str],
    current_players: list[Player],
    sport: SportConfig,
    contest: ContestConfig,
) -> list[Player]:
    """King's own pick list, further restricted to QBs with at least one
    eligible teammate (available, fits roster and salary alongside that
    QB) -- RULES.md: "Only offer QBs with at least one eligible teammate
    ... If none, castling is illegal." Empty means castling can't offer
    any QB at all right now.
    """
    kings = pick_list(Piece.KING, players_pool, locked_player_ids, current_players, sport, contest)
    return [
        king
        for king in kings
        if pick_list(
            Piece.ROOK,
            players_pool,
            locked_player_ids | {king.id},
            current_players + [king],
            sport,
            contest,
            king.team,
        )
    ]
