"""Command-line runner. All I/O lives here; the engine (build.py,
rules.py, openings.py, ...) stays pure.

Usage:
    python -m dfs_chess.cli --etr <projections.csv> --contest <contest.json> [--seed N]
"""
from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

import chess

from .build import (
    HAPPY_HUNTING,
    MoveResult,
    check_white_dead_end,
    is_build_over,
    move_is_completable,
    play_black_move,
    play_black_template_move,
    play_white_move,
    san_history,
)
from .config import ContestConfig, EntryTier, load_contest_config
from .loaders import load_etr_csv, load_line_stats, load_opening_book
from .models import BuildState, KingMode, Move, Piece, Player, Side
from .openings import (
    BookLine,
    RankedFamily,
    continuing_lines,
    find_opening_lines,
    opening_name,
    opening_preview,
    rank_families,
    split_family,
)
from .picklist import castle_qb_candidates, pick_list
from .pieces import classify, piece_for_chess_type
from .rules import captured_square, locked_qb_team, open_roster_slots, place_kings, push_silent_move, switch_king
from .sport import SportConfig, load_sport_config

RESTART_BUILD = object()  # sentinel: the user chose "start again" at the book-exit prompt

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SPORT_PATH = REPO_ROOT / "config" / "sports" / "nfl.json"
DEFAULT_OPENINGS_DIR = REPO_ROOT / "data" / "openings"


def _load_book() -> list[BookLine]:
    paths = sorted(DEFAULT_OPENINGS_DIR.glob("*.tsv"))
    return load_opening_book(paths)


def _load_line_stats() -> list[dict]:
    try:
        return load_line_stats(DEFAULT_OPENINGS_DIR / "line_stats.json")
    except (OSError, ValueError, KeyError):
        return []


def format_move_list(sans: tuple[str, ...]) -> str:
    if not sans:
        return "(no moves yet)"
    parts = []
    for i in range(0, len(sans), 2):
        move_num = i // 2 + 1
        white = sans[i]
        black = sans[i + 1] if i + 1 < len(sans) else None
        parts.append(f"{move_num}. {white}" + (f" {black}" if black else ""))
    return " ".join(parts)


def _describe_move(move: Move) -> str:
    return f"{move.piece.value.title()}: {move.player.name}"


def format_player_field_table(state: BuildState) -> str:
    rows = max(len(state.white_moves), len(state.black_moves))
    if rows == 0:
        return "(no picks yet)"
    header = f"{'Player':<28} | {'Field':<28}"
    lines = [header, "-" * len(header)]
    for i in range(rows):
        left = _describe_move(state.white_moves[i]) if i < len(state.white_moves) else ""
        right = _describe_move(state.black_moves[i]) if i < len(state.black_moves) else ""
        lines.append(f"{left:<28} | {right:<28}")
    return "\n".join(lines)


def remaining_salary(state: BuildState, sport: SportConfig, contest: ContestConfig, side: Side) -> int:
    moves = state.white_moves if side is Side.WHITE else state.black_moves
    spent = sum(m.player.salary for m in moves)
    return contest.effective_cap(sport) - spent


def proj_total(state: BuildState, side: Side) -> float:
    """Sum of `side`'s locked players' projections (Task 16) -- a
    capture moves a `Move` (and so its player's projection) from one
    side's list to the other's (`rules.apply_capture_move`), so this
    needs no special-casing for that: it just sums whichever list
    currently holds the player.
    """
    moves = state.white_moves if side is Side.WHITE else state.black_moves
    return sum(m.player.proj for m in moves)


def _side_stats(
    state: BuildState, sport: SportConfig, contest: ContestConfig, side: Side
) -> tuple[int, float, float, float]:
    """(remaining salary, average remaining per still-open roster slot --
    0 if none are open, core ownership sum, core projection total) for
    `side`, all per the per-turn salary/ownership/projection display
    (Task 13b, Task 16).
    """
    moves = state.white_moves if side is Side.WHITE else state.black_moves
    players = [m.player for m in moves]
    remaining = remaining_salary(state, sport, contest, side)
    open_count = sum(open_roster_slots(players, sport.roster_slots).values())
    avg = remaining / open_count if open_count else 0.0
    tier = contest.field_tier()
    ownership = sum(p.own_for(tier) for p in players)
    return remaining, avg, ownership, proj_total(state, side)


