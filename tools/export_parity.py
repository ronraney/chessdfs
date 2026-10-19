#!/usr/bin/env python3
"""Task 30: runs the Python engine on a fixed set of scenarios and writes
their results to web/src/engine/__fixtures__/parity.json, which
web/src/engine/parity.test.ts then replays through the TS engine and
compares exactly. This script is the ONLY source of truth for the JSON --
every value in it comes from calling the real dfs_chess engine functions
(rules.py/build.py/openings.py/config.py/pieces.py/loaders.py), never
reimplemented here. If a scenario's setup is wrong, the script itself
raises (nothing here catches exceptions), so a bad fixture never ships.

Deliberately excludes anything whose result depends on a seeded random
pick (RULES.md: Black's book commitment/free play, both engines' PRNGs
produce different literal values for the "same" seed -- see Task 29's
rng.ts) -- every scenario here is 100% deterministic given its inputs, so
a mismatch can only mean a real behavioral difference between the two
engines, never a random-pick coincidence.

Usage: python tools/export_parity.py
"""
from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path

import chess

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from dfs_chess.config import ContestConfig  # noqa: E402
from dfs_chess.loaders import load_etr_csv, load_line_stats, load_opening_book  # noqa: E402
from dfs_chess.models import BuildState, KingMode, Piece, Player, Side  # noqa: E402
from dfs_chess.openings import book_continuations, opening_name, rank_families  # noqa: E402
from dfs_chess.picklist import castle_qb_candidates, pick_list  # noqa: E402
from dfs_chess.pieces import classify  # noqa: E402
from dfs_chess.rules import (  # noqa: E402
    apply_capture_move,
    apply_move,
    castle,
    is_legal_capture,
    is_legal_move,
    lineup_still_completable,
    place_kings,
    switch_king,
)
from dfs_chess.sport import load_sport_config  # noqa: E402

ETR_PATH = REPO_ROOT / "data" / "samples" / "NFL Weekly DFS System - Projections.csv"
OPENINGS_DIR = REPO_ROOT / "data" / "openings"
LINE_STATS_PATH = OPENINGS_DIR / "line_stats.json"
SPORT_PATH = REPO_ROOT / "config" / "sports" / "nfl.json"
OUT_PATH = REPO_ROOT / "web" / "src" / "engine" / "__fixtures__" / "parity.json"

NFL = load_sport_config(SPORT_PATH)
CONTEST = ContestConfig(cap=50000, field_size=1000, payouts=[])


def make_player(id_: str, pos: str, salary: int, proj: float = 10.0, team: str = "AAA") -> Player:
    return Player(
        id=id_, name=id_, positions=(pos,), team=team, opp="BBB",
        salary=salary, proj=proj, own_small=0.1, own_large=0.1,
        floor=proj * 0.6, ceiling=proj * 1.6,
    )


def uci(move: str) -> chess.Move:
    return chess.Move.from_uci(move)


def player_dict(p: Player) -> dict:
    return {
        "id": p.id, "name": p.name, "positions": list(p.positions), "team": p.team,
        "opp": p.opp, "salary": p.salary, "proj": p.proj,
        "own_small": p.own_small, "own_large": p.own_large,
        "floor": p.floor, "ceiling": p.ceiling,
    }


# --- classification of every sample player ----------------------------------

def scenario_classify_all_players() -> dict:
    """Task "piece pools": classify() now returns every piece band a player
    qualifies for, not one first-match winner -- `expected` carries each
    player's full pool, sorted for a stable comparison.
    """
    players = load_etr_csv(ETR_PATH)
    return {
        "name": "classify_all_sample_players",
        "kind": "classify_all_players",
        "num_players": len(players),
        "players": [player_dict(p) for p in players],
        "expected": [{"id": p.id, "pieces": sorted(piece.value for piece in classify(p, NFL))} for p in players],
    }


# --- ordinary moves / illegal moves / roster-salary rejections --------------
# `setup`: a list of {move, player_id} applied in order via apply_move
# before the move under test. `players` holds every Player referenced
# anywhere in the scenario, keyed by id.

