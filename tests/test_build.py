import random
from pathlib import Path

import chess

from dfs_chess.build import (
    HAPPY_HUNTING,
    NO_LEGAL_MOVES,
    check_white_dead_end,
    move_is_completable,
    play_black_move,
    play_black_template_move,
    play_white_move,
)
from dfs_chess.config import ContestConfig
from dfs_chess.loaders import load_opening_book
from dfs_chess.models import BuildState, KingMode, Move, Piece, Player, Side
from dfs_chess.openings import BookLine, book_continuations
from dfs_chess.pieces import classify, piece_for_chess_type
from dfs_chess.rules import apply_move, place_kings
from dfs_chess.sport import PieceBand, RosterSlot, SportConfig, load_sport_config

REPO_ROOT = Path(__file__).resolve().parent.parent
NFL = load_sport_config(REPO_ROOT / "config" / "sports" / "nfl.json")
BOOK = load_opening_book([REPO_ROOT / "data" / "openings" / f"{letter}.tsv" for letter in "abcde"])
CONTEST = ContestConfig(field_size=1000, payouts=[])

# A roster of exactly one slot, open to one made-up position -- enough to
# exercise the end condition without hand-constructing a full 9-pick NFL
# lineup. piece_bands has only PAWN (the required catch-all), so only
# actual pawn-type chess moves resolve to a real player here; that's
# fine, this sport only exists for these tests.
TOY_SPORT = SportConfig(
    sport="TOY",
    salary_cap=50000,
    piece_bands=[PieceBand(piece=Piece.PAWN, positions=None, min_salary=None, max_salary=None)],
    roster_slots=[RosterSlot(name="ANY", positions=frozenset({"ANY"}), count=1)],
)


def make_player(id_: str, pos: str, salary: int, proj: float = 10.0) -> Player:
    return Player(
        id=id_,
        name=id_,
        positions=(pos,),
        team="AAA",
        opp="BBB",
        salary=salary,
        proj=proj,
        own_small=0.1,
        own_large=0.1,
    )


def _nfl_pool() -> list[Player]:
    # Black's first reply to 1. e4 is always a pawn or knight move (every
    # other piece is blocked on move 1) -- these two bands cover every
    # book continuation after "e4".
    pawns = [make_player(f"pawn{i}", "WR", 3000 + i) for i in range(8)]
    knights = [make_player(f"knight{i}", "TE", 4600 + i) for i in range(4)]
    return pawns + knights


def uci(move: str) -> chess.Move:
    return chess.Move.from_uci(move)


# --- Black's book play -------------------------------------------------------

def test_black_stays_in_book_while_a_line_matches():
    pool = _nfl_pool()
    white_player, *black_pool = pool

    result = play_white_move(BuildState(), uci("e2e4"), white_player, NFL, CONTEST, BOOK)
    assert result.message is None

    black_result = play_black_move(
        result.state, BOOK, {}, 0, NFL, CONTEST, black_pool, random.Random(1)
    )

    played_san = black_result.state.black_moves[-1].san
    assert played_san in book_continuations(("e4",), BOOK)
    assert black_result.opening is not None  # a name is exposed once in book


def test_same_seed_gives_the_same_build():
    pool = _nfl_pool()
    white_player, *black_pool = pool
    result = play_white_move(BuildState(), uci("e2e4"), white_player, NFL, CONTEST, BOOK)

    r1 = play_black_move(result.state, BOOK, {}, 0, NFL, CONTEST, black_pool, random.Random(99))
    r2 = play_black_move(result.state, BOOK, {}, 0, NFL, CONTEST, black_pool, random.Random(99))

    assert r1.state.black_moves[-1].san == r2.state.black_moves[-1].san
    assert r1.state.black_moves[-1].player.id == r2.state.black_moves[-1].player.id


