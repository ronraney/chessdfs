from pathlib import Path

import pytest

from dfs_chess.models import Piece, Player
from dfs_chess.pieces import classify
from dfs_chess.sport import load_sport_config

NFL = load_sport_config(
    Path(__file__).resolve().parent.parent / "config" / "sports" / "nfl.json"
)


def make_player(pos: str, salary: int, team: str = "AAA") -> Player:
    return Player(
        id="p1",
        name="Test Player",
        positions=(pos,),
        team=team,
        opp="BBB",
        salary=salary,
        proj=10.0,
        own_small=10.0,
        own_large=10.0,
        floor=6.0,
        ceiling=16.0,
    )


@pytest.mark.parametrize("salary", [100, 3000, 4999, 5000, 6900, 7000, 9000])
def test_qb_is_always_king_only(salary):
    # QUEEN/ROOK/BISHOP/KNIGHT are all explicitly RB/WR/TE -- a QB never
    # pools into anything else, at any salary.
    assert classify(make_player("QB", salary), NFL) == {Piece.KING}


@pytest.mark.parametrize("pos", ["RB", "WR", "TE"])
def test_non_qb_skill_position_at_7000_plus_is_queen_eligible(pos):
    assert Piece.QUEEN in classify(make_player(pos, 7000), NFL)
    assert Piece.QUEEN in classify(make_player(pos, 9500), NFL)


def test_dst_and_other_non_skill_positions_are_never_queen_eligible():
    """Piece table: Queen/Bishop/Knight are explicitly RB/WR/TE now, not
    "any non-QB" -- DST and an otherwise-unclassified position (e.g. FB)
    no longer pool into Queen just by being priced at $7,000+.
    """
    assert Piece.QUEEN not in classify(make_player("DST", 9500), NFL)
    assert Piece.QUEEN not in classify(make_player("FB", 9500), NFL)


def test_rook_bishop_knight_are_rbwrte_now_not_one_position_each():
    # Rook/Bishop/Knight all now share the same RB/WR/TE position band
    # (differentiated only by salary floor, plus Rook's own team
    # restriction) -- an RB is Bishop/Knight-eligible too, not just Rook.
    rb = make_player("RB", 5200)
    assert {Piece.BISHOP, Piece.KNIGHT} <= classify(rb, NFL)
    wr = make_player("WR", 5200)
    assert {Piece.BISHOP, Piece.KNIGHT} <= classify(wr, NFL)


def test_bishop_boundary_4999_5000():
    assert Piece.BISHOP not in classify(make_player("WR", 4999), NFL)
    assert Piece.BISHOP in classify(make_player("WR", 5000), NFL)


def test_knight_floor_is_4500_unlike_bishops_5000():
    """Knight's own floor is $4,500, not Bishop's $5,000 -- an RB/WR/TE
    from $4,500 up to (but not including) $5,000 is in BOTH the Knight
    and Pawn pools (Pawn's own band still runs up to $5,000), not
    Knight-only.
    """
    assert classify(make_player("TE", 4499), NFL) == {Piece.PAWN, Piece.ROOK}
    assert classify(make_player("TE", 4500), NFL) == {Piece.KNIGHT, Piece.PAWN, Piece.ROOK}
    assert classify(make_player("TE", 4999), NFL) == {Piece.KNIGHT, Piece.PAWN, Piece.ROOK}
    assert classify(make_player("TE", 5000), NFL) == {Piece.KNIGHT, Piece.BISHOP, Piece.ROOK}


def test_bishop_knight_overlap_queen_at_6999_vs_7000():
    assert classify(make_player("WR", 6900), NFL) == {Piece.BISHOP, Piece.KNIGHT, Piece.ROOK}
    assert classify(make_player("WR", 7000), NFL) == {Piece.BISHOP, Piece.KNIGHT, Piece.ROOK, Piece.QUEEN}


def test_dst_is_pawn_eligible_at_every_salary():
    assert classify(make_player("DST", 5200), NFL) == {Piece.PAWN}
    assert classify(make_player("DST", 1000), NFL) == {Piece.PAWN}
    assert classify(make_player("DST", 50000), NFL) == {Piece.PAWN}


def test_any_non_qb_under_5000_with_no_qb_locked_is_pawn_and_rook():
    # With no QB locked yet for the moving side (qb_team=None, the
    # default), Rook's own team restriction doesn't apply -- "list all
    # RB/WR/TE" (RULES.md "Direct Rook move") -- so an RB/WR/TE under
    # $5,000 pools as both Pawn and Rook, not Pawn alone.
    assert classify(make_player("RB", 2500), NFL) == {Piece.PAWN, Piece.ROOK}
    assert classify(make_player("WR", 0), NFL) == {Piece.PAWN, Piece.ROOK}


def test_pawn_under_5000_is_position_agnostic_for_non_qb():
    assert classify(make_player("DST", 1000), NFL) == {Piece.PAWN}
    assert classify(make_player("FB", 3500), NFL) == {Piece.PAWN}  # not RB/WR/TE -- no Rook pool


def test_multi_position_player_pools_from_every_position_it_holds():
    hybrid = Player(
        id="h1",
        name="Hybrid",
        positions=("RB", "WR"),
        team="AAA",
        opp="BBB",
        salary=5200,
        proj=10.0,
        own_small=0.1,
        own_large=0.1,
        floor=6.0,
        ceiling=16.0,
    )
    # Piece pools: both positions' bands contribute, not just the first
    # (moot here since RB/WR share the same bands now, but the pool is
    # still every band RB/WR together qualify for).
    assert classify(hybrid, NFL) == {Piece.ROOK, Piece.BISHOP, Piece.KNIGHT}


# --- Rook: team-restricted (RULES.md piece table, "Rook = correlation") ----


def test_rook_requires_qb_team_match_when_a_qb_is_locked():
    teammate = make_player("RB", 5200, team="CIN")
    assert Piece.ROOK in classify(teammate, NFL, qb_team="CIN")
    assert Piece.ROOK not in classify(teammate, NFL, qb_team="DET")


def test_rook_ignores_team_when_no_qb_is_locked_yet():
    anyone = make_player("WR", 3000, team="SEA")
    assert Piece.ROOK in classify(anyone, NFL, qb_team=None)


def test_rook_team_restriction_does_not_affect_bishop_or_knight():
    # Only Rook's own band is team-restricted -- a team mismatch narrows
    # Rook out of the pool without touching any of the player's other
    # salary-band memberships.
    player = make_player("TE", 5200, team="CIN")
    assert classify(player, NFL, qb_team="DET") == {Piece.BISHOP, Piece.KNIGHT}