def _legal_move_scenario(
    name: str, players: list[Player], setup: list[tuple[str, str]], move: str, player_id: str,
    contest: ContestConfig = CONTEST,
) -> dict:
    by_id = {p.id: p for p in players}
    state = BuildState()
    for mv, pid in setup:
        state = apply_move(state, uci(mv), by_id[pid], NFL, contest)

    legal = is_legal_move(state, uci(move), by_id[player_id], NFL, contest)
    scenario = {
        "name": name,
        "kind": "legal_move",
        "players": [player_dict(p) for p in players],
        "setup": [{"move": mv, "player_id": pid} for mv, pid in setup],
        "move": move,
        "player_id": player_id,
        "cap": contest.cap,
        "field_size": contest.field_size,
        "expected": {"legal": legal},
    }
    if legal:
        new_state = apply_move(state, uci(move), by_id[player_id], NFL, contest)
        side_moves = new_state.white_moves if new_state.board.turn == chess.BLACK else new_state.black_moves
        move_record = next(m for m in side_moves if m.player.id == player_id)
        scenario["expected"] = {
            "legal": True,
            "san": move_record.san,
            "piece": move_record.piece.value,
            "locked_player_ids": sorted(new_state.locked_player_ids),
        }
    return scenario


def scenario_ordinary_move_white_e4() -> dict:
    return _legal_move_scenario(
        "ordinary_move_white_e4",
        [make_player("w1", "WR", 3000)],
        [],
        "e2e4",
        "w1",
    )


def scenario_ordinary_move_black_e5_reply() -> dict:
    return _legal_move_scenario(
        "ordinary_move_black_e5_reply",
        [make_player("w1", "WR", 3000), make_player("b1", "WR", 3000)],
        [("e2e4", "w1")],
        "e7e5",
        "b1",
    )


def scenario_illegal_chess_move_pawn_jump() -> dict:
    return _legal_move_scenario(
        "illegal_chess_move_pawn_jump",
        [make_player("p1", "WR", 3000)],
        [],
        "e2e5",  # pawns can't jump three squares
        "p1",
    )


def scenario_illegal_piece_mismatch() -> dict:
    return _legal_move_scenario(
        "illegal_piece_mismatch",
        [make_player("rb1", "RB", 5200)],  # classifies as Rook, not Knight
        [],
        "b1c3",
        "rb1",
    )


def scenario_illegal_already_locked_repick() -> dict:
    rb = make_player("rb1", "RB", 5200)
    return _legal_move_scenario(
        "illegal_already_locked_repick",
        [make_player("w1", "WR", 3000), make_player("b1", "WR", 3000), rb, make_player("b2", "WR", 3000)],
        [("a2a4", "w1"), ("h7h5", "b1"), ("a1a3", "rb1"), ("h5h4", "b2")],
        "a3a5",
        "rb1",  # already locked by the earlier a1a3 move
    )


def scenario_illegal_cap_overflow_white() -> dict:
    tight = ContestConfig(cap=10000, field_size=1000, payouts=[])
    return _legal_move_scenario(
        "illegal_cap_overflow_white",
        [make_player("dst1", "DST", 5200), make_player("b1", "WR", 3000), make_player("dst2", "DST", 5100)],
        [("e2e4", "dst1"), ("a7a6", "b1")],
        "d2d4",
        "dst2",  # 5200 + 5100 = 10300 > 10000
        contest=tight,
    )


def scenario_roster_completable_flex_absorbs_third_rb() -> dict:
    roster = [make_player(f"rb{i}", "RB", 5200) for i in range(3)]
    return {
        "name": "roster_completable_flex_absorbs_third_rb",
        "kind": "roster_completable",
        "players": [player_dict(p) for p in roster],
        "cap": CONTEST.cap,
        "expected": {"completable": lineup_still_completable(roster, NFL, CONTEST.cap)},
    }


def _overlap_setup_players() -> list[Player]:
    return [make_player("filler_w", "WR", 3000), make_player("filler_b", "WR", 3000)]


