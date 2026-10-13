#!/usr/bin/env python3
"""Task 11f: list every build (seeds 1-1000) where Black had no legal
move, for two White-move strategies. Read-only analysis -- NOT part of
the engine, no engine code changed. Reuses tools/sim_builds.py's helpers
(_eligible_unlocked, _slot_open_counts, _why_stuck, _white_turn,
_format_moves) rather than duplicating them.

Run A: White plays uniformly random legal (move, player) pairs -- the
exact same strategy as tools/sim_builds.py.

Run B: White follows a single book line, chosen uniformly at random
(via the per-seed rng) from the loaded book, playing that line's White
moves in order. If the line's next White move is ever illegal on the
actual board, or has no resolvable player, or the line runs out of
White moves, the line ends for the rest of that build and White falls
back to Run A's free/random play from then on (it never resumes).

For each build where Black ends up with no legal move, reports: seed,
full move list (standard notation), the opening name `openings.
opening_name` reports for the position Black got stuck in, why (board /
exclusivity / roster / salary -- a build can hit more than one), Black's
still-open roster slots, and Black's remaining salary (effective cap
minus what Black has spent so far).

REPRODUCIBILITY: same PYTHONHASHSEED=0 requirement as sim_builds.py --
see that module's docstring. Run with:
  PYTHONHASHSEED=0 python tools/task11f_black_stuck.py
"""
from __future__ import annotations

import random
import sys
from dataclasses import dataclass
from pathlib import Path

import chess

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dfs_chess.build import is_build_over, play_black_move, san_history  # noqa: E402
from dfs_chess.config import load_contest_config  # noqa: E402
from dfs_chess.loaders import load_etr_csv, load_line_stats, load_opening_book  # noqa: E402
from dfs_chess.models import BuildState, Piece, Side  # noqa: E402
from dfs_chess.openings import BookLine, opening_name, rank_families  # noqa: E402
from dfs_chess.pieces import piece_for_chess_type  # noqa: E402
from dfs_chess.rules import apply_move, can_castle, castle  # noqa: E402
from sim_builds import (  # noqa: E402
    CONTEST_PATH,
    ETR_PATH,
    LINE_STATS_PATH,
    MAX_PLIES,
    NUM_BUILDS,
    OPENINGS_DIR,
    SPORT_PATH,
    _eligible_unlocked,
    _format_moves,
    _slot_open_counts,
    _white_turn,
    _why_stuck,
)
from dfs_chess.sport import load_sport_config  # noqa: E402


@dataclass
class BlackStuckCase:
    seed: int
    sans: tuple[str, ...]
    opening: str | None
    reasons: tuple[str, ...]
    open_slots: dict[str, int]
    remaining_salary: int


def _black_remaining_salary(state: BuildState, sport, contest) -> int:
    spent = sum(m.player.salary for m in state.black_moves)
    return contest.effective_cap(sport) - spent


def _try_book_white_move(state, sport, contest, players_pool, rng, san):
    """Attempt one specific SAN as White's move: legal on the current
    board, and a player resolves for it. Returns (new_state, True) on
    success, (None, False) otherwise -- the caller treats failure as
    "the book line ends here."
    """
    try:
        move = state.board.parse_san(san)
    except ValueError:
        return None, False

    if state.board.is_castling(move):
        if not can_castle(state, Side.WHITE):
            return None, False
        kings = _eligible_unlocked(Piece.KING, state, sport, players_pool)
        rooks = _eligible_unlocked(Piece.ROOK, state, sport, players_pool)
        rng.shuffle(kings)
        rng.shuffle(rooks)
        for king in kings:
            for rook in rooks:
                try:
                    return castle(state, move, king, rook, sport, contest), True
                except ValueError:
                    continue
        return None, False

    piece = piece_for_chess_type(state.board.piece_type_at(move.from_square))
    candidates = _eligible_unlocked(piece, state, sport, players_pool)
    rng.shuffle(candidates)
    for player in candidates:
        try:
            return apply_move(state, move, player, sport, contest), True
        except (ValueError, NotImplementedError):
            continue
    return None, False


