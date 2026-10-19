from pathlib import Path

import chess
import pytest

from dfs_chess.config import ContestConfig
from dfs_chess.models import BuildState, KingMode, Move, Piece, Player, Side
from dfs_chess.pieces import classify
from dfs_chess.rules import (
    lineup_still_completable,
    apply_capture_move,
    apply_move,
    assign_roster_slots,
    can_castle,
    castle,
    is_legal_capture,
    is_legal_move,
    place_kings,
    switch_king,
)
from dfs_chess.sport import load_sport_config

CONTEST = ContestConfig(cap=50000, field_size=1000, payouts=[])
NFL = load_sport_config(
    Path(__file__).resolve().parent.parent / "config" / "sports" / "nfl.json"
)


def make_player(id_: str, pos: str, salary: int, team: str = "AAA") -> Player:
    return Player(
        id=id_,
        name=id_,
        positions=(pos,),
        team=team,
        opp="BBB",
        salary=salary,
        proj=10.0,
        own_small=0.1,
        own_large=0.1,
        floor=6.0,
        ceiling=16.0,
    )


def uci(move: str) -> chess.Move:
    return chess.Move.from_uci(move)


# --- chess legality + turn order -------------------------------------------

def test_illegal_chess_move_rejected():
    pawn = make_player("p1", "WR", 3000)  # cheap -> Pawn tier
    bad_move = uci("e2e5")  # pawns can't jump three squares
    assert is_legal_move(BuildState(), bad_move, pawn, NFL, CONTEST) is False
    with pytest.raises(ValueError):
        apply_move(BuildState(), bad_move, pawn, NFL, CONTEST)


def test_move_piece_must_match_classification():
    qb = make_player("qb1", "QB", 6000)  # pools as King only, never Knight
    assert classify(qb, NFL) == {Piece.KING}
    assert is_legal_move(BuildState(), uci("b1c3"), qb, NFL, CONTEST) is False


def test_turn_alternates():
    state = BuildState()
    assert state.board.turn == chess.WHITE

    state = apply_move(state, uci("e2e4"), make_player("w1", "WR", 3000), NFL, CONTEST)
    assert state.board.turn == chess.BLACK
    assert {m.player.id for m in state.white_moves} == {"w1"}

    state = apply_move(state, uci("e7e5"), make_player("b1", "WR", 3000), NFL, CONTEST)
    assert state.board.turn == chess.WHITE
    assert {m.player.id for m in state.black_moves} == {"b1"}


def test_san_comes_from_board():
    knight = make_player("te1", "TE", 5200)
    state = apply_move(BuildState(), uci("b1c3"), knight, NFL, CONTEST)
    assert state.white_moves[0].san == "Nc3"
    assert state.white_moves[0].piece is Piece.KNIGHT


# --- direct Rook move: team-restricted (RULES.md piece table) --------------