def scenario_overlap_rb_7000_plus_picked_by_rook_move() -> dict:
    """Task "piece pools": a $7,000+ RB is Rook-pool AND Queen-pool
    eligible now (no more mutual-exclusivity ceiling) -- this scenario
    picks one via a real Rook move; the sibling scenario below picks the
    same kind of player via a real Queen move.
    """
    rb = make_player("rb_overlap_rook", "RB", 7200)
    return _legal_move_scenario(
        "overlap_rb_7000_plus_picked_by_rook_move",
        [*_overlap_setup_players(), rb],
        [("a2a4", "filler_w"), ("h7h6", "filler_b")],  # clears the a-file for the a1 rook
        "a1a3",
        "rb_overlap_rook",
    )


def scenario_overlap_rb_7000_plus_picked_by_queen_move() -> dict:
    rb = make_player("rb_overlap_queen", "RB", 7200)
    return _legal_move_scenario(
        "overlap_rb_7000_plus_picked_by_queen_move",
        [*_overlap_setup_players(), rb],
        [("d2d4", "filler_w"), ("h7h6", "filler_b")],  # clears the d-file for the d1 queen
        "d1d3",
        "rb_overlap_queen",
    )


def scenario_roster_completable_second_dst_illegal() -> dict:
    roster = [make_player("dst1", "DST", 2500), make_player("dst2", "DST", 2600)]
    return {
        "name": "roster_completable_second_dst_illegal",
        "kind": "roster_completable",
        "players": [player_dict(p) for p in roster],
        "cap": CONTEST.cap,
        "expected": {"completable": lineup_still_completable(roster, NFL, CONTEST.cap)},
    }


# --- castling (both King modes, incl. the QB switch) ------------------------

def _ready_to_castle_queenside_moves() -> list[tuple[str, str]]:
    return [
        ("d2d4", "w_pawn"), ("a7a6", "b1"), ("b1c3", "te1"), ("a6a5", "b2"),
        ("c1f4", "wr1"), ("a5a4", "b3"), ("d1d3", "rb_queen"), ("a4a3", "b4"),
    ]


def _ready_to_castle_players() -> list[Player]:
    return [
        make_player("w_pawn", "WR", 3000), make_player("b1", "WR", 3000), make_player("te1", "TE", 5200),
        make_player("b2", "WR", 3000), make_player("wr1", "WR", 5000), make_player("b3", "WR", 3000),
        make_player("rb_queen", "RB", 7200), make_player("b4", "WR", 3000),
    ]


def scenario_castle_emerge_queenside() -> dict:
    players = _ready_to_castle_players()
    by_id = {p.id: p for p in players}
    state = BuildState()
    for mv, pid in _ready_to_castle_queenside_moves():
        state = apply_move(state, uci(mv), by_id[pid], NFL, CONTEST)

    king = make_player("qb1", "QB", 6000)
    rook = make_player("rb1", "RB", 5200)
    new_state = castle(state, uci("e1c1"), king, rook, NFL, CONTEST)

    return {
        "name": "castle_emerge_queenside",
        "kind": "castle",
        "players": [player_dict(p) for p in players + [king, rook]],
        "setup": [{"move": mv, "player_id": pid} for mv, pid in _ready_to_castle_queenside_moves()],
        "move": "e1c1",
        "king_mode": "EMERGE",
        "king_player_id": king.id,
        "rook_player_id": rook.id,
        "expected": {
            "san": next(m.san for m in new_state.white_moves if m.player.id == rook.id),
            "locked_player_ids": sorted(new_state.locked_player_ids),
            "white_castled": new_state.white_castled,
            "king_piece": next(m.piece.value for m in new_state.white_moves if m.player.id == king.id),
            "rook_piece": next(m.piece.value for m in new_state.white_moves if m.player.id == rook.id),
        },
    }


