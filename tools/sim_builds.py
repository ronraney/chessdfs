#!/usr/bin/env python3
"""One-time analysis script (Tasks 11b/11c): simulate 1,000 builds on the
real NFL ETR slate (data/samples), seeds 1-1000. White plays a uniformly
random legal move and a uniformly random eligible player; Black plays
exactly as `dfs_chess.build.play_black_move` already does. Read-only
analysis -- NOT part of the engine, and no engine code is changed to
support it.

Reports:
  1. How often a build gets stuck (a side to move with no legal move while
     White's lineup is still incomplete), split by side.
  2. For stuck builds: the ply it happened at, which roster slot(s) were
     still open for the stuck side, why (see below), and one full example
     move sequence.
  3. Black's salary: average total spent, and average salary per pick
     (pick 1..9, in the order Black actually locked them).

Task 11b found a real engine bug here: `play_black_move` could offer a
capturing book/free-play move whose captured-player transfer was actually
infeasible, which then raised an uncaught `ValueError` out of
`apply_capture` (reproduced at seeds 17/18 of the first 20). Task 11c fixed
it in `rules.is_legal_move` itself (checked before a capturing move is
ever offered to either side) -- see that function's docstring. This script
no longer needs to catch that `ValueError` around `play_black_move`; if one
ever did escape again, that would mean the fix regressed, so it's
deliberately left uncaught now rather than silently absorbed.

WHY-stuck classification (deliverable 2, Task 11c): for each roster slot
still open on the stuck side, looks at every real ETR player who could
fill it (by position) and classifies why none of them worked right now:
  - "board": none of those players' piece type has a legal chess move
    available at all (the position blocks it, independent of players).
  - "exclusivity": some do have a movable piece type, but every one is
    already locked (by either side).
  - "roster": unlocked, movable candidates exist, but adding any one of
    them (alone) still fails the roster/slot-assignment check.
  - "salary": unlocked, movable, slot-fitting candidates exist, but every
    one would exceed the remaining budget.
A single stuck build can hit more than one reason across its open slots.
This checks each candidate's OWN addition in isolation (not a capture's
further transfer, and not castling's King+Rook pairing) -- a deliberate
simplification for a diagnostic tool, not a re-derivation of is_legal_move.

REPRODUCIBILITY NOTE (found while writing up Task 11c, not fixed here --
it's a separate bug from the one this task asked for): `openings.
book_continuations` returns a `set[str]`, and `play_black_move` builds its
candidate list by iterating that set. Python
only guarantees string-keyed set/dict iteration order within a single
process -- it depends on `PYTHONHASHSEED`, which is randomized by default
on every interpreter start. So the *same* `random.Random(seed)` can still
produce a *different* build across separate `python` invocations, which
is a real gap against RULES.md's "randomness only through an injected
seed." Confirmed directly: seed 5 gave three different move sequences
across three plain `python -c` runs, but was identical across three runs
with `PYTHONHASHSEED=0`. Every number in this script's report was
generated with `PYTHONHASHSEED=0` for exactly this reason --
run it the same way to reproduce them:

Usage: PYTHONHASHSEED=0 python tools/sim_builds.py
"""
from __future__ import annotations

import random
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import chess

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from dfs_chess.build import is_build_over, play_black_move, san_history  # noqa: E402
from dfs_chess.config import load_contest_config  # noqa: E402
from dfs_chess.loaders import load_etr_csv, load_line_stats, load_opening_book  # noqa: E402
from dfs_chess.models import BuildState, Piece, Player, Side  # noqa: E402
from dfs_chess.openings import rank_families  # noqa: E402
from dfs_chess.pieces import classify, piece_for_chess_type  # noqa: E402
from dfs_chess.rules import apply_move, can_castle, castle, lineup_still_completable  # noqa: E402
from dfs_chess.sport import RosterSlot, load_sport_config  # noqa: E402

ETR_PATH = REPO_ROOT / "data" / "samples" / "NFL Weekly DFS System - Projections.csv"
CONTEST_PATH = REPO_ROOT / "config" / "contest.example.json"
SPORT_PATH = REPO_ROOT / "config" / "sports" / "nfl.json"
OPENINGS_DIR = REPO_ROOT / "data" / "openings"
LINE_STATS_PATH = OPENINGS_DIR / "line_stats.json"

NUM_BUILDS = 1000
MAX_PLIES = 100  # safety net; a real build always finishes or sticks well before this


@dataclass
class BuildOutcome:
    seed: int
    completed: bool
    stuck_side: str | None  # "WHITE" / "BLACK" / None (if completed)
    stuck_ply: int | None
    stuck_reasons: set[str] | None  # subset of {"board","exclusivity","roster","salary"}
    open_slots: dict[str, int] | None  # slot name -> instances still open, for the stuck side
    sans: tuple[str, ...]
    black_pick_salaries: list[int]  # in the order Black actually locked them


