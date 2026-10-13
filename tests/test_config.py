import json
from pathlib import Path

from dfs_chess.config import ContestConfig, load_contest_config
from dfs_chess.models import FieldTier
from dfs_chess.sport import load_sport_config

NFL = load_sport_config(
    Path(__file__).resolve().parent.parent / "config" / "sports" / "nfl.json"
)


def make_config(field_size: int) -> ContestConfig:
    return ContestConfig(cap=50000, field_size=field_size, payouts=[])


def test_field_tier_boundary_1999_2000():
    assert make_config(1999).field_tier() is FieldTier.SMALL
    assert make_config(2000).field_tier() is FieldTier.MID


def test_field_tier_boundary_9999_10000():
    assert make_config(9999).field_tier() is FieldTier.MID
    assert make_config(10000).field_tier() is FieldTier.LARGE


# --- cap default/override ---------------------------------------------------

def test_cap_defaults_to_sport_salary_cap_when_omitted():
    contest = ContestConfig(field_size=1000, payouts=[])  # cap omitted
    assert contest.cap is None
    assert contest.effective_cap(NFL) == NFL.salary_cap


def test_cap_override_takes_precedence_over_sport():
    contest = ContestConfig(cap=10000, field_size=1000, payouts=[])
    assert contest.effective_cap(NFL) == 10000


def test_load_contest_config_without_cap_defaults_to_sport(tmp_path):
    path = tmp_path / "contest.json"
    path.write_text(json.dumps({"field_size": 1000, "payouts": []}))

    contest = load_contest_config(path)

    assert contest.cap is None
    assert contest.effective_cap(NFL) == NFL.salary_cap


def test_load_contest_config_with_cap_overrides_sport(tmp_path):
    path = tmp_path / "contest.json"
    path.write_text(json.dumps({"cap": 35000, "field_size": 1000, "payouts": []}))

    contest = load_contest_config(path)

    assert contest.effective_cap(NFL) == 35000


# --- entry-size tiers / target rank (Task 20) --------------------------------
# Replaces the old percentile "contest aggression scale" (Task 15).

def test_target_rank_2_entries_is_rank_1():
    assert make_config(2).target_rank(last_rank=200) == 1


def test_target_rank_1000_entries_is_rank_9():
    # 1,000 is Small's own upper bound -- boundary sizes belong to the
    # lower tier, so this is still Small's fraction=1 case (rank 9), not
    # Mid's fraction=0 case (rank 10).
    assert make_config(1000).target_rank(last_rank=200) == 9


def test_target_rank_1001_entries_is_rank_10():
    # Just over Small's upper bound -- now Mid, essentially at its own
    # fraction=0 case (rank 10).
    assert make_config(1001).target_rank(last_rank=200) == 10


def test_target_rank_max_entries_scale_is_last_rank():
    assert make_config(416_171).target_rank(last_rank=200) == 200


def test_entry_tier_boundaries_belong_to_the_lower_tier():
    assert make_config(1000).entry_tier(last_rank=200).name == "Small"
    assert make_config(1001).entry_tier(last_rank=200).name == "Mid"
    assert make_config(5000).entry_tier(last_rank=200).name == "Mid"
    assert make_config(5001).entry_tier(last_rank=200).name == "Large"
    assert make_config(100_000).entry_tier(last_rank=200).name == "Large"
    assert make_config(100_001).entry_tier(last_rank=200).name == "XL"


def test_rank_tier_matches_the_configured_rank_ranges():
    contest = make_config(1000)  # irrelevant to rank_tier -- only the ranges matter
    assert contest.rank_tier(1, last_rank=200).name == "Small"
    assert contest.rank_tier(9, last_rank=200).name == "Small"
    assert contest.rank_tier(10, last_rank=200).name == "Mid"
    assert contest.rank_tier(29, last_rank=200).name == "Mid"
    assert contest.rank_tier(30, last_rank=200).name == "Large"
    assert contest.rank_tier(60, last_rank=200).name == "Large"
    assert contest.rank_tier(61, last_rank=200).name == "XL"
    assert contest.rank_tier(200, last_rank=200).name == "XL"


def test_target_rank_is_zero_when_nothing_is_ranked():
    assert make_config(1000).target_rank(last_rank=0) == 0


def test_load_contest_config_max_entries_scale_override(tmp_path):
    # field_size sits above the default large_max_entries (100,000), so
    # it's in the XL tier, where an overridden max_entries_scale is the
    # tier's own upper bound -- field_size == max_entries_scale there
    # means XL's fraction=1 case, i.e. target_rank == last_rank.
    path = tmp_path / "contest.json"
    path.write_text(
        json.dumps({"field_size": 150_000, "payouts": [], "max_entries_scale": 150_000})
    )
    contest = load_contest_config(path)
    assert contest.max_entries_scale == 150_000
    assert contest.target_rank(last_rank=200) == 200


def test_load_contest_config_without_max_entries_scale_uses_default(tmp_path):
    path = tmp_path / "contest.json"
    path.write_text(json.dumps({"field_size": 1000, "payouts": []}))
    contest = load_contest_config(path)
    assert contest.max_entries_scale == 416_171


def test_load_contest_config_tier_overrides(tmp_path):
    path = tmp_path / "contest.json"
    path.write_text(
        json.dumps(
            {
                "field_size": 1000,
                "payouts": [],
                "small_max_entries": 500,
                "small_max_rank": 5,
            }
        )
    )
    contest = load_contest_config(path)
    assert contest.small_max_entries == 500
    assert contest.small_max_rank == 5
    # 1,000 entries now falls past Small's (overridden) upper bound.
    assert contest.entry_tier(last_rank=200).name == "Mid"
