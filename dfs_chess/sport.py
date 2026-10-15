"""Sport config schema + loader: piece bands, roster slots, salary cap.

Per CLAUDE.md "Multi-sport ready" — sport-specific rules live in data
(`config/sports/*.json`), not in code. `pieces.py` and `rules.py` read a
`SportConfig`; neither hardcodes a position string or a salary band.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from .models import Piece


@dataclass(frozen=True)
class PieceBand:
    piece: Piece
    positions: frozenset[str] | None  # None = any position
    exclude_positions: frozenset[str] | None  # None = no exclusions
    min_salary: int | None  # None = no floor
    max_salary: int | None  # None = no ceiling (exclusive)

    def matches(self, positions: set[str], salary: int) -> bool:
        if self.positions is not None and not (self.positions & positions):
            return False
        if self.exclude_positions is not None and (self.exclude_positions & positions):
            return False
        if self.min_salary is not None and salary < self.min_salary:
            return False
        if self.max_salary is not None and salary >= self.max_salary:
            return False
        return True


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


def _position_fully_covered(position: str, piece_bands: list[PieceBand]) -> bool:
    """Whether every possible salary for `position` matches at least one
    band -- i.e. the bands relevant to `position` (by `positions`/
    `exclude_positions`), merged by salary range, cover [0, infinity) with
    no gap. Rejects pools "the piece that locked him" could ever fail to
    find.
    """
    relevant = [
        band
        for band in piece_bands
        if (band.positions is None or position in band.positions)
        and (band.exclude_positions is None or position not in band.exclude_positions)
    ]
    intervals = sorted(
        (band.min_salary or 0, band.max_salary if band.max_salary is not None else math.inf)
        for band in relevant
    )
    covered_to = 0.0
    for lo, hi in intervals:
        if lo > covered_to:
            return False
        covered_to = max(covered_to, hi)
    return covered_to == math.inf


def load_sport_config(path: str | Path) -> SportConfig:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    piece_bands = [
        PieceBand(
            piece=Piece[band["piece"]],
            positions=(
                frozenset(band["positions"]) if band.get("positions") is not None else None
            ),
            exclude_positions=(
                frozenset(band["exclude_positions"]) if band.get("exclude_positions") is not None else None
            ),
            min_salary=band.get("min_salary"),
            max_salary=band.get("max_salary"),
        )
        for band in data["piece_bands"]
    ]

    roster_slots = [
        RosterSlot(name=slot["name"], positions=frozenset(slot["positions"]), count=slot["count"])
        for slot in data["roster_slots"]
    ]

    all_positions = {position for slot in roster_slots for position in slot.positions}
    uncovered = sorted(p for p in all_positions if not _position_fully_covered(p, piece_bands))
    if uncovered:
        raise ValueError(
            f"{path}: piece_bands leave a salary gap for position(s) {', '.join(uncovered)} -- "
            "some player at that position would classify as no piece at all"
        )

    return SportConfig(
        sport=data["sport"],
        salary_cap=data["salary_cap"],
        piece_bands=piece_bands,
        roster_slots=roster_slots,
    )