def format_salary_ownership_table(state: BuildState, sport: SportConfig, contest: ContestConfig) -> str:
    w_remaining, w_avg, w_own, w_proj = _side_stats(state, sport, contest, Side.WHITE)
    b_remaining, b_avg, b_own, b_proj = _side_stats(state, sport, contest, Side.BLACK)

    header = f"{'You':<34} | {'Field':<34}"
    lines = [header, "-" * len(header)]
    lines.append(
        f"{f'Salary rem: ${w_remaining:,} (avg ${w_avg:,.0f}/slot)':<34} | "
        f"{f'Salary rem: ${b_remaining:,} (avg ${b_avg:,.0f}/slot)':<34}"
    )
    lines.append(f"{f'Core ownership: {w_own * 100:.1f}%':<34} | {f'Core ownership: {b_own * 100:.1f}%':<34}")
    lines.append(f"{f'Core projection: {w_proj:.1f} pts':<34} | {f'Core projection: {b_proj:.1f} pts':<34}")
    return "\n".join(lines)


def _eligible_sorted(
    piece: Piece, state: BuildState, sport: SportConfig, contest: ContestConfig, players_pool: list[Player]
) -> list[Player]:
    """`piece`'s own pick list (RULES.md piece table: eligible, unlocked,
    roster/salary-feasible, sorted by its own metric, capped) for
    whichever side is currently on the move.
    """
    side = Side.WHITE if state.board.turn == chess.WHITE else Side.BLACK
    current = [m.player for m in (state.white_moves if side is Side.WHITE else state.black_moves)]
    qb_team = locked_qb_team(state, side)
    return pick_list(piece, players_pool, state.locked_player_ids, current, sport, contest, qb_team)


def _print_check_notice(state: BuildState) -> None:
    """Task 18: when the side to move is in check, a short notice above
    whatever comes next for it -- White's free-move/player-pick prompt
    (shown via `_print_turn_header`, below), or Black's own upcoming
    move (shown by a second call right before it's resolved, in
    `_run_one_build` -- Black has no interactive prompt of its own, but
    this is the analogous "about to move" moment for it).
    """
    if not state.board.is_check():
        return
    print("You're in check" if state.board.turn == chess.WHITE else "Black is in check")


def _print_turn_header(
    state: BuildState, sport: SportConfig, contest: ContestConfig, book: list[BookLine]
) -> None:
    print("\n" + "=" * 60)
    print(state.board)
    print()
    print("Moves:", format_move_list(san_history(state.board)))
    print()
    print(format_player_field_table(state))
    print()
    name = opening_name(san_history(state.board), book)
    print(f"Opening: {name or '(none yet)'}")
    print()
    print(format_salary_ownership_table(state, sport, contest))
    _print_check_notice(state)


PICK_LIST_PAGE_SIZE = 15


def _prompt_player_choice(
    candidates: list[Player],
    contest: ContestConfig,
    preview_base: float,
    label: str,
    input_func,
    allow_cancel: bool = True,
) -> Player | None:
    """Returns the chosen Player, or None if there were no candidates at
    all. With `allow_cancel` (free play), the user may also back out
    ('b') to re-enter the move instead -- that too returns None. In
    template mode (`allow_cancel=False`, Task 13b), there's no move to
    re-enter, so backing out just re-asks the same question instead of
    ending the template.

    `preview_base` is White's projection total *before* this specific
    pick (Task 16) -- each candidate row shows `preview_base + p.proj`,
    what the total would become if that candidate is the one locked.
    Callers pass the right base for compound picks: e.g. the RB half of
    an EMERGE-mode castle adds the just-chosen (not yet applied) QB's
    own projection on top of the pre-move total, and a QB-switch
    candidate list subtracts the outgoing QB's projection first, since
    that's a swap, not an addition.

    Shows PICK_LIST_PAGE_SIZE (15) candidates at a time, already sorted
    by projection by the caller (Task 18); 'm' reveals the next 15, 's'
    searches by name. Numbering stays stable across both -- it's always
    each candidate's fixed position in the one full sorted list, never
    reassigned per page or per search.
    """
    if not candidates:
        print(f"No eligible {label} players available for that move.")
        return None

    tier = contest.field_tier()
    numbered = list(enumerate(candidates, start=1))
    shown = 0

    def print_rows(rows: list[tuple[int, Player]]) -> None:
        for i, p in rows:
            own_pct = p.own_for(tier) * 100
            print(
                f"  {i}. {p.name} | {p.positions[0]} | {p.team} | "
                f"${p.salary:,} | {p.proj:.1f} pts | -> {preview_base + p.proj:.1f} total pts | {own_pct:.1f}% own"
            )

    def show_more() -> None:
        nonlocal shown
        page = numbered[shown : shown + PICK_LIST_PAGE_SIZE]
        if not page:
            print("No more players to show.")
            return
        print_rows(page)
        shown += len(page)

    print(f"\nEligible {label} players:")
    show_more()

    while True:
        options = []
        if shown < len(numbered):
            options.append("'m' for more")
        options.append("'s' to search by name")
        if allow_cancel:
            options.append("'b' to re-enter your move")
        prompt = f"Pick a {label} (number, {', '.join(options)}): "

        raw = input_func(prompt).strip()
        if allow_cancel and raw.lower() == "b":
            return None
        if raw.lower() == "m":
            show_more()
            continue
        if raw.lower() == "s":
            query = input_func("Search by name: ").strip().lower()
            matches = [(i, p) for i, p in numbered if query in p.name.lower()]
            if not matches:
                print("No matching players.")
            else:
                print_rows(matches)
            continue
        if raw.isdigit() and 1 <= int(raw) <= len(candidates):
            return candidates[int(raw) - 1]
        print("Not a valid choice -- try again.")


