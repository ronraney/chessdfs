import pytest

from dfs_chess.config import ContestConfig
from dfs_chess.metrics import floor_value, leverage, sort_metric, value
from dfs_chess.models import Piece, Player

# Mid tier (field_size 2000 -> own_for averages small/large) for leverage's
# own ownership lookup.
CONTEST = ContestConfig(field_size=2000, payouts=[])


def make_player(salary: int, proj: float, floor: float, ceiling: float, own_small: float, own_large: float) -> Player:
    return Player(
        id="p1", name="Test Player", positions=("WR",), team="AAA", opp="BBB",
        salary=salary, proj=proj, own_small=own_small, own_large=own_large,
        floor=floor, ceiling=ceiling,
    )


def test_value_is_projection_per_1000_salary():
    player = make_player(salary=5000, proj=20.0, floor=10.0, ceiling=30.0, own_small=0.1, own_large=0.1)
    assert value(player) == pytest.approx(4.0)  # 20 / 5000 * 1000


def test_floor_value_is_floor_per_1000_salary():
    player = make_player(salary=5000, proj=20.0, floor=10.0, ceiling=30.0, own_small=0.1, own_large=0.1)
    assert floor_value(player) == pytest.approx(2.0)  # 10 / 5000 * 1000


def test_leverage_discounts_value_by_ownership():
    player = make_player(salary=5000, proj=20.0, floor=10.0, ceiling=30.0, own_small=0.2, own_large=0.4)
    # Mid tier -> own_for is the small/large average (0.3); value is 4.0.
    assert leverage(player, CONTEST) == pytest.approx(4.0 * (1 - 0.3))


def test_leverage_is_lower_for_a_more_owned_player_at_the_same_value():
    chalky = make_player(salary=5000, proj=20.0, floor=10.0, ceiling=30.0, own_small=0.5, own_large=0.5)
    leveraged = make_player(salary=5000, proj=20.0, floor=10.0, ceiling=30.0, own_small=0.05, own_large=0.05)
    assert leverage(leveraged, CONTEST) > leverage(chalky, CONTEST)


# --- sort_metric: each piece's own column (RULES.md piece table) -----------

def test_sort_metric_king_and_rook_use_projection():
    player = make_player(salary=5000, proj=20.0, floor=1.0, ceiling=99.0, own_small=0.9, own_large=0.9)
    assert sort_metric(Piece.KING, player, CONTEST) == player.proj
    assert sort_metric(Piece.ROOK, player, CONTEST) == player.proj


def test_sort_metric_queen_uses_ceiling():
    player = make_player(salary=5000, proj=20.0, floor=1.0, ceiling=42.0, own_small=0.9, own_large=0.9)
    assert sort_metric(Piece.QUEEN, player, CONTEST) == player.ceiling


def test_sort_metric_bishop_uses_leverage():
    player = make_player(salary=5000, proj=20.0, floor=1.0, ceiling=42.0, own_small=0.2, own_large=0.4)
    assert sort_metric(Piece.BISHOP, player, CONTEST) == leverage(player, CONTEST)


def test_sort_metric_knight_uses_floor_value():
    player = make_player(salary=5000, proj=20.0, floor=12.5, ceiling=42.0, own_small=0.2, own_large=0.4)
    assert sort_metric(Piece.KNIGHT, player, CONTEST) == floor_value(player)


def test_sort_metric_pawn_uses_value():
    player = make_player(salary=2000, proj=8.0, floor=3.0, ceiling=12.0, own_small=0.2, own_large=0.4)
    assert sort_metric(Piece.PAWN, player, CONTEST) == value(player)
