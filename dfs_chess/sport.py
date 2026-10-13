"""Sport config schema + loader: piece bands, roster slots, salary cap.

Per CLAUDE.md "Multi-sport ready" — sport-specific rules live in data
(`config/sports/*.json`), not in code. `pieces.py` and `rules.py` read a
`SportConfig`; neither hardcodes a position string or a salary band.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .models import Piece


@dataclass(frozen=True)
class PieceBand:
    piece: Piece
    positions: frozenset[str] | None  # None = any position
    min_salary: int | None  # None = no floor
    max_salary: int | None  # None = no ceiling (exclusive)

    def matches(self, positions: set[str], salary: int) -> bool:
        if self.positions is not None and not (self.positions & positions):
            return False
        if self.min_salary is not None and salary < self.min_salary:
            return False
        if self.max_salary is not None and salary >= self.max_salary:
            return False
        return True

    @property
    def is_catch_all(self) -> bool:
        return self.positions is None and self.min_salary is None and self.max_salary is None


@dataclass(frozen=True)
class RosterSlot:
    name: str
    positions: frozenset[str]
    count: int


@dataclass(frozen=True)
class SportConfig:
    sport: str
    salary_cap: int
    piece_bands: list[PieceBand]
    roster_slots: list[RosterSlot]

    @property
    def roster_size(self) -> int:
        return sum(slot.count for slot in self.roster_slots)


def load_sport_config(path: str | Path) -> SportConfig:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    piece_bands = [
        PieceBand(
            piece=Piece[band["piece"]],
            positions=(
                frozenset(band["positions"]) if band.get("positions") is not None else None
            ),
            min_salary=band.get("min_salary"),
            max_salary=band.get("max_salary"),
        )
        for band in data["piece_bands"]
    ]
    if not any(band.is_catch_all for band in piece_bands):
        raise ValueError(
            f"{path}: piece_bands has no catch-all band (positions, min_salary, "
            "and max_salary all null) -- every player must be classifiable"
        )

    roster_slots = [
        RosterSlot(name=slot["name"], positions=frozenset(slot["positions"]), count=slot["count"])
        for slot in data["roster_slots"]
    ]
    return SportConfig(
        sport=data["sport"],
        salary_cap=data["salary_cap"],
        piece_bands=piece_bands,
        roster_slots=roster_slots,
    )
