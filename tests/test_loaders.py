import json
from pathlib import Path

import pytest

from dfs_chess.loaders import (
    SlateValidationError,
    load_etr_csv,
    load_line_stats,
    load_opening_book,
    load_popularity,
    validate_etr_csv,
)
from dfs_chess.pieces import classify
from dfs_chess.sport import load_sport_config

SAMPLE_CSV = (
    Path(__file__).resolve().parent.parent
    / "data"
    / "samples"
    / "NFL Weekly DFS System - Projections.csv"
)
OPENINGS_DIR = Path(__file__).resolve().parent.parent / "data" / "openings"
NFL = load_sport_config(
    Path(__file__).resolve().parent.parent / "config" / "sports" / "nfl.json"
)


def test_load_sample_etr_csv_has_301_players():
    players = load_etr_csv(SAMPLE_CSV)
    assert len(players) == 301


def test_salaries_are_ints():
    players = load_etr_csv(SAMPLE_CSV)
    assert all(isinstance(p.salary, int) for p in players)


def test_every_loaded_player_classifies():
    players = load_etr_csv(SAMPLE_CSV)
    for p in players:
        classify(p, NFL)


def test_ownership_is_a_0_to_1_fraction():
    players = load_etr_csv(SAMPLE_CSV)
    assert all(0.0 <= p.own_small <= 1.0 for p in players)
    assert all(0.0 <= p.own_large <= 1.0 for p in players)


def test_names_are_trimmed():
    players = load_etr_csv(SAMPLE_CSV)
    dst_players = [p for p in players if p.positions == ("DST",)]
    assert dst_players  # sanity: sample actually has DST rows to check
    assert all(p.name == p.name.strip() for p in players)


def test_load_etr_csv_falls_back_to_plain_id_column(tmp_path):
    """Bug fix: a real DK export (data/samples/repro-slate.csv, not
    committed here -- this fixture is a minimal stand-in with the same
    header shape) carried a plain "id" column instead of "DK_ID", which
    raised KeyError for every row. Mirrors loaders.ts's own fix (fall
    back to "id" when "DK_ID" is genuinely absent from the header) and
    test; see test_build.py for the full load -> lock -> reply repro.
    """
    csv_path = tmp_path / "id_only.csv"
    csv_path.write_text(
        "Player,DK Pos,Team,Opp,DK Salary,DK Proj,Small Field,Large Field,id\n"
        'Test Player A,DST,AAA,BBB,"$2,000",5.0,10.00%,10.00%,1001\n'
        'Test Player B,DST,AAA,BBB,"$2,100",5.1,10.00%,10.00%,1002\n'
        'Test Player C,DST,AAA,BBB,"$2,200",5.2,10.00%,10.00%,1003\n'
    )
    players = load_etr_csv(csv_path)
    assert [p.id for p in players] == ["1001", "1002", "1003"]


# --- slate validation (Task 43, admin-upload-only rigor) --------------------

_HEADER = "Player,DK Pos,Team,Opp,DK Salary,DK Proj,Small Field,Large Field,DK_ID"


def _row(id_: str, name: str, pos: str, salary: int) -> str:
    return f'{name},{pos},AAA,BBB,"${salary:,}",10.0,10.00%,10.00%,{id_}'


# QB(1) + RB(2) + WR(3) + TE(1) + DST(1) -- exactly covers every dedicated
# slot with nothing left over for FLEX, but FLEX's own check only asks for
# >=1 RB/WR/TE total (a plain per-slot count, not a full across-slots
# matching -- see validate_etr_csv's own comment), which the RB/WR/TE
# already on the roster trivially satisfy.
_FEASIBLE_ROWS = [
    _row("1", "QB1", "QB", 6000),
    _row("2", "RB1", "RB", 5200),
    _row("3", "RB2", "RB", 5300),
    _row("4", "WR1", "WR", 5000),
    _row("5", "WR2", "WR", 5100),
    _row("6", "WR3", "WR", 5200),
    _row("7", "TE1", "TE", 4500),
    _row("8", "DST1", "DST", 2500),
]


def _write_csv(tmp_path, rows: list[str]) -> Path:
    path = tmp_path / "slate.csv"
    path.write_text("\n".join([_HEADER, *rows]) + "\n")
    return path


def test_validate_etr_csv_real_sample_validates_cleanly():
    players, id_column = validate_etr_csv(SAMPLE_CSV, NFL)
    assert len(players) == 301
    assert id_column == "DK_ID"


