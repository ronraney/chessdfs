import json
from pathlib import Path

from dfs_chess.loaders import load_etr_csv, load_line_stats, load_opening_book, load_popularity
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