def test_different_seeds_can_give_different_builds():
    # Sanity check for the determinism test above: confirm the seed is
    # actually doing something, not just that nothing varies by chance.
    pool = _nfl_pool()
    white_player, *black_pool = pool
    result = play_white_move(BuildState(), uci("e2e4"), white_player, NFL, CONTEST, BOOK)

    sans = {
        play_black_move(result.state, BOOK, {}, 0, NFL, CONTEST, black_pool, random.Random(seed))
        .state.black_moves[-1]
        .san
        for seed in range(20)
    }
    assert len(sans) > 1


# --- template mode (Task 13) --------------------------------------------------

def test_play_black_template_move_plays_exactly_with_highest_projection():
    pool = _nfl_pool()
    white_player, *black_pool = pool
    state = play_white_move(BuildState(), uci("e2e4"), white_player, NFL, CONTEST, BOOK).state

    result = play_black_template_move(state, uci("e7e5"), NFL, CONTEST, black_pool, BOOK)

    assert result is not None
    assert result.state.black_moves[-1].san == "e5"
    expected = next(p for p in black_pool if classify(p, NFL) is Piece.PAWN)  # highest proj, tie-break stable
    assert result.state.black_moves[-1].player.id == expected.id
    assert result.opening is not None


def test_play_black_template_move_returns_none_when_dfs_illegal():
    white_player = make_player("w1", "WR", 3000)
    state = play_white_move(BuildState(), uci("e2e4"), white_player, NFL, CONTEST, BOOK).state

    result = play_black_template_move(state, uci("e7e5"), NFL, CONTEST, [], BOOK)  # no candidates at all

    assert result is None


# --- Black's book-line commitment outside a template (Task 13) --------------
# A small synthetic book: two lines sharing "e4 e5 Nf3" but diverging at
# Black's *second* move (Nc6 vs Nf6) -- real enough to prove commitment
# persists across turns, not just that the same move got re-picked by luck.
_LINE_A = BookLine(eco="X1", name="Line A", moves=("e4", "e5", "Nf3", "Nc6"))
_LINE_B = BookLine(eco="X2", name="Line B", moves=("e4", "e5", "Nf3", "Nf6"))
_SYNTH_BOOK = [_LINE_A, _LINE_B]


def test_black_commits_to_a_book_line_and_keeps_it_while_white_stays_in_it():
    white_pawn = make_player("w_pawn", "WR", 3000)
    white_knight = make_player("w_knight", "TE", 4600)
    black_pool = [make_player(f"b_pawn{i}", "WR", 3000 + i) for i in range(2)] + [
        make_player(f"b_knight{i}", "TE", 4600 + i) for i in range(2)
    ]

    state = play_white_move(BuildState(), uci("e2e4"), white_pawn, NFL, CONTEST, _SYNTH_BOOK).state
    black1 = play_black_move(state, _SYNTH_BOOK, {}, 0, NFL, CONTEST, black_pool, random.Random(7))
    assert black1.state.black_moves[-1].san == "e5"
    committed = black1.state.black_committed_line
    assert committed in (_LINE_A.moves, _LINE_B.moves)

    state2 = play_white_move(black1.state, uci("g1f3"), white_knight, NFL, CONTEST, _SYNTH_BOOK).state

    # Vary the rng across many trials: if Black were re-rolling every ply
    # instead of honoring its commitment, some of these would land on the
    # sibling line's move (Nc6 vs Nf6) instead.
    sans = {
        play_black_move(state2, _SYNTH_BOOK, {}, 0, NFL, CONTEST, black_pool, random.Random(seed))
        .state.black_moves[-1]
        .san
        for seed in range(30)
    }
    assert sans == {committed[3]}


def test_black_picks_the_closest_rank_line():
    # Task 20: Line A's family rank (1) is closer to the target rank (1)
    # than Line B's (90) -- Black must pick A regardless of seed.
    white_pawn = make_player("w_pawn", "WR", 3000)
    black_pool = [make_player(f"b_pawn{i}", "WR", 3000 + i) for i in range(2)] + [
        make_player(f"b_knight{i}", "TE", 4600 + i) for i in range(2)
    ]
    family_ranks = {"Line A": 1, "Line B": 90}
    target_rank = 1

    state = play_white_move(BuildState(), uci("e2e4"), white_pawn, NFL, CONTEST, _SYNTH_BOOK).state

    for seed in range(10):
        result = play_black_move(
            state, _SYNTH_BOOK, family_ranks, target_rank, NFL, CONTEST, black_pool, random.Random(seed)
        )
        assert result.state.black_committed_line == _LINE_A.moves


