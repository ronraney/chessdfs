from pathlib import Path

import pytest

from dfs_chess.config import ContestConfig
from dfs_chess.models import Piece, Player
from dfs_chess.picklist import castle_qb_candidates, pick_list
from dfs_chess.sport import load_sport_config

NFL = load_sport_config(
    Path(__file__).resolve().parent.parent / "config" / "sports" / "nfl.json"
)
CONTEST = ContestConfig(field_size=1000, payouts=[])


def make_player(
    id_: str, pos: str, salary: int, proj: float = 10.0, floor: float = 6.0, ceiling: float = 16.0,
    own_small: float = 0.1, own_large: float = 0.1, team: str = "AAA",
) -> Player:
    return Player(
        id=id_, name=id_, positions=(pos,), team=team, opp="BBB",
        salary=salary, proj=proj, own_small=own_small, own_large=own_large,
        floor=floor, ceiling=ceiling,
    )


# --- eligibility / feasibility ----------------------------------------------

def test_pick_list_excludes_locked_players():
    pool = [make_player("rb1", "RB", 5200), make_player("rb2", "RB", 5300)]
    result = pick_list(Piece.BISHOP, pool, {"rb1"}, [], NFL, CONTEST)
    assert [p.id for p in result] == ["rb2"]


def test_pick_list_excludes_players_that_would_overflow_the_roster():
    # White already has 2 RBs + the FLEX spoken for by 3 RBs -- a 4th
    # RB-eligible candidate has no slot left.
    current = [make_player(f"rb{i}", "RB", 5200) for i in range(3)]
    pool = current + [make_player("rb4", "RB", 5300)]
    result = pick_list(Piece.BISHOP, pool, set(), current, NFL, CONTEST)
    assert [p.id for p in result] == []


def test_pick_list_excludes_players_that_would_overflow_the_cap():
    tight = ContestConfig(cap=10000, field_size=1000, payouts=[])
    current = [make_player("wr1", "WR", 5100)]
    pool = current + [make_player("rb1", "RB", 5200)]  # 5100 + 5200 > 10000
    result = pick_list(Piece.BISHOP, pool, set(), current, NFL, tight)
    assert [p.id for p in result] == []


# --- sort: each piece by its own metric (RULES.md piece table) -------------

def test_pick_list_king_and_rook_sort_by_projection():
    pool = [make_player("qb1", "QB", 6000, proj=15.0), make_player("qb2", "QB", 6200, proj=25.0)]
    result = pick_list(Piece.KING, pool, set(), [], NFL, CONTEST)
    assert [p.id for p in result] == ["qb2", "qb1"]


def test_pick_list_queen_sorts_by_ceiling_not_projection():
    low_ceiling_high_proj = make_player("a", "RB", 7200, proj=25.0, ceiling=30.0)
    high_ceiling_low_proj = make_player("b", "RB", 7300, proj=20.0, ceiling=45.0)
    result = pick_list(Piece.QUEEN, [low_ceiling_high_proj, high_ceiling_low_proj], set(), [], NFL, CONTEST)
    assert [p.id for p in result] == ["b", "a"]


def test_pick_list_bishop_sorts_by_leverage_not_value():
    # Same value (proj/salary), but "chalk" (heavily owned) should rank
    # below the lower-owned player once leverage discounts it.
    chalk = make_player("chalk", "WR", 5000, proj=20.0, own_small=0.5, own_large=0.5)
    leveraged = make_player("leveraged", "WR", 5000, proj=20.0, own_small=0.05, own_large=0.05)
    result = pick_list(Piece.BISHOP, [chalk, leveraged], set(), [], NFL, CONTEST)
    assert [p.id for p in result] == ["leveraged", "chalk"]


def test_pick_list_knight_sorts_by_floor_value_not_projection():
    high_proj_low_floor = make_player("a", "TE", 4600, proj=20.0, floor=2.0)
    low_proj_high_floor = make_player("b", "TE", 4600, proj=10.0, floor=9.0)
    result = pick_list(Piece.KNIGHT, [high_proj_low_floor, low_proj_high_floor], set(), [], NFL, CONTEST)
    assert [p.id for p in result] == ["b", "a"]


