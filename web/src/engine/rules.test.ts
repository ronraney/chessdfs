// Ported from tests/test_rules.py, now in full. The "roster/salary
// feasibility, tested directly" section exercises lineup_still_completable
// directly; "chess legality + turn order"/"exclusivity"/"roster/salary
// (same rules for both sides)" exercise is_legal_move/apply_move (ported
// Task 24); "castling"/"King modes (Task 14)"/"captures (Task 18/19)"
// exercise can_castle/castle/switch_king/place_kings/is_legal_capture/
// apply_capture_move (ported this task, Task 25).
import type { Square } from "chess.js";
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import nflConfig from "../data/config/sports/nfl.json";
import { ContestConfig } from "./config";
import { BuildState, KingMode, Move, Piece, Side, Player } from "./models";
import { classify } from "./pieces";
import type { ChessMove } from "./rules";
import {
  applyCaptureMove,
  applyMove,
  assignRosterSlots,
  blockedPositions,
  canCastle,
  castle,
  isLegalCapture,
  isLegalMove,
  lineupStillCompletable,
  placeKings,
  switchKing,
} from "./rules";
import { loadSportConfig } from "./sport";

const CONTEST = new ContestConfig({ cap: 50000, fieldSize: 1000, payouts: [] });
// lineupStillCompletable takes a plain cap number, not a ContestConfig.
const CONTEST_CAP = 50000;
const NFL = loadSportConfig(nflConfig);

function makePlayer(id: string, pos: string, salary: number, team = "AAA"): Player {
  return new Player({
    id,
    name: id,
    positions: [pos],
    team,
    opp: "BBB",
    salary,
    proj: 10.0,
    ownSmall: 0.1,
    ownLarge: 0.1,
    floor: 6.0,
    ceiling: 16.0,
  });
}

// UCI shorthand (e.g. "e2e4" -> {from: "e2", to: "e4"}), matching Python's
// local `uci()` test helper (`chess.Move.from_uci(move)`). 4-char only --
// no ported test here moves a pawn to its promotion rank.
function uci(move: string): ChessMove {
  return { from: move.slice(0, 2) as Square, to: move.slice(2, 4) as Square };
}

// Plays Nc3, Bf4, Qd3 for White (clearing b1/c1/d1 and locking a
// Knight-tier + Bishop-tier + Queen-tier player), with harmless Black
// a-pawn replies, leaving White ready to play O-O-O.
function stateReadyToCastleQueenside(): BuildState {
  let state = applyMove(new BuildState(), uci("d2d4"), makePlayer("w_pawn", "WR", 3000), NFL, CONTEST);
  state = applyMove(state, uci("a7a6"), makePlayer("b1", "WR", 3000), NFL, CONTEST);
  state = applyMove(state, uci("b1c3"), makePlayer("te1", "TE", 5200), NFL, CONTEST);
  state = applyMove(state, uci("a6a5"), makePlayer("b2", "WR", 3000), NFL, CONTEST);
  state = applyMove(state, uci("c1f4"), makePlayer("wr1", "WR", 5000), NFL, CONTEST);
  state = applyMove(state, uci("a5a4"), makePlayer("b3", "WR", 3000), NFL, CONTEST);
  state = applyMove(state, uci("d1d3"), makePlayer("rb_queen", "RB", 7200), NFL, CONTEST);
  state = applyMove(state, uci("a4a3"), makePlayer("b4", "WR", 3000), NFL, CONTEST);
  return state;
}

// Like stateReadyToCastleQueenside, but White's QB is already locked from
// setup (Task 14 PLACED king mode) before any move is played.
function stateReadyToCastleQueensidePlaced(whiteQbTeam = "AAA"): BuildState {
  let state = placeKings(makePlayer("qb_w", "QB", 6500, whiteQbTeam), makePlayer("qb_b", "QB", 6200), NFL, CONTEST);
  state = applyMove(state, uci("d2d4"), makePlayer("w_pawn", "WR", 3000), NFL, CONTEST);
  state = applyMove(state, uci("a7a6"), makePlayer("b1", "WR", 3000), NFL, CONTEST);
  state = applyMove(state, uci("b1c3"), makePlayer("te1", "TE", 5200), NFL, CONTEST);
  state = applyMove(state, uci("a6a5"), makePlayer("b2", "WR", 3000), NFL, CONTEST);
  state = applyMove(state, uci("c1f4"), makePlayer("wr1", "WR", 5000), NFL, CONTEST);
  state = applyMove(state, uci("a5a4"), makePlayer("b3", "WR", 3000), NFL, CONTEST);
  state = applyMove(state, uci("d1d3"), makePlayer("rb_queen", "RB", 7200), NFL, CONTEST);
  state = applyMove(state, uci("a4a3"), makePlayer("b4", "WR", 3000), NFL, CONTEST);
  return state;
}

function stateWithACaptureAvailable(): BuildState {
  let state = applyMove(new BuildState(), uci("e2e4"), makePlayer("w_pawn1", "WR", 3000), NFL, CONTEST);
  state = applyMove(state, uci("d7d5"), makePlayer("b_pawn1", "WR", 3000), NFL, CONTEST);
  return state;
}

// White's f7-targeting bishop captures Black's f7 pawn, which never moved.
function stateWithAnUnmovedPawnCaptureAvailable(): BuildState {
  let state = applyMove(new BuildState(), uci("e2e4"), makePlayer("w_pawn1", "WR", 3000), NFL, CONTEST);
  state = applyMove(state, uci("e7e5"), makePlayer("b_pawn1", "WR", 3000), NFL, CONTEST);
  state = applyMove(state, uci("f1c4"), makePlayer("w_bishop1", "WR", 5000), NFL, CONTEST);
  state = applyMove(state, uci("b8c6"), makePlayer("b_knight1", "TE", 5200), NFL, CONTEST);
  return state;
}