def _format_piece_sequence(pieces: tuple[Piece, ...]) -> str:
    """`pieces` (e.g. `openings.OpeningPreview.white_pieces`) as a
    display string, e.g. "Pawn, Knight, Bishop, Castle" (Task 17) --
    an adjacent (KING, ROOK) pair is exactly what a castling move adds
    (`openings.opening_preview`: "castling counts as one King pick then
    one Rook pick"), so it collapses to the single word "Castle" rather
    than reading as two separate picks; any other King or Rook entry
    (vanishingly rare in real opening-book lines, but not impossible)
    shows as itself.
    """
    labels: list[str] = []
    i = 0
    while i < len(pieces):
        if pieces[i] is Piece.KING and i + 1 < len(pieces) and pieces[i + 1] is Piece.ROOK:
            labels.append("Castle")
            i += 2
        else:
            labels.append(pieces[i].value.title())
            i += 1
    return ", ".join(labels)


_TIER_ORDER = ("Small", "Mid", "Large", "XL")


def _print_family_option(i: int | None, family: RankedFamily, tag: str | None, sport: SportConfig) -> None:
    """One setup-screen row for `family` -- numbered (`i`) in the main
    list, or unnumbered (`i=None`) for the standalone "Suggested
    opening" callout.
    """
    name, detail = split_family(family.line.name)
    suffix = f"  [{tag}]" if tag else ""
    prefix = f"  {i}. " if i is not None else "  "
    print(f"{prefix}{name}{suffix}")
    if detail:
        print(f"       {detail}")
    preview = opening_preview(family.line, sport)
    print(f"       {_format_piece_sequence(preview.white_pieces)}")


def _ordered_opening_rows(
    ranked_families: list[RankedFamily], contest: ContestConfig, own_tier: EntryTier, last_rank: int
) -> list[tuple[RankedFamily, str | None]]:
    """`ranked_families` ordered for the setup list (Task 20): `own_tier`
    (the contest's own) first, then the other three tiers in Small/Mid/
    Large/XL order, each by rank -- paired with a quiet tag (e.g.
    "XL-style") for every family NOT in `own_tier`, None for those that
    are.
    """
    by_tier: dict[str, list[RankedFamily]] = {name: [] for name in _TIER_ORDER}
    for family in ranked_families:
        by_tier[contest.rank_tier(family.rank, last_rank).name].append(family)

    order = [own_tier.name] + [name for name in _TIER_ORDER if name != own_tier.name]
    rows: list[tuple[RankedFamily, str | None]] = []
    for tier_name in order:
        tag = None if tier_name == own_tier.name else f"{tier_name}-style"
        rows.extend((family, tag) for family in by_tier[tier_name])
    return rows


def _prompt_opening_search(book: list[BookLine], input_func) -> BookLine | None:
    """The setup screen's 's' search (Task 20) -- across the WHOLE book,
    so it also finds a named variation (or an unranked family) that
    isn't itself in the ranked-family list. Returns the chosen line, or
    None if there were no matches, or the user backed out of the match
    list without picking one.
    """
    query = input_func("Search by name: ").strip()
    matches = find_opening_lines(query, book)
    if not matches:
        print("No matching openings.")
        return None
    print(f"\n{len(matches)} matching opening(s):")
    for i, line in enumerate(matches, start=1):
        name, detail = split_family(line.name)
        print(f"  {i}. {name}" + (f": {detail}" if detail else ""))
    while True:
        choice = input_func("Pick a number (or press Enter to go back): ").strip()
        if not choice:
            return None
        if choice.isdigit() and 1 <= int(choice) <= len(matches):
            return matches[int(choice) - 1]
        print("Not a valid number -- try again.")