def test_pick_list_pawn_sorts_by_value_not_projection():
    cheap_efficient = make_player("a", "WR", 3000, proj=12.0)  # value 4.0
    pricier_less_efficient = make_player("b", "WR", 4900, proj=14.0)  # value ~2.86
    result = pick_list(Piece.PAWN, [cheap_efficient, pricier_less_efficient], set(), [], NFL, CONTEST)
    assert [p.id for p in result] == ["a", "b"]


# --- list cap (RULES.md "List cap") -----------------------------------------

def test_pick_list_caps_queen_rook_bishop_knight_to_12():
    pool = [make_player(f"wr{i}", "WR", 7000 + i, proj=float(i)) for i in range(20)]
    assert len(pick_list(Piece.QUEEN, pool, set(), [], NFL, CONTEST)) == 12
    assert len(pick_list(Piece.ROOK, pool, set(), [], NFL, CONTEST)) == 12
    assert len(pick_list(Piece.BISHOP, pool, set(), [], NFL, CONTEST)) == 12
    assert len(pick_list(Piece.KNIGHT, pool, set(), [], NFL, CONTEST)) == 12


def test_pick_list_king_and_pawn_are_uncapped():
    kings = [make_player(f"qb{i}", "QB", 6000 + i, proj=float(i)) for i in range(20)]
    pawns = [make_player(f"wr{i}", "WR", 3000 + i, proj=float(i)) for i in range(20)]
    assert len(pick_list(Piece.KING, kings, set(), [], NFL, CONTEST)) == 20
    assert len(pick_list(Piece.PAWN, pawns, set(), [], NFL, CONTEST)) == 20


def test_pick_list_cap_applies_after_removing_taken_and_infeasible_players():
    # 14 otherwise-eligible Bishops: one is already locked, and WR(3) +
    # FLEX(1) are already filled by 4 locked WRs, so every one of these
    # candidates (all WR) is also infeasible -- the surviving list must
    # be empty, not capped-but-nonempty by counting taken/infeasible
    # players toward the 12.
    current = [make_player(f"wr_locked{i}", "WR", 5000 + i) for i in range(4)]  # fills WR(3) + FLEX
    pool = [make_player(f"wr{i}", "WR", 5100 + i, proj=float(i)) for i in range(14)]
    result = pick_list(Piece.BISHOP, pool, {pool[0].id}, current, NFL, CONTEST)
    assert result == []


# --- Rook: team-restricted (RULES.md "Rook = correlation") -----------------

def test_pick_list_rook_restricted_to_qb_team_when_given():
    teammate = make_player("rb1", "RB", 5200, team="CIN")
    other_team = make_player("rb2", "RB", 5300, team="DET")
    result = pick_list(Piece.ROOK, [teammate, other_team], set(), [], NFL, CONTEST, qb_team="CIN")
    assert [p.id for p in result] == ["rb1"]


def test_pick_list_rook_lists_all_rbwrte_when_no_qb_locked():
    cin = make_player("rb1", "RB", 5200, team="CIN")
    det = make_player("rb2", "RB", 5300, team="DET")
    result = pick_list(Piece.ROOK, [cin, det], set(), [], NFL, CONTEST, qb_team=None)
    assert {p.id for p in result} == {"rb1", "rb2"}


# --- castle_qb_candidates: "only offer QBs with an eligible teammate" ------

def test_castle_qb_candidates_excludes_a_qb_with_no_teammate_in_the_pool():
    lonely_qb = make_player("qb1", "QB", 6000, team="CIN")
    teamed_qb = make_player("qb2", "QB", 6200, team="DET")
    teammate = make_player("rb1", "RB", 5200, team="DET")
    pool = [lonely_qb, teamed_qb, teammate]
    result = castle_qb_candidates(pool, set(), [], NFL, CONTEST)
    assert [p.id for p in result] == ["qb2"]


def test_castle_qb_candidates_empty_when_no_qb_has_an_eligible_teammate():
    pool = [make_player("qb1", "QB", 6000, team="CIN"), make_player("qb2", "QB", 6200, team="DET")]
    assert castle_qb_candidates(pool, set(), [], NFL, CONTEST) == []


def test_castle_qb_candidates_excludes_a_qb_whose_only_teammate_is_already_locked():
    qb = make_player("qb1", "QB", 6000, team="CIN")
    teammate = make_player("rb1", "RB", 5200, team="CIN")
    result = castle_qb_candidates([qb, teammate], {teammate.id}, [], NFL, CONTEST)
    assert result == []
