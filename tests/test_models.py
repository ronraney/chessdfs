from dfs_chess.models import FieldTier, Player


def make_player(own_small: float, own_large: float) -> Player:
    return Player(
        id="p1",
        name="Test Player",
        positions=("WR",),
        team="AAA",
        opp="BBB",
        salary=5000,
        proj=10.0,
        own_small=own_small,
        own_large=own_large,
    )


def test_own_for_small_uses_small_field():
    assert make_player(10.0, 20.0).own_for(FieldTier.SMALL) == 10.0


def test_own_for_large_uses_large_field():
    assert make_player(10.0, 20.0).own_for(FieldTier.LARGE) == 20.0


def test_own_for_mid_returns_average():
    assert make_player(10.0, 20.0).own_for(FieldTier.MID) == 15.0