def _prompt_for_opening_setup(
    line_stats: list[dict],
    book: list[BookLine],
    contest: ContestConfig,
    sport: SportConfig,
    rng: random.Random,
    input_func,
) -> BookLine | None:
    """The build's opening screen (Task 20, replacing Task 15's
    percentile scale): the contest's entry-size tier and its suggested
    opening (the ranked family at the contest's target rank) as the
    default -- pressing Enter accepts it. Below that, every ranked
    family, grouped by tier (the contest's own tier first), each with
    its representative line's piece-type sequence (Task 17), paged
    PICK_LIST_PAGE_SIZE at a time ('m' for more, 's' to search by name
    across the whole book -- so this also finds a named variation that
    isn't itself a ranked family), 'r' for a random ranked family from
    the contest's own tier, or 'p' to play your own opening. A family
    outside the contest's own tier shows a quiet tier tag (e.g.
    "XL-style"). Returns None for free play (also the only option when
    nothing is ranked at all -- there's nothing to suggest or list).
    """
    ranked_families = rank_families(line_stats)
    last_rank = len(ranked_families)

    if not ranked_families:
        print("     (Play your own opening)")
        while True:
            raw = input_func("'s' to search by name, or press Enter to play your own opening: ").strip()
            if not raw:
                return None
            if raw.lower() == "s":
                chosen = _prompt_opening_search(book, input_func)
                if chosen is not None:
                    return chosen
                continue
            print("Not a valid choice -- try again.")

    by_rank = {family.rank: family for family in ranked_families}
    tier = contest.entry_tier(last_rank)
    target = contest.target_rank(last_rank)
    suggestion = by_rank[target]

    print(f"\nContest tier: {tier.name} ({contest.field_size:,} entries)")
    print("Suggested opening:")
    _print_family_option(None, suggestion, None, sport)

    rows = _ordered_opening_rows(ranked_families, contest, tier, last_rank)
    numbered = list(enumerate(rows, start=1))
    shown = 0

    def print_rows(page: list[tuple[int, tuple[RankedFamily, str | None]]]) -> None:
        for i, (family, tag) in page:
            _print_family_option(i, family, tag, sport)

    def show_more() -> None:
        nonlocal shown
        page = numbered[shown : shown + PICK_LIST_PAGE_SIZE]
        if not page:
            print("No more openings to show.")
            return
        print_rows(page)
        shown += len(page)

    print("\nAll ranked openings:")
    show_more()
    print("     (Play your own opening)")

    own_tier_pool = [family for family in ranked_families if contest.rank_tier(family.rank, last_rank).name == tier.name]

    while True:
        options = []
        if shown < len(numbered):
            options.append("'m' for more")
        options.append("'s' to search by name")
        options.append("'r' for Random")
        prompt = (
            f"Pick a number, {', '.join(options)}, Enter to accept the suggestion, "
            "or 'p' to play your own opening: "
        )
        raw = input_func(prompt).strip()

        if not raw:
            return suggestion.line
        if raw.lower() == "p":
            return None
        if raw.lower() == "m":
            show_more()
            continue
        if raw.lower() in ("r", "random"):
            pool = own_tier_pool or ranked_families
            return rng.choice(pool).line
        if raw.lower() == "s":
            chosen = _prompt_opening_search(book, input_func)
            if chosen is not None:
                return chosen
            continue
        if raw.isdigit() and 1 <= int(raw) <= len(rows):
            return rows[int(raw) - 1][0].line
        print("Not a valid choice -- try again.")


def _prompt_for_king_mode(input_func) -> KingMode:
    """The very first setup screen (RULES.md "King modes"), before the
    opening is even chosen: let the King emerge naturally (today's
    behavior), or place White's QB now. Blank defaults to "emerge".
    """
    print("\nKing mode: let your King emerge naturally, or place your QB now?")
    while True:
        raw = input_func("('emerge'/'place', blank for emerge): ").strip().lower()
        if raw in ("", "emerge", "e"):
            return KingMode.EMERGE
        if raw in ("place", "placed", "p"):
            return KingMode.PLACED
        print("Please answer 'emerge' or 'place'.")


def _prompt_and_place_kings(
    players_pool: list[Player], sport: SportConfig, contest: ContestConfig, input_func
) -> BuildState:
    """Task 14 "Place your King now": the user picks White's QB (sorted
    by projection, with salary and ownership -- same listing every other
    player pick uses) before move 1; Black's QB is the current
    placeholder (highest projection, excluding White's). Both lock
    immediately, no chess move involved.
    """
    print("\nPlace your King now -- pick White's QB:")
    qbs = sorted(
        (p for p in players_pool if Piece.KING in classify(p, sport)), key=lambda p: p.proj, reverse=True
    )
    white_king = _prompt_player_choice(qbs, contest, 0.0, "QB", input_func, allow_cancel=False)
    black_king = next(p for p in qbs if p.id != white_king.id)
    return place_kings(white_king, black_king, sport, contest)