def scenario_castle_placed_queenside() -> dict:
    players = _ready_to_castle_players()
    by_id = {p.id: p for p in players}
    white_qb = make_player("qb_w", "QB", 6500)
    black_qb = make_player("qb_b", "QB", 6200)
    state = place_kings(white_qb, black_qb, NFL, CONTEST)
    for mv, pid in _ready_to_castle_queenside_moves():
        state = apply_move(state, uci(mv), by_id[pid], NFL, CONTEST)

    rook = make_player("rb1", "RB", 5200)
    new_state = castle(state, uci("e1c1"), None, rook, NFL, CONTEST, KingMode.PLACED)

    return {
        "name": "castle_placed_queenside",
        "kind": "castle",
        "players": [player_dict(p) for p in players + [white_qb, black_qb, rook]],
        "white_king_player_id": white_qb.id,
        "black_king_player_id": black_qb.id,
        "setup": [{"move": mv, "player_id": pid} for mv, pid in _ready_to_castle_queenside_moves()],
        "move": "e1c1",
        "king_mode": "PLACED",
        "rook_player_id": rook.id,
        "expected": {
            "san": next(m.san for m in new_state.white_moves if m.player.id == rook.id),
            "locked_player_ids": sorted(new_state.locked_player_ids),
            "white_castled": new_state.white_castled,
            "rook_piece": next(m.piece.value for m in new_state.white_moves if m.player.id == rook.id),
            "king_move_count": len([m for m in new_state.white_moves if m.piece is Piece.KING]),
            "king_player_id_after": next(m.player.id for m in new_state.white_moves if m.piece is Piece.KING),
        },
    }


def scenario_switch_king_after_placed_castle() -> dict:
    players = _ready_to_castle_players()
    by_id = {p.id: p for p in players}
    white_qb = make_player("qb_w", "QB", 6500)
    black_qb = make_player("qb_b", "QB", 6200)
    state = place_kings(white_qb, black_qb, NFL, CONTEST)
    for mv, pid in _ready_to_castle_queenside_moves():
        state = apply_move(state, uci(mv), by_id[pid], NFL, CONTEST)
    rook = make_player("rb1", "RB", 5200)
    state = castle(state, uci("e1c1"), None, rook, NFL, CONTEST, KingMode.PLACED)

    new_qb = make_player("qb_new", "QB", 5800)
    new_state = switch_king(state, Side.WHITE, new_qb, NFL, CONTEST)
    assert new_state is not None

    return {
        "name": "switch_king_after_placed_castle",
        "kind": "switch_king",
        "players": [player_dict(p) for p in players + [white_qb, black_qb, rook, new_qb]],
        "white_king_player_id": white_qb.id,
        "black_king_player_id": black_qb.id,
        "rook_player_id": rook.id,
        "setup": [{"move": mv, "player_id": pid} for mv, pid in _ready_to_castle_queenside_moves()],
        "castle_move": "e1c1",
        "side": "WHITE",
        "new_king_player_id": new_qb.id,
        "expected": {
            "success": True,
            "locked_player_ids": sorted(new_state.locked_player_ids),
            "king_player_id_after": next(m.player.id for m in new_state.white_moves if m.piece is Piece.KING),
        },
    }


# --- captures (incl. an unmoved piece and one en passant) -------------------

def scenario_capture_with_history() -> dict:
    w_pawn = make_player("w_pawn1", "WR", 3000)
    b_pawn = make_player("b_pawn1", "WR", 3000)
    state = apply_move(BuildState(), uci("e2e4"), w_pawn, NFL, CONTEST)
    state = apply_move(state, uci("d7d5"), b_pawn, NFL, CONTEST)
    capture_move = uci("e4d5")
    new_state = apply_capture_move(state, capture_move, NFL, CONTEST)
    captured_record = next(m for m in new_state.white_moves if m.player.id == b_pawn.id)

    return {
        "name": "capture_with_history",
        "kind": "capture",
        "players": [player_dict(w_pawn), player_dict(b_pawn)],
        "setup": [{"move": "e2e4", "player_id": "w_pawn1"}, {"move": "d7d5", "player_id": "b_pawn1"}],
        "move": "e4d5",
        "replacement_player_id": None,
        "expected": {
            "san": captured_record.san,
            "captured_player_id": b_pawn.id,
            "white_moves_count": len(new_state.white_moves),
            "black_moves_count": len(new_state.black_moves),
        },
    }


