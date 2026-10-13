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