def _offer_king_switch(
    state: BuildState, sport: SportConfig, contest: ContestConfig, players_pool: list[Player], input_func
) -> BuildState:
    """Task 14: right after White castles in PLACED king mode, a
    one-time "Switch your QB?" offer -- declining ('b') or an infeasible
    pick leaves the original QB in place.
    """
    current_king = next(m.player for m in state.white_moves if m.piece is Piece.KING)
    candidates = sorted(
        (p for p in players_pool if p.id not in state.locked_player_ids and Piece.KING in classify(p, sport)),
        key=lambda p: p.proj,
        reverse=True,
    )
    print(
        f"\nSwitch your QB? Currently locked: {current_king.name} | "
        f"${current_king.salary:,} | {current_king.proj:.1f} pts"
    )
    # A swap, not an addition -- the outgoing King's own projection comes
    # back out of the base first, so each candidate's preview is what the
    # total would become with THAT King instead of the current one.
    preview_base = proj_total(state, Side.WHITE) - current_king.proj
    new_king = _prompt_player_choice(candidates, contest, preview_base, "QB", input_func)
    if new_king is None:
        return state
    new_state = switch_king(state, Side.WHITE, new_king, sport, contest)
    if new_state is None:
        print(f"{new_king.name} doesn't fit -- keeping {current_king.name}.")
        return state
    print(f"Switched to {new_king.name}.")
    return new_state


def _play_castling_move(
    state: BuildState,
    chess_move: chess.Move,
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
    book: list[BookLine],
    king_mode: KingMode,
    input_func,
    allow_cancel: bool,
) -> MoveResult | None:
    """Shared castling handler for both template and free-play White
    turns. EMERGE mode: prompts for QB then RB (King + Rook locked
    together) -- only QBs with at least one eligible teammate are
    offered (RULES.md: "If none, castling is illegal"). PLACED mode
    (Task 14): the King is already locked, so this offers the one-time
    "Switch your QB?" FIRST, then prompts for RB from the final QB's
    teammates (RULES.md: the Rook must be a teammate of whichever QB
    ends up locked, so the switch has to be resolved before the Rook
    pick, not after). Returns None on any decline/infeasibility, same
    convention the callers already use.
    """
    base = proj_total(state, Side.WHITE)
    if king_mode is KingMode.EMERGE:
        qb_candidates = castle_qb_candidates(
            players_pool, state.locked_player_ids, [m.player for m in state.white_moves], sport, contest
        )
        qb = _prompt_player_choice(qb_candidates, contest, base, "QB", input_func, allow_cancel)
        if qb is None:
            return None
        base += qb.proj  # King + Rook lock together -- the RB preview builds on top of this move's own QB too
        rb_candidates = pick_list(
            Piece.ROOK,
            players_pool,
            state.locked_player_ids | {qb.id},
            [m.player for m in state.white_moves] + [qb],
            sport,
            contest,
            qb.team,
        )
    else:
        state = _offer_king_switch(state, sport, contest, players_pool, input_func)
        qb = next(m.player for m in state.white_moves if m.piece is Piece.KING)  # ignored by play_white_move
        rb_candidates = pick_list(
            Piece.ROOK, players_pool, state.locked_player_ids, [m.player for m in state.white_moves], sport, contest, qb.team
        )

    rb = _prompt_player_choice(rb_candidates, contest, base, "RB", input_func, allow_cancel)
    if rb is None:
        return None

    try:
        return play_white_move(state, chess_move, qb, sport, contest, book, white_rook=rb, king_mode=king_mode)
    except ValueError:
        return None


def _play_capture_move(
    state: BuildState,
    chess_move: chess.Move,
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
    book: list[BookLine],
    input_func,
    allow_cancel: bool,
) -> MoveResult | None:
    """Shared capture handler for both template and free-play White
    turns. If the captured piece has lock history, the captured player
    IS the pick -- no prompt at all (`play_white_move`/`apply_capture_
    move` transfer them if they fit White's roster, or return them to
    the pool, locking no one, if they don't -- RULES.md "Captures").
    If it never moved, there's no player to transfer: with at least one
    eligible, unlocked player of the captured piece's own real chess
    type (e.g. an unmoved pawn -> a Pawn pick), the capturing side picks
    one via the same pick list (and message) every other pick uses;
    with none, the capture still happens and locks no one. Returns None
    only if the user backs out of that prompt (free play) -- any
    ValueError from actually applying the move propagates to the
    caller, same as every other pick, so each caller's own existing
    error handling still applies.
    """
    square = captured_square(state.board, chess_move)
    if state.piece_locks.get(square):
        return play_white_move(state, chess_move, None, sport, contest, book)

    captured_type = piece_for_chess_type(state.board.piece_type_at(square))
    candidates = _eligible_sorted(captured_type, state, sport, contest, players_pool)
    if not candidates:
        print(
            f"\nYou play {state.board.san(chess_move)}, capturing an unmoved "
            f"{captured_type.value.lower()}. No eligible {captured_type.value.title()} fits -- locks no player."
        )
        return play_white_move(state, chess_move, None, sport, contest, book)

    print(
        f"\nYou play {state.board.san(chess_move)}, capturing an unmoved "
        f"{captured_type.value.lower()}: pick a {captured_type.value.title()}."
    )
    player = _prompt_player_choice(
        candidates,
        contest,
        proj_total(state, Side.WHITE),
        captured_type.value.title(),
        input_func,
        allow_cancel,
    )
    if player is None:
        return None
    return play_white_move(state, chess_move, player, sport, contest, book)