def test_direct_rook_move_without_a_locked_qb_accepts_any_rbwrte_team():
    # RULES.md "Direct Rook move": "if not [locked], list all RB/WR/TE."
    state = apply_move(BuildState(), uci("a2a4"), make_player("w1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("a7a5"), make_player("b1", "WR", 3000), NFL, CONTEST)

    teammate = make_player("rb1", "RB", 5200, team="CIN")
    assert is_legal_move(state, uci("a1a3"), teammate, NFL, CONTEST) is True

    other_team = make_player("rb2", "RB", 5300, team="DET")
    assert is_legal_move(state, uci("a1a3"), other_team, NFL, CONTEST) is True


def test_direct_rook_move_with_a_locked_qb_requires_a_teammate():
    # RULES.md "Direct Rook move": "if the side's QB is locked, list his
    # teammates."
    qb = make_player("qb1", "QB", 6000, team="CIN")
    state = apply_move(BuildState(), uci("e2e4"), make_player("w1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("e7e5"), make_player("b1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("a2a4"), make_player("w2", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("a7a5"), make_player("b2", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("e1e2"), qb, NFL, CONTEST)  # King move locks the QB (CIN)
    state = apply_move(state, uci("h7h6"), make_player("b3", "WR", 3000), NFL, CONTEST)

    teammate = make_player("rb1", "RB", 5200, team="CIN")
    assert is_legal_move(state, uci("a1a3"), teammate, NFL, CONTEST) is True

    other_team = make_player("rb2", "RB", 5300, team="DET")
    assert is_legal_move(state, uci("a1a3"), other_team, NFL, CONTEST) is False


# --- exclusivity ------------------------------------------------------------

def test_exclusivity_blocks_the_other_side():
    rb = make_player("rb1", "RB", 5200)
    state = apply_move(BuildState(), uci("a2a4"), make_player("w1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("a7a5"), make_player("b1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("a1a3"), rb, NFL, CONTEST)  # White rook locks rb
    assert is_legal_move(state, uci("a8a6"), rb, NFL, CONTEST) is False  # Black can't repick it


def test_exclusivity_blocks_the_same_side_repicking():
    rb = make_player("rb1", "RB", 5200)
    state = apply_move(BuildState(), uci("a2a4"), make_player("w1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("h7h5"), make_player("b1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("a1a3"), rb, NFL, CONTEST)  # White rook locks rb
    state = apply_move(state, uci("h5h4"), make_player("b2", "WR", 3000), NFL, CONTEST)
    assert is_legal_move(state, uci("a3a5"), rb, NFL, CONTEST) is False


# --- roster/salary (same rules for both sides) ------------------------------

def test_unknown_position_illegal_for_white():
    fb = make_player("fb1", "FB", 3000)
    assert classify(fb, NFL) == {Piece.PAWN}  # classifies fine...
    assert is_legal_move(BuildState(), uci("e2e4"), fb, NFL, CONTEST) is False  # ...but DK has no FB slot


def test_second_king_illegal_for_white():
    state = apply_move(BuildState(), uci("e2e4"), make_player("w1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("h7h6"), make_player("b1", "WR", 3000), NFL, CONTEST)
    qb1 = make_player("qb1", "QB", 6000)
    state = apply_move(state, uci("e1e2"), qb1, NFL, CONTEST)  # King move locks QB1
    state = apply_move(state, uci("h6h5"), make_player("b2", "WR", 3000), NFL, CONTEST)

    qb2 = make_player("qb2", "QB", 5500)
    assert is_legal_move(state, uci("e2e3"), qb2, NFL, CONTEST) is False  # chess-legal, DFS-blocked


def test_lineup_impossible_to_complete_illegal_for_black():
    state = apply_move(BuildState(), uci("e2e4"), make_player("w1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("e7e5"), make_player("b1", "WR", 3000), NFL, CONTEST)  # frees e7
    state = apply_move(state, uci("d2d3"), make_player("w2", "WR", 3000), NFL, CONTEST)
    qb1 = make_player("qb1_b", "QB", 6000)
    state = apply_move(state, uci("e8e7"), qb1, NFL, CONTEST)  # Black King locks QB1
    state = apply_move(state, uci("d3d4"), make_player("w3", "WR", 3000), NFL, CONTEST)

    qb2 = make_player("qb2_b", "QB", 5500)  # a 2nd QB can never fit a DK roster
    assert is_legal_move(state, uci("e7e6"), qb2, NFL, CONTEST) is False


def test_cap_overflow_illegal_for_white():
    tight = ContestConfig(cap=10000, field_size=1000, payouts=[])
    dst1 = make_player("dst1", "DST", 5200)
    dst2 = make_player("dst2", "DST", 5100)  # 5200 + 5100 = 10300 > 10000
    state = apply_move(BuildState(), uci("e2e4"), dst1, NFL, tight)
    state = apply_move(state, uci("a7a6"), make_player("b1", "WR", 3000), NFL, tight)
    assert is_legal_move(state, uci("d2d4"), dst2, NFL, tight) is False


def test_cap_overflow_illegal_for_black():
    tight = ContestConfig(cap=10000, field_size=1000, payouts=[])
    dst1 = make_player("dst1", "DST", 5200)
    dst2 = make_player("dst2", "DST", 5100)  # 5200 + 5100 = 10300 > 10000
    state = apply_move(BuildState(), uci("e2e4"), make_player("w1", "WR", 3000), NFL, tight)
    state = apply_move(state, uci("e7e5"), dst1, NFL, tight)
    state = apply_move(state, uci("d2d3"), make_player("w2", "WR", 3000), NFL, tight)
    assert is_legal_move(state, uci("d7d5"), dst2, NFL, tight) is False


# --- roster/salary feasibility, tested directly -----------------------------
# `lineup_still_completable` is the one function `is_legal_move`, `castle`,
# and `apply_capture_move` all call to decide overflow -- these exercise it
# with plain Player lists, independent of chess legality or which call site
# uses it.

def test_flex_can_absorb_one_extra_rb():
    roster = [make_player(f"rb{i}", "RB", 5200) for i in range(3)]  # 3rd RB uses the 1 flex
    assert lineup_still_completable(roster, NFL, CONTEST.cap) is True


def test_flex_double_overflow_illegal():
    roster = [make_player(f"rb{i}", "RB", 5200) for i in range(3)] + [
        make_player(f"wr{i}", "WR", 5000) for i in range(3)
    ]
    assert lineup_still_completable(roster, NFL, CONTEST.cap) is True  # flex spent on the 3rd RB
    overflowed = roster + [make_player("wr4", "WR", 5300)]  # 4th WR would need the flex too
    assert lineup_still_completable(overflowed, NFL, CONTEST.cap) is False


def test_second_dst_illegal():
    one_dst = [make_player("dst1", "DST", 2500)]
    assert lineup_still_completable(one_dst, NFL, CONTEST.cap) is True
    two_dst = one_dst + [make_player("dst2", "DST", 2600)]
    assert lineup_still_completable(two_dst, NFL, CONTEST.cap) is False


def test_castle_cap_overflow():
    # Mirrors castle()'s own check: Knight+Bishop already locked (9600),
    # King+Rook (12000) pushes the total to 21600 > a 15000 cap.
    already_locked = [make_player("te1", "TE", 4600), make_player("wr1", "WR", 5000)]
    king = make_player("qb1", "QB", 6000)
    rook = make_player("rb1", "RB", 6000)
    assert lineup_still_completable(already_locked + [king, rook], NFL, 15000) is False


def test_capture_illegal_on_cap_overflow():
    # Mirrors is_legal_capture()'s own check: the captured player (Task
    # 18: the capturing move's only pick) on top of what's already
    # locked exceeds a tight cap.
    already_locked = make_player("wr1", "WR", 5100)
    captured = make_player("rb1", "RB", 5200)  # 5100 + 5200 = 10300 > 10000
    assert lineup_still_completable([already_locked, captured], NFL, 10000) is False


def test_capture_illegal_on_roster_overflow():
    # The capturing side already has its own QB; capturing a 2nd QB-tier
    # player can never fit a DK roster, regardless of salary/cap.
    already_locked = [make_player("qb2", "QB", 5900)]
    captured_qb = make_player("qb1", "QB", 6000)
    assert lineup_still_completable(already_locked + [captured_qb], NFL, CONTEST.cap) is False


def test_multi_position_player_fills_either_slot():
    # A hybrid RB/WR player, per CLAUDE.md's "Multi-sport ready": "can fill
    # any slot matching any of them."
    hybrid = Player(
        id="h1",
        name="Hybrid",
        positions=("RB", "WR"),
        team="AAA",
        opp="BBB",
        salary=3000,
        proj=10.0,
        own_small=0.1,
        own_large=0.1,
        floor=6.0,
        ceiling=16.0,
    )
    three_rbs = [make_player(f"rb{i}", "RB", 5200) for i in range(3)]  # fills RB(2) + FLEX(1)
    roster = three_rbs + [hybrid]
    assert lineup_still_completable(roster, NFL, CONTEST.cap) is True  # hybrid still fits via WR


# Task 43: DK slot display on the finish screen/Copy lineup.

def test_assign_roster_slots_dedicated_slots_no_overflow():
    roster = [
        make_player("qb1", "QB", 6000),
        make_player("rb1", "RB", 5200),
        make_player("wr1", "WR", 5000),
        make_player("te1", "TE", 4500),
    ]
    assert assign_roster_slots(roster, NFL.roster_slots) == ["QB", "RB", "WR", "TE"]


def test_assign_roster_slots_3rd_rb_lands_in_flex():
    # Which of the 3 interchangeable RBs ends up labeled FLEX vs. RB is
    # whatever the augmenting search finds first, not lock order (RB and
    # RB are indistinguishable slot instances anyway) -- the multiset of
    # labels is the actual contract, not a specific player->label mapping.
    roster = [make_player(f"rb{i}", "RB", 5200) for i in range(3)]
    assert sorted(assign_roster_slots(roster, NFL.roster_slots)) == ["FLEX", "RB", "RB"]


def test_assign_roster_slots_full_9_player_lineup():
    roster = [
        make_player("qb1", "QB", 6000),
        make_player("rb1", "RB", 5200),
        make_player("rb2", "RB", 5300),
        make_player("wr1", "WR", 5000),
        make_player("wr2", "WR", 5100),
        make_player("wr3", "WR", 5200),
        make_player("te1", "TE", 4500),
        make_player("rb3", "RB", 5400),  # flex
        make_player("dst1", "DST", 2500),
    ]
    slots = assign_roster_slots(roster, NFL.roster_slots)
    assert sorted(slots) == ["DST", "FLEX", "QB", "RB", "RB", "TE", "WR", "WR", "WR"]


def test_assign_roster_slots_multi_position_player_gets_a_valid_slot():
    # 3 pure RBs fill RB(2)+FLEX(1) entirely; the RB/WR hybrid has nowhere
    # left in the RB family, but WR(3) is wide open -- same feasibility
    # test_multi_position_player_fills_either_slot already covers; this
    # just checks assign_roster_slots finds the same valid total
    # assignment max_assignable already guarantees exists, not which
    # specific slot name the hybrid draws.
    hybrid = Player(
        id="h1",
        name="Hybrid",
        positions=("RB", "WR"),
        team="AAA",
        opp="BBB",
        salary=3000,
        proj=10.0,
        own_small=0.1,
        own_large=0.1,
        floor=6.0,
        ceiling=16.0,
    )
    three_rbs = [make_player(f"rb{i}", "RB", 5200) for i in range(3)]
    roster = three_rbs + [hybrid]
    slots = assign_roster_slots(roster, NFL.roster_slots)
    assert len(slots) == len(roster)
    assert all(s != "" for s in slots)
    assert sorted(slots) == ["FLEX", "RB", "RB", "WR"]


# --- castling ----------------------------------------------------------------

def test_can_castle_false_before_knight_and_bishop():
    assert can_castle(BuildState(), Side.WHITE) is False


def test_castle_illegal_before_knight_and_bishop():
    # Board where b1/c1/d1 happen to be clear, but reached without ever going
    # through our engine -- so nothing was ever "locked" for Knight/Bishop.
    raw_board = chess.Board()
    for m in ["d2d4", "a7a6", "b1c3", "a6a5", "c1f4", "a5a4", "d1d3", "a4a3"]:
        raw_board.push(chess.Move.from_uci(m))
    state = BuildState(board=raw_board)

    assert can_castle(state, Side.WHITE) is False
    king = make_player("qb1", "QB", 6000)
    rook = make_player("rb1", "RB", 5200)
    with pytest.raises(ValueError):
        castle(state, uci("e1c1"), king, rook, NFL, CONTEST)


def _state_ready_to_castle_queenside() -> BuildState:
    """Plays Nc3, Bf4, Qd3 for White (clearing b1/c1/d1 and locking a
    Knight-tier + Bishop-tier + Queen-tier player), with harmless Black
    a-pawn replies, leaving White ready to play O-O-O.
    """
    state = apply_move(BuildState(), uci("d2d4"), make_player("w_pawn", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("a7a6"), make_player("b1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("b1c3"), make_player("te1", "TE", 5200), NFL, CONTEST)
    state = apply_move(state, uci("a6a5"), make_player("b2", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("c1f4"), make_player("wr1", "WR", 5000), NFL, CONTEST)
    state = apply_move(state, uci("a5a4"), make_player("b3", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("d1d3"), make_player("rb_queen", "RB", 7200), NFL, CONTEST)
    state = apply_move(state, uci("a4a3"), make_player("b4", "WR", 3000), NFL, CONTEST)
    return state


def test_castle_queenside_san_and_locks_king_and_rook():
    state = _state_ready_to_castle_queenside()
    assert can_castle(state, Side.WHITE) is True

    castle_move = uci("e1c1")
    assert state.board.is_queenside_castling(castle_move)
    assert castle_move in state.board.legal_moves

    king = make_player("qb1", "QB", 6000)
    rook = make_player("rb1", "RB", 5200)
    new_state = castle(state, castle_move, king, rook, NFL, CONTEST)

    assert {"qb1", "rb1"} <= new_state.locked_player_ids
    sans = {m.san for m in new_state.white_moves if m.player.id in ("qb1", "rb1")}
    assert sans == {"O-O-O"}
    assert new_state.board.piece_type_at(chess.C1) == chess.KING
    assert new_state.board.piece_type_at(chess.D1) == chess.ROOK
    assert new_state.board.turn == chess.BLACK


def test_castle_twice_illegal():
    state = castle(
        _state_ready_to_castle_queenside(),
        uci("e1c1"),
        make_player("qb1", "QB", 6000),
        make_player("rb1", "RB", 5200),
        NFL,
        CONTEST,
    )
    assert can_castle(state, Side.WHITE) is False


def test_castle_rejects_wrong_piece_types():
    state = _state_ready_to_castle_queenside()
    not_a_king = make_player("rb9", "RB", 5200)  # Rook-tier, not King
    rook = make_player("rb1", "RB", 5300)
    with pytest.raises(ValueError):
        castle(state, uci("e1c1"), not_a_king, rook, NFL, CONTEST)


# --- Rook = correlation: castling's Rook must be the King's teammate ------

def test_castle_rejects_a_rook_not_on_the_kings_team():
    state = _state_ready_to_castle_queenside()
    king = make_player("qb1", "QB", 6000, team="CIN")
    rook = make_player("rb1", "RB", 5200, team="DET")  # not a teammate
    with pytest.raises(ValueError):
        castle(state, uci("e1c1"), king, rook, NFL, CONTEST)


def test_castle_accepts_a_rook_on_the_kings_team():
    state = _state_ready_to_castle_queenside()
    king = make_player("qb1", "QB", 6000, team="CIN")
    rook = make_player("rb1", "RB", 5200, team="CIN")
    new_state = castle(state, uci("e1c1"), king, rook, NFL, CONTEST)
    assert {"qb1", "rb1"} <= new_state.locked_player_ids


def test_castle_respects_exclusivity():
    # A board built directly from a FEN (not played out through apply_move):
    # King and Rook both still home (castling rights intact), Knight and
    # Bishop developed off their home squares, queenside castling chess-legal.
    fen = "rnbqkbnr/1ppppppp/8/8/3P1B2/p1NQ4/PPP1PPPP/R3KBNR w KQkq - 0 5"
    board = chess.Board(fen)

    knight = make_player("te1", "TE", 4600)
    bishop = make_player("wr1", "WR", 5000)
    rook = make_player("rb1", "RB", 5200)  # the Rook White wants to castle with
    state = BuildState(
        board=board,
        white_moves=[
            Move(side=Side.WHITE, piece=Piece.KNIGHT, san="Nc3", player=knight),
            Move(side=Side.WHITE, piece=Piece.BISHOP, san="Bf4", player=bishop),
        ],
        # Black already took this same player elsewhere.
        black_moves=[Move(side=Side.BLACK, piece=Piece.ROOK, san="(elsewhere)", player=rook)],
        locked_player_ids={knight.id, bishop.id, rook.id},
    )
    assert can_castle(state, Side.WHITE) is True  # Knight + Bishop are developed...

    castle_move = uci("e1c1")
    assert castle_move in state.board.legal_moves  # ...and the chess move itself is legal...

    king = make_player("qb1", "QB", 6000)
    with pytest.raises(ValueError):  # ...but the Rook isn't White's to castle with.
        castle(state, castle_move, king, rook, NFL, CONTEST)


# --- King modes (Task 14) ---------------------------------------------------

def test_place_kings_locks_both_qbs_before_move_1():
    white_qb = make_player("qb_w", "QB", 6500)
    black_qb = make_player("qb_b", "QB", 6200)

    state = place_kings(white_qb, black_qb, NFL, CONTEST)

    assert state.white_moves == [Move(side=Side.WHITE, piece=Piece.KING, san="(placed)", player=white_qb)]
    assert state.black_moves == [Move(side=Side.BLACK, piece=Piece.KING, san="(placed)", player=black_qb)]
    assert state.locked_player_ids == {"qb_w", "qb_b"}
    assert state.board.move_stack == []  # no chess move happened


def test_place_kings_rejects_a_non_king_player():
    not_a_qb = make_player("rb1", "RB", 5200)
    black_qb = make_player("qb_b", "QB", 6200)
    with pytest.raises(ValueError):
        place_kings(not_a_qb, black_qb, NFL, CONTEST)


def test_place_kings_rejects_the_same_player_for_both_sides():
    qb = make_player("qb_shared", "QB", 6500)
    with pytest.raises(ValueError):
        place_kings(qb, qb, NFL, CONTEST)


def _state_ready_to_castle_queenside_placed(white_qb_team: str = "AAA") -> BuildState:
    """Like `_state_ready_to_castle_queenside`, but White's QB is
    already locked from setup (Task 14 PLACED king mode) before any
    move is played.
    """
    state = place_kings(make_player("qb_w", "QB", 6500, team=white_qb_team), make_player("qb_b", "QB", 6200), NFL, CONTEST)
    state = apply_move(state, uci("d2d4"), make_player("w_pawn", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("a7a6"), make_player("b1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("b1c3"), make_player("te1", "TE", 5200), NFL, CONTEST)
    state = apply_move(state, uci("a6a5"), make_player("b2", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("c1f4"), make_player("wr1", "WR", 5000), NFL, CONTEST)
    state = apply_move(state, uci("a5a4"), make_player("b3", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("d1d3"), make_player("rb_queen", "RB", 7200), NFL, CONTEST)
    state = apply_move(state, uci("a4a3"), make_player("b4", "WR", 3000), NFL, CONTEST)
    return state


def test_can_castle_in_placed_mode_ignores_the_setup_placed_king():
    state = _state_ready_to_castle_queenside_placed()
    # The setup-placed King is already in white_moves (Piece.KING), which
    # would block EMERGE-mode castling -- PLACED mode must not be fooled
    # by that signal.
    assert can_castle(state, Side.WHITE, KingMode.EMERGE) is False
    assert can_castle(state, Side.WHITE, KingMode.PLACED) is True


def test_castle_in_placed_mode_locks_only_the_rook():
    state = _state_ready_to_castle_queenside_placed()
    castle_move = uci("e1c1")
    assert state.board.is_queenside_castling(castle_move)

    rook = make_player("rb1", "RB", 5200)
    new_state = castle(state, castle_move, None, rook, NFL, CONTEST, KingMode.PLACED)

    assert "rb1" in new_state.locked_player_ids
    rook_moves = [m for m in new_state.white_moves if m.player.id == "rb1"]
    assert len(rook_moves) == 1 and rook_moves[0].piece is Piece.ROOK
    # Still exactly one King-piece entry for White -- the original setup
    # placement -- never a second one from castling.
    king_moves = [m for m in new_state.white_moves if m.piece is Piece.KING]
    assert len(king_moves) == 1
    assert king_moves[0].player.id == "qb_w"
    assert new_state.board.piece_type_at(chess.C1) == chess.KING
    assert new_state.board.piece_type_at(chess.D1) == chess.ROOK
    assert new_state.white_castled is True


def test_castle_in_placed_mode_rejects_a_rook_not_on_the_placed_qbs_team():
    state = _state_ready_to_castle_queenside_placed(white_qb_team="CIN")
    rook = make_player("rb1", "RB", 5200, team="DET")  # not a teammate of the placed QB
    with pytest.raises(ValueError):
        castle(state, uci("e1c1"), None, rook, NFL, CONTEST, KingMode.PLACED)


def test_castle_in_placed_mode_accepts_a_rook_on_the_placed_qbs_team():
    state = _state_ready_to_castle_queenside_placed(white_qb_team="CIN")
    rook = make_player("rb1", "RB", 5200, team="CIN")
    new_state = castle(state, uci("e1c1"), None, rook, NFL, CONTEST, KingMode.PLACED)
    assert "rb1" in new_state.locked_player_ids


def test_castle_twice_illegal_in_placed_mode():
    state = _state_ready_to_castle_queenside_placed()
    state = castle(state, uci("e1c1"), None, make_player("rb1", "RB", 5200), NFL, CONTEST, KingMode.PLACED)
    assert can_castle(state, Side.WHITE, KingMode.PLACED) is False


def test_switch_king_returns_old_qb_to_pool_and_locks_new():
    state = _state_ready_to_castle_queenside_placed()
    state = castle(state, uci("e1c1"), None, make_player("rb1", "RB", 5200), NFL, CONTEST, KingMode.PLACED)

    new_qb = make_player("qb_new", "QB", 5800)
    new_state = switch_king(state, Side.WHITE, new_qb, NFL, CONTEST)

    assert new_state is not None
    assert "qb_new" in new_state.locked_player_ids
    assert "qb_w" not in new_state.locked_player_ids  # old QB freed, available to either side
    king_moves = [m for m in new_state.white_moves if m.piece is Piece.KING]
    assert len(king_moves) == 1
    assert king_moves[0].player.id == "qb_new"


def test_switch_king_rejects_an_infeasible_new_qb():
    state = _state_ready_to_castle_queenside_placed()
    state = castle(state, uci("e1c1"), None, make_player("rb1", "RB", 5200), NFL, CONTEST, KingMode.PLACED)

    tight = ContestConfig(cap=1000, field_size=1000, payouts=[])  # far under any real QB's salary
    too_expensive = make_player("qb_new", "QB", 9000)

    result = switch_king(state, Side.WHITE, too_expensive, NFL, tight)

    assert result is None  # rejected -- caller keeps the original QB


# --- captures (Task 18: the captured player IS the capturing move's pick) --

def _state_with_a_capture_available() -> BuildState:
    state = apply_move(BuildState(), uci("e2e4"), make_player("w_pawn1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("d7d5"), make_player("b_pawn1", "WR", 3000), NFL, CONTEST)
    return state


def test_is_legal_move_rejects_every_capture():
    # Task 18: a capture is never resolved through the ordinary
    # new-pick path -- is_legal_move rejects it outright regardless of
    # the player passed, directing callers to is_legal_capture instead.
    state = _state_with_a_capture_available()
    capture_move = uci("e4d5")
    assert state.board.is_capture(capture_move)
    assert is_legal_move(state, capture_move, make_player("anyone", "WR", 3000), NFL, CONTEST) is False


def test_capture_adds_exactly_one_player_the_captured_one():
    state = _state_with_a_capture_available()
    capture_move = uci("e4d5")

    new_state = apply_capture_move(state, capture_move, NFL, CONTEST)

    # Exactly one player added to White -- the captured one -- not a
    # separate new pick for the capturing pawn too.
    assert len(new_state.white_moves) - len(state.white_moves) == 1
    assert {m.player.id for m in new_state.white_moves} == {"w_pawn1", "b_pawn1"}
    assert new_state.black_moves == []
    assert new_state.board.piece_at(chess.D5).color == chess.WHITE
    captured_move_record = next(m for m in new_state.white_moves if m.player.id == "b_pawn1")
    assert captured_move_record.san == "exd5"


def test_most_recently_locked_player_transfers_on_capture():
    k1 = make_player("te_k1", "TE", 5200)
    k2 = make_player("te_k2", "TE", 5300)
    state = apply_move(BuildState(), uci("b1c3"), k1, NFL, CONTEST)  # Nc3 locks K1
    state = apply_move(state, uci("d7d5"), make_player("b_pawn1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("c3e4"), k2, NFL, CONTEST)  # Ne4 locks K2 (same knight, moved again)

    capture_move = uci("d5e4")  # Black pawn captures the knight on e4
    assert state.board.is_capture(capture_move)
    assert not state.board.is_en_passant(capture_move)

    new_state = apply_capture_move(state, capture_move, NFL, CONTEST)

    assert {m.player.id for m in new_state.white_moves} == {"te_k1"}  # K1 (older) stays
    black_ids = {m.player.id for m in new_state.black_moves}
    assert "te_k2" in black_ids  # K2 (most recent) transferred
    assert "te_k1" not in black_ids


def _state_with_an_unmoved_pawn_capture_available() -> BuildState:
    # White's f7-targeting bishop captures Black's f7 pawn, which never moved.
    state = apply_move(BuildState(), uci("e2e4"), make_player("w_pawn1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("e7e5"), make_player("b_pawn1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("f1c4"), make_player("w_bishop1", "WR", 5000), NFL, CONTEST)
    state = apply_move(state, uci("b8c6"), make_player("b_knight1", "TE", 5200), NFL, CONTEST)
    return state


def test_capturing_an_unmoved_pawn_requires_and_locks_a_pawn_pick():
    # Task 19: a captured piece with no lock history has nothing to
    # transfer -- the capturing side picks a player of its own instead,
    # of the captured piece's own real chess type (here, Pawn).
    state = _state_with_an_unmoved_pawn_capture_available()
    capture_move = uci("c4f7")
    assert state.board.is_capture(capture_move)

    pawn_pick = make_player("wr_new", "WR", 3200)
    assert classify(pawn_pick, NFL) == {Piece.PAWN, Piece.ROOK}  # Rook too: no QB locked yet

    assert is_legal_capture(state, capture_move, NFL, CONTEST) is False  # no player supplied
    assert is_legal_capture(state, capture_move, NFL, CONTEST, pawn_pick) is True

    expected_san = state.board.san(capture_move)
    new_state = apply_capture_move(state, capture_move, NFL, CONTEST, pawn_pick)

    # Exactly one player added -- the new Pawn pick -- not a transfer:
    # the f7 pawn never had a locked player to begin with, so nothing
    # comes out of Black's side.
    assert len(new_state.white_moves) - len(state.white_moves) == 1
    assert new_state.black_moves == state.black_moves
    record = next(m for m in new_state.white_moves if m.player.id == "wr_new")
    assert record.piece is Piece.PAWN
    assert record.san == expected_san
    assert "wr_new" in new_state.locked_player_ids  # can't be picked again by either side


def test_capturing_an_unmoved_knight_gives_a_knight_pick():
    # A White bishop captures Black's g8 knight, still on its home
    # square -- no lock history, so (Task 19) the capturing side picks
    # its own Knight-type player instead of transferring one.
    board = chess.Board("4k1n1/8/8/8/2B5/8/8/4K3 w - - 0 1")
    state = BuildState(board=board)
    capture_move = uci("c4g8")
    assert state.board.is_capture(capture_move)

    knight_pick = make_player("te1", "TE", 5200)
    assert classify(knight_pick, NFL) == {Piece.KNIGHT, Piece.BISHOP, Piece.ROOK}

    assert is_legal_capture(state, capture_move, NFL, CONTEST) is False
    assert is_legal_capture(state, capture_move, NFL, CONTEST, knight_pick) is True

    new_state = apply_capture_move(state, capture_move, NFL, CONTEST, knight_pick)

    assert len(new_state.white_moves) == 1
    assert new_state.white_moves[0].player.id == "te1"
    assert new_state.white_moves[0].piece is Piece.KNIGHT
    assert "te1" in new_state.locked_player_ids  # can't be picked again by either side


def test_capturing_an_unmoved_piece_with_no_fitting_player_locks_nobody():
    # Rule change: a capture is always legal. White already has its one
    # DST slot filled; a DST-position player classifies as Pawn (NFL's
    # catch-all band) just like the captured, never-moved f7 pawn does --
    # but it can't fit any roster slot a second time, so no eligible
    # player fits this capture at all. The capture still happens; it
    # just locks nobody. Covers both calling conventions: no player
    # supplied at all, and one explicitly supplied that doesn't fit.
    w_dst1 = make_player("w_dst1", "DST", 2500)
    state = apply_move(BuildState(), uci("e2e4"), w_dst1, NFL, CONTEST)
    state = apply_move(state, uci("e7e5"), make_player("b_pawn1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("f1c4"), make_player("w_bishop1", "WR", 5000), NFL, CONTEST)
    state = apply_move(state, uci("b8c6"), make_player("b_knight1", "TE", 5200), NFL, CONTEST)

    capture_move = uci("c4f7")
    assert state.board.is_capture(capture_move)

    second_dst = make_player("b_dst2", "DST", 2600)
    assert classify(second_dst, NFL) == {Piece.PAWN}  # the right type...
    assert is_legal_capture(state, capture_move, NFL, CONTEST, second_dst) is False  # ...but doesn't fit

    for replacement in (None, second_dst):
        new_state = apply_capture_move(state, capture_move, NFL, CONTEST, replacement)
        assert new_state.white_moves == state.white_moves  # no new pick -- the capturing bishop locks nobody
        assert new_state.black_moves == state.black_moves  # the unmoved f7 pawn was never on Black's roster
        assert "b_dst2" not in new_state.locked_player_ids
        assert new_state.board.piece_at(chess.F7).color == chess.WHITE  # the capture itself still happened


def test_capture_returns_to_pool_when_transfer_would_overflow_the_roster():
    # Rule change: White already has one DST locked. Black's d5 pawn is
    # also a DST pick. Transferring it would give White two DSTs, which
    # DST's single slot can't hold -- the capture is still legal, but
    # the captured player leaves Black's roster and returns to the pool
    # (available to either side) instead of transferring; the capturing
    # pawn locks nobody.
    w_dst1 = make_player("w_dst1", "DST", 2500)
    state = apply_move(BuildState(), uci("e2e4"), w_dst1, NFL, CONTEST)
    b_dst_captured = make_player("b_dst_captured", "DST", 2600)
    state = apply_move(state, uci("d7d5"), b_dst_captured, NFL, CONTEST)

    capture_move = uci("e4d5")
    assert state.board.is_capture(capture_move)
    assert is_legal_capture(state, capture_move, NFL, CONTEST) is False  # doesn't fit -- still legal to attempt

    new_state = apply_capture_move(state, capture_move, NFL, CONTEST)

    assert new_state.white_moves == state.white_moves  # unchanged -- no new pick for the capturing side
    assert "b_dst_captured" not in {m.player.id for m in new_state.black_moves}  # left Black's roster
    assert "b_dst_captured" not in new_state.locked_player_ids  # back in the pool
    assert new_state.board.piece_at(chess.D5).color == chess.WHITE  # the capture itself still happened

    # Available to either side afterward: Black can now lock the very
    # same player who just returned to the pool (a pawn move, since DST
    # only classifies as Pawn).
    after_black_locks_him = apply_move(new_state, uci("c7c6"), b_dst_captured, NFL, CONTEST)
    assert "b_dst_captured" in {m.player.id for m in after_black_locks_him.black_moves}


def test_black_capturing_an_unmoved_piece_with_no_fitting_player_locks_nobody():
    # Mirrors the White test above, with Black as the capturing side.
    # Black's DST slot fills via 1...e5 (clearing e7, so the f8 bishop
    # can reach c5 in one move); the bishop then takes White's unmoved
    # f2 pawn from c5 (c5-d4-e3-f2, both squares still empty).
    b_dst1 = make_player("b_dst1", "DST", 2500)
    state = apply_move(BuildState(), uci("g2g3"), make_player("w_pawn1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("e7e5"), b_dst1, NFL, CONTEST)
    state = apply_move(state, uci("b1c3"), make_player("w_knight1", "TE", 5200), NFL, CONTEST)
    state = apply_move(state, uci("f8c5"), make_player("b_bishop1", "WR", 5000), NFL, CONTEST)
    state = apply_move(state, uci("h2h3"), make_player("w_pawn2", "WR", 3100), NFL, CONTEST)

    capture_move = uci("c5f2")  # Black's bishop captures White's unmoved f2 pawn
    assert state.board.is_capture(capture_move)
    assert state.board.turn == chess.BLACK

    second_dst = make_player("w_dst2", "DST", 2600)
    assert classify(second_dst, NFL) == {Piece.PAWN}
    assert is_legal_capture(state, capture_move, NFL, CONTEST, second_dst) is False  # doesn't fit

    new_state = apply_capture_move(state, capture_move, NFL, CONTEST, None)
    assert new_state.black_moves == state.black_moves  # the capturing bishop locks nobody
    assert new_state.white_moves == state.white_moves
    assert "w_dst2" not in new_state.locked_player_ids
    assert new_state.board.piece_at(chess.F2).color == chess.BLACK


def test_black_capture_returns_to_pool_when_transfer_would_overflow_the_roster():
    # Mirrors the White test above, with Black as the capturing side.
    b_dst1 = make_player("b_dst1", "DST", 2500)
    state = apply_move(BuildState(), uci("d2d4"), make_player("w_pawn1", "WR", 3000), NFL, CONTEST)
    state = apply_move(state, uci("d7d5"), b_dst1, NFL, CONTEST)
    w_dst_captured = make_player("w_dst_captured", "DST", 2600)
    state = apply_move(state, uci("e2e4"), w_dst_captured, NFL, CONTEST)

    capture_move = uci("d5e4")
    assert state.board.is_capture(capture_move)
    assert state.board.turn == chess.BLACK
    assert is_legal_capture(state, capture_move, NFL, CONTEST) is False

    new_state = apply_capture_move(state, capture_move, NFL, CONTEST)

    assert new_state.black_moves == state.black_moves  # unchanged -- no new pick for Black
    assert "w_dst_captured" not in {m.player.id for m in new_state.white_moves}  # left White's roster
    assert "w_dst_captured" not in new_state.locked_player_ids  # back in the pool