def test_black_prefers_a_ranked_line_over_an_unranked_one():
    # Task 20: an unranked family (missing from family_ranks) counts as
    # farthest -- Line B (unranked) must lose to Line A even though A's
    # own rank (50) is numerically far from the target (1); "farthest"
    # beats any real, finite distance.
    white_pawn = make_player("w_pawn", "WR", 3000)
    black_pool = [make_player(f"b_pawn{i}", "WR", 3000 + i) for i in range(2)] + [
        make_player(f"b_knight{i}", "TE", 4600 + i) for i in range(2)
    ]
    family_ranks = {"Line A": 50}  # "Line B" is absent -- unranked
    target_rank = 1

    state = play_white_move(BuildState(), uci("e2e4"), white_pawn, NFL, CONTEST, _SYNTH_BOOK).state

    for seed in range(10):
        result = play_black_move(
            state, _SYNTH_BOOK, family_ranks, target_rank, NFL, CONTEST, black_pool, random.Random(seed)
        )
        assert result.state.black_committed_line == _LINE_A.moves


def test_black_ties_between_lines_are_broken_by_the_seed():
    # Both families unranked (missing from family_ranks) -> both count
    # as farthest -> tied -> the seed decides.
    white_pawn = make_player("w_pawn", "WR", 3000)
    black_pool = [make_player(f"b_pawn{i}", "WR", 3000 + i) for i in range(2)] + [
        make_player(f"b_knight{i}", "TE", 4600 + i) for i in range(2)
    ]
    state = play_white_move(BuildState(), uci("e2e4"), white_pawn, NFL, CONTEST, _SYNTH_BOOK).state

    committed = {
        play_black_move(state, _SYNTH_BOOK, {}, 0, NFL, CONTEST, black_pool, random.Random(seed))
        .state.black_committed_line
        for seed in range(30)
    }
    assert len(committed) > 1  # both lines turn up across enough seeds


def test_black_re_chooses_when_white_deviates_from_the_line():
    white_pawn = make_player("w_pawn", "WR", 3000)
    white_knight = make_player("w_knight", "TE", 4600)
    black_pool = [make_player(f"b_pawn{i}", "WR", 3000 + i) for i in range(4)] + [
        make_player(f"b_knight{i}", "TE", 4600 + i) for i in range(4)
    ]

    state = play_white_move(BuildState(), uci("e2e4"), white_pawn, NFL, CONTEST, _SYNTH_BOOK).state
    black1 = play_black_move(state, _SYNTH_BOOK, {}, 0, NFL, CONTEST, black_pool, random.Random(7))
    assert black1.state.black_committed_line is not None

    # White deviates: Nc3 instead of either line's Nf3.
    state2 = play_white_move(black1.state, uci("b1c3"), white_knight, NFL, CONTEST, _SYNTH_BOOK).state
    black2 = play_black_move(state2, _SYNTH_BOOK, {}, 0, NFL, CONTEST, black_pool, random.Random(7))

    assert black2.state.black_committed_line is None  # nothing in the synthetic book matches "e4 e5 Nc3"


_WHITE_LINE = ("e2e4", "g1f3")  # real book moves, always legal here regardless of Black's own replies