def _play_silent_king_move(
    state: BuildState, chess_move: chess.Move, sport: SportConfig, book: list[BookLine]
) -> MoveResult:
    """A plain (non-castling) King move in PLACED king mode (Task 14):
    "later King moves lock no player" -- pushes it silently and reports
    the resulting opening/ending exactly like any other move.
    """
    new_state = push_silent_move(state, chess_move)
    opening = opening_name(san_history(new_state.board), book)
    message = HAPPY_HUNTING if is_build_over(new_state, sport) else None
    return MoveResult(new_state, opening, message)


def _prompt_book_exit(input_func) -> object | None:
    """Task 13b: no book continuation remains for White at all. Returns
    RESTART_BUILD if the user wants a brand new build, or None to
    continue with free play.
    """
    print("\nThere is no longer an opening line. Would you like to continue, or start again?")
    while True:
        raw = input_func("(continue/again): ").strip().lower()
        if raw in ("continue", "c"):
            return None
        if raw in ("again", "start again", "restart", "r"):
            return RESTART_BUILD
        print("Please answer 'continue' or 'start again'.")


def _prompt_for_continuation(
    state: BuildState,
    moves_so_far: tuple[str, ...],
    book: list[BookLine],
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
    input_func,
    king_mode: KingMode = KingMode.EMERGE,
) -> BookLine | object | None:
    """Offered once a template ends mid-build (RULES.md "Opening
    templates"): a numbered list of named lines that still continue from
    here AND keep White's lineup completable (Task 13b -- same
    feasibility check Black's own book choices already use), or a free
    move. Returns the chosen line to start a new template from, RESTART_
    BUILD if the user wants a fresh build (Task 13b's book-exit prompt,
    offered only when nothing at all qualifies), or None for a free move.
    """
    depth = len(moves_so_far)
    matches = [
        line
        for line in continuing_lines(moves_so_far, book)
        if move_is_completable(
            state, state.board.parse_san(line.moves[depth]), sport, contest, players_pool, king_mode
        )
    ]
    if not matches:
        return _prompt_book_exit(input_func)

    print(f"\n{len(matches)} opening continuation(s) from here:")
    for i, line in enumerate(matches, start=1):
        print(f"  {i}. {line.name} ({line.moves[depth]}...)")
    while True:
        choice = input_func("Pick a number (or press Enter for a free move): ").strip()
        if not choice:
            return None
        if choice.isdigit() and 1 <= int(choice) <= len(matches):
            return matches[int(choice) - 1]
        print("Not a valid number -- try again.")


def _play_white_template_move(
    state: BuildState,
    chess_move: chess.Move,
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
    book: list[BookLine],
    input_func,
    king_mode: KingMode = KingMode.EMERGE,
) -> MoveResult | None:
    """Applies the active template's prescribed White move, prompting
    only for which eligible player to lock (the move itself is fixed).
    Backing out ('b') just re-asks the same question (Task 13b) -- it no
    longer ends the template; `_prompt_player_choice` only returns None
    here when no eligible player exists at all, which does end the
    template (RULES.md "Opening templates": "its next move is illegal
    under the DFS rules") -- same for a chosen player who turns out
    illegal once applied. A plain King move in PLACED king mode
    (Task 14) always succeeds, locking no one.
    """
    if state.board.is_castling(chess_move):
        return _play_castling_move(
            state, chess_move, sport, contest, players_pool, book, king_mode, input_func, allow_cancel=False
        )

    if state.board.is_capture(chess_move):
        try:
            return _play_capture_move(
                state, chess_move, sport, contest, players_pool, book, input_func, allow_cancel=False
            )
        except ValueError:
            return None

    piece = piece_for_chess_type(state.board.piece_type_at(chess_move.from_square))
    if king_mode is KingMode.PLACED and piece is Piece.KING:
        return _play_silent_king_move(state, chess_move, sport, book)

    player = _prompt_player_choice(
        _eligible_sorted(piece, state, sport, contest, players_pool),
        contest,
        proj_total(state, Side.WHITE),
        piece.value.title(),
        input_func,
        allow_cancel=False,
    )
    if player is None:
        return None
    try:
        return play_white_move(state, chess_move, player, sport, contest, book)
    except ValueError:
        return None