def run_one_build_bookline(seed, players_pool, sport, contest, book, family_ranks, target_rank):
    """Same build loop as sim_builds.run_one_build, except White follows
    a randomly chosen book line's White moves for as long as that keeps
    working (see module docstring), instead of always playing randomly.
    Returns a BlackStuckCase if Black got stuck, else None.
    """
    rng = random.Random(seed)
    state = BuildState()
    line: BookLine = rng.choice(book)
    in_book = True
    white_book_plies_used = 0  # count of this line's White moves played so far

    for _ply in range(1, MAX_PLIES + 1):
        if state.board.turn == chess.WHITE:
            new_state = None
            stuck = False
            used_book = False
            if in_book:
                book_index = 2 * white_book_plies_used
                if book_index < len(line.moves):
                    new_state, used_book = _try_book_white_move(
                        state, sport, contest, players_pool, rng, line.moves[book_index]
                    )
            if used_book:
                white_book_plies_used += 1
            else:
                in_book = False
                new_state, stuck = _white_turn(state, sport, contest, players_pool, rng)
            if stuck:
                return None  # White stuck -- not what this task is after
            state = new_state
            if is_build_over(state, sport):
                return None
        else:
            try:
                result = play_black_move(state, book, family_ranks, target_rank, sport, contest, players_pool, rng)
            except RuntimeError:
                return BlackStuckCase(
                    seed,
                    san_history(state.board),
                    opening_name(san_history(state.board), book),
                    tuple(sorted(_why_stuck(Side.BLACK, state, sport, contest, players_pool))),
                    _slot_open_counts([m.player for m in state.black_moves], sport.roster_slots),
                    _black_remaining_salary(state, sport, contest),
                )
            state = result.state

    raise RuntimeError(f"seed {seed}: build did not finish or get stuck within {MAX_PLIES} plies")


def run_one_build_random_white(seed, players_pool, sport, contest, book, family_ranks, target_rank):
    """Same as sim_builds.run_one_build, but returns only a
    BlackStuckCase (or None) -- White-stuck and completed builds aren't
    this task's deliverable.
    """
    rng = random.Random(seed)
    state = BuildState()

    for _ply in range(1, MAX_PLIES + 1):
        if state.board.turn == chess.WHITE:
            new_state, stuck = _white_turn(state, sport, contest, players_pool, rng)
            if stuck:
                return None
            state = new_state
            if is_build_over(state, sport):
                return None
        else:
            try:
                result = play_black_move(state, book, family_ranks, target_rank, sport, contest, players_pool, rng)
            except RuntimeError:
                return BlackStuckCase(
                    seed,
                    san_history(state.board),
                    opening_name(san_history(state.board), book),
                    tuple(sorted(_why_stuck(Side.BLACK, state, sport, contest, players_pool))),
                    _slot_open_counts([m.player for m in state.black_moves], sport.roster_slots),
                    _black_remaining_salary(state, sport, contest),
                )
            state = result.state

    raise RuntimeError(f"seed {seed}: build did not finish or get stuck within {MAX_PLIES} plies")


def _report(label: str, cases: list[BlackStuckCase]) -> None:
    print(f"=== {label}: {len(cases)} Black-stuck build(s) out of {NUM_BUILDS} (seeds 1-{NUM_BUILDS}) ===\n")
    if not cases:
        print("(none)\n")
        return

    def group_key(case: BlackStuckCase):
        return (0 if "board" in case.reasons else 1, case.reasons)

    for case in sorted(cases, key=lambda c: group_key(c) + (c.seed,)):
        print(f"--- seed {case.seed} -- cause: {', '.join(case.reasons)} ---")
        print(f"  Opening: {case.opening or '(none -- out of book)'}")
        print(f"  Black open slots: {case.open_slots}")
        print(f"  Black remaining salary: ${case.remaining_salary:,}")
        print(f"  Moves: {_format_moves(case.sans)}")
        print()


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

    run_a = [
        run_one_build_random_white(seed, players_pool, sport, contest, book, family_ranks, target_rank)
        for seed in range(1, NUM_BUILDS + 1)
    ]
    _report("Run A -- White plays random legal moves", [c for c in run_a if c is not None])

    run_b = [
        run_one_build_bookline(seed, players_pool, sport, contest, book, family_ranks, target_rank)
        for seed in range(1, NUM_BUILDS + 1)
    ]
    _report("Run B -- White follows a random book line, then free play", [c for c in run_b if c is not None])


if __name__ == "__main__":
    main()