def _drive_multi_ply(seed: int) -> tuple[list[str], tuple[str, ...] | None]:
    white_pool = [make_player("w_pawn", "WR", 3000), make_player("w_knight", "TE", 4600)]
    black_pool = [make_player(f"b_pawn{i}", "WR", 3000 + i) for i in range(8)] + [
        make_player(f"b_knight{i}", "TE", 4600 + i) for i in range(8)
    ]
    state = BuildState()
    rng = random.Random(seed)
    black_sans: list[str] = []
    for white_uci in _WHITE_LINE:
        move = uci(white_uci)
        piece = piece_for_chess_type(state.board.piece_type_at(move.from_square))
        player = next(p for p in white_pool if p.id not in state.locked_player_ids and classify(p, NFL) is piece)
        state = play_white_move(state, move, player, NFL, CONTEST, BOOK).state
        black_result = play_black_move(state, BOOK, {}, 0, NFL, CONTEST, black_pool, rng)
        state = black_result.state
        black_sans.append(state.black_moves[-1].san)
    return black_sans, state.black_committed_line


def test_same_seed_gives_the_same_build_across_multiple_plies():
    assert _drive_multi_ply(99) == _drive_multi_ply(99)


def test_different_seeds_can_give_different_multi_ply_builds():
    results = {tuple(_drive_multi_ply(seed)[0]) for seed in range(20)}
    assert len(results) > 1


# --- King modes (Task 14) -----------------------------------------------------