def _play_white_free_turn(
    state: BuildState,
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
    book: list[BookLine],
    input_func,
    king_mode: KingMode = KingMode.EMERGE,
) -> MoveResult:
    """Today's free-move flow: raw SAN entry, then a player pick for
    whatever piece band it requires -- retries on anything illegal until
    a move actually goes through. Also accepts 'stop' (Task 13b: once
    past the book, the user may end the build at any point with their
    current core -- same ending as a completed lineup, "Happy Hunting",
    just with whatever's locked so far). A plain King move in PLACED
    king mode (Task 14) always succeeds, locking no one.
    """
    while True:
        move_text = input_func("\nYour move (SAN), or 'stop' to end with your current core: ").strip()
        if not move_text:
            continue
        if move_text.lower() == "stop":
            opening = opening_name(san_history(state.board), book)
            return MoveResult(state, opening, HAPPY_HUNTING)

        try:
            chess_move = state.board.parse_san(move_text)
        except ValueError as e:
            print(f"Illegal move: {e}")
            continue

        try:
            if state.board.is_castling(chess_move):
                result = _play_castling_move(
                    state, chess_move, sport, contest, players_pool, book, king_mode, input_func, allow_cancel=True
                )
                if result is None:
                    continue
                return result

            if state.board.is_capture(chess_move):
                result = _play_capture_move(
                    state, chess_move, sport, contest, players_pool, book, input_func, allow_cancel=True
                )
                if result is None:
                    continue
                return result

            piece = piece_for_chess_type(state.board.piece_type_at(chess_move.from_square))
            if king_mode is KingMode.PLACED and piece is Piece.KING:
                return _play_silent_king_move(state, chess_move, sport, book)

            player = _prompt_player_choice(
                _eligible_sorted(piece, state, sport, contest, players_pool),
                contest,
                proj_total(state, Side.WHITE),
                piece.value.title(),
                input_func,
            )
            if player is None:
                continue
            return play_white_move(state, chess_move, player, sport, contest, book)
        except (ValueError, NotImplementedError) as e:
            print(f"Illegal pick: {e}")
            continue


def _print_ending(state: BuildState, contest: ContestConfig) -> None:
    print(f"\n{HAPPY_HUNTING}\n")
    print("Your final lineup:")
    total_salary = 0
    total_proj = 0.0
    for m in state.white_moves:
        p = m.player
        print(f"  {m.piece.value.title():<8} {p.name:<24} {p.positions[0]:<4} ${p.salary:>6,} {p.proj:>6.1f} pts")
        total_salary += p.salary
        total_proj += p.proj
    print(f"\nTotal salary: ${total_salary:,}")
    print(f"Total projection: {total_proj:.1f} pts")


def _print_dead_end(side: Side, open_slots: dict[str, int]) -> None:
    """Task 13b: a single dead-end ending for either side (replaces the
    old White-only message and Black's uncaught RuntimeError crash).
    """
    print("\nBlack has hit a dead end." if side is Side.BLACK else "\nYou have hit a dead end.")
    print("The build process is done. Happy Hunting.")
    if open_slots:
        slots = ", ".join(f"{name} x{count}" for name, count in open_slots.items())
        print(f"Open slots: {slots}")


def _capture_message(pre_state: BuildState, post_state: BuildState, side: Side) -> str | None:
    """If the move that took `pre_state` to `post_state` was a capture
    of a piece WITH lock history, the message for it: who was captured
    and from whom, e.g. "Black plays exd4, capturing your Malik
    Washington." -- or, if transferring them would have overflowed the
    capturing side's roster, that they returned to the pool instead
    (RULES.md "Captures"), e.g. "exd4: Malik Washington (RB) doesn't
    fit your roster. He returns to the pool." None if it wasn't a
    capture, no move was made at all (a book-exit/continuation step
    between turns), or the captured piece never moved -- that pick was
    never on either side's roster to begin with, so it isn't a transfer
    "from" anyone; White's own pick-prompt message already covers it,
    and Black's falls through to the plain "locking" announcement below
    instead.
    """
    if len(post_state.board.move_stack) <= len(pre_state.board.move_stack):
        return None
    last_move = post_state.board.move_stack[-1]
    if not pre_state.board.is_capture(last_move):
        return None
    captured_history = pre_state.piece_locks.get(captured_square(pre_state.board, last_move))
    if not captured_history:
        return None

    captured = captured_history[-1]
    san = pre_state.board.san(last_move)
    moves = post_state.white_moves if side is Side.WHITE else post_state.black_moves
    transferred = any(m.player.id == captured.id for m in moves)
    if not transferred:
        whose_roster = "your" if side is Side.WHITE else "the Field's"
        return f"{san}: {captured.name} ({captured.positions[0]}) doesn't fit {whose_roster} roster. He returns to the pool."
    if side is Side.WHITE:
        return f"You play {san}, capturing the Field's {captured.name}."
    return f"Black plays {san}, capturing your {captured.name}."


class _RestartBuild(Exception):
    """Internal control-flow signal: the user chose "start again" at the
    book-exit prompt (Task 13b) -- caught by `run`'s outer loop.
    """


