"""Legality rules: castling, exclusivity, captures, roster/salary.

Turn order and move legality are anchored on a real `chess.Board`
(python-chess) — a move must be a legal chess move AND pass the DFS rules
below. SAN and captures both come from the board, per RULES.md.

Roster shape (slots, eligible positions, salary cap) comes from a
`SportConfig`, not from constants here, per RULES.md "Multi-sport ready".
"""
from __future__ import annotations

import chess

from .config import ContestConfig
from .models import BuildState, KingMode, Move, Piece, Player, Side
from .pieces import classify, piece_for_chess_type
from .sport import RosterSlot, SportConfig


def _side_to_move(board: chess.Board) -> Side:
    return Side.WHITE if board.turn == chess.WHITE else Side.BLACK


def _moves_for(state: BuildState, side: Side) -> list[Move]:
    return state.white_moves if side is Side.WHITE else state.black_moves


def _with_board_state(
    state: BuildState,
    side: Side,
    moves: list[Move],
    locked_player_ids: set[str],
    board: chess.Board,
    piece_locks: dict[chess.Square, list[Player]],
) -> BuildState:
    if side is Side.WHITE:
        return BuildState(
            board=board,
            white_moves=moves,
            black_moves=list(state.black_moves),
            locked_player_ids=locked_player_ids,
            piece_locks=piece_locks,
            black_committed_line=state.black_committed_line,
            white_castled=state.white_castled,
            black_castled=state.black_castled,
        )
    return BuildState(
        board=board,
        white_moves=list(state.white_moves),
        black_moves=moves,
        locked_player_ids=locked_player_ids,
        piece_locks=piece_locks,
        black_committed_line=state.black_committed_line,
        white_castled=state.white_castled,
        black_castled=state.black_castled,
    )


def max_assignable(players: list[Player], roster_slots: list[RosterSlot]) -> int:
    """Max number of `players` that can be simultaneously placed into
    distinct roster slot instances they're eligible for (each slot's
    `count` expands into that many interchangeable instances). A maximum
    bipartite matching (Kuhn's algorithm) — small enough (<=9 a side) that
    a plain augmenting-path search is fine. If this comes back under
    `len(players)`, no later pick can ever complete the roster.
    """
    instance_positions: list[frozenset[str]] = []
    for slot in roster_slots:
        instance_positions.extend([slot.positions] * slot.count)

    occupant: list[int | None] = [None] * len(instance_positions)

    def augment(player_idx: int, visited: set[int]) -> bool:
        eligible_positions = {p.upper() for p in players[player_idx].positions}
        for slot_idx, slot_positions in enumerate(instance_positions):
            if slot_idx in visited or not (slot_positions & eligible_positions):
                continue
            visited.add(slot_idx)
            if occupant[slot_idx] is None or augment(occupant[slot_idx], visited):
                occupant[slot_idx] = player_idx
                return True
        return False

    return sum(1 for i in range(len(players)) if augment(i, set()))


def lineup_still_completable(players: list[Player], sport: SportConfig, cap: int) -> bool:
    """Whether `players` — one side's locked roster so far — could still be
    completed into a legal lineup for `sport` within `cap`. Only checks for
    overflow a later pick could never undo; it does not require minimums
    yet, since the roster is still incomplete.
    """
    if len(players) > sport.roster_size:
        return False
    if sum(p.salary for p in players) > cap:
        return False
    if max_assignable(players, sport.roster_slots) < len(players):
        return False
    return True


def is_lineup_complete(players: list[Player], sport: SportConfig) -> bool:
    """Whether `players` is a full, legal lineup for `sport` -- exactly
    `roster_size` players, every one of them placeable into a distinct
    roster slot. (Salary cap isn't part of "complete" -- a side can finish
    under budget.)
    """
    return (
        len(players) == sport.roster_size
        and max_assignable(players, sport.roster_slots) == sport.roster_size
    )