def test_move_is_completable_true_for_a_silent_king_move_with_empty_pool():
    state = place_kings(make_player("qb_w", "QB", 6500), make_player("qb_b", "QB", 6200), NFL, CONTEST)
    state = apply_move(state, uci("e2e4"), make_player("w_pawn", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("d7d5"), make_player("b_pawn", "WR", 3000), NFL, CONTEST)

    king_move = uci("e1e2")
    assert king_move in state.board.legal_moves

    # PLACED: locks no one, so an empty pool is still fine. EMERGE: this
    # move would need to lock a brand-new QB, and there's none to find.
    assert move_is_completable(state, king_move, NFL, CONTEST, [], KingMode.PLACED) is True
    assert move_is_completable(state, king_move, NFL, CONTEST, [], KingMode.EMERGE) is False


def test_black_king_move_in_placed_mode_locks_no_player():
    state = place_kings(make_player("qb_w", "QB", 6500), make_player("qb_b", "QB", 6200), NFL, CONTEST)
    state = apply_move(state, uci("e2e4"), make_player("w_pawn", "WR", 3000), NFL, CONTEST)

    result = play_black_template_move(
        state, uci("e7e5"), NFL, CONTEST, [make_player("b_pawn", "WR", 3000)], BOOK, KingMode.PLACED
    )
    assert result is not None
    state = result.state
    assert len(state.black_moves) == 2  # the setup-placed King + the e5 Pawn pick

    state = apply_move(state, uci("d2d4"), make_player("w_pawn2", "WR", 3100), NFL, CONTEST)
    before = state.black_moves

    king_move = uci("e8e7")
    assert king_move in state.board.legal_moves
    result2 = play_black_template_move(state, king_move, NFL, CONTEST, [], BOOK, KingMode.PLACED)

    assert result2 is not None
    assert result2.state.black_moves == before  # unchanged -- no new lock
    assert result2.state.board.piece_type_at(chess.E7) == chess.KING  # the king really did move


def test_king_capture_in_placed_mode_now_works():
    # Previously-flagged gap (Task 14/15 session logs): a King capture
    # in PLACED mode was unsupported, since the old capture rule needed
    # to both suppress the King's own new pick AND still transfer the
    # captured piece, with no primitive for "transfer only." Task 18
    # removes the mover's own pick from every capture -- the captured
    # player IS the pick, regardless of which piece captured -- so that
    # conflict no longer exists and this just works now.
    white_king = make_player("qb_w", "QB", 6500)
    black_king = make_player("qb_b", "QB", 6200)
    captured_knight = make_player("te_captured", "TE", 4600)

    board = chess.Board("4k3/8/8/8/8/8/4n3/4K3 w - - 0 1")
    state = BuildState(
        board=board,
        white_moves=[Move(side=Side.WHITE, piece=Piece.KING, san="(placed)", player=white_king)],
        black_moves=[
            Move(side=Side.BLACK, piece=Piece.KING, san="(placed)", player=black_king),
            Move(side=Side.BLACK, piece=Piece.KNIGHT, san="Ne2", player=captured_knight),
        ],
        locked_player_ids={white_king.id, black_king.id, captured_knight.id},
        piece_locks={chess.E2: [captured_knight]},
    )

    king_capture = uci("e1e2")
    assert king_capture in state.board.legal_moves
    assert state.board.is_capture(king_capture)

    result = play_white_move(state, king_capture, None, NFL, CONTEST, BOOK, king_mode=KingMode.PLACED)

    assert len(result.state.white_moves) == 2  # the placed King + the captured Knight
    assert result.state.white_moves[-1].player.id == captured_knight.id
    assert result.state.black_moves == [state.black_moves[0]]  # Black keeps only its King


# --- capturing a piece that never moved (Task 19) ----------------------------

def test_black_can_capture_an_unmoved_knight_and_gets_a_knight_pick():
    # Previously avoided (no lock history meant no legal capture at
    # all): Black's bishop captures White's knight, still on its home
    # square g1 (White only ever moves its OTHER knight/pawns) -- Task
    # 19 lets Black play this now, picking its own Knight (the same
    # highest-projection placeholder every other pick uses) rather than
    # transferring anything. A real move sequence from the start
    # position (rather than a hand-built FEN) so `san_history` can
    # still replay it.
    board = chess.Board()
    for san in ("Nc3", "e5", "f3", "Bc5", "a3"):
        board.push_san(san)
    state = BuildState(board=board)
    capture_move = board.parse_san("Bxg1")
    assert capture_move in state.board.legal_moves
    assert state.board.is_capture(capture_move)

    result = play_black_template_move(state, capture_move, NFL, CONTEST, _nfl_pool(), BOOK, KingMode.EMERGE)

    assert result is not None
    assert len(result.state.black_moves) == 1
    record = result.state.black_moves[0]
    assert record.piece is Piece.KNIGHT
    assert record.player.id == "knight0"  # highest-proj eligible Knight in _nfl_pool()
    assert result.state.white_moves == []  # nothing removed -- there was nothing to remove


# --- end condition -------------------------------------------------------------

def test_build_ends_on_whites_completion_with_black_incomplete():
    white_player = make_player("w1", "ANY", 1000)

    result = play_white_move(BuildState(), uci("e2e4"), white_player, TOY_SPORT, CONTEST, book=[])

    assert result.message == HAPPY_HUNTING
    assert {m.player.id for m in result.state.white_moves} == {"w1"}
    assert result.state.black_moves == []  # Black never got a turn, let alone finished


def test_black_with_a_full_lineup_still_moves_without_locking():
    # Hand-built: Black already has its one slot filled (full under
    # TOY_SPORT) while White still has none locked -- an edge case that
    # wouldn't arise through normal alternating play with equal roster
    # sizes (White's own completion would have already ended the build),
    # but that's exactly why play_black_move needs to be tested in this
    # state directly rather than only through a played-out sequence.
    board = chess.Board()
    board.push(uci("e2e4"))  # so it's Black's turn
    black_player = make_player("b1", "ANY", 1000)
    state = BuildState(
        board=board,
        white_moves=[],
        black_moves=[Move(side=Side.BLACK, piece=Piece.PAWN, san="(elsewhere)", player=black_player)],
        locked_player_ids={black_player.id},
    )

    result = play_black_move(state, [], {}, 0, TOY_SPORT, CONTEST, [], random.Random(3))

    assert result.state.black_moves == state.black_moves  # unchanged -- no one new locked
    assert result.state.locked_player_ids == state.locked_player_ids
    assert len(result.state.board.move_stack) == len(board.move_stack) + 1  # but a real move was made
    assert result.message is None  # White still hasn't completed; the build isn't over


# --- capture transfer pre-check (Task 11c) -----------------------------------

def test_no_valueerror_escapes_play_black_move_for_an_infeasible_capture():
    # Black already has one DST locked. White's e4 pawn is also a DST
    # pick, and dxe4 would transfer it over as Black's pick for this
    # move (Task 18) -- giving Black two DSTs, which DST's single slot
    # can't hold. Before Task 11c's fix (under the old two-pick capture
    # rule), this exact shape escaped `play_black_move` as an uncaught
    # ValueError (reproduced on real data at seeds 17/18 in Task 11b).
    # Across many seeds here, play_black_move must never raise it, and
    # must never actually complete that transfer.
    b_dst1 = make_player("b_dst1", "DST", 2500)
    state = apply_move(BuildState(), uci("d2d4"), make_player("w_f1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("d7d5"), b_dst1, NFL, CONTEST)
    w_dst_captured = make_player("w_dst_captured", "DST", 2600)
    state = apply_move(state, uci("e2e4"), w_dst_captured, NFL, CONTEST)

    capture_move = uci("d5e4")
    assert capture_move in state.board.legal_moves
    assert state.board.is_capture(capture_move)

    pool = [make_player(f"filler_wr{i}", "WR", 3000 + i) for i in range(8)] + [
        make_player(f"filler_te{i}", "TE", 4600 + i) for i in range(4)
    ]

    for seed in range(50):
        result = play_black_move(state, [], {}, 0, NFL, CONTEST, pool, random.Random(seed))
        positions = [m.player.positions[0] for m in result.state.black_moves]
        assert positions.count("DST") <= 1  # the overflowing transfer never went through
        assert "w_dst_captured" not in {m.player.id for m in result.state.black_moves}


# --- dead-end endings (Task 11e) ---------------------------------------------

def _fully_boxed_white_roster() -> list[Move]:
    """8 locked White players filling every non-QB slot exactly (RB x2,
    WR x3 + the 1 FLEX, TE x1, DST x1) -- only QB is left open.
    """
    rbs = [make_player(f"rb{i}", "RB", 5200 + i, proj=1.0) for i in range(2)]
    wrs = [make_player(f"wr{i}", "WR", 5000 + i, proj=1.0) for i in range(4)]  # 3 base + 1 FLEX
    te = make_player("te0", "TE", 4600, proj=1.0)
    dst = make_player("dst0", "DST", 2500, proj=1.0)
    return [
        Move(side=Side.WHITE, piece=Piece.ROOK, san="x", player=p) for p in rbs
    ] + [
        Move(side=Side.WHITE, piece=Piece.BISHOP, san="x", player=p) for p in wrs
    ] + [
        Move(side=Side.WHITE, piece=Piece.KNIGHT, san="x", player=te),
        Move(side=Side.WHITE, piece=Piece.PAWN, san="x", player=dst),
    ]


def test_white_boxed_king_with_only_qb_open_ends_the_build():
    # The pristine starting position's White king (e1) already has zero
    # legal moves -- boxed by its own queen, bishop, and d2/e2/f2 pawns,
    # none of which have moved here. With every other roster slot already
    # full (hand-built below), every one of the 20 legal first moves
    # (16 pawn + 4 knight) needs a slot that's already full too, so
    # nothing else can substitute for the missing king move.
    white_moves = _fully_boxed_white_roster()
    state = BuildState(
        white_moves=white_moves,
        locked_player_ids={m.player.id for m in white_moves},
    )
    assert state.board.turn == chess.WHITE

    result = check_white_dead_end(state, NFL, CONTEST, [])

    assert result is not None
    assert result.message == NO_LEGAL_MOVES
    assert result.open_slots == {"QB": 1}
    assert result.state.white_moves == white_moves  # nothing changed -- build just ends


def test_white_with_a_legal_move_is_not_a_dead_end():
    # A fresh build: White has 20 legal first moves and a normal player
    # pool, so this must NOT be reported as a dead end.
    pool = [make_player(f"pawn{i}", "WR", 3000 + i) for i in range(4)] + [
        make_player(f"knight{i}", "TE", 4600 + i) for i in range(2)
    ]
    assert check_white_dead_end(BuildState(), NFL, CONTEST, pool) is None