def scenario_capture_unmoved_knight() -> dict:
    board = chess.Board("4k1n1/8/8/8/2B5/8/8/4K3 w - - 0 1")
    state = BuildState(board=board)
    capture_move = uci("c4g8")
    knight_pick = make_player("te1", "TE", 5200)
    assert is_legal_capture(state, capture_move, NFL, CONTEST) is False
    assert is_legal_capture(state, capture_move, NFL, CONTEST, knight_pick) is True
    new_state = apply_capture_move(state, capture_move, NFL, CONTEST, knight_pick)

    return {
        "name": "capture_unmoved_knight",
        "kind": "capture",
        "fen": "4k1n1/8/8/8/2B5/8/8/4K3 w - - 0 1",
        "players": [player_dict(knight_pick)],
        "setup": [],
        "move": "c4g8",
        "replacement_player_id": "te1",
        "expected": {
            "san": new_state.white_moves[0].san,
            "captured_player_id": knight_pick.id,
            "captured_piece": new_state.white_moves[0].piece.value,
            "white_moves_count": len(new_state.white_moves),
            "black_moves_count": len(new_state.black_moves),
        },
    }


def scenario_capture_en_passant() -> dict:
    w_pawn_e4 = make_player("w_e4", "WR", 3000)
    b_h6 = make_player("b_h6", "WR", 3000)
    w_pawn_e5 = make_player("w_e5", "WR", 3100)
    b_d5 = make_player("b_d5", "WR", 3200)
    state = apply_move(BuildState(), uci("e2e4"), w_pawn_e4, NFL, CONTEST)
    state = apply_move(state, uci("h7h6"), b_h6, NFL, CONTEST)
    state = apply_move(state, uci("e4e5"), w_pawn_e5, NFL, CONTEST)
    state = apply_move(state, uci("d7d5"), b_d5, NFL, CONTEST)

    capture_move = uci("e5d6")
    assert state.board.is_en_passant(capture_move)
    new_state = apply_capture_move(state, capture_move, NFL, CONTEST)
    captured_record = next(m for m in new_state.white_moves if m.player.id == b_d5.id)

    return {
        "name": "capture_en_passant",
        "kind": "capture",
        "players": [player_dict(p) for p in (w_pawn_e4, b_h6, w_pawn_e5, b_d5)],
        "setup": [
            {"move": "e2e4", "player_id": "w_e4"}, {"move": "h7h6", "player_id": "b_h6"},
            {"move": "e4e5", "player_id": "w_e5"}, {"move": "d7d5", "player_id": "b_d5"},
        ],
        "move": "e5d6",
        "replacement_player_id": None,
        "expected": {
            "san": captured_record.san,
            "captured_player_id": b_d5.id,
            "white_moves_count": len(new_state.white_moves),
            "black_moves_count": len(new_state.black_moves),
        },
    }


# --- captures that don't fit -- the capture is still legal, but locks no --
# player instead of transferring/picking (RULES.md "Captures") -----------

def scenario_capture_returns_to_pool() -> dict:
    # White already has one DST locked; Black's d5 pawn is also a DST
    # pick. Transferring it would overflow DST's single slot, so the
    # capture still happens but the captured player returns to the pool
    # (removed from both sides' locked_player_ids) instead of transferring.
    w_dst1 = make_player("w_dst1", "DST", 2500)
    b_dst_captured = make_player("b_dst_captured", "DST", 2600)
    state = apply_move(BuildState(), uci("e2e4"), w_dst1, NFL, CONTEST)
    state = apply_move(state, uci("d7d5"), b_dst_captured, NFL, CONTEST)
    capture_move = uci("e4d5")
    assert is_legal_capture(state, capture_move, NFL, CONTEST) is False  # doesn't fit -- still legal to attempt
    new_state = apply_capture_move(state, capture_move, NFL, CONTEST)

    return {
        "name": "capture_returns_to_pool",
        "kind": "capture_no_lock",
        "players": [player_dict(w_dst1), player_dict(b_dst_captured)],
        "setup": [{"move": "e2e4", "player_id": "w_dst1"}, {"move": "d7d5", "player_id": "b_dst_captured"}],
        "move": "e4d5",
        "expected": {
            "white_moves_count": len(new_state.white_moves),
            "black_moves_count": len(new_state.black_moves),
            "locked_player_ids": sorted(new_state.locked_player_ids),
        },
    }


