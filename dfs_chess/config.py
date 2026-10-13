"""Contest config schema + loader (salary cap, field size, payouts, and
the Task 20 entry-size tiers used to suggest an opening by family rank).
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from .models import FieldTier
from .sport import SportConfig

FIELD_TIER_MID_MIN = 2000
FIELD_TIER_LARGE_MIN = 10000

# Task 20 "Field-size tiers": XL's upper entries bound (its rank upper
# bound is "last" -- however many families `openings.rank_families`
# actually ranks, resolved by the caller, not a fixed number here).
DEFAULT_MAX_ENTRIES_SCALE = 416_171

DEFAULT_SMALL_MAX_ENTRIES = 1_000
DEFAULT_MID_MAX_ENTRIES = 5_000
DEFAULT_LARGE_MAX_ENTRIES = 100_000
DEFAULT_SMALL_MAX_RANK = 9
DEFAULT_MID_MAX_RANK = 29
DEFAULT_LARGE_MAX_RANK = 60


@dataclass(frozen=True)
class PayoutTier:
    rank: int
    amount: float


@dataclass(frozen=True)
class EntryTier:
    """One of Task 20's four tiers (Small/Mid/Large/XL), resolved
    against a specific contest: its name, the [low_entries, high_entries]
    total-contest-entries range it covers, and the [low_rank, high_rank]
    family-rank range an opening suggestion is drawn from within it.
    """

    name: str
    low_entries: int
    high_entries: int
    low_rank: int
    high_rank: int


@dataclass(frozen=True)
class ContestConfig:
    field_size: int
    payouts: list[PayoutTier]
    cap: int | None = None  # None -> defaults to the sport's salary_cap
    max_entries_scale: int = DEFAULT_MAX_ENTRIES_SCALE
    small_max_entries: int = DEFAULT_SMALL_MAX_ENTRIES
    mid_max_entries: int = DEFAULT_MID_MAX_ENTRIES
    large_max_entries: int = DEFAULT_LARGE_MAX_ENTRIES
    small_max_rank: int = DEFAULT_SMALL_MAX_RANK
    mid_max_rank: int = DEFAULT_MID_MAX_RANK
    large_max_rank: int = DEFAULT_LARGE_MAX_RANK

    def effective_cap(self, sport: SportConfig) -> int:
        return self.cap if self.cap is not None else sport.salary_cap

    def field_tier(self) -> FieldTier:
        if self.field_size < FIELD_TIER_MID_MIN:
            return FieldTier.SMALL
        if self.field_size < FIELD_TIER_LARGE_MIN:
            return FieldTier.MID
        return FieldTier.LARGE

    def entry_tiers(self, last_rank: int) -> tuple[EntryTier, ...]:
        """All four tiers, in order, using this contest's own configured
        boundaries -- defaults: Small 2-1,000 -> ranks 1-9; Mid
        1,000-5,000 -> 10-29; Large 5,000-100,000 -> 30-60; XL 100,000+
        -> 61-`last_rank`. Each tier's low bound is the previous tier's
        high bound, both in entries and in rank -- boundary entries
        sizes belong to the lower tier (`entry_tier`/`target_rank` below
        both rely on that). `last_rank` (the number of families Task
        20's `openings.rank_families` actually ranked) resolves XL's
        open "...-last" rank bound, since this config has no visibility
        into that count itself.
        """
        return (
            EntryTier("Small", 2, self.small_max_entries, 1, self.small_max_rank),
            EntryTier(
                "Mid", self.small_max_entries, self.mid_max_entries, self.small_max_rank + 1, self.mid_max_rank
            ),
            EntryTier(
                "Large", self.mid_max_entries, self.large_max_entries, self.mid_max_rank + 1, self.large_max_rank
            ),
            EntryTier("XL", self.large_max_entries, self.max_entries_scale, self.large_max_rank + 1, last_rank),
        )

    def entry_tier(self, last_rank: int) -> EntryTier:
        """This contest's own tier, by its `field_size` (boundary sizes
        belong to the lower tier).
        """
        tiers = self.entry_tiers(last_rank)
        for tier in tiers[:-1]:
            if self.field_size <= tier.high_entries:
                return tier
        return tiers[-1]

    def rank_tier(self, rank: int, last_rank: int) -> EntryTier:
        """Which tier `rank` nominally falls under, independent of this
        contest's own tier -- for tagging an off-tier pick in the CLI
        (e.g. "XL-style").
        """
        tiers = self.entry_tiers(last_rank)
        for tier in tiers[:-1]:
            if rank <= tier.high_rank:
                return tier
        return tiers[-1]

    def target_rank(self, last_rank: int) -> int:
        """Task 20's target-rank formula: round(low_rank + (ln(entries)
        - ln(tier_low)) / (ln(tier_high) - ln(tier_low)) * (high_rank -
        low_rank)), within this contest's own tier -- e.g. 2 entries ->
        rank 1 (Small's own low bound). 0 if nothing is ranked at all;
        otherwise clamped to [1, last_rank].
        """
        if last_rank <= 0:
            return 0
        tier = self.entry_tier(last_rank)
        if tier.high_entries <= tier.low_entries:
            return max(1, min(last_rank, tier.low_rank))
        fraction = (math.log(self.field_size) - math.log(tier.low_entries)) / (
            math.log(tier.high_entries) - math.log(tier.low_entries)
        )
        raw = tier.low_rank + fraction * (tier.high_rank - tier.low_rank)
        return max(1, min(last_rank, round(raw)))


def load_contest_config(path: str | Path) -> ContestConfig:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    return ContestConfig(
        cap=data.get("cap"),
        field_size=data["field_size"],
        payouts=[
            PayoutTier(rank=tier["rank"], amount=tier["amount"])
            for tier in data["payouts"]
        ],
        max_entries_scale=data.get("max_entries_scale", DEFAULT_MAX_ENTRIES_SCALE),
        small_max_entries=data.get("small_max_entries", DEFAULT_SMALL_MAX_ENTRIES),
        mid_max_entries=data.get("mid_max_entries", DEFAULT_MID_MAX_ENTRIES),
        large_max_entries=data.get("large_max_entries", DEFAULT_LARGE_MAX_ENTRIES),
        small_max_rank=data.get("small_max_rank", DEFAULT_SMALL_MAX_RANK),
        mid_max_rank=data.get("mid_max_rank", DEFAULT_MID_MAX_RANK),
        large_max_rank=data.get("large_max_rank", DEFAULT_LARGE_MAX_RANK),
    )
