// Ported from tests/test_rules.py. The "roster/salary feasibility, tested
// directly" section exercises lineup_still_completable directly; the
// "chess legality + turn order", "exclusivity", and "roster/salary (same
// rules for both sides)" sections exercise is_legal_move/apply_move --
// Task 23 deferred all of those (11 tests) pending ContestConfig; Task 24
// ports ContestConfig + is_legal_move/apply_move (ordinary moves only) and
// these tests along with them. The other test_rules.py sections (castling,
// King modes, captures) remain deferred, their own future task.
import type { Square } from "chess.js";
import { describe, expect, it } from "vitest";
import nflConfig from "../data/config/sports/nfl.json";
import { ContestConfig } from "./config";
import { BuildState, Piece, Player } from "./models";
import { classify } from "./pieces";
import type { ChessMove } from "./rules";
import { applyMove, isLegalMove, lineupStillCompletable } from "./rules";
import { loadSportConfig } from "./sport";

const CONTEST = new ContestConfig({ cap: 50000, fieldSize: 1000, payouts: [] });
// lineupStillCompletable takes a plain cap number, not a ContestConfig.
const CONTEST_CAP = 50000;
const NFL = loadSportConfig(nflConfig);

function makePlayer(id: string, pos: string, salary: number): Player {
  return new Player({
    id,
    name: id,
    positions: [pos],
    team: "AAA",
    opp: "BBB",
    salary,
    proj: 10.0,
    ownSmall: 0.1,
    ownLarge: 0.1,
  });
}

// UCI shorthand (e.g. "e2e4" -> {from: "e2", to: "e4"}), matching Python's
// local `uci()` test helper (`chess.Move.from_uci(move)`). 4-char only --
// no ported test here moves a pawn to its promotion rank.
function uci(move: string): ChessMove {
  return { from: move.slice(0, 2) as Square, to: move.slice(2, 4) as Square };
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
    const rb = makePlayer("rb1", "RB", 5200); // classifies as Rook, not Knight
    expect(classify(rb, NFL)).toBe(Piece.ROOK);
    expect(isLegalMove(new BuildState(), uci("b1c3"), rb, NFL, CONTEST)).toBe(false);
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
    const knight = makePlayer("te1", "TE", 4600);
    const state = applyMove(new BuildState(), uci("b1c3"), knight, NFL, CONTEST);
    expect(state.whiteMoves[0].san).toBe("Nc3");
    expect(state.whiteMoves[0].piece).toBe(Piece.KNIGHT);
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
    expect(classify(fb, NFL)).toBe(Piece.PAWN); // classifies fine...
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
    const alreadyLocked = [makePlayer("te1", "TE", 4600), makePlayer("wr1", "WR", 5000)];
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
    });
    const threeRbs = [0, 1, 2].map((i) => makePlayer(`rb${i}`, "RB", 5200)); // fills RB(2) + FLEX(1)
    const roster = [...threeRbs, hybrid];
    expect(lineupStillCompletable(roster, NFL, CONTEST_CAP)).toBe(true); // hybrid still fits via WR
  });
});