describe("isLegalMove / applyMove", () => {
  // --- chess legality + turn order ------------------------------------

  it("rejects an illegal chess move", () => {
    const pawn = makePlayer("p1", "WR", 3000); // cheap -> Pawn tier
    const badMove = uci("e2e5"); // pawns can't jump three squares
    expect(isLegalMove(new BuildState(), badMove, pawn, NFL, CONTEST)).toBe(false);
    expect(() => applyMove(new BuildState(), badMove, pawn, NFL, CONTEST)).toThrow();
  });

  it("rejects a move whose piece doesn't match the player's classification", () => {
    const qb = makePlayer("qb1", "QB", 6000); // pools as King only, never Knight
    expect(classify(qb, NFL)).toEqual(new Set([Piece.KING]));
    expect(isLegalMove(new BuildState(), uci("b1c3"), qb, NFL, CONTEST)).toBe(false);
  });

  it("turn alternates", () => {
    let state = new BuildState();
    expect(state.board.turn()).toBe("w");

    state = applyMove(state, uci("e2e4"), makePlayer("w1", "WR", 3000), NFL, CONTEST);
    expect(state.board.turn()).toBe("b");
    expect(new Set(state.whiteMoves.map((m) => m.player.id))).toEqual(new Set(["w1"]));

    state = applyMove(state, uci("e7e5"), makePlayer("b1", "WR", 3000), NFL, CONTEST);
    expect(state.board.turn()).toBe("w");
    expect(new Set(state.blackMoves.map((m) => m.player.id))).toEqual(new Set(["b1"]));
  });

  it("SAN comes from the board", () => {
    const knight = makePlayer("te1", "TE", 5200);
    const state = applyMove(new BuildState(), uci("b1c3"), knight, NFL, CONTEST);
    expect(state.whiteMoves[0].san).toBe("Nc3");
    expect(state.whiteMoves[0].piece).toBe(Piece.KNIGHT);
  });

  // --- direct Rook move: no team restriction at all (Rule change "Rook:
  // stack builder" -- team now only feeds pickList's own stack-tier sort,
  // never isLegalMove's eligibility check) -----------------------------

  it("direct Rook move accepts any RB/WR/TE team, with no QB locked", () => {
    let state = applyMove(new BuildState(), uci("a2a4"), makePlayer("w1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("a7a5"), makePlayer("b1", "WR", 3000), NFL, CONTEST);

    const teammate = makePlayer("rb1", "RB", 5200, "CIN");
    expect(isLegalMove(state, uci("a1a3"), teammate, NFL, CONTEST)).toBe(true);

    const otherTeam = makePlayer("rb2", "RB", 5300, "DET");
    expect(isLegalMove(state, uci("a1a3"), otherTeam, NFL, CONTEST)).toBe(true);
  });

  it("direct Rook move accepts any RB/WR/TE team, even with a QB already locked", () => {
    const qb = makePlayer("qb1", "QB", 6000, "CIN");
    let state = applyMove(new BuildState(), uci("e2e4"), makePlayer("w1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("e7e5"), makePlayer("b1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("a2a4"), makePlayer("w2", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("a7a5"), makePlayer("b2", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("e1e2"), qb, NFL, CONTEST); // King move locks the QB (CIN)
    state = applyMove(state, uci("h7h6"), makePlayer("b3", "WR", 3000), NFL, CONTEST);

    const teammate = makePlayer("rb1", "RB", 5200, "CIN");
    expect(isLegalMove(state, uci("a1a3"), teammate, NFL, CONTEST)).toBe(true);

    // Formerly illegal (not a teammate of the locked QB) -- now legal,
    // same as the no-QB case: only castling still restricts the Rook to
    // the QB's own team (see castle()'s own tests below).
    const otherTeam = makePlayer("rb2", "RB", 5300, "DET");
    expect(isLegalMove(state, uci("a1a3"), otherTeam, NFL, CONTEST)).toBe(true);
  });

  // --- exclusivity ------------------------------------------------------

  it("exclusivity blocks the other side", () => {
    const rb = makePlayer("rb1", "RB", 5200);
    let state = applyMove(new BuildState(), uci("a2a4"), makePlayer("w1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("a7a5"), makePlayer("b1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("a1a3"), rb, NFL, CONTEST); // White rook locks rb
    expect(isLegalMove(state, uci("a8a6"), rb, NFL, CONTEST)).toBe(false); // Black can't repick it
  });

  it("exclusivity blocks the same side repicking", () => {
    const rb = makePlayer("rb1", "RB", 5200);
    let state = applyMove(new BuildState(), uci("a2a4"), makePlayer("w1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("h7h5"), makePlayer("b1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("a1a3"), rb, NFL, CONTEST); // White rook locks rb
    state = applyMove(state, uci("h5h4"), makePlayer("b2", "WR", 3000), NFL, CONTEST);
    expect(isLegalMove(state, uci("a3a5"), rb, NFL, CONTEST)).toBe(false);
  });

  // --- roster/salary (same rules for both sides) -------------------------

  it("unknown position is illegal for White", () => {
    const fb = makePlayer("fb1", "FB", 3000);
    expect(classify(fb, NFL)).toEqual(new Set([Piece.PAWN])); // classifies fine...
    expect(isLegalMove(new BuildState(), uci("e2e4"), fb, NFL, CONTEST)).toBe(false); // ...but DK has no FB slot
  });

  it("second King is illegal for White", () => {
    let state = applyMove(new BuildState(), uci("e2e4"), makePlayer("w1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("h7h6"), makePlayer("b1", "WR", 3000), NFL, CONTEST);
    const qb1 = makePlayer("qb1", "QB", 6000);
    state = applyMove(state, uci("e1e2"), qb1, NFL, CONTEST); // King move locks QB1
    state = applyMove(state, uci("h6h5"), makePlayer("b2", "WR", 3000), NFL, CONTEST);

    const qb2 = makePlayer("qb2", "QB", 5500);
    expect(isLegalMove(state, uci("e2e3"), qb2, NFL, CONTEST)).toBe(false); // chess-legal, DFS-blocked
  });

  it("lineup impossible to complete is illegal for Black", () => {
    let state = applyMove(new BuildState(), uci("e2e4"), makePlayer("w1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("e7e5"), makePlayer("b1", "WR", 3000), NFL, CONTEST); // frees e7
    state = applyMove(state, uci("d2d3"), makePlayer("w2", "WR", 3000), NFL, CONTEST);
    const qb1 = makePlayer("qb1_b", "QB", 6000);
    state = applyMove(state, uci("e8e7"), qb1, NFL, CONTEST); // Black King locks QB1
    state = applyMove(state, uci("d3d4"), makePlayer("w3", "WR", 3000), NFL, CONTEST);

    const qb2 = makePlayer("qb2_b", "QB", 5500); // a 2nd QB can never fit a DK roster
    expect(isLegalMove(state, uci("e7e6"), qb2, NFL, CONTEST)).toBe(false);
  });

  it("cap overflow is illegal for White", () => {
    const tight = new ContestConfig({ cap: 10000, fieldSize: 1000, payouts: [] });
    const dst1 = makePlayer("dst1", "DST", 5200);
    const dst2 = makePlayer("dst2", "DST", 5100); // 5200 + 5100 = 10300 > 10000
    let state = applyMove(new BuildState(), uci("e2e4"), dst1, NFL, tight);
    state = applyMove(state, uci("a7a6"), makePlayer("b1", "WR", 3000), NFL, tight);
    expect(isLegalMove(state, uci("d2d4"), dst2, NFL, tight)).toBe(false);
  });

  it("cap overflow is illegal for Black", () => {
    const tight = new ContestConfig({ cap: 10000, fieldSize: 1000, payouts: [] });
    const dst1 = makePlayer("dst1", "DST", 5200);
    const dst2 = makePlayer("dst2", "DST", 5100); // 5200 + 5100 = 10300 > 10000
    let state = applyMove(new BuildState(), uci("e2e4"), makePlayer("w1", "WR", 3000), NFL, tight);
    state = applyMove(state, uci("e7e5"), dst1, NFL, tight);
    state = applyMove(state, uci("d2d3"), makePlayer("w2", "WR", 3000), NFL, tight);
    expect(isLegalMove(state, uci("d7d5"), dst2, NFL, tight)).toBe(false);
  });
});

describe("castling", () => {
  it("can_castle is false before Knight and Bishop", () => {
    expect(canCastle(new BuildState(), Side.WHITE)).toBe(false);
  });

  it("castle is illegal before Knight and Bishop", () => {
    // Board where b1/c1/d1 happen to be clear, but reached without ever
    // going through our engine -- so nothing was ever "locked" for
    // Knight/Bishop.
    const rawBoard = new Chess();
    for (const m of ["d2d4", "a7a6", "b1c3", "a6a5", "c1f4", "a5a4", "d1d3", "a4a3"]) {
      rawBoard.move({ from: m.slice(0, 2) as Square, to: m.slice(2, 4) as Square });
    }
    const state = new BuildState({ board: rawBoard });

    expect(canCastle(state, Side.WHITE)).toBe(false);
    const king = makePlayer("qb1", "QB", 6000);
    const rook = makePlayer("rb1", "RB", 5200);
    expect(() => castle(state, uci("e1c1"), king, rook, NFL, CONTEST)).toThrow();
  });

  it("castle queenside: SAN and locks King and Rook", () => {
    const state = stateReadyToCastleQueenside();
    expect(canCastle(state, Side.WHITE)).toBe(true);

    const castleMove = uci("e1c1");
    const matched = state.board.moves({ verbose: true }).find((m) => m.from === "e1" && m.to === "c1");
    expect(matched?.isQueensideCastle()).toBe(true);

    const king = makePlayer("qb1", "QB", 6000);
    const rook = makePlayer("rb1", "RB", 5200);
    const newState = castle(state, castleMove, king, rook, NFL, CONTEST);

    expect(newState.lockedPlayerIds.has("qb1")).toBe(true);
    expect(newState.lockedPlayerIds.has("rb1")).toBe(true);
    const sans = new Set(
      newState.whiteMoves.filter((m) => m.player.id === "qb1" || m.player.id === "rb1").map((m) => m.san),
    );
    expect(sans).toEqual(new Set(["O-O-O"]));
    expect(newState.board.get("c1")?.type).toBe("k");
    expect(newState.board.get("d1")?.type).toBe("r");
    expect(newState.board.turn()).toBe("b");
  });

  it("castle twice is illegal", () => {
    const state = castle(
      stateReadyToCastleQueenside(),
      uci("e1c1"),
      makePlayer("qb1", "QB", 6000),
      makePlayer("rb1", "RB", 5200),
      NFL,
      CONTEST,
    );
    expect(canCastle(state, Side.WHITE)).toBe(false);
  });

  it("castle rejects wrong piece types", () => {
    const state = stateReadyToCastleQueenside();
    const notAKing = makePlayer("rb9", "RB", 5200); // Rook-tier, not King
    const rook = makePlayer("rb1", "RB", 5300);
    expect(() => castle(state, uci("e1c1"), notAKing, rook, NFL, CONTEST)).toThrow();
  });

  // --- Rook = correlation: castling's Rook must be the King's teammate --

  it("castle rejects a Rook not on the King's team", () => {
    const state = stateReadyToCastleQueenside();
    const king = makePlayer("qb1", "QB", 6000, "CIN");
    const rook = makePlayer("rb1", "RB", 5200, "DET"); // not a teammate
    expect(() => castle(state, uci("e1c1"), king, rook, NFL, CONTEST)).toThrow();
  });

  it("castle accepts a Rook on the King's team", () => {
    const state = stateReadyToCastleQueenside();
    const king = makePlayer("qb1", "QB", 6000, "CIN");
    const rook = makePlayer("rb1", "RB", 5200, "CIN");
    const newState = castle(state, uci("e1c1"), king, rook, NFL, CONTEST);
    expect(newState.lockedPlayerIds.has("qb1")).toBe(true);
    expect(newState.lockedPlayerIds.has("rb1")).toBe(true);
  });

  it("castle respects exclusivity", () => {
    // A board built directly from a FEN (not played out through
    // applyMove): King and Rook both still home (castling rights intact),
    // Knight and Bishop developed off their home squares, queenside
    // castling chess-legal.
    const fen = "rnbqkbnr/1ppppppp/8/8/3P1B2/p1NQ4/PPP1PPPP/R3KBNR w KQkq - 0 5";
    const board = new Chess(fen);

    const knight = makePlayer("te1", "TE", 5200);
    const bishop = makePlayer("wr1", "WR", 5000);
    const rook = makePlayer("rb1", "RB", 5200); // the Rook White wants to castle with
    const state = new BuildState({
      board,
      whiteMoves: [
        new Move({ side: Side.WHITE, piece: Piece.KNIGHT, san: "Nc3", player: knight }),
        new Move({ side: Side.WHITE, piece: Piece.BISHOP, san: "Bf4", player: bishop }),
      ],
      // Black already took this same player elsewhere.
      blackMoves: [new Move({ side: Side.BLACK, piece: Piece.ROOK, san: "(elsewhere)", player: rook })],
      lockedPlayerIds: new Set([knight.id, bishop.id, rook.id]),
    });
    expect(canCastle(state, Side.WHITE)).toBe(true); // Knight + Bishop are developed...

    const castleMove = uci("e1c1");
    expect(state.board.moves({ verbose: true }).some((m) => m.from === "e1" && m.to === "c1")).toBe(true); // ...and the chess move itself is legal...

    const king = makePlayer("qb1", "QB", 6000);
    expect(() => castle(state, castleMove, king, rook, NFL, CONTEST)).toThrow(); // ...but the Rook isn't White's to castle with.
  });
});

describe("King modes (Task 14)", () => {
  it("place_kings locks both QBs before move 1", () => {
    const whiteQb = makePlayer("qb_w", "QB", 6500);
    const blackQb = makePlayer("qb_b", "QB", 6200);

    const state = placeKings(whiteQb, blackQb, NFL, CONTEST);

    expect(state.whiteMoves.length).toBe(1);
    expect(state.whiteMoves[0].piece).toBe(Piece.KING);
    expect(state.whiteMoves[0].san).toBe("(placed)");
    expect(state.whiteMoves[0].player.id).toBe("qb_w");
    expect(state.blackMoves.length).toBe(1);
    expect(state.blackMoves[0].player.id).toBe("qb_b");
    expect(state.lockedPlayerIds).toEqual(new Set(["qb_w", "qb_b"]));
    expect(state.board.history()).toEqual([]); // no chess move happened
  });

  it("place_kings rejects a non-King player", () => {
    const notAQb = makePlayer("rb1", "RB", 5200);
    const blackQb = makePlayer("qb_b", "QB", 6200);
    expect(() => placeKings(notAQb, blackQb, NFL, CONTEST)).toThrow();
  });

  it("place_kings rejects the same player for both sides", () => {
    const qb = makePlayer("qb_shared", "QB", 6500);
    expect(() => placeKings(qb, qb, NFL, CONTEST)).toThrow();
  });

  it("can_castle in PLACED mode ignores the setup-placed King", () => {
    const state = stateReadyToCastleQueensidePlaced();
    // The setup-placed King is already in whiteMoves (Piece.KING), which
    // would block EMERGE-mode castling -- PLACED mode must not be fooled
    // by that signal.
    expect(canCastle(state, Side.WHITE, KingMode.EMERGE)).toBe(false);
    expect(canCastle(state, Side.WHITE, KingMode.PLACED)).toBe(true);
  });

  it("castle in PLACED mode locks only the Rook", () => {
    const state = stateReadyToCastleQueensidePlaced();
    const castleMove = uci("e1c1");
    const matched = state.board.moves({ verbose: true }).find((m) => m.from === "e1" && m.to === "c1");
    expect(matched?.isQueensideCastle()).toBe(true);

    const rook = makePlayer("rb1", "RB", 5200);
    const newState = castle(state, castleMove, null, rook, NFL, CONTEST, KingMode.PLACED);

    expect(newState.lockedPlayerIds.has("rb1")).toBe(true);
    const rookMoves = newState.whiteMoves.filter((m) => m.player.id === "rb1");
    expect(rookMoves.length).toBe(1);
    expect(rookMoves[0].piece).toBe(Piece.ROOK);
    // Still exactly one King-piece entry for White -- the original setup
    // placement -- never a second one from castling.
    const kingMoves = newState.whiteMoves.filter((m) => m.piece === Piece.KING);
    expect(kingMoves.length).toBe(1);
    expect(kingMoves[0].player.id).toBe("qb_w");
    expect(newState.board.get("c1")?.type).toBe("k");
    expect(newState.board.get("d1")?.type).toBe("r");
    expect(newState.whiteCastled).toBe(true);
  });

  it("castle in PLACED mode rejects a Rook not on the placed QB's team", () => {
    const state = stateReadyToCastleQueensidePlaced("CIN");
    const rook = makePlayer("rb1", "RB", 5200, "DET"); // not a teammate of the placed QB
    expect(() => castle(state, uci("e1c1"), null, rook, NFL, CONTEST, KingMode.PLACED)).toThrow();
  });

  it("castle in PLACED mode accepts a Rook on the placed QB's team", () => {
    const state = stateReadyToCastleQueensidePlaced("CIN");
    const rook = makePlayer("rb1", "RB", 5200, "CIN");
    const newState = castle(state, uci("e1c1"), null, rook, NFL, CONTEST, KingMode.PLACED);
    expect(newState.lockedPlayerIds.has("rb1")).toBe(true);
  });

  it("castle twice is illegal in PLACED mode", () => {
    let state = stateReadyToCastleQueensidePlaced();
    state = castle(state, uci("e1c1"), null, makePlayer("rb1", "RB", 5200), NFL, CONTEST, KingMode.PLACED);
    expect(canCastle(state, Side.WHITE, KingMode.PLACED)).toBe(false);
  });

  it("switch_king returns the old QB to the pool and locks the new one", () => {
    let state = stateReadyToCastleQueensidePlaced();
    state = castle(state, uci("e1c1"), null, makePlayer("rb1", "RB", 5200), NFL, CONTEST, KingMode.PLACED);

    const newQb = makePlayer("qb_new", "QB", 5800);
    const newState = switchKing(state, Side.WHITE, newQb, NFL, CONTEST);

    expect(newState).not.toBeNull();
    expect(newState!.lockedPlayerIds.has("qb_new")).toBe(true);
    expect(newState!.lockedPlayerIds.has("qb_w")).toBe(false); // old QB freed, available to either side
    const kingMoves = newState!.whiteMoves.filter((m) => m.piece === Piece.KING);
    expect(kingMoves.length).toBe(1);
    expect(kingMoves[0].player.id).toBe("qb_new");
  });

  it("switch_king rejects an infeasible new QB", () => {
    let state = stateReadyToCastleQueensidePlaced();
    state = castle(state, uci("e1c1"), null, makePlayer("rb1", "RB", 5200), NFL, CONTEST, KingMode.PLACED);

    const tight = new ContestConfig({ cap: 1000, fieldSize: 1000, payouts: [] }); // far under any real QB's salary
    const tooExpensive = makePlayer("qb_new", "QB", 9000);

    const result = switchKing(state, Side.WHITE, tooExpensive, NFL, tight);

    expect(result).toBeNull(); // rejected -- caller keeps the original QB
  });
});

// --- captures (Task 18: the captured player IS the capturing move's pick) --

describe("captures", () => {
  it("isLegalMove rejects every capture", () => {
    // Task 18: a capture is never resolved through the ordinary new-pick
    // path -- isLegalMove rejects it outright regardless of the player
    // passed, directing callers to isLegalCapture instead.
    const state = stateWithACaptureAvailable();
    const captureMove = uci("e4d5");
    const matched = state.board.moves({ verbose: true }).find((m) => m.from === "e4" && m.to === "d5");
    expect(matched?.isCapture()).toBe(true);
    expect(isLegalMove(state, captureMove, makePlayer("anyone", "WR", 3000), NFL, CONTEST)).toBe(false);
  });

  it("capture adds exactly one player -- the captured one", () => {
    const state = stateWithACaptureAvailable();
    const captureMove = uci("e4d5");

    const newState = applyCaptureMove(state, captureMove, NFL, CONTEST);

    // Exactly one player added to White -- the captured one -- not a
    // separate new pick for the capturing pawn too.
    expect(newState.whiteMoves.length - state.whiteMoves.length).toBe(1);
    expect(new Set(newState.whiteMoves.map((m) => m.player.id))).toEqual(new Set(["w_pawn1", "b_pawn1"]));
    expect(newState.blackMoves).toEqual([]);
    expect(newState.board.get("d5")?.color).toBe("w");
    const capturedMoveRecord = newState.whiteMoves.find((m) => m.player.id === "b_pawn1");
    expect(capturedMoveRecord?.san).toBe("exd5");
  });

  it("most recently locked player transfers on capture", () => {
    const k1 = makePlayer("te_k1", "TE", 5200);
    const k2 = makePlayer("te_k2", "TE", 5300);
    let state = applyMove(new BuildState(), uci("b1c3"), k1, NFL, CONTEST); // Nc3 locks K1
    state = applyMove(state, uci("d7d5"), makePlayer("b_pawn1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("c3e4"), k2, NFL, CONTEST); // Ne4 locks K2 (same knight, moved again)

    const captureMove = uci("d5e4"); // Black pawn captures the knight on e4
    const matched = state.board.moves({ verbose: true }).find((m) => m.from === "d5" && m.to === "e4");
    expect(matched?.isCapture()).toBe(true);
    expect(matched?.isEnPassant()).toBe(false);

    const newState = applyCaptureMove(state, captureMove, NFL, CONTEST);

    expect(new Set(newState.whiteMoves.map((m) => m.player.id))).toEqual(new Set(["te_k1"])); // K1 (older) stays
    const blackIds = new Set(newState.blackMoves.map((m) => m.player.id));
    expect(blackIds.has("te_k2")).toBe(true); // K2 (most recent) transferred
    expect(blackIds.has("te_k1")).toBe(false);
  });

  // Bug fix: a RECAPTURE of the same square used to transfer the WRONG
  // player on the second capture. Ron's build: 1. e4 e5 2. Nf3 Nc6 3. Nc3
  // Nf6 4. Bb5 a6 5. Bxc6 dxc6 -- 5. Bxc6 (fits) used to write
  // `[...moverHistory, captured]` at c6 (the bishop's OWN history from
  // b5, PLUS the just-transferred knight, both under the same square
  // key), so 5...dxc6's "most recently locked player transfers" read the
  // knight back out again instead of the bishop's own pick from 4. Bb5 --
  // the knight (already safely transferred to White) was never even
  // still on the board to be captured a second time. Fixed: a capture
  // never adds to the CAPTURING piece's own history (`moverHistory` moves
  // to the new square unchanged, `captured` is tracked only via `moves`/
  // `locked`), so recapturing c6 now correctly reads the bishop's own
  // (unmodified) history.
  it("a recapture on the same square transfers the right player each time (bug fix)", () => {
    let state = applyMove(new BuildState(), uci("e2e4"), makePlayer("w_pawn1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("e7e5"), makePlayer("b_pawn1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("g1f3"), makePlayer("w_knight1", "RB", 5200), NFL, CONTEST);
    const bKnightC6 = makePlayer("b_knight_c6", "RB", 5200); // 2...Nc6
    state = applyMove(state, uci("b8c6"), bKnightC6, NFL, CONTEST);
    state = applyMove(state, uci("b1c3"), makePlayer("w_knight2", "RB", 5300), NFL, CONTEST);
    state = applyMove(state, uci("g8f6"), makePlayer("b_knight2", "RB", 5300), NFL, CONTEST);
    const wBishopB5 = makePlayer("w_bishop_b5", "WR", 5500); // 4. Bb5
    state = applyMove(state, uci("f1b5"), wBishopB5, NFL, CONTEST);
    state = applyMove(state, uci("a7a6"), makePlayer("b_pawn2", "WR", 3000), NFL, CONTEST);

    // 5. Bxc6 -- White's bishop captures Black's knight on c6.
    const firstCapture = state.board.moves({ verbose: true }).find((m) => m.from === "b5" && m.to === "c6");
    expect(firstCapture?.isCapture()).toBe(true);
    state = applyCaptureMove(state, uci("b5c6"), NFL, CONTEST);

    const knightTransfer = state.whiteMoves.find((m) => m.player.id === "b_knight_c6");
    expect(knightTransfer?.piece).toBe(Piece.KNIGHT); // the knight's own real piece, not re-derived from the bishop
    expect(state.blackMoves.some((m) => m.player.id === "b_knight_c6")).toBe(false);

    // 5...dxc6 -- Black's pawn recaptures on c6, now occupied by White's
    // bishop (the knight was already removed from the board in move 5).
    const secondCapture = state.board.moves({ verbose: true }).find((m) => m.from === "d7" && m.to === "c6");
    expect(secondCapture?.isCapture()).toBe(true);
    state = applyCaptureMove(state, uci("d7c6"), NFL, CONTEST);

    const bishopTransfer = state.blackMoves.find((m) => m.player.id === "w_bishop_b5");
    expect(bishopTransfer?.piece).toBe(Piece.BISHOP); // correctly named as a Bishop, not a Knight
    expect(state.whiteMoves.some((m) => m.player.id === "w_bishop_b5")).toBe(false);

    // The first capture's own transfer is untouched by the second.
    expect(state.whiteMoves.some((m) => m.player.id === "b_knight_c6")).toBe(true);
    expect(state.blackMoves.some((m) => m.player.id === "b_knight_c6")).toBe(false);
  });

  // Bug fix, same scenario: Take back (BuildScreen.tsx's own `pastStates`
  // stack) restores a build by keeping the PRIOR BuildState snapshot
  // around and discarding whatever came after -- it never recomputes
  // anything, so the real guarantee it depends on is that deriving a
  // LATER move from a state never mutates that state itself. Confirms
  // that directly: the snapshot right after 5. Bxc6 (what Take back
  // would restore to if 5...dxc6 were undone) stays exactly as it was,
  // even after 5...dxc6 is derived from it.
  it("Take back's own snapshot after a capture is unaffected by a later capture derived from it", () => {
    let state = applyMove(new BuildState(), uci("e2e4"), makePlayer("w_pawn1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("e7e5"), makePlayer("b_pawn1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("g1f3"), makePlayer("w_knight1", "RB", 5200), NFL, CONTEST);
    state = applyMove(state, uci("b8c6"), makePlayer("b_knight_c6", "RB", 5200), NFL, CONTEST);
    state = applyMove(state, uci("b1c3"), makePlayer("w_knight2", "RB", 5300), NFL, CONTEST);
    state = applyMove(state, uci("g8f6"), makePlayer("b_knight2", "RB", 5300), NFL, CONTEST);
    const wBishopB5 = makePlayer("w_bishop_b5", "WR", 5500);
    state = applyMove(state, uci("f1b5"), wBishopB5, NFL, CONTEST);
    state = applyMove(state, uci("a7a6"), makePlayer("b_pawn2", "WR", 3000), NFL, CONTEST);

    const takeBackSnapshot = applyCaptureMove(state, uci("b5c6"), NFL, CONTEST); // 5. Bxc6
    const snapshotWhiteMoves = takeBackSnapshot.whiteMoves;
    const snapshotPieceLocks = takeBackSnapshot.pieceLocks;

    applyCaptureMove(takeBackSnapshot, uci("d7c6"), NFL, CONTEST); // 5...dxc6, derived but never fed back in

    // Taking back 5...dxc6 means keeping `takeBackSnapshot` exactly as it
    // was -- same object references, same transfer, same piece-lock
    // history for c6 (the bishop's own, from 4. Bb5).
    expect(takeBackSnapshot.whiteMoves).toBe(snapshotWhiteMoves);
    expect(takeBackSnapshot.pieceLocks).toBe(snapshotPieceLocks);
    expect(takeBackSnapshot.whiteMoves.some((m) => m.player.id === "b_knight_c6")).toBe(true);
    expect(takeBackSnapshot.pieceLocks.get("c6" as Square)).toEqual([wBishopB5]);
  });

  it("en passant capture transfers the captured pawn's player (Task 30b)", () => {
    // chess.js keeps "ordinary capture" and "en passant" as separate move
    // flags -- isCapture() alone is false here, unlike python-chess's
    // board.is_capture() (True for both). Before Task 30b's fix, every
    // "is this a capture" check in this module relied on isCapture()
    // alone, so this move was silently treated as an ordinary move
    // needing a brand-new player instead of a capture transfer -- caught
    // by Task 30's parity check against the Python original.
    const wE4 = makePlayer("w_e4", "WR", 3000);
    const bH6 = makePlayer("b_h6", "WR", 3000);
    const wE5 = makePlayer("w_e5", "WR", 3100);
    const bD5 = makePlayer("b_d5", "WR", 3200);
    let state = applyMove(new BuildState(), uci("e2e4"), wE4, NFL, CONTEST);
    state = applyMove(state, uci("h7h6"), bH6, NFL, CONTEST);
    state = applyMove(state, uci("e4e5"), wE5, NFL, CONTEST);
    state = applyMove(state, uci("d7d5"), bD5, NFL, CONTEST); // sets up en passant on d6

    const captureMove = uci("e5d6");
    const matched = state.board.moves({ verbose: true }).find((m) => m.from === "e5" && m.to === "d6");
    expect(matched?.isEnPassant()).toBe(true);
    expect(matched?.isCapture()).toBe(false);

    expect(isLegalMove(state, captureMove, makePlayer("anyone", "WR", 3000), NFL, CONTEST)).toBe(false);
    expect(isLegalCapture(state, captureMove, NFL, CONTEST)).toBe(true);

    const newState = applyCaptureMove(state, captureMove, NFL, CONTEST);

    expect(newState.whiteMoves).toHaveLength(3); // w_e4, w_e5, + the transferred b_d5
    const transferred = newState.whiteMoves.find((m) => m.player.id === "b_d5");
    expect(transferred?.san).toBe("exd6");
    expect(newState.blackMoves.some((m) => m.player.id === "b_d5")).toBe(false); // gone from Black's side
  });

  it("capturing an unmoved pawn requires and locks a Pawn pick", () => {
    // Task 19: a captured piece with no lock history has nothing to
    // transfer -- the capturing side picks a player of its own instead,
    // of the captured piece's own real chess type (here, Pawn).
    const state = stateWithAnUnmovedPawnCaptureAvailable();
    const captureMove = uci("c4f7");
    const matched = state.board.moves({ verbose: true }).find((m) => m.from === "c4" && m.to === "f7");
    expect(matched?.isCapture()).toBe(true);

    const pawnPick = makePlayer("wr_new", "WR", 3200);
    expect(classify(pawnPick, NFL)).toEqual(new Set([Piece.PAWN, Piece.ROOK])); // Rook too: no QB locked yet

    expect(isLegalCapture(state, captureMove, NFL, CONTEST)).toBe(false); // no player supplied
    expect(isLegalCapture(state, captureMove, NFL, CONTEST, pawnPick)).toBe(true);

    const expectedSan = matched!.san;
    const newState = applyCaptureMove(state, captureMove, NFL, CONTEST, pawnPick);

    // Exactly one player added -- the new Pawn pick -- not a transfer: the
    // f7 pawn never had a locked player to begin with, so nothing comes
    // out of Black's side.
    expect(newState.whiteMoves.length - state.whiteMoves.length).toBe(1);
    expect(newState.blackMoves).toEqual(state.blackMoves);
    const record = newState.whiteMoves.find((m) => m.player.id === "wr_new");
    expect(record?.piece).toBe(Piece.PAWN);
    expect(record?.san).toBe(expectedSan);
    expect(newState.lockedPlayerIds.has("wr_new")).toBe(true); // can't be picked again by either side
  });

  it("capturing an unmoved knight gives a Knight pick", () => {
    // A White bishop captures Black's g8 knight, still on its home square
    // -- no lock history, so (Task 19) the capturing side picks its own
    // Knight-type player instead of transferring one.
    const board = new Chess("4k1n1/8/8/8/2B5/8/8/4K3 w - - 0 1");
    const state = new BuildState({ board });
    const captureMove = uci("c4g8");
    const matched = state.board.moves({ verbose: true }).find((m) => m.from === "c4" && m.to === "g8");
    expect(matched?.isCapture()).toBe(true);

    const knightPick = makePlayer("te1", "TE", 5200);
    expect(classify(knightPick, NFL)).toEqual(new Set([Piece.KNIGHT, Piece.BISHOP, Piece.ROOK]));

    expect(isLegalCapture(state, captureMove, NFL, CONTEST)).toBe(false);
    expect(isLegalCapture(state, captureMove, NFL, CONTEST, knightPick)).toBe(true);

    const newState = applyCaptureMove(state, captureMove, NFL, CONTEST, knightPick);

    expect(newState.whiteMoves.length).toBe(1);
    expect(newState.whiteMoves[0].player.id).toBe("te1");
    expect(newState.whiteMoves[0].piece).toBe(Piece.KNIGHT);
    expect(newState.lockedPlayerIds.has("te1")).toBe(true); // can't be picked again by either side
  });

  it("capturing an unmoved piece with no fitting player locks nobody", () => {
    // Rule change: a capture is always legal. White already has its one
    // DST slot filled; a DST-position player classifies as Pawn (NFL's
    // catch-all band) just like the captured, never-moved f7 pawn does
    // -- but it can't fit any roster slot a second time, so no eligible
    // player fits this capture at all. The capture still happens; it
    // just locks nobody. Covers both calling conventions: no player
    // supplied at all, and one explicitly supplied that doesn't fit.
    const wDst1 = makePlayer("w_dst1", "DST", 2500);
    let state = applyMove(new BuildState(), uci("e2e4"), wDst1, NFL, CONTEST);
    state = applyMove(state, uci("e7e5"), makePlayer("b_pawn1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("f1c4"), makePlayer("w_bishop1", "WR", 5000), NFL, CONTEST);
    state = applyMove(state, uci("b8c6"), makePlayer("b_knight1", "TE", 5200), NFL, CONTEST);

    const captureMove = uci("c4f7");
    const matched = state.board.moves({ verbose: true }).find((m) => m.from === "c4" && m.to === "f7");
    expect(matched?.isCapture()).toBe(true);

    const secondDst = makePlayer("b_dst2", "DST", 2600);
    expect(classify(secondDst, NFL)).toEqual(new Set([Piece.PAWN])); // the right type...
    expect(isLegalCapture(state, captureMove, NFL, CONTEST, secondDst)).toBe(false); // ...but doesn't fit

    for (const replacement of [null, secondDst]) {
      const newState = applyCaptureMove(state, captureMove, NFL, CONTEST, replacement);
      expect(newState.whiteMoves).toEqual(state.whiteMoves); // no new pick -- the capturing bishop locks nobody
      expect(newState.blackMoves).toEqual(state.blackMoves); // the unmoved f7 pawn was never on Black's roster
      expect(newState.lockedPlayerIds.has("b_dst2")).toBe(false);
      expect(newState.board.get("f7")?.color).toBe("w"); // the capture itself still happened
    }
  });

  it("capture returns the captured player to the pool when transfer would overflow the roster", () => {
    // Rule change: White already has one DST locked. Black's d5 pawn is
    // also a DST pick. Transferring it would give White two DSTs, which
    // DST's single slot can't hold -- the capture is still legal, but
    // the captured player leaves Black's roster and returns to the pool
    // (available to either side) instead of transferring; the capturing
    // pawn locks nobody.
    const wDst1 = makePlayer("w_dst1", "DST", 2500);
    let state = applyMove(new BuildState(), uci("e2e4"), wDst1, NFL, CONTEST);
    const bDstCaptured = makePlayer("b_dst_captured", "DST", 2600);
    state = applyMove(state, uci("d7d5"), bDstCaptured, NFL, CONTEST);

    const captureMove = uci("e4d5");
    const matched = state.board.moves({ verbose: true }).find((m) => m.from === "e4" && m.to === "d5");
    expect(matched?.isCapture()).toBe(true);
    expect(isLegalCapture(state, captureMove, NFL, CONTEST)).toBe(false); // doesn't fit -- still legal to attempt

    const newState = applyCaptureMove(state, captureMove, NFL, CONTEST);

    expect(newState.whiteMoves).toEqual(state.whiteMoves); // unchanged -- no new pick for the capturing side
    expect(newState.blackMoves.some((m) => m.player.id === "b_dst_captured")).toBe(false); // left Black's roster
    expect(newState.lockedPlayerIds.has("b_dst_captured")).toBe(false); // back in the pool
    expect(newState.board.get("d5")?.color).toBe("w"); // the capture itself still happened

    // Available to either side afterward: Black can now lock the very
    // same player who just returned to the pool (a pawn move, since DST
    // only classifies as Pawn).
    const afterBlackLocksHim = applyMove(newState, uci("c7c6"), bDstCaptured, NFL, CONTEST);
    expect(afterBlackLocksHim.blackMoves.some((m) => m.player.id === "b_dst_captured")).toBe(true);
  });

  it("Black capturing an unmoved piece with no fitting player locks nobody", () => {
    // Mirrors the White test above, with Black as the capturing side.
    // Black's DST slot fills via 1...e5 (clearing e7, so the f8 bishop
    // can reach c5 in one move); the bishop then takes White's unmoved
    // f2 pawn from c5 (c5-d4-e3-f2, both squares still empty).
    const bDst1 = makePlayer("b_dst1", "DST", 2500);
    let state = applyMove(new BuildState(), uci("g2g3"), makePlayer("w_pawn1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("e7e5"), bDst1, NFL, CONTEST);
    state = applyMove(state, uci("b1c3"), makePlayer("w_knight1", "TE", 5200), NFL, CONTEST);
    state = applyMove(state, uci("f8c5"), makePlayer("b_bishop1", "WR", 5000), NFL, CONTEST);
    state = applyMove(state, uci("h2h3"), makePlayer("w_pawn2", "WR", 3100), NFL, CONTEST);

    const captureMove = uci("c5f2"); // Black's bishop captures White's unmoved f2 pawn
    const matched = state.board.moves({ verbose: true }).find((m) => m.from === "c5" && m.to === "f2");
    expect(matched?.isCapture()).toBe(true);
    expect(state.board.turn()).toBe("b");

    const secondDst = makePlayer("w_dst2", "DST", 2600);
    expect(classify(secondDst, NFL)).toEqual(new Set([Piece.PAWN]));
    expect(isLegalCapture(state, captureMove, NFL, CONTEST, secondDst)).toBe(false); // doesn't fit

    const newState = applyCaptureMove(state, captureMove, NFL, CONTEST, null);
    expect(newState.blackMoves).toEqual(state.blackMoves); // the capturing bishop locks nobody
    expect(newState.whiteMoves).toEqual(state.whiteMoves);
    expect(newState.lockedPlayerIds.has("w_dst2")).toBe(false);
    expect(newState.board.get("f2")?.color).toBe("b");
  });

  it("Black's capture returns the captured player to the pool when transfer would overflow the roster", () => {
    // Mirrors the White test above, with Black as the capturing side.
    const bDst1 = makePlayer("b_dst1", "DST", 2500);
    let state = applyMove(new BuildState(), uci("d2d4"), makePlayer("w_pawn1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("d7d5"), bDst1, NFL, CONTEST);
    const wDstCaptured = makePlayer("w_dst_captured", "DST", 2600);
    state = applyMove(state, uci("e2e4"), wDstCaptured, NFL, CONTEST);

    const captureMove = uci("d5e4");
    const matched = state.board.moves({ verbose: true }).find((m) => m.from === "d5" && m.to === "e4");
    expect(matched?.isCapture()).toBe(true);
    expect(state.board.turn()).toBe("b");
    expect(isLegalCapture(state, captureMove, NFL, CONTEST)).toBe(false);

    const newState = applyCaptureMove(state, captureMove, NFL, CONTEST);

    expect(newState.blackMoves).toEqual(state.blackMoves); // unchanged -- no new pick for Black
    expect(newState.whiteMoves.some((m) => m.player.id === "w_dst_captured")).toBe(false); // left White's roster
    expect(newState.lockedPlayerIds.has("w_dst_captured")).toBe(false); // back in the pool
  });
});

describe("lineupStillCompletable", () => {
  it("flex can absorb one extra RB", () => {
    const roster = [0, 1, 2].map((i) => makePlayer(`rb${i}`, "RB", 5200)); // 3rd RB uses the 1 flex
    expect(lineupStillCompletable(roster, NFL, CONTEST_CAP)).toBe(true);
  });

  it("flex double overflow is illegal", () => {
    const roster = [
      ...[0, 1, 2].map((i) => makePlayer(`rb${i}`, "RB", 5200)),
      ...[0, 1, 2].map((i) => makePlayer(`wr${i}`, "WR", 5000)),
    ];
    expect(lineupStillCompletable(roster, NFL, CONTEST_CAP)).toBe(true); // flex spent on the 3rd RB
    const overflowed = [...roster, makePlayer("wr4", "WR", 5300)]; // 4th WR would need the flex too
    expect(lineupStillCompletable(overflowed, NFL, CONTEST_CAP)).toBe(false);
  });

  it("second DST is illegal", () => {
    const oneDst = [makePlayer("dst1", "DST", 2500)];
    expect(lineupStillCompletable(oneDst, NFL, CONTEST_CAP)).toBe(true);
    const twoDst = [...oneDst, makePlayer("dst2", "DST", 2600)];
    expect(lineupStillCompletable(twoDst, NFL, CONTEST_CAP)).toBe(false);
  });

  it("mirrors castle()'s cap overflow check", () => {
    // Knight+Bishop already locked (9600), King+Rook (12000) pushes the
    // total to 21600 > a 15000 cap.
    const alreadyLocked = [makePlayer("te1", "TE", 5200), makePlayer("wr1", "WR", 5000)];
    const king = makePlayer("qb1", "QB", 6000);
    const rook = makePlayer("rb1", "RB", 6000);
    expect(lineupStillCompletable([...alreadyLocked, king, rook], NFL, 15000)).toBe(false);
  });

  it("mirrors is_legal_capture()'s cap overflow check", () => {
    // The captured player (Task 18: the capturing move's only pick) on top
    // of what's already locked exceeds a tight cap.
    const alreadyLocked = makePlayer("wr1", "WR", 5100);
    const captured = makePlayer("rb1", "RB", 5200); // 5100 + 5200 = 10300 > 10000
    expect(lineupStillCompletable([alreadyLocked, captured], NFL, 10000)).toBe(false);
  });

  it("capture is illegal on roster overflow", () => {
    // The capturing side already has its own QB; capturing a 2nd QB-tier
    // player can never fit a DK roster, regardless of salary/cap.
    const alreadyLocked = [makePlayer("qb2", "QB", 5900)];
    const capturedQb = makePlayer("qb1", "QB", 6000);
    expect(lineupStillCompletable([...alreadyLocked, capturedQb], NFL, CONTEST_CAP)).toBe(false);
  });

  it("multi-position player fills either slot", () => {
    // A hybrid RB/WR player, per CLAUDE.md's "Multi-sport ready": "can fill
    // any slot matching any of them."
    const hybrid = new Player({
      id: "h1",
      name: "Hybrid",
      positions: ["RB", "WR"],
      team: "AAA",
      opp: "BBB",
      salary: 3000,
      proj: 10.0,
      ownSmall: 0.1,
      ownLarge: 0.1,
      floor: 6.0,
      ceiling: 16.0,
    });
    const threeRbs = [0, 1, 2].map((i) => makePlayer(`rb${i}`, "RB", 5200)); // fills RB(2) + FLEX(1)
    const roster = [...threeRbs, hybrid];
    expect(lineupStillCompletable(roster, NFL, CONTEST_CAP)).toBe(true); // hybrid still fits via WR
  });
});

// Task 43: DK slot display on the finish screen/Copy lineup.
describe("assignRosterSlots", () => {
  it("assigns each player to their own dedicated slot, with no overflow", () => {
    const roster = [makePlayer("qb1", "QB", 6000), makePlayer("rb1", "RB", 5200), makePlayer("wr1", "WR", 5000), makePlayer("te1", "TE", 4500)];
    expect(assignRosterSlots(roster, NFL.rosterSlots)).toEqual(["QB", "RB", "WR", "TE"]);
  });

  it("a 3rd RB beyond the 2 dedicated slots lands in FLEX -- some RB does, not necessarily the 3rd one locked", () => {
    // Which of the 3 interchangeable RBs ends up labeled FLEX vs. RB is
    // whatever the augmenting search finds first, not lock order (RB and
    // RB are indistinguishable slot instances anyway) -- the multiset of
    // labels is the actual contract, not a specific player->label mapping.
    const roster = [0, 1, 2].map((i) => makePlayer(`rb${i}`, "RB", 5200));
    expect(assignRosterSlots(roster, NFL.rosterSlots).sort()).toEqual(["FLEX", "RB", "RB"]);
  });

  it("a full 9-player lineup assigns every DK slot exactly once", () => {
    const roster = [
      makePlayer("qb1", "QB", 6000),
      makePlayer("rb1", "RB", 5200),
      makePlayer("rb2", "RB", 5300),
      makePlayer("wr1", "WR", 5000),
      makePlayer("wr2", "WR", 5100),
      makePlayer("wr3", "WR", 5200),
      makePlayer("te1", "TE", 4500),
      makePlayer("rb3", "RB", 5400), // flex
      makePlayer("dst1", "DST", 2500),
    ];
    const slots = assignRosterSlots(roster, NFL.rosterSlots);
    expect(slots.sort()).toEqual(["DST", "FLEX", "QB", "RB", "RB", "TE", "WR", "WR", "WR"]);
  });

  it("a multi-position player still gets a valid slot when sharing the roster with same-family players", () => {
    // 3 pure RBs fill RB(2)+FLEX(1) entirely; the RB/WR hybrid has nowhere
    // left in the RB family, but WR(3) is wide open -- same feasibility
    // lineupStillCompletable's own "multi-position player fills either
    // slot" test already covers; this just checks assignRosterSlots finds
    // the same valid total assignment maxAssignable already guarantees
    // exists, not which specific slot name the hybrid draws.
    const hybrid = new Player({
      id: "h1",
      name: "Hybrid",
      positions: ["RB", "WR"],
      team: "AAA",
      opp: "BBB",
      salary: 3000,
      proj: 10.0,
      ownSmall: 0.1,
      ownLarge: 0.1,
      floor: 6.0,
      ceiling: 16.0,
    });
    const threeRbs = [0, 1, 2].map((i) => makePlayer(`rb${i}`, "RB", 5200));
    const roster = [...threeRbs, hybrid];
    const slots = assignRosterSlots(roster, NFL.rosterSlots);
    expect(slots).toHaveLength(roster.length);
    expect(slots.every((s) => s !== "")).toBe(true); // every player landed somewhere
    expect(slots.sort()).toEqual(["FLEX", "RB", "RB", "WR"]);
  });
});

// Rule change "Roster-full notice + opponent in pick lists": which real-
// world positions have no roster-slot capacity left at all, FLEX included.
describe("blockedPositions", () => {
  it("empty roster: nothing is blocked", () => {
    expect(blockedPositions([], NFL.rosterSlots)).toEqual(new Set());
  });

  it("WR is blocked once WR(3) and FLEX are both spoken for by WRs", () => {
    const roster = [0, 1, 2, 3].map((i) => makePlayer(`wr${i}`, "WR", 5000 + i, "AAA"));
    expect(blockedPositions(roster, NFL.rosterSlots)).toEqual(new Set(["WR"]));
  });

  it("RB is NOT blocked by a full WR+FLEX -- FLEX could just as easily have gone to an RB", () => {
    // Only 3 WRs locked (WR(3) full, FLEX still open) -- RB(2) is wide open
    // AND FLEX remains available to RB, so RB isn't blocked at all.
    const roster = [0, 1, 2].map((i) => makePlayer(`wr${i}`, "WR", 5000 + i, "AAA"));
    expect(blockedPositions(roster, NFL.rosterSlots)).toEqual(new Set());
  });

  it("a position with its own dedicated slot filled, but no FLEX overlap (QB), is blocked on its own", () => {
    const roster = [makePlayer("qb1", "QB", 6000, "AAA")];
    expect(blockedPositions(roster, NFL.rosterSlots).has("QB")).toBe(true);
  });

  it("every FLEX-eligible position (RB, WR, TE) is blocked once a full lineup locks FLEX too", () => {
    const roster = [
      makePlayer("qb1", "QB", 6000, "AAA"),
      makePlayer("rb1", "RB", 5200, "AAA"),
      makePlayer("rb2", "RB", 5300, "AAA"),
      makePlayer("wr1", "WR", 5000, "AAA"),
      makePlayer("wr2", "WR", 5100, "AAA"),
      makePlayer("wr3", "WR", 5200, "AAA"),
      makePlayer("te1", "TE", 4500, "AAA"),
      makePlayer("rb3", "RB", 5400, "AAA"), // flex
      makePlayer("dst1", "DST", 2500, "AAA"),
    ];
    expect(blockedPositions(roster, NFL.rosterSlots)).toEqual(new Set(["QB", "RB", "WR", "TE", "DST"]));
  });
});
