"""Turn flow: White's move always comes from the caller; Black's is
generated here. Randomness only ever flows through an injected
`random.Random` -- nothing in this module touches the global `random`
module state.

The build ends when White's lineup is complete (RULES.md), regardless of
Black's. Black's lineup must always stay completable (enforced per-move,
same as White's, via `rules.is_legal_move`/`lineup_still_completable`) but
need not be finished. Once Black's lineup IS full, Black's board moves
lock no player (RULES.md) -- see `push_silent_move` below.

Outside an explicit template (RULES.md "Opening templates"), Black
commits to one full book line at a time -- among every line matching
the moves so far, the one whose family (`openings.split_family`'s first
element) rank is closest to the contest's target rank (Task 20:
`openings.rank_families`, `ContestConfig.target_rank()` -- an unranked
family counts as farthest), ties broken by a seeded random choice --
and plays that line exactly for as long as it keeps matching (see
`play_black_move`, `BuildState.black_committed_line`). Once no book
line matches, or there's nothing
left to commit to, Black plays any legal move, chosen uniformly. A
capture is its own category now (Task 18): the captured player IS the
move's pick. If the captured piece has no lock history -- it never
moved -- there's nothing to transfer, so Black instead picks the same
TEMPORARY placeholder (highest `proj` among legal, unlocked candidates)
of that piece's own real chess type, same as any other pick (Task 19);
a candidate move resolves to None (same as any other unplayable move)
only when no such player exists. Once Black's lineup is full, captures
and castling are excluded outright too, since both inherently lock a
player and Black isn't drafting anymore.

Black's PLAYER pick within whichever piece band a (non-silent) move
requires is a TEMPORARY PLACEHOLDER -- highest `proj` among legal,
unlocked candidates -- until the Monte Carlo sim is ported.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass

import chess

from .config import ContestConfig
from .models import BuildState, KingMode, Piece, Player, Side
from .openings import BookLine, book_continuations, opening_name, split_family
from .pieces import classify, piece_for_chess_type
from .rules import (
    apply_capture_move,
    apply_move,
    can_castle,
    captured_square,
    castle,
    is_legal_capture,
    is_legal_move,
    is_lineup_complete,
    lineup_still_completable,
    open_roster_slots,
    push_silent_move,
)
from .sport import SportConfig

HAPPY_HUNTING = "Happy Hunting"
NO_LEGAL_MOVES = "No legal moves"


@dataclass(frozen=True)
class MoveResult:
    state: BuildState
    opening: str | None
    message: str | None  # HAPPY_HUNTING, NO_LEGAL_MOVES, or None (build still ongoing)
    open_slots: dict[str, int] | None = None  # populated only for NO_LEGAL_MOVES


def san_history(board: chess.Board) -> tuple[str, ...]:
    """The full build's SAN move list in order, reconstructed from the
    board's own move stack (so no separate move-order tracking is needed
    anywhere in BuildState).
    """
    replay = chess.Board()
    sans: list[str] = []
    for move in board.move_stack:
        sans.append(replay.san(move))
        replay.push(move)
    return tuple(sans)


def is_build_over(state: BuildState, sport: SportConfig) -> bool:
    return is_lineup_complete([m.player for m in state.white_moves], sport)


def _eligible_unlocked(
    piece: Piece, state: BuildState, sport: SportConfig, players_pool: list[Player]
) -> list[Player]:
    return [
        p
        for p in players_pool
        if p.id not in state.locked_player_ids and piece in classify(p, sport)
    ]


def _best_legal_player(
    chess_move: chess.Move,
    piece: Piece,
    state: BuildState,
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
) -> Player | None:
    """Highest-projection eligible player for which `chess_move` is
    actually legal -- the TEMPORARY placeholder pick (see module docstring).
    """
    candidates = sorted(
        _eligible_unlocked(piece, state, sport, players_pool),
        key=lambda p: p.proj,
        reverse=True,
    )
    for player in candidates:
        if is_legal_move(state, chess_move, player, sport, contest):
            return player
    return None


def _best_legal_capture_player(
    chess_move: chess.Move,
    captured_type: Piece,
    state: BuildState,
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
) -> Player | None:
    """Highest-projection eligible player of `captured_type` for which
    `chess_move` -- a capture of a piece with no lock history, i.e. it
    never moved (Task 19) -- is actually legal right now. The TEMPORARY
    placeholder pick, same convention as `_best_legal_player`.
    """
    candidates = sorted(
        _eligible_unlocked(captured_type, state, sport, players_pool),
        key=lambda p: p.proj,
        reverse=True,
    )
    for player in candidates:
        if is_legal_capture(state, chess_move, sport, contest, player):
            return player
    return None


def _best_legal_castle_players(
    state: BuildState,
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
    king_mode: KingMode = KingMode.EMERGE,
) -> tuple[Player, ...] | None:
    """A 2-tuple (King, Rook) in EMERGE mode, or a 1-tuple (Rook) in
    PLACED mode (Task 14: castling locks only the Rook there)."""
    side = Side.WHITE if state.board.turn == chess.WHITE else Side.BLACK
    if not can_castle(state, side, king_mode):
        return None

    current = [m.player for m in (state.white_moves if side is Side.WHITE else state.black_moves)]
    cap = contest.effective_cap(sport)
    rooks = sorted(
        _eligible_unlocked(Piece.ROOK, state, sport, players_pool), key=lambda p: p.proj, reverse=True
    )
    if king_mode is KingMode.PLACED:
        for rook in rooks:
            if lineup_still_completable(current + [rook], sport, cap):
                return (rook,)
        return None

    kings = sorted(
        _eligible_unlocked(Piece.KING, state, sport, players_pool), key=lambda p: p.proj, reverse=True
    )
    for king in kings:
        for rook in rooks:
            if lineup_still_completable(current + [king, rook], sport, cap):
                return king, rook
    return None


def _resolve_players(
    state: BuildState,
    chess_move: chess.Move,
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
    king_mode: KingMode = KingMode.EMERGE,
) -> tuple[Player, ...] | None:
    """The player(s) `chess_move` would lock -- one, or two for castling
    in EMERGE mode (King + Rook, per RULES.md), one for castling in
    PLACED mode (Rook only), one for a capture (Task 18: the captured
    player IS the pick, regardless of which piece did the capturing --
    this now includes a capturing King move in PLACED mode, previously
    unsupported since there was no clean way to skip the mover's own
    pick while still doing the transfer; Task 18 removes the mover's
    own pick for every capture, so that conflict no longer exists), or
    zero for a plain (non-capturing, non-castling) King move in PLACED
    mode (RULES.md "King modes": "later King moves lock no player") --
    or None if no legal, unlocked candidate (or no legal capture) exists,
    i.e. this move isn't playable at all right now. A capture whose
    captured piece has no lock history -- it never moved -- resolves to
    the best eligible player of that piece's own real chess type
    instead of a transfer (Task 19).
    """
    if state.board.is_castling(chess_move):
        pair = _best_legal_castle_players(state, sport, contest, players_pool, king_mode)
        return None if pair is None else pair
    if state.board.is_capture(chess_move):
        square = captured_square(state.board, chess_move)
        captured_history = state.piece_locks.get(square, [])
        if captured_history:
            if not is_legal_capture(state, chess_move, sport, contest):
                return None
            return (captured_history[-1],)
        captured_type = piece_for_chess_type(state.board.piece_type_at(square))
        player = _best_legal_capture_player(chess_move, captured_type, state, sport, contest, players_pool)
        return None if player is None else (player,)
    piece = piece_for_chess_type(state.board.piece_type_at(chess_move.from_square))
    if king_mode is KingMode.PLACED and piece is Piece.KING:
        return ()
    player = _best_legal_player(chess_move, piece, state, sport, contest, players_pool)
    return None if player is None else (player,)


def _apply_resolved_players(
    state: BuildState,
    chess_move: chess.Move,
    players: tuple[Player, ...],
    sport: SportConfig,
    contest: ContestConfig,
    king_mode: KingMode,
) -> BuildState:
    """Applies `chess_move` given the player(s) `_resolve_players`
    already resolved for it: castling (1 player in PLACED mode, just the
    Rook; 2 in EMERGE mode, King + Rook), a capture (`players` holds the
    captured player when there's lock history to transfer -- `apply_
    capture_move` re-derives that itself and ignores it -- or the
    chosen replacement player when the captured piece never moved,
    Task 19), a silent King move (empty -- PLACED mode only, Task 14),
    or an ordinary single-player lock.
    """
    if state.board.is_castling(chess_move):
        if king_mode is KingMode.PLACED:
            (rook,) = players
            return castle(state, chess_move, None, rook, sport, contest, king_mode)
        king, rook = players
        return castle(state, chess_move, king, rook, sport, contest, king_mode)
    if state.board.is_capture(chess_move):
        (player,) = players
        return apply_capture_move(state, chess_move, sport, contest, player)
    if not players:
        return push_silent_move(state, chess_move)
    (player,) = players
    return apply_move(state, chess_move, player, sport, contest)


def check_white_dead_end(
    state: BuildState,
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
    king_mode: KingMode = KingMode.EMERGE,
) -> MoveResult | None:
    """If White (to move) has no legal (chess move, eligible player)
    combination at all, ends the build early: White's lineup stays
    incomplete, and `message` is `NO_LEGAL_MOVES` with `open_slots` naming
    what's still unfilled (RULES.md: no "Happy Hunting" in that case).
    Returns None if White still has at least one legal move -- the caller
    should proceed normally (prompt for it, apply it via `play_white_move`).
    """
    if state.board.turn != chess.WHITE:
        raise ValueError("it is not White's turn")

    for move in state.board.legal_moves:
        if _resolve_players(state, move, sport, contest, players_pool, king_mode) is not None:
            return None

    open_slots = open_roster_slots([m.player for m in state.white_moves], sport.roster_slots)
    return MoveResult(state, None, NO_LEGAL_MOVES, open_slots)


def move_is_completable(
    state: BuildState,
    chess_move: chess.Move,
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
    king_mode: KingMode = KingMode.EMERGE,
) -> bool:
    """Whether some eligible, unlocked, roster/salary-feasible player
    exists for `chess_move` right now, for whichever side is on the
    board -- the same feasibility `play_white_move`/`play_black_move`
    themselves rely on, exposed for the CLI's template-continuation
    filter (Task 13b: White's continuation list should only ever offer
    lines that are actually playable, the same as Black's own book
    choices already are). A silent King move (Task 14, PLACED mode)
    counts as completable too -- it locks no one, but it's still playable.
    """
    return _resolve_players(state, chess_move, sport, contest, players_pool, king_mode) is not None


def _is_move_playable_for_black(
    chess_move: chess.Move,
    state: BuildState,
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
    black_is_full: bool,
    king_mode: KingMode = KingMode.EMERGE,
) -> bool:
    """Whether Black could actually play `chess_move` right now. Once
    Black's lineup is full, that's just "not a capture and not castling"
    (both inherently lock a player); otherwise it's "a legal, unlocked
    player exists for the piece band" (`move_is_completable`, which
    also covers PLACED mode's silent King moves, and -- Task 19 -- a
    capture of a piece that never moved, via the same placeholder pick
    as any other move).
    """
    if black_is_full:
        return not (state.board.is_capture(chess_move) or state.board.is_castling(chess_move))
    return move_is_completable(state, chess_move, sport, contest, players_pool, king_mode)


def _playable_continuations(
    state: BuildState,
    continuations: set[str],
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
    black_is_full: bool,
    king_mode: KingMode = KingMode.EMERGE,
) -> set[str]:
    """`continuations` restricted to the ones Black can actually play --
    see `_is_move_playable_for_black`."""
    playable: set[str] = set()
    for san in continuations:
        move = state.board.parse_san(san)
        if _is_move_playable_for_black(move, state, sport, contest, players_pool, black_is_full, king_mode):
            playable.add(san)
    return playable


def _choose_black_committed_line(
    moves_so_far: tuple[str, ...],
    state: BuildState,
    book: list[BookLine],
    family_ranks: dict[str, int],
    target_rank: int,
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
    black_is_full: bool,
    rng: random.Random,
    king_mode: KingMode = KingMode.EMERGE,
) -> tuple[str, ...] | None:
    """A full book line matching `moves_so_far`, chosen among every
    matching line whose *next* move Black could actually play right now
    -- Task 20: the one whose family (`openings.split_family`'s first
    element, looked up in `family_ranks`) rank is closest to
    `target_rank`; a family missing from `family_ranks` (unranked, e.g.
    King's Pawn Game) counts as farthest -- never preferred over any
    ranked family -- ties (including "every matching line's family is
    unranked") broken by a seeded random choice. Returns None if no
    line qualifies. Black then plays that whole line exactly while it
    keeps matching (see `play_black_move`) -- RULES.md "Opening
    templates": "Black outside a template ... commit to it and play it
    exactly."
    """
    depth = len(moves_so_far)
    continuations = book_continuations(moves_so_far, book)
    playable = _playable_continuations(state, continuations, sport, contest, players_pool, black_is_full, king_mode)
    if not playable:
        return None
    matching_lines = [
        line
        for line in book
        if len(line.moves) > depth and line.moves[:depth] == moves_so_far and line.moves[depth] in playable
    ]
    if not matching_lines:
        return None

    def rank_distance(line: BookLine) -> float:
        family, _ = split_family(line.name)
        rank = family_ranks.get(family)
        return math.inf if rank is None else abs(rank - target_rank)

    distances = [rank_distance(line) for line in matching_lines]
    min_distance = min(distances)
    closest = [line for line, distance in zip(matching_lines, distances) if distance == min_distance]
    return rng.choice(closest).moves


def play_white_move(
    state: BuildState,
    white_move: chess.Move,
    white_player: Player | None,
    sport: SportConfig,
    contest: ContestConfig,
    book: list[BookLine],
    white_rook: Player | None = None,
    king_mode: KingMode = KingMode.EMERGE,
) -> MoveResult:
    """Applies the caller-chosen White move. `white_rook` is required iff
    `white_move` is castling (King + Rook, locked together in EMERGE
    mode -- `white_player` is the King then). In PLACED king mode
    (Task 14), castling locks only the Rook; `white_player` is ignored
    for that call (the caller may pass the side's already-locked King as
    a harmless placeholder). A plain (non-castling) King move in PLACED
    mode locks no one at all ("later King moves lock no player") -- the
    caller is expected to route that case to `rules.push_silent_move`
    directly rather than here, since there's no player to supply. A
    capture whose captured piece has lock history (Task 18) also needs
    no `white_player` at all -- the captured player IS the pick, so
    there's nothing the caller could have prompted for; pass None. A
    capture of a piece that never moved (Task 19) does need
    `white_player`: the capturing side's own pick of that piece's real
    chess type, prompted for same as any other pick.
    """
    if state.board.is_castling(white_move):
        if white_rook is None:
            raise ValueError("white_move is castling; white_rook is required too")
        king = white_player if king_mode is KingMode.EMERGE else None
        state = castle(state, white_move, king, white_rook, sport, contest, king_mode)
    elif state.board.is_capture(white_move):
        state = apply_capture_move(state, white_move, sport, contest, white_player)
    else:
        if white_player is None:
            raise ValueError("white_move is not castling or a capture; white_player is required")
        state = apply_move(state, white_move, white_player, sport, contest)

    opening = opening_name(san_history(state.board), book)
    message = HAPPY_HUNTING if is_build_over(state, sport) else None
    return MoveResult(state, opening, message)


def play_black_move(
    state: BuildState,
    book: list[BookLine],
    family_ranks: dict[str, int],
    target_rank: int,
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
    rng: random.Random,
    king_mode: KingMode = KingMode.EMERGE,
) -> MoveResult:
    """Generates and applies Black's move. Outside an explicit template
    (RULES.md "Opening templates"), Black commits to one full book line
    at a time -- chosen among every line matching the moves so far, the
    one whose family rank is closest to `target_rank` (Task 20),
    excluding any whose next move Black can't actually play -- and plays
    that line exactly for as long as it keeps matching
    (`state.black_committed_line`). Black
    re-chooses only once that line runs out or White's own move no
    longer matches it; with no line to commit to at all, any legal move
    is played, chosen uniformly. Locks a player normally, unless Black's
    lineup is already full, in which case the move is pushed silently
    (see module docstring).
    """
    if state.board.turn != chess.BLACK:
        raise ValueError("it is not Black's turn")

    black_is_full = is_lineup_complete([m.player for m in state.black_moves], sport)
    moves_so_far = san_history(state.board)
    depth = len(moves_so_far)

    committed = state.black_committed_line
    if committed is not None:
        if depth >= len(committed) or committed[:depth] != moves_so_far:
            committed = None  # the line ran out, or White's own move left it
        else:
            move = state.board.parse_san(committed[depth])
            if not _is_move_playable_for_black(
                move, state, sport, contest, players_pool, black_is_full, king_mode
            ):
                committed = None  # no longer playable here -- re-choose below

    if committed is None:
        committed = _choose_black_committed_line(
            moves_so_far,
            state,
            book,
            family_ranks,
            target_rank,
            sport,
            contest,
            players_pool,
            black_is_full,
            rng,
            king_mode,
        )

    chess_move = state.board.parse_san(committed[depth]) if committed is not None else None

    if chess_move is None:
        # No book line to commit to at all: any legal move, chosen
        # uniformly -- RULES.md gives no other weighting signal for free play.
        if black_is_full:
            candidates = [
                m
                for m in state.board.legal_moves
                if not state.board.is_capture(m) and not state.board.is_castling(m)
            ]
        else:
            candidates = [
                m
                for m in state.board.legal_moves
                if _resolve_players(state, m, sport, contest, players_pool, king_mode) is not None
            ]
        if not candidates:
            raise RuntimeError("Black has no legal move available")
        chess_move = rng.choice(candidates)

    if black_is_full:
        new_state = push_silent_move(state, chess_move)
    else:
        players = _resolve_players(state, chess_move, sport, contest, players_pool, king_mode)
        assert players is not None  # chess_move was only chosen because this resolved
        new_state = _apply_resolved_players(state, chess_move, players, sport, contest, king_mode)

    new_state.black_committed_line = committed
    opening = opening_name(san_history(new_state.board), book)
    message = HAPPY_HUNTING if is_build_over(new_state, sport) else None
    return MoveResult(new_state, opening, message)


def play_black_template_move(
    state: BuildState,
    chess_move: chess.Move,
    sport: SportConfig,
    contest: ContestConfig,
    players_pool: list[Player],
    book: list[BookLine],
    king_mode: KingMode = KingMode.EMERGE,
) -> MoveResult | None:
    """Applies `chess_move` for Black exactly as given, in place of
    Black's usual book-weighted choice -- for template mode, where both
    sides mechanically play a user-chosen book line (RULES.md "Opening
    templates"). Player pick is the same highest-projection placeholder
    used everywhere else in this module (see module docstring); `book`
    is only for naming the resulting opening, same as everywhere else.
    Returns None if no eligible, unlocked, roster/salary-feasible player
    exists for `chess_move` right now (a template-mode "DFS-illegal"
    move) -- the caller should treat the template as ended here and fall
    back to Black's normal (`play_black_move`) behavior for this turn.
    A plain King move in PLACED king mode (Task 14) always succeeds,
    locking no one ("later King moves lock no player").
    """
    if state.board.turn != chess.BLACK:
        raise ValueError("it is not Black's turn")

    black_is_full = is_lineup_complete([m.player for m in state.black_moves], sport)
    if black_is_full:
        if state.board.is_capture(chess_move) or state.board.is_castling(chess_move):
            return None
        new_state = push_silent_move(state, chess_move)
    else:
        players = _resolve_players(state, chess_move, sport, contest, players_pool, king_mode)
        if players is None:
            return None
        new_state = _apply_resolved_players(state, chess_move, players, sport, contest, king_mode)

    opening = opening_name(san_history(new_state.board), book)
    message = HAPPY_HUNTING if is_build_over(new_state, sport) else None
    return MoveResult(new_state, opening, message)
