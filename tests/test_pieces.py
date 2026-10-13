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
def test_qb_is_always_king(salary):
    assert classify(make_player("QB", salary), NFL) is Piece.KING


@pytest.mark.parametrize("pos", ["RB", "WR", "TE", "DST", "FB"])
def test_non_qb_at_7000_plus_is_queen(pos):
    assert classify(make_player(pos, 7000), NFL) is Piece.QUEEN
    assert classify(make_player(pos, 9500), NFL) is Piece.QUEEN


def test_rb_rook_boundary_4900_5000():
    assert classify(make_player("RB", 4900), NFL) is Piece.PAWN
    assert classify(make_player("RB", 5000), NFL) is Piece.ROOK


def test_wr_bishop_boundary_4900_5000():
    assert classify(make_player("WR", 4900), NFL) is Piece.PAWN
    assert classify(make_player("WR", 5000), NFL) is Piece.BISHOP


def test_rook_bishop_knight_vs_queen_boundary_6900_7000():
    assert classify(make_player("RB", 6900), NFL) is Piece.ROOK
    assert classify(make_player("RB", 7000), NFL) is Piece.QUEEN
    assert classify(make_player("WR", 6900), NFL) is Piece.BISHOP
    assert classify(make_player("WR", 7000), NFL) is Piece.QUEEN
    assert classify(make_player("TE", 6900), NFL) is Piece.KNIGHT
    assert classify(make_player("TE", 7000), NFL) is Piece.QUEEN


def test_te_knight_boundary_4400_4500():
    assert classify(make_player("TE", 4400), NFL) is Piece.PAWN
    assert classify(make_player("TE", 4500), NFL) is Piece.KNIGHT


def test_dst_at_5200_is_pawn():
    assert classify(make_player("DST", 5200), NFL) is Piece.PAWN


def test_any_player_under_3000_is_pawn():
    assert classify(make_player("RB", 2500), NFL) is Piece.PAWN
    assert classify(make_player("DST", 1000), NFL) is Piece.PAWN
    assert classify(make_player("WR", 0), NFL) is Piece.PAWN


def test_dst_in_pawn_range():
    assert classify(make_player("DST", 3000), NFL) is Piece.PAWN
    assert classify(make_player("DST", 4900), NFL) is Piece.PAWN


def test_pawn_range_is_position_agnostic():
    assert classify(make_player("RB", 3000), NFL) is Piece.PAWN
    assert classify(make_player("WR", 4900), NFL) is Piece.PAWN
    assert classify(make_player("FB", 3500), NFL) is Piece.PAWN


def test_multi_position_player_classifies_by_either_position():
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
    assert classify(hybrid, NFL) is Piece.ROOK  # matches via RB; WR would also match Bishop
