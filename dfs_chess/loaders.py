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
from .sport import SportConfig

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
    "floor": "DK Floor",
    "ceiling": "DK Ceiling",
}


def _parse_salary(raw: str) -> int:
    return int(raw.replace("$", "").replace(",", ""))


def _parse_percent(raw: str) -> float:
    """"40.20%" -> 0.402 (stored as a 0-1 fraction; shown as a percent in the UI)."""
    return float(raw.rstrip("%")) / 100


def _strip_opp(raw: str) -> str:
    """"@ARI" (away) -> "ARI"; "SF" (home) is unchanged."""
    return raw[1:] if raw.startswith("@") else raw


def _resolve_id_column(column_map: dict[str, str], fieldnames: list[str] | None) -> str:
    """Bug fix: some DK exports carry only a plain "id" column, not
    "DK_ID" — row[column_map["id"]] would then raise KeyError for every
    row (the TS port's equivalent silently gave every Player the SAME
    `undefined` id instead, which is worse: the whole player pool reads
    as "already locked" the moment any one player locks — see loaders.ts's
    own fix, which this mirrors). Falls back to "id" when "DK_ID" is
    genuinely absent from the file's own header row.
    """
    fields = fieldnames or []
    if column_map["id"] in fields:
        return column_map["id"]
    if "id" in fields:
        return "id"
    return column_map["id"]


def load_etr_csv(
    path: str | Path,
    column_map: dict[str, str] = ETR_COLUMN_MAP,
) -> list[Player]:
    players: list[Player] = []
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        id_column = _resolve_id_column(column_map, reader.fieldnames)
        for row in reader:
            players.append(
                Player(
                    id=row[id_column],
                    name=row[column_map["name"]].strip(),
                    positions=(row[column_map["pos"]],),
                    team=row[column_map["team"]],
                    opp=_strip_opp(row[column_map["opp"]]),
                    salary=_parse_salary(row[column_map["salary"]]),
                    proj=float(row[column_map["proj"]]),
                    own_small=_parse_percent(row[column_map["own_small"]]),
                    own_large=_parse_percent(row[column_map["own_large"]]),
                    floor=float(row[column_map["floor"]]),
                    ceiling=float(row[column_map["ceiling"]]),
                )
            )
    return players


class SlateValidationError(Exception):
    pass


# Task 43: admin-upload-only rigor -- a separate function from
# load_etr_csv itself (not folded into it) so every other caller (tests,
# tools, the CLI's own load) keeps working against small/synthetic CSVs
# that were never meant to form a complete, roster-feasible lineup. Mirrors
# loaders.ts's validateSlateCsv 1:1 (same checks, same order, same message
# wording) -- only the admin upload (TS side; there's no Python admin
# screen) needs "is this actually a usable slate" rigor, but the checks
# themselves live here too for parity. Raises SlateValidationError
# describing the first problem found (column shape before IDs before
# roster-slot feasibility -- parsing rows needs the columns to exist
# first); returns the parsed players + which column was used as the ID
# otherwise.
def validate_etr_csv(
    path: str | Path,
    sport: SportConfig,
    column_map: dict[str, str] = ETR_COLUMN_MAP,
) -> tuple[list[Player], str]:
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        fields = reader.fieldnames or []
        rows = list(reader)

    required_keys = ["name", "pos", "team", "opp", "salary", "proj", "own_small", "own_large", "floor", "ceiling"]
    missing_columns = [key for key in required_keys if column_map[key] not in fields]
    if missing_columns:
        names = ", ".join(column_map[key] for key in missing_columns)
        raise SlateValidationError(f"Missing required column(s): {names}.")

    if column_map["id"] not in fields and "id" not in fields:
        raise SlateValidationError(f'No ID column found (expected "{column_map["id"]}" or "id").')
    id_column = _resolve_id_column(column_map, fields)

    missing_id_count = sum(1 for row in rows if not (row.get(id_column) or "").strip())
    if missing_id_count:
        raise SlateValidationError(f"{missing_id_count} player(s) are missing an ID value.")

    seen_ids: set[str] = set()
    duplicate_ids: set[str] = set()
    for row in rows:
        row_id = row[id_column]
        if row_id in seen_ids:
            duplicate_ids.add(row_id)
        seen_ids.add(row_id)
    if duplicate_ids:
        raise SlateValidationError(f"Duplicate ID(s): {', '.join(duplicate_ids)}.")

    players = load_etr_csv(path, column_map)

    short_slots = [
        (slot, sum(1 for p in players if slot.positions & {pos.upper() for pos in p.positions}))
        for slot in sport.roster_slots
    ]
    short_slots = [(slot, have) for slot, have in short_slots if have < slot.count]
    if short_slots:
        detail = ", ".join(f"{slot.name} (need {slot.count}, have {have})" for slot, have in short_slots)
        raise SlateValidationError(f"Not enough players for slot(s): {detail}.")

    return players, id_column


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