def scenario_capture_unmoved_no_fitting_player() -> dict:
    # White's bishop captures Black's unmoved f7 pawn, but White's DST
    # slot is already filled -- no eligible Pawn-band replacement fits,
    # so the capture still happens but locks nobody.
    w_dst1 = make_player("w_dst1", "DST", 2500)
    b_pawn1 = make_player("b_pawn1", "WR", 3000)
    w_bishop1 = make_player("w_bishop1", "WR", 5000)
    b_knight1 = make_player("b_knight1", "TE", 5200)
    state = apply_move(BuildState(), uci("e2e4"), w_dst1, NFL, CONTEST)
    state = apply_move(state, uci("e7e5"), b_pawn1, NFL, CONTEST)
    state = apply_move(state, uci("f1c4"), w_bishop1, NFL, CONTEST)
    state = apply_move(state, uci("b8c6"), b_knight1, NFL, CONTEST)
    capture_move = uci("c4f7")
    new_state = apply_capture_move(state, capture_move, NFL, CONTEST, None)

    return {
        "name": "capture_unmoved_no_fitting_player",
        "kind": "capture_no_lock",
        "players": [player_dict(p) for p in (w_dst1, b_pawn1, w_bishop1, b_knight1)],
        "setup": [
            {"move": "e2e4", "player_id": "w_dst1"}, {"move": "e7e5", "player_id": "b_pawn1"},
            {"move": "f1c4", "player_id": "w_bishop1"}, {"move": "b8c6", "player_id": "b_knight1"},
        ],
        "move": "c4f7",
        "expected": {
            "white_moves_count": len(new_state.white_moves),
            "black_moves_count": len(new_state.black_moves),
            "locked_player_ids": sorted(new_state.locked_player_ids),
        },
    }


# --- ownership by field size -------------------------------------------------

def scenario_field_tier(field_size: int, sample_player: Player) -> dict:
    contest = ContestConfig(field_size=field_size, payouts=[])
    tier = contest.field_tier()
    return {
        "name": f"field_tier_{field_size}",
        "kind": "field_tier",
        "field_size": field_size,
        "sample_player": player_dict(sample_player),
        "expected": {
            "field_tier": tier.value,
            "own_for": sample_player.own_for(tier),
        },
    }


# --- target rank for various entry counts ------------------------------------

def scenario_target_rank(field_size: int, last_rank: int) -> dict:
    contest = ContestConfig(field_size=field_size, payouts=[])
    return {
        "name": f"target_rank_{field_size}",
        "kind": "target_rank",
        "field_size": field_size,
        "last_rank": last_rank,
        "expected": {"target_rank": contest.target_rank(last_rank)},
    }


# --- suggested opening (Task 31): by_rank[contest.target_rank(last_rank)], --
# the selection cli.py's _prompt_for_opening_setup makes inline, here called
# via rank_families/ContestConfig.target_rank directly (both already real,
# tested engine functions) rather than importing the CLI itself.

def scenario_suggested_opening(field_size: int) -> dict:
    ranked = rank_families(load_line_stats(LINE_STATS_PATH))
    by_rank = {family.rank: family for family in ranked}
    contest = ContestConfig(field_size=field_size, payouts=[])
    suggestion = by_rank[contest.target_rank(len(ranked))]
    return {
        "name": f"suggested_opening_{field_size}",
        "kind": "suggested_opening",
        "field_size": field_size,
        "expected": {
            "rank": suggestion.rank,
            "name": suggestion.name,
            "games": suggestion.games,
            "eco": suggestion.line.eco,
            "moves": list(suggestion.line.moves),
        },
    }


# --- full family ranking list -------------------------------------------------

def scenario_family_ranking() -> dict:
    ranked = rank_families(load_line_stats(LINE_STATS_PATH))
    return {
        "name": "family_ranking_full_list",
        "kind": "family_ranking",
        "expected": {
            "families": [
                {"name": f.name, "rank": f.rank, "games": f.games, "eco": f.line.eco, "moves": list(f.line.moves)}
                for f in ranked
            ],
        },
    }


# --- opening naming and continuations ----------------------------------------

def scenario_opening_lookup(name: str, moves: list[str]) -> dict:
    book = load_opening_book([OPENINGS_DIR / f"{letter}.tsv" for letter in "abcde"])
    moves_t = tuple(moves)
    return {
        "name": name,
        "kind": "opening_lookup",
        "moves": moves,
        "expected": {
            "opening_name": opening_name(moves_t, book),
            "continuations": sorted(book_continuations(moves_t, book)),
        },
    }