def test_validate_etr_csv_feasible_minimal_slate_validates_cleanly(tmp_path):
    path = _write_csv(tmp_path, _FEASIBLE_ROWS)
    players, id_column = validate_etr_csv(path, NFL)
    assert len(players) == 8
    assert id_column == "DK_ID"


def test_validate_etr_csv_rejects_no_id_column(tmp_path):
    path = tmp_path / "slate.csv"
    path.write_text(
        "Player,DK Pos,Team,Opp,DK Salary,DK Proj,Small Field,Large Field\n"
        "QB1,QB,AAA,BBB,$6000,10.0,10.00%,10.00%\n"
    )
    with pytest.raises(SlateValidationError, match="No ID column found"):
        validate_etr_csv(path, NFL)


def test_validate_etr_csv_rejects_missing_id_value(tmp_path):
    rows = [*_FEASIBLE_ROWS[:-1], _row("", "DST1", "DST", 2500)]
    path = _write_csv(tmp_path, rows)
    with pytest.raises(SlateValidationError, match="missing an ID value"):
        validate_etr_csv(path, NFL)


def test_validate_etr_csv_rejects_duplicate_ids(tmp_path):
    rows = [*_FEASIBLE_ROWS[:-1], _row("1", "DST1", "DST", 2500)]  # "1" reused from QB1
    path = _write_csv(tmp_path, rows)
    with pytest.raises(SlateValidationError, match=r"Duplicate ID\(s\): 1"):
        validate_etr_csv(path, NFL)


def test_validate_etr_csv_rejects_missing_required_columns_naming_them(tmp_path):
    path = tmp_path / "slate.csv"
    path.write_text("Player,DK Pos,DK_ID\nQB1,QB,1\n")
    with pytest.raises(
        SlateValidationError,
        match=r"Missing required column\(s\): Team, Opp, DK Salary, DK Proj, Small Field, Large Field\.",
    ):
        validate_etr_csv(path, NFL)


def test_validate_etr_csv_rejects_too_few_players_for_a_slot_naming_it(tmp_path):
    rows = [row for row in _FEASIBLE_ROWS if not row.startswith("RB2,")]  # only 1 RB, needs 2
    path = _write_csv(tmp_path, rows)
    with pytest.raises(SlateValidationError, match=r"Not enough players for slot\(s\): RB \(need 2, have 1\)"):
        validate_etr_csv(path, NFL)


# --- opening book ------------------------------------------------------------

def test_load_opening_book_parses_all_five_files():
    book = load_opening_book([OPENINGS_DIR / f"{letter}.tsv" for letter in "abcde"])
    assert len(book) > 3000  # ~3865 rows across a.tsv-e.tsv, minus 5 headers


def test_load_opening_book_strips_move_numbers():
    book = load_opening_book([OPENINGS_DIR / "c.tsv"])
    ruy_lopez = next(line for line in book if line.name == "Ruy Lopez")
    assert ruy_lopez.eco == "C60"
    assert ruy_lopez.moves == ("e4", "e5", "Nf3", "Nc6", "Bb5")


def test_load_popularity_reads_the_vendored_snapshot():
    # Task 9b populated this from a real Lichess game dump (the
    # Opening Explorer API itself is still blocked -- Task 9). This only
    # checks the loader reads valid JSON into the expected shape.
    popularity = load_popularity(OPENINGS_DIR / "popularity.json")
    assert isinstance(popularity, dict)


def test_load_popularity_parses_a_populated_file(tmp_path):
    path = tmp_path / "popularity.json"
    path.write_text('{"e4": {"e5": 100, "c5": 80}}', encoding="utf-8")
    assert load_popularity(path) == {"e4": {"e5": 100, "c5": 80}}


# --- line stats (Task 9b / Task 15) -------------------------------------------

def test_load_line_stats_reads_the_vendored_snapshot():
    lines = load_line_stats(OPENINGS_DIR / "line_stats.json")
    assert isinstance(lines, list)
    assert lines  # Task 9b populated this from a real Lichess game dump
    assert {"eco", "name", "moves", "games"} <= lines[0].keys()


def test_load_line_stats_parses_a_populated_file(tmp_path):
    path = tmp_path / "line_stats.json"
    path.write_text(
        json.dumps(
            {
                "_meta": {"month": "2026-09"},
                "lines": [{"eco": "C60", "name": "Ruy Lopez", "moves": ["e4"], "games": 10}],
            }
        ),
        encoding="utf-8",
    )
    assert load_line_stats(path) == [{"eco": "C60", "name": "Ruy Lopez", "moves": ["e4"], "games": 10}]
