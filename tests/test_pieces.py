from pathlib import Path

import pytest

from dfs_chess.models import Piece, Player
from dfs_chess.pieces import classify
from dfs_chess.sport import load_sport_config

NFL = load_sport_config(
    Path(__file__).resolve().parent.parent / "config" / "sports" / "nfl.json"
)


def make_player(pos: str, salary: int) -> Player:
    return Player(
        id="p1",
        name="Test Player",
        positions=(pos,),
        team="AAA",
        opp="BBB",
        salary=salary,
        proj=10.0,
        own_small=10.0,
        own_large=10.0,
    )


@pytest.mark.parametrize("salary", [100, 3000, 4999, 5000, 6900, 7000, 9000])
def test_qb_is_always_king_only(salary):
    # QUEEN explicitly excludes QB -- a QB never pools into anything else,
    # at any salary.
    assert classify(make_player("QB", salary), NFL) == {Piece.KING}


@pytest.mark.parametrize("pos", ["RB", "WR", "TE", "DST", "FB"])
def test_non_qb_at_7000_plus_is_queen_eligible(pos):
    assert Piece.QUEEN in classify(make_player(pos, 7000), NFL)
    assert Piece.QUEEN in classify(make_player(pos, 9500), NFL)


def test_rb_rook_boundary_4999_5000():
    assert classify(make_player("RB", 4999), NFL) == {Piece.PAWN}
    assert classify(make_player("RB", 5000), NFL) == {Piece.ROOK}


def test_wr_bishop_boundary_4999_5000():
    assert classify(make_player("WR", 4999), NFL) == {Piece.PAWN}
    assert classify(make_player("WR", 5000), NFL) == {Piece.BISHOP}


def test_te_knight_floor_is_4500_unlike_rb_wr():
    """Knight's own floor is $4,500, not Rook/Bishop's $5,000 -- a TE from
    $4,500 up to (but not including) $5,000 is in BOTH the Knight and
    Pawn pools (Pawn's own band still runs up to $5,000), not Knight-only.
    """
    assert classify(make_player("TE", 4499), NFL) == {Piece.PAWN}
    assert classify(make_player("TE", 4500), NFL) == {Piece.KNIGHT, Piece.PAWN}
    assert classify(make_player("TE", 4999), NFL) == {Piece.KNIGHT, Piece.PAWN}
    assert classify(make_player("TE", 5000), NFL) == {Piece.KNIGHT}


def test_rook_bishop_knight_overlap_queen_at_6999_vs_7000():
    """Piece pools: Rook/Bishop/Knight no longer have a $7,000 ceiling, so
    an RB/WR/TE at $7,000+ is in BOTH its position band and Queen -- the
    $6,900 case stays single-pool (below Queen's own $7,000 floor).
    """
    assert classify(make_player("RB", 6900), NFL) == {Piece.ROOK}
    assert classify(make_player("RB", 7000), NFL) == {Piece.ROOK, Piece.QUEEN}
    assert classify(make_player("WR", 6900), NFL) == {Piece.BISHOP}
    assert classify(make_player("WR", 7000), NFL) == {Piece.BISHOP, Piece.QUEEN}
    assert classify(make_player("TE", 6900), NFL) == {Piece.KNIGHT}
    assert classify(make_player("TE", 7000), NFL) == {Piece.KNIGHT, Piece.QUEEN}


def test_dst_is_pawn_eligible_at_every_salary():
    assert Piece.PAWN in classify(make_player("DST", 5200), NFL)
    assert Piece.PAWN in classify(make_player("DST", 1000), NFL)
    assert Piece.PAWN in classify(make_player("DST", 50000), NFL)


def test_dst_at_7000_plus_is_pawn_and_queen():
    # DST is Pawn-eligible regardless of salary ("plus all DST") AND, once
    # >= $7,000, also Queen-eligible -- these two Pawn rules (position-
    # agnostic under $5,000, DST at any salary) aren't mutually exclusive.
    assert classify(make_player("DST", 7000), NFL) == {Piece.PAWN, Piece.QUEEN}


def test_any_non_qb_under_3000_is_pawn_only():
    assert classify(make_player("RB", 2500), NFL) == {Piece.PAWN}
    assert classify(make_player("DST", 1000), NFL) == {Piece.PAWN}
    assert classify(make_player("WR", 0), NFL) == {Piece.PAWN}


def test_pawn_under_5000_is_position_agnostic_for_non_qb():
    assert classify(make_player("RB", 3000), NFL) == {Piece.PAWN}
    assert classify(make_player("WR", 4900), NFL) == {Piece.PAWN}
    assert classify(make_player("FB", 3500), NFL) == {Piece.PAWN}


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
    )
    # Piece pools: both positions' bands contribute, not just the first.
    assert classify(hybrid, NFL) == {Piece.ROOK, Piece.BISHOP}