# --- one complete template build: Ruy Lopez Morphy Defense ------------------

MORPHY_DEFENSE = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]


def _best_player_for_move(state: BuildState, move: chess.Move, piece: Piece, pool: list[Player]) -> Player:
    candidates = sorted(
        (p for p in pool if p.id not in state.locked_player_ids and piece in classify(p, NFL)),
        key=lambda p: p.proj, reverse=True,
    )
    for player in candidates:
        if is_legal_move(state, move, player, NFL, CONTEST):
            return player
    raise RuntimeError(f"no eligible player found for {move!r} ({piece})")


def scenario_template_build_ruy_lopez_morphy() -> dict:
    from dfs_chess.pieces import piece_for_chess_type

    pool = load_etr_csv(ETR_PATH)
    state = BuildState()
    picks: list[dict] = []

    for ply, san in enumerate(MORPHY_DEFENSE, start=1):
        move = state.board.parse_san(san)
        side = state.board.turn
        piece = piece_for_chess_type(state.board.piece_type_at(move.from_square))
        player = _best_player_for_move(state, move, piece, pool)
        state = apply_move(state, move, player, NFL, CONTEST)
        picks.append({
            "ply": ply,
            "side": "WHITE" if side == chess.WHITE else "BLACK",
            "san": san,
            "piece": piece.value,
            "player_id": player.id,
            "player_name": player.name,
        })

    return {
        "name": "template_build_ruy_lopez_morphy_defense",
        "kind": "template_build",
        "template_moves": MORPHY_DEFENSE,
        "expected": {
            "picks": picks,
            "white_moves": [p for p in picks if p["side"] == "WHITE"],
            "black_moves": [p for p in picks if p["side"] == "BLACK"],
            "opening_name_at_end": opening_name(
                tuple(MORPHY_DEFENSE), load_opening_book([OPENINGS_DIR / f"{letter}.tsv" for letter in "abcde"])
            ),
        },
    }


# --- pick lists (RULES.md piece table: sort metric + list cap) -------------

def scenario_pick_list_queen_sorts_by_ceiling() -> dict:
    # Override each one's ceiling independently of proj (make_player's own
    # default ties ceiling to proj) -- the inverted ranking is the point.
    pool = [
        replace(make_player("a", "RB", 7200, proj=25.0), ceiling=20.0),
        replace(make_player("b", "RB", 7300, proj=20.0), ceiling=45.0),
    ]
    result = pick_list(Piece.QUEEN, pool, set(), [], NFL, CONTEST)
    return {
        "name": "pick_list_queen_sorts_by_ceiling",
        "kind": "pick_list",
        "piece": "QUEEN",
        "players": [player_dict(p) for p in pool],
        "locked_player_ids": [],
        "current_player_ids": [],
        "qb_team": None,
        "cap": CONTEST.cap,
        "field_size": CONTEST.field_size,
        "expected": {"ids": [p.id for p in result]},
    }


def scenario_pick_list_rook_requires_qb_team() -> dict:
    teammate = make_player("rb1", "RB", 5200, team="CIN")
    other_team = make_player("rb2", "RB", 5300, team="DET")
    pool = [teammate, other_team]
    result = pick_list(Piece.ROOK, pool, set(), [], NFL, CONTEST, qb_team="CIN")
    return {
        "name": "pick_list_rook_requires_qb_team",
        "kind": "pick_list",
        "piece": "ROOK",
        "players": [player_dict(p) for p in pool],
        "locked_player_ids": [],
        "current_player_ids": [],
        "qb_team": "CIN",
        "cap": CONTEST.cap,
        "field_size": CONTEST.field_size,
        "expected": {"ids": [p.id for p in result]},
    }


def scenario_pick_list_caps_bishop_at_12() -> dict:
    pool = [make_player(f"wr{i}", "WR", 5100 + i, proj=float(i)) for i in range(20)]
    result = pick_list(Piece.BISHOP, pool, set(), [], NFL, CONTEST)
    return {
        "name": "pick_list_caps_bishop_at_12",
        "kind": "pick_list",
        "piece": "BISHOP",
        "players": [player_dict(p) for p in pool],
        "locked_player_ids": [],
        "current_player_ids": [],
        "qb_team": None,
        "cap": CONTEST.cap,
        "field_size": CONTEST.field_size,
        "expected": {"ids": [p.id for p in result]},
    }