def run(
    etr_path: Path,
    contest_path: Path,
    seed: int | None,
    input_func=input,
) -> None:
    players_pool = load_etr_csv(etr_path)
    contest = load_contest_config(contest_path)
    sport = load_sport_config(DEFAULT_SPORT_PATH)
    book = _load_book()
    line_stats = _load_line_stats()

    current_seed = seed if seed is not None else random.SystemRandom().randrange(2**32)

    while True:
        try:
            _run_one_build(players_pool, contest, sport, book, line_stats, current_seed, input_func)
            return
        except _RestartBuild:
            # Task 14: "start again" uses a fresh seed -- with an
            # explicit --seed N, N+1, N+2, ... per restart.
            current_seed += 1
            continue


def _run_one_build(
    players_pool: list[Player],
    contest: ContestConfig,
    sport: SportConfig,
    book: list[BookLine],
    line_stats: list[dict],
    seed: int,
    input_func,
) -> None:
    print(f"Seed: {seed}")
    rng = random.Random(seed)
    ranked_families = rank_families(line_stats)
    family_ranks = {family.name: family.rank for family in ranked_families}
    target_rank = contest.target_rank(len(ranked_families))

    # RULES.md "King modes": chosen at setup, before the opening.
    king_mode = _prompt_for_king_mode(input_func)
    state = (
        _prompt_and_place_kings(players_pool, sport, contest, input_func)
        if king_mode is KingMode.PLACED
        else BuildState()
    )
    # The template currently governing both sides' moves (RULES.md
    # "Opening templates"), None once it's ended/never started -- in
    # which case `offer_continuation` means White should be offered a
    # new named continuation from here before falling to a free move.
    active_template: BookLine | None = _prompt_for_opening_setup(line_stats, book, contest, sport, rng, input_func)
    offer_continuation = False

    while True:
        _print_turn_header(state, sport, contest, book)

        dead_end = check_white_dead_end(state, sport, contest, players_pool, king_mode)
        if dead_end is not None:
            _print_dead_end(Side.WHITE, dead_end.open_slots)
            return

        pre_white_state = state
        result: MoveResult | None = None
        while result is None:
            depth = len(san_history(state.board))
            if active_template is not None and depth >= len(active_template.moves):
                active_template = None
                offer_continuation = True

            if active_template is not None:
                chess_move = state.board.parse_san(active_template.moves[depth])
                result = _play_white_template_move(
                    state, chess_move, sport, contest, players_pool, book, input_func, king_mode
                )
                if result is None:
                    active_template = None
                    offer_continuation = True
                continue

            if offer_continuation:
                offer_continuation = False
                print("\nThe opening template has ended.")
                chosen = _prompt_for_continuation(
                    state, san_history(state.board), book, sport, contest, players_pool, input_func, king_mode
                )
                if chosen is RESTART_BUILD:
                    raise _RestartBuild()
                if chosen is not None:
                    active_template = chosen
                    continue

            result = _play_white_free_turn(state, sport, contest, players_pool, book, input_func, king_mode)

        state = result.state
        capture_msg = _capture_message(pre_white_state, state, Side.WHITE)
        if capture_msg:
            print(f"\n{capture_msg}")
        if result.message == HAPPY_HUNTING:
            _print_ending(state, contest)
            return

        black_depth = len(san_history(state.board))
        if active_template is not None and black_depth >= len(active_template.moves):
            active_template = None
            offer_continuation = True

        pre_black_state = state
        _print_check_notice(state)  # Black, now to move, may be in check from White's last move

        black_result = None
        if active_template is not None:
            black_chess_move = state.board.parse_san(active_template.moves[black_depth])
            black_result = play_black_template_move(
                state, black_chess_move, sport, contest, players_pool, book, king_mode
            )
            if black_result is None:
                active_template = None
                offer_continuation = True
        if black_result is None:
            try:
                black_result = play_black_move(
                    state, book, family_ranks, target_rank, sport, contest, players_pool, rng, king_mode
                )
            except RuntimeError:
                open_slots = open_roster_slots([m.player for m in state.white_moves], sport.roster_slots)
                _print_dead_end(Side.BLACK, open_slots)
                return

        state = black_result.state
        black_capture_msg = _capture_message(pre_black_state, state, Side.BLACK)
        if black_capture_msg:
            print(f"\n{black_capture_msg}")
        else:
            black_move = state.black_moves[-1]
            print(
                f"\nBlack plays {black_move.san}, locking {black_move.player.name} "
                f"({black_move.piece.value.title()})"
            )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m dfs_chess.cli")
    parser.add_argument("--etr", required=True, type=Path, help="ETR projections CSV")
    parser.add_argument("--contest", required=True, type=Path, help="Contest config JSON")
    parser.add_argument("--seed", type=int, default=None, help="Random seed for Black's play")
    args = parser.parse_args(argv)

    try:
        run(args.etr, args.contest, args.seed)
    except (EOFError, KeyboardInterrupt):
        print("\nExiting.")
    except OSError as e:
        print(f"Could not read a required file: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