def _eligible_unlocked(piece, state, sport, players_pool):
    return [
        p for p in players_pool if p.id not in state.locked_player_ids and piece in classify(p, sport)
    ]


def _slot_open_counts(players, roster_slots: list[RosterSlot]) -> dict[str, int]:
    """How many instances of each roster slot are NOT filled by `players`.
    Same kind of bipartite matching as rules.max_assignable, reimplemented
    here (tool-local, read-only) because this analysis needs the *per-slot*
    assignment, not just the max total count rules.py exposes.
    """
    instances: list[RosterSlot] = []
    for slot in roster_slots:
        instances.extend([slot] * slot.count)
    occupant: list[int | None] = [None] * len(instances)

    def augment(player_idx: int, visited: set[int]) -> bool:
        positions = {p.upper() for p in players[player_idx].positions}
        for idx, slot in enumerate(instances):
            if idx in visited or not (slot.positions & positions):
                continue
            visited.add(idx)
            if occupant[idx] is None or augment(occupant[idx], visited):
                occupant[idx] = player_idx
                return True
        return False

    for i in range(len(players)):
        augment(i, set())

    open_counts: dict[str, int] = {}
    for idx, slot in enumerate(instances):
        if occupant[idx] is None:
            open_counts[slot.name] = open_counts.get(slot.name, 0) + 1
    return open_counts


def _why_stuck(
    side: Side, state: BuildState, sport, contest, players_pool: list[Player]
) -> set[str]:
    """Why the given (confirmed stuck) side has no move right now, per
    still-open roster slot -- see the module docstring for the four
    categories and the simplifications this makes.
    """
    current_players = [m.player for m in (state.white_moves if side is Side.WHITE else state.black_moves)]
    cap = contest.effective_cap(sport)
    open_slots = _slot_open_counts(current_players, sport.roster_slots)
    if not open_slots:
        return set()

    movable_pieces: set[Piece] = set()
    for move in state.board.legal_moves:
        if state.board.is_castling(move):
            if can_castle(state, side):
                movable_pieces.add(Piece.KING)
                movable_pieces.add(Piece.ROOK)
            continue
        movable_pieces.add(piece_for_chess_type(state.board.piece_type_at(move.from_square)))

    spent = sum(p.salary for p in current_players)
    reasons: set[str] = set()
    for slot_name in open_slots:
        slot = next(s for s in sport.roster_slots if s.name == slot_name)
        slot_candidates = [
            p for p in players_pool if slot.positions & {x.upper() for x in p.positions}
        ]
        movable_candidates = [p for p in slot_candidates if classify(p, sport) & movable_pieces]
        if not movable_candidates:
            reasons.add("board")
            continue

        unlocked = [p for p in movable_candidates if p.id not in state.locked_player_ids]
        if not unlocked:
            reasons.add("exclusivity")
            continue

        if any(lineup_still_completable(current_players + [p], sport, cap) for p in unlocked):
            continue  # this slot alone isn't the blocker; a different open slot must be

        salary_blocked = [p for p in unlocked if spent + p.salary > cap]
        if salary_blocked:
            reasons.add("salary")
        if len(salary_blocked) < len(unlocked):
            reasons.add("roster")  # some were affordable but still failed -> slot-assignment
    return reasons


def _white_turn(state, sport, contest, players_pool, rng):
    """One random White turn: tries every (legal move, eligible player)
    pair, in shuffled order, returning on the first that actually applies.
    Only reports stuck once truly nothing works -- not after one bad guess.
    """
    moves = list(state.board.legal_moves)
    rng.shuffle(moves)
    for move in moves:
        if state.board.is_castling(move):
            if not can_castle(state, Side.WHITE):
                continue
            kings = _eligible_unlocked(Piece.KING, state, sport, players_pool)
            rooks = _eligible_unlocked(Piece.ROOK, state, sport, players_pool)
            rng.shuffle(kings)
            rng.shuffle(rooks)
            for king in kings:
                for rook in rooks:
                    try:
                        return castle(state, move, king, rook, sport, contest), False
                    except ValueError:
                        continue
        else:
            piece = piece_for_chess_type(state.board.piece_type_at(move.from_square))
            candidates = _eligible_unlocked(piece, state, sport, players_pool)
            rng.shuffle(candidates)
            for player in candidates:
                try:
                    return apply_move(state, move, player, sport, contest), False
                except (ValueError, NotImplementedError):
                    continue
    return state, True


