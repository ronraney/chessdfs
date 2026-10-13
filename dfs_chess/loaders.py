"""ETR projections CSV -> list[Player], the Lichess opening book TSVs ->
list[BookLine], and the fetched opening-popularity snapshot -> dict. Column
names are never hardcoded into logic — they're mapped here so an ETR
export format change is a one-place edit.
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

from .models import Player
from .openings import BookLine

_MOVE_NUMBER = re.compile(r"^\d+\.$")

# Verified against data/samples/NFL Weekly DFS System - Projections.csv.
# `id` and `DK_ID` are both present and identical in that sample; DK_ID is
# used since it's the name DK's own upload format expects. `Small Field`/
# `Large Field` are separate ownership projections — there's no single
# "Own" column — hence own_small/own_large on Player.
ETR_COLUMN_MAP: dict[str, str] = {
    "id": "DK_ID",
    "name": "Player",
    "pos": "DK Pos",
    "team": "Team",
    "opp": "Opp",
    "salary": "DK Salary",
    "proj": "DK Proj",
    "own_small": "Small Field",
    "own_large": "Large Field",
}


def _parse_salary(raw: str) -> int:
    return int(raw.replace("$", "").replace(",", ""))


def _parse_percent(raw: str) -> float:
    """"40.20%" -> 0.402 (stored as a 0-1 fraction; shown as a percent in the UI)."""
    return float(raw.rstrip("%")) / 100


def load_etr_csv(
    path: str | Path,
    column_map: dict[str, str] = ETR_COLUMN_MAP,
) -> list[Player]:
    players: list[Player] = []
    with open(path, "r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            players.append(
                Player(
                    id=row[column_map["id"]],
                    name=row[column_map["name"]].strip(),
                    positions=(row[column_map["pos"]],),
                    team=row[column_map["team"]],
                    opp=row[column_map["opp"]],
                    salary=_parse_salary(row[column_map["salary"]]),
                    proj=float(row[column_map["proj"]]),
                    own_small=_parse_percent(row[column_map["own_small"]]),
                    own_large=_parse_percent(row[column_map["own_large"]]),
                )
            )
    return players


def _parse_pgn_moves(pgn: str) -> tuple[str, ...]:
    """"1. e4 e5 2. Nf3" -> ("e4", "e5", "Nf3") — drops the move-number tokens."""
    return tuple(token for token in pgn.split() if not _MOVE_NUMBER.match(token))


def load_opening_book(paths: list[str | Path]) -> list[BookLine]:
    """Lichess chess-openings TSVs (eco, name, pgn columns) -> BookLine
    list. Source: github.com/lichess-org/chess-openings (CC0 1.0).
    """
    lines: list[BookLine] = []
    for path in paths:
        with open(path, "r", encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f, delimiter="\t"):
                lines.append(
                    BookLine(
                        eco=row["eco"],
                        name=row["name"],
                        moves=_parse_pgn_moves(row["pgn"]),
                    )
                )
    return lines


def load_popularity(path: str | Path) -> dict[str, dict[str, int]]:
    """`data/openings/popularity.json`, produced by
    `tools/fetch_popularity.py` -- `{"<moves joined by ' '>": {<next move
    SAN>: <game count>}}`, one entry per position actually fetched. A
    position with no entry has no data (see `openings.book_weights`).
    """
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_line_stats(path: str | Path) -> list[dict]:
    """`data/openings/line_stats.json`, produced by
    `tools/count_popularity.py` -- its `"lines"` list verbatim (each a
    dict with `eco`/`name`/`moves`/`games`/`white_rate`/`draw_rate`/
    `black_rate`); the `"_meta"` key is dropped. See
    `openings.rank_families`.
    """
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)["lines"]
