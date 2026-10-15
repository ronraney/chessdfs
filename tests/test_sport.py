import json

import pytest

from dfs_chess.sport import load_sport_config


def _write_config(tmp_path, piece_bands):
    path = tmp_path / "sport.json"
    path.write_text(
        json.dumps(
            {
                "sport": "TEST",
                "salary_cap": 50000,
                "piece_bands": piece_bands,
                "roster_slots": [{"name": "ANY", "positions": ["X"], "count": 1}],
            }
        )
    )
    return path


def test_load_sport_config_rejects_missing_catch_all(tmp_path):
    path = _write_config(
        tmp_path,
        piece_bands=[
            {"piece": "KING", "positions": ["QB"], "min_salary": None, "max_salary": None},
        ],
    )
    with pytest.raises(ValueError):
        load_sport_config(path)


def test_load_sport_config_accepts_a_catch_all(tmp_path):
    path = _write_config(
        tmp_path,
        piece_bands=[
            {"piece": "KING", "positions": ["QB"], "min_salary": None, "max_salary": None},
            {"piece": "PAWN", "positions": None, "min_salary": None, "max_salary": None},
        ],
    )
    sport = load_sport_config(path)
    assert sport.sport == "TEST"


def test_load_sport_config_rejects_a_salary_gap(tmp_path):
    """Piece pools: bands below $5,000 and above $5,000 that don't
    actually meet at the boundary leave a real gap (nothing matches
    exactly $5,000) -- rejected the same as a missing catch-all.
    """
    path = _write_config(
        tmp_path,
        piece_bands=[
            {"piece": "KING", "positions": ["QB"], "min_salary": None, "max_salary": None},
            {"piece": "PAWN", "positions": None, "min_salary": None, "max_salary": 4999},
            {"piece": "QUEEN", "positions": None, "min_salary": 5001, "max_salary": None},
        ],
    )
    with pytest.raises(ValueError):
        load_sport_config(path)


def test_load_sport_config_accepts_bands_that_meet_exactly_at_the_boundary(tmp_path):
    path = _write_config(
        tmp_path,
        piece_bands=[
            {"piece": "KING", "positions": ["QB"], "min_salary": None, "max_salary": None},
            {"piece": "PAWN", "positions": None, "min_salary": None, "max_salary": 5000},
            {"piece": "QUEEN", "positions": None, "min_salary": 5000, "max_salary": None},
        ],
    )
    sport = load_sport_config(path)
    assert sport.sport == "TEST"


def test_load_sport_config_honors_exclude_positions_for_coverage(tmp_path):
    """A band excluding position X must not count toward covering X --
    X needs its OWN fallback, same as if that band simply didn't list X.
    """
    path = _write_config(
        tmp_path,
        piece_bands=[
            {"piece": "QUEEN", "positions": None, "exclude_positions": ["X"], "min_salary": None, "max_salary": None},
        ],
    )
    with pytest.raises(ValueError):
        load_sport_config(path)


def test_load_sport_config_accepts_exclude_positions_with_a_fallback(tmp_path):
    path = _write_config(
        tmp_path,
        piece_bands=[
            {"piece": "QUEEN", "positions": None, "exclude_positions": ["X"], "min_salary": None, "max_salary": None},
            {"piece": "PAWN", "positions": ["X"], "min_salary": None, "max_salary": None},
        ],
    )
    sport = load_sport_config(path)
    assert sport.sport == "TEST"