def open_roster_slots(players: list[Player], roster_slots: list[RosterSlot]) -> dict[str, int]:
    """How many instances of each roster slot in `roster_slots` are NOT
    filled by `players`, via the same maximum bipartite matching
    `max_assignable` uses -- {} if every slot is filled.
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


def captured_square(board: chess.Board, move: chess.Move) -> chess.Square:
    """The square holding the piece `move` captures. Normally `to_square`;
    for en passant the captured pawn sits beside it. Call before pushing.
    """
    if board.is_en_passant(move):
        return chess.square(chess.square_file(move.to_square), chess.square_rank(move.from_square))
    return move.to_square


def _castling_rook_squares(board: chess.Board, move: chess.Move) -> tuple[chess.Square, chess.Square]:
    kingside = board.is_kingside_castling(move)
    if move.from_square == chess.E1:
        return (chess.H1, chess.F1) if kingside else (chess.A1, chess.D1)
    return (chess.H8, chess.F8) if kingside else (chess.A8, chess.D8)


def is_legal_move(
    state: BuildState,
    chess_move: chess.Move,
    player: Player,
    sport: SportConfig,
    contest: ContestConfig,
) -> bool:
    if chess_move not in state.board.legal_moves:
        return False
    if state.board.is_castling(chess_move):
        return False  # castling locks King + Rook together; use castle()
    if state.board.is_capture(chess_move):
        return False  # the captured player is the pick; use apply_capture_move()

    side = _side_to_move(state.board)
    piece = piece_for_chess_type(state.board.piece_type_at(chess_move.from_square))

    if player.id in state.locked_player_ids:
        return False
    if piece not in classify(player, sport):
        return False

    cap = contest.effective_cap(sport)
    current = [m.player for m in _moves_for(state, side)]
    if not lineup_still_completable(current + [player], sport, cap):
        return False

    return True


def apply_move(
    state: BuildState,
    chess_move: chess.Move,
    player: Player,
    sport: SportConfig,
    contest: ContestConfig,
) -> BuildState:
    """A non-capturing, non-castling move: `player` is this move's new
    pick. A capture never reaches here (`is_legal_move` rejects it) --
    the captured player IS the move's pick instead; see
    `apply_capture_move`.
    """
    if not is_legal_move(state, chess_move, player, sport, contest):
        raise ValueError(f"illegal move: {chess_move!r} for {player!r}")

    side = _side_to_move(state.board)
    piece = piece_for_chess_type(state.board.piece_type_at(chess_move.from_square))
    san = state.board.san(chess_move)

    new_board = state.board.copy()
    new_board.push(chess_move)

    new_piece_locks = dict(state.piece_locks)
    mover_history = new_piece_locks.pop(chess_move.from_square, [])
    new_piece_locks[chess_move.to_square] = mover_history + [player]

    move_record = Move(side=side, piece=piece, san=san, player=player)
    moves = _moves_for(state, side) + [move_record]
    locked = state.locked_player_ids | {player.id}

    return _with_board_state(state, side, moves, locked, new_board, new_piece_locks)


def can_castle(state: BuildState, side: Side, king_mode: KingMode = KingMode.EMERGE) -> bool:
    """`king_mode` EMERGE (default): matches the pre-Task-14 behavior
    exactly -- a King locked by any move (including a prior castling)
    blocks further castling. PLACED: the King is already locked from
    setup, which must NOT block castling (RULES.md "King modes"/Piece
    rules castling clause) -- the explicit `*_castled` flag is what
    detects "already castled" instead.
    """
    already_castled = state.white_castled if side is Side.WHITE else state.black_castled
    if already_castled:
        return False
    locked_pieces = {m.piece for m in _moves_for(state, side)}
    if king_mode is KingMode.EMERGE and Piece.KING in locked_pieces:
        return False
    return Piece.KNIGHT in locked_pieces and Piece.BISHOP in locked_pieces


def castle(
    state: BuildState,
    chess_move: chess.Move,
    king: Player | None,
    rook: Player,
    sport: SportConfig,
    contest: ContestConfig,
    king_mode: KingMode = KingMode.EMERGE,
) -> BuildState:
    """`king` is required (and locked, King + Rook together) in EMERGE
    mode. In PLACED mode (Task 14), the King is already locked from
    setup -- castling locks only the Rook, and `king` is ignored (pass
    None).
    """
    if chess_move not in state.board.legal_moves or not state.board.is_castling(chess_move):
        raise ValueError(f"{chess_move!r} is not a legal castling move")

    side = _side_to_move(state.board)
    if not can_castle(state, side, king_mode):
        raise ValueError(f"castling is not legal for {side}")

    if king_mode is KingMode.EMERGE:
        if king is None:
            raise ValueError("king_mode is EMERGE; a King player is required")
        if Piece.KING not in classify(king, sport):
            raise ValueError(f"{king.name!r} does not classify as King")
        if king.id in state.locked_player_ids:
            raise ValueError(f"{king.name!r} is already locked")

    if Piece.ROOK not in classify(rook, sport):
        raise ValueError(f"{rook.name!r} does not classify as Rook")
    if rook.id in state.locked_player_ids:
        raise ValueError(f"{rook.name!r} is already locked")

    current = [m.player for m in _moves_for(state, side)]
    additions = [king, rook] if king_mode is KingMode.EMERGE else [rook]
    if not lineup_still_completable(current + additions, sport, contest.effective_cap(sport)):
        raise ValueError("castling would make a legal lineup impossible to complete")

    san = state.board.san(chess_move)
    rook_from, rook_to = _castling_rook_squares(state.board, chess_move)

    new_board = state.board.copy()
    new_board.push(chess_move)

    new_piece_locks = dict(state.piece_locks)
    king_history = new_piece_locks.pop(chess_move.from_square, [])
    # PLACED mode: the King's square still holds whatever locked it at
    # setup -- castling relocates that history along with the physical
    # king move, but doesn't add to it (no new King lock here).
    new_piece_locks[chess_move.to_square] = (king_history + [king]) if king_mode is KingMode.EMERGE else king_history
    rook_history = new_piece_locks.pop(rook_from, [])
    new_piece_locks[rook_to] = rook_history + [rook]

    new_moves = [Move(side=side, piece=Piece.ROOK, san=san, player=rook)]
    if king_mode is KingMode.EMERGE:
        new_moves.insert(0, Move(side=side, piece=Piece.KING, san=san, player=king))
    moves = _moves_for(state, side) + new_moves
    locked = state.locked_player_ids | ({king.id, rook.id} if king_mode is KingMode.EMERGE else {rook.id})

    new_state = _with_board_state(state, side, moves, locked, new_board, new_piece_locks)
    if side is Side.WHITE:
        new_state.white_castled = True
    else:
        new_state.black_castled = True
    return new_state


def switch_king(
    state: BuildState,
    side: Side,
    new_king: Player,
    sport: SportConfig,
    contest: ContestConfig,
) -> BuildState | None:
    """Task 14's one-time "Switch your QB?" offer, right after castling
    in PLACED king mode: `side`'s currently-locked QB returns to the
    player pool (available to either side again), and `new_king` takes
    its place -- provided the swap keeps the lineup completable (the
    roster shape never changes, still exactly one QB; only salary can
    actually break this). Returns None if `new_king` doesn't classify as
    King, is already locked, or the swap would overflow the cap -- the
    caller should treat that as "switch rejected," leaving the original
    QB in place.
    """
    if Piece.KING not in classify(new_king, sport):
        return None
    if new_king.id in state.locked_player_ids:
        return None

    moves = _moves_for(state, side)
    old_king_move = next((m for m in moves if m.piece is Piece.KING), None)
    if old_king_move is None:
        return None
    old_king = old_king_move.player

    other_players = [m.player for m in moves if m.player.id != old_king.id]
    if not lineup_still_completable(other_players + [new_king], sport, contest.effective_cap(sport)):
        return None

    new_moves = [
        Move(side=side, piece=Piece.KING, san=m.san, player=new_king) if m.player.id == old_king.id else m
        for m in moves
    ]
    new_locked = (state.locked_player_ids - {old_king.id}) | {new_king.id}
    new_piece_locks = {
        square: [new_king if p.id == old_king.id else p for p in history]
        for square, history in state.piece_locks.items()
    }

    return _with_board_state(state, side, new_moves, new_locked, state.board, new_piece_locks)


def place_kings(white_king: Player, black_king: Player, sport: SportConfig, contest: ContestConfig) -> BuildState:
    """Task 14 "Place your King now": locks White's and Black's QB
    before move 1 -- no chess move is involved, so the board starts at
    the normal starting position. Raises ValueError if either player
    doesn't classify as King, they're the same player, or either is
    unaffordable alone (mirrors the same completability check every
    other lock goes through).
    """
    if Piece.KING not in classify(white_king, sport):
        raise ValueError(f"{white_king.name!r} does not classify as King")
    if Piece.KING not in classify(black_king, sport):
        raise ValueError(f"{black_king.name!r} does not classify as King")
    if white_king.id == black_king.id:
        raise ValueError("White and Black cannot place the same QB")

    cap = contest.effective_cap(sport)
    if not lineup_still_completable([white_king], sport, cap):
        raise ValueError(f"{white_king.name!r} is not affordable for White")
    if not lineup_still_completable([black_king], sport, cap):
        raise ValueError(f"{black_king.name!r} is not affordable for Black")

    return BuildState(
        white_moves=[Move(side=Side.WHITE, piece=Piece.KING, san="(placed)", player=white_king)],
        black_moves=[Move(side=Side.BLACK, piece=Piece.KING, san="(placed)", player=black_king)],
        locked_player_ids={white_king.id, black_king.id},
    )


def _other_side(side: Side) -> Side:
    return Side.BLACK if side is Side.WHITE else Side.WHITE


def is_legal_capture(
    state: BuildState,
    chess_move: chess.Move,
    sport: SportConfig,
    contest: ContestConfig,
    player: Player | None = None,
) -> bool:
    """Whether `chess_move` is a legal capture right now. The captured
    player IS this move's pick when the captured piece has lock
    history -- then `player` is ignored, and this just checks whether
    transferring the captured player keeps the capturing side's lineup
    completable. For a captured piece with NO lock history (it never
    moved), there's nothing to transfer -- `player` is the capturing
    side's own pick of that piece's real chess type instead; legal only
    if `player` classifies as that type, isn't already locked, and
    keeps the lineup completable. False (not an error) if `player` is
    required here but missing or doesn't qualify -- same "not playable"
    convention `is_legal_move` uses for everything else.
    """
    if chess_move not in state.board.legal_moves:
        return False
    if not state.board.is_capture(chess_move) or state.board.is_castling(chess_move):
        return False

    side = _side_to_move(state.board)
    current = [m.player for m in _moves_for(state, side)]
    cap = contest.effective_cap(sport)

    square = captured_square(state.board, chess_move)
    captured_history = state.piece_locks.get(square, [])
    if captured_history:
        return lineup_still_completable(current + [captured_history[-1]], sport, cap)

    if player is None or player.id in state.locked_player_ids:
        return False
    captured_type = piece_for_chess_type(state.board.piece_type_at(square))
    if captured_type not in classify(player, sport):
        return False
    return lineup_still_completable(current + [player], sport, cap)


def apply_capture_move(
    state: BuildState,
    chess_move: chess.Move,
    sport: SportConfig,
    contest: ContestConfig,
    player: Player | None = None,
) -> BuildState:
    """Applies a capturing move: the captured player IS this move's
    pick -- the capturing piece locks no new player of its own. If the
    captured piece has lock history, there's nothing for a caller to
    have prompted for (`player` is ignored). If it never moved, there's
    no locked player on record to transfer -- `player` is required
    instead: the capturing side's own pick of that piece's real chess
    type, taking the captured piece's place as this move's only pick.
    Raises ValueError if `chess_move` isn't a legal, non-castling
    capture right now, if a never-moved capture's `player` is missing,
    doesn't classify as the captured piece's type, or is already
    locked, or if the resulting pick would overflow the capturing
    side's roster/salary.
    """
    if chess_move not in state.board.legal_moves:
        raise ValueError(f"illegal move: {chess_move!r}")
    if state.board.is_castling(chess_move):
        raise ValueError(f"{chess_move!r} is castling, not a plain capture; use castle()")
    if not state.board.is_capture(chess_move):
        raise ValueError(f"{chess_move!r} is not a capture; use apply_move()")

    side = _side_to_move(state.board)
    san = state.board.san(chess_move)
    square = captured_square(state.board, chess_move)
    captured_history = state.piece_locks.get(square, [])
    if captured_history:
        # A transfer keeps the captured player's own prior identity -- the
        # piece whichever earlier move actually locked them with, not a
        # fresh classify() (which, now that pools overlap, could name a
        # DIFFERENT piece than the one they were really picked as).
        captured = captured_history[-1]
        locked_piece = next(
            m.piece for m in (state.white_moves + state.black_moves) if m.player.id == captured.id
        )
    else:
        captured_type = piece_for_chess_type(state.board.piece_type_at(square))
        if player is None:
            raise ValueError(
                f"{san!r} captures an unmoved {captured_type.value.title()} -- a player pick is required"
            )
        if captured_type not in classify(player, sport):
            raise ValueError(f"{player.name!r} does not classify as {captured_type.value.title()}")
        if player.id in state.locked_player_ids:
            raise ValueError(f"{player.name!r} is already locked")
        captured = player
        locked_piece = captured_type

    cap = contest.effective_cap(sport)
    current = [m.player for m in _moves_for(state, side)]
    if not lineup_still_completable(current + [captured], sport, cap):
        raise ValueError(f"capturing {captured.name!r} would make the lineup impossible to complete")

    new_board = state.board.copy()
    new_board.push(chess_move)

    new_piece_locks = dict(state.piece_locks)
    mover_history = new_piece_locks.pop(chess_move.from_square, [])
    if square != chess_move.to_square:
        new_piece_locks.pop(square, None)
    new_piece_locks[chess_move.to_square] = mover_history + [captured]

    move_record = Move(side=side, piece=locked_piece, san=san, player=captured)
    moves = _moves_for(state, side) + [move_record]

    opposing_side = _other_side(side)
    opponent_moves = [m for m in _moves_for(state, opposing_side) if m.player.id != captured.id]
    # A historied transfer's `captured` is already locked, so this is a
    # no-op there; a never-moved capture's `captured` is the freshly
    # chosen `player`, who needs adding here (Task 19) -- otherwise
    # they'd stay "available" for either side to pick again later.
    locked = state.locked_player_ids | {captured.id}

    if side is Side.WHITE:
        return BuildState(
            board=new_board,
            white_moves=moves,
            black_moves=opponent_moves,
            locked_player_ids=locked,
            piece_locks=new_piece_locks,
            black_committed_line=state.black_committed_line,
            white_castled=state.white_castled,
            black_castled=state.black_castled,
        )
    return BuildState(
        board=new_board,
        white_moves=opponent_moves,
        black_moves=moves,
        locked_player_ids=locked,
        piece_locks=new_piece_locks,
        black_committed_line=state.black_committed_line,
        white_castled=state.white_castled,
        black_castled=state.black_castled,
    )


def push_silent_move(state: BuildState, chess_move: chess.Move) -> BuildState:
    """Pushes `chess_move` without locking any player -- for a side whose
    lineup is already complete (RULES.md: "If Black's lineup fills first,
    Black's board moves lock no player"). Must be neither a capture nor
    castling: both inherently lock a player (a transferred capture would
    overflow an already-full roster; castling always locks King + Rook),
    so neither makes sense once nobody is being drafted this move.
    """
    if chess_move not in state.board.legal_moves:
        raise ValueError(f"illegal move: {chess_move!r}")
    if state.board.is_capture(chess_move):
        raise ValueError(f"{chess_move!r} is a capture; a silent move cannot be")
    if state.board.is_castling(chess_move):
        raise ValueError(f"{chess_move!r} is castling; a silent move cannot be")

    side = _side_to_move(state.board)
    new_board = state.board.copy()
    new_board.push(chess_move)

    new_piece_locks = dict(state.piece_locks)
    history = new_piece_locks.pop(chess_move.from_square, [])
    if history:
        new_piece_locks[chess_move.to_square] = history

    moves = _moves_for(state, side)
    return _with_board_state(state, side, moves, state.locked_player_ids, new_board, new_piece_locks)