def run_one_build(seed: int, players_pool, sport, contest, book, family_ranks, target_rank) -> BuildOutcome:
    rng = random.Random(seed)
    state = BuildState()

    for ply in range(1, MAX_PLIES + 1):
        if state.board.turn == chess.WHITE:
            new_state, stuck = _white_turn(state, sport, contest, players_pool, rng)
            if stuck:
                return BuildOutcome(
                    seed,
                    False,
                    "WHITE",
                    ply,
                    _why_stuck(Side.WHITE, state, sport, contest, players_pool),
                    _slot_open_counts([m.player for m in state.white_moves], sport.roster_slots),
                    san_history(state.board),
                    [m.player.salary for m in state.black_moves],
                )
            state = new_state
            if is_build_over(state, sport):
                return BuildOutcome(
                    seed, True, None, None, None, None, san_history(state.board),
                    [m.player.salary for m in state.black_moves],
                )
        else:
            # Task 11c fixed the capture-transfer pre-check in
            # rules.is_legal_move, so play_black_move should only ever
            # raise the clean, intentional RuntimeError here -- a
            # ValueError escaping would mean that fix regressed, and is
            # deliberately left uncaught so this would fail loudly.
            try:
                result = play_black_move(state, book, family_ranks, target_rank, sport, contest, players_pool, rng)
            except RuntimeError:
                return BuildOutcome(
                    seed,
                    False,
                    "BLACK",
                    ply,
                    _why_stuck(Side.BLACK, state, sport, contest, players_pool),
                    _slot_open_counts([m.player for m in state.black_moves], sport.roster_slots),
                    san_history(state.board),
                    [m.player.salary for m in state.black_moves],
                )
            state = result.state

    raise RuntimeError(f"seed {seed}: build did not finish or get stuck within {MAX_PLIES} plies")


def _format_moves(sans: tuple[str, ...]) -> str:
    parts = []
    for i in range(0, len(sans), 2):
        num = i // 2 + 1
        white = sans[i]
        black = sans[i + 1] if i + 1 < len(sans) else None
        parts.append(f"{num}. {white}" + (f" {black}" if black else ""))
    return " ".join(parts)


def _report(outcomes: list[BuildOutcome]) -> None:
    total = len(outcomes)
    stuck = [o for o in outcomes if not o.completed]
    completed = [o for o in outcomes if o.completed]
    stuck_white = [o for o in stuck if o.stuck_side == "WHITE"]
    stuck_black = [o for o in stuck if o.stuck_side == "BLACK"]

    print(f"=== {total} builds simulated (seeds 1-{total}) ===\n")

    print("--- 1. Stuck-build frequency ---")
    print(f"Completed:                              {len(completed):4d}  ({len(completed) / total:5.1%})")
    print(f"Stuck -- White to move, no legal move:  {len(stuck_white):4d}  ({len(stuck_white) / total:5.1%})")
    print(f"Stuck -- Black to move, no legal move:  {len(stuck_black):4d}  ({len(stuck_black) / total:5.1%})")
    print()

    print("--- 2. Stuck-build detail ---")
    if not stuck:
        print("(no stuck builds)")
    else:
        ply_counts = Counter(o.stuck_ply for o in stuck)
        print("Stuck-at-ply distribution:", dict(sorted(ply_counts.items())))

        slot_counts: Counter = Counter()
        for o in stuck:
            slot_counts.update(o.open_slots)
        print("Open-slot frequency across stuck builds:", dict(slot_counts.most_common()))

        for label, group in (("White", stuck_white), ("Black", stuck_black)):
            if not group:
                continue
            reason_counts: Counter = Counter()
            for o in group:
                reason_counts.update(o.stuck_reasons)
            print(f"Why {label} got stuck (builds can hit more than one):", dict(reason_counts.most_common()))

        example = stuck[0]
        print(
            f"\nExample stuck build -- seed {example.seed}, "
            f"{example.stuck_side} stuck at ply {example.stuck_ply}:"
        )
        print(f"  Open slots for {example.stuck_side}: {example.open_slots}")
        print(f"  Why: {sorted(example.stuck_reasons)}")
        print(f"  Full move sequence: {_format_moves(example.sans)}")
    print()

    print("--- 3. Black's salary ---")
    totals = [sum(o.black_pick_salaries) for o in outcomes]
    print(f"Average total salary used by Black (all {total} builds): ${sum(totals) / len(totals):,.0f}")
    max_picks = max(len(o.black_pick_salaries) for o in outcomes)
    for i in range(max_picks):
        vals = [o.black_pick_salaries[i] for o in outcomes if len(o.black_pick_salaries) > i]
        print(f"  Pick {i + 1}: avg ${sum(vals) / len(vals):>8,.0f}   (n={len(vals)})")


def main() -> None:
    players_pool = load_etr_csv(ETR_PATH)
    contest = load_contest_config(CONTEST_PATH)
    sport = load_sport_config(SPORT_PATH)
    book = load_opening_book([OPENINGS_DIR / f"{letter}.tsv" for letter in "abcde"])
    try:
        ranked_families = rank_families(load_line_stats(LINE_STATS_PATH))
    except (OSError, ValueError, KeyError):
        ranked_families = []
    family_ranks = {family.name: family.rank for family in ranked_families}
    target_rank = contest.target_rank(len(ranked_families))

    outcomes = [
        run_one_build(seed, players_pool, sport, contest, book, family_ranks, target_rank)
        for seed in range(1, NUM_BUILDS + 1)
    ]
    _report(outcomes)


if __name__ == "__main__":
    main()