def scenario_castle_qb_candidates_excludes_a_lonely_qb() -> dict:
    lonely_qb = make_player("qb1", "QB", 6000, proj=30.0, team="CIN")  # no CIN teammate below
    teamed_qb = make_player("qb2", "QB", 6200, proj=10.0, team="DET")
    teammate = make_player("rb1", "RB", 5200, team="DET")
    pool = [lonely_qb, teamed_qb, teammate]
    result = castle_qb_candidates(pool, set(), [], NFL, CONTEST)
    return {
        "name": "castle_qb_candidates_excludes_a_lonely_qb",
        "kind": "castle_qb_candidates",
        "players": [player_dict(p) for p in pool],
        "locked_player_ids": [],
        "current_player_ids": [],
        "cap": CONTEST.cap,
        "field_size": CONTEST.field_size,
        "expected": {"ids": [p.id for p in result]},
    }


def main() -> None:
    sample_players = load_etr_csv(ETR_PATH)
    first_sample_player = sample_players[0]
    last_rank = len(rank_families(load_line_stats(LINE_STATS_PATH)))

    scenarios = [
        scenario_classify_all_players(),
        scenario_ordinary_move_white_e4(),
        scenario_ordinary_move_black_e5_reply(),
        scenario_illegal_chess_move_pawn_jump(),
        scenario_illegal_piece_mismatch(),
        scenario_illegal_already_locked_repick(),
        scenario_illegal_cap_overflow_white(),
        scenario_roster_completable_flex_absorbs_third_rb(),
        scenario_roster_completable_second_dst_illegal(),
        scenario_overlap_rb_7000_plus_picked_by_rook_move(),
        scenario_overlap_rb_7000_plus_picked_by_queen_move(),
        scenario_castle_emerge_queenside(),
        scenario_castle_placed_queenside(),
        scenario_switch_king_after_placed_castle(),
        scenario_capture_with_history(),
        scenario_capture_unmoved_knight(),
        scenario_capture_en_passant(),
        scenario_capture_returns_to_pool(),
        scenario_capture_unmoved_no_fitting_player(),
        scenario_field_tier(1999, first_sample_player),
        scenario_field_tier(2000, first_sample_player),
        scenario_field_tier(9999, first_sample_player),
        scenario_field_tier(10000, first_sample_player),
        scenario_target_rank(2, last_rank),
        scenario_target_rank(100, last_rank),
        scenario_target_rank(1000, last_rank),
        scenario_target_rank(1001, last_rank),
        scenario_target_rank(5000, last_rank),
        scenario_target_rank(10000, last_rank),
        scenario_target_rank(100000, last_rank),
        scenario_target_rank(416171, last_rank),
        scenario_suggested_opening(2),
        scenario_suggested_opening(100),
        scenario_suggested_opening(1000),
        scenario_suggested_opening(1001),
        scenario_suggested_opening(5000),
        scenario_suggested_opening(10000),
        scenario_suggested_opening(100000),
        scenario_suggested_opening(416171),
        scenario_family_ranking(),
        scenario_opening_lookup("opening_lookup_after_e4", ["e4"]),
        scenario_opening_lookup("opening_lookup_ruy_lopez", ["e4", "e5", "Nf3", "Nc6", "Bb5"]),
        scenario_opening_lookup("opening_lookup_sicilian", ["e4", "c5"]),
        scenario_opening_lookup("opening_lookup_no_match", ["Qzz9"]),
        scenario_template_build_ruy_lopez_morphy(),
        scenario_pick_list_queen_sorts_by_ceiling(),
        scenario_pick_list_rook_requires_qb_team(),
        scenario_pick_list_caps_bishop_at_12(),
        scenario_castle_qb_candidates_excludes_a_lonely_qb(),
    ]

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump({"scenario_count": len(scenarios), "scenarios": scenarios}, f, indent=2)
        f.write("\n")

    print(f"Wrote {len(scenarios)} scenarios to {OUT_PATH.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
