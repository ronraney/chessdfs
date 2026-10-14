// Ported from tests/test_build.py, now in full (Task 29). Python's `rng`
// param is a seeded `random.Random`; TS has no seedable equivalent, so
// every ported test uses rng.ts's own from-scratch SeededRandom instead
// (see that file's header). Because of that substitution, no test here can
// assert "this exact seed produces this exact pick" the way a Python test
// theoretically could -- but as it turns out, none of test_build.py's own
// seeded tests do that either: every one of them already asserts a
// property (set membership, same-seed-same-result, or "varies across
// enough seeds") rather than a specific seed's literal pick, so every one
// ports over unchanged in spirit, just with SeededRandom standing in for
// random.Random. None needed converting into a new kind of test.
import type { Square } from "chess.js";
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import nflConfig from "../data/config/sports/nfl.json";
import {
  HAPPY_HUNTING,
  NO_LEGAL_MOVES,
  checkWhiteDeadEnd,
  moveIsCompletable,
  playBlackMove,
  playBlackTemplateMove,
  playWhiteMove,
} from "./build";
import { ContestConfig } from "./config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOpeningBook } from "./loaders";
import { BuildState, KingMode, Move, Piece, Player, Side } from "./models";
import { BookLine, bookContinuations } from "./openings";
import { classify, pieceForChessType } from "./pieces";
import type { ChessMove } from "./rules";
import { applyMove, placeKings } from "./rules";
import { SeededRandom } from "./rng";
import { PieceBand, RosterSlot, SportConfig, loadSportConfig } from "./sport";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENINGS_DIR = path.join(dirname, "..", "data", "openings");
const NFL = loadSportConfig(nflConfig);
const BOOK = loadOpeningBook(
  ["a", "b", "c", "d", "e"].map((letter) => readFileSync(path.join(OPENINGS_DIR, `${letter}.tsv`), "utf-8")),
);
const CONTEST = new ContestConfig({ fieldSize: 1000, payouts: [] });

// A roster of exactly one slot, open to one made-up position -- enough to
// exercise the end condition without hand-constructing a full 9-pick NFL
// lineup. pieceBands has only PAWN (the required catch-all), so only
// actual pawn-type chess moves resolve to a real player here; that's fine,
// this sport only exists for these tests.
const TOY_SPORT = new SportConfig({
  sport: "TOY",
  salaryCap: 50000,
  pieceBands: [new PieceBand({ piece: Piece.PAWN, positions: null, minSalary: null, maxSalary: null })],
  rosterSlots: [new RosterSlot({ name: "ANY", positions: new Set(["ANY"]), count: 1 })],
});

function makePlayer(id: string, pos: string, salary: number, proj = 10.0): Player {
  return new Player({
    id,
    name: id,
    positions: [pos],
    team: "AAA",
    opp: "BBB",
    salary,
    proj,
    ownSmall: 0.1,
    ownLarge: 0.1,
  });
}

// Black's first reply to 1. e4 is always a pawn or knight move (every
// other piece is blocked on move 1) -- these two bands cover every book
// continuation after "e4".
function nflPool(): Player[] {
  const pawns = Array.from({ length: 8 }, (_, i) => makePlayer(`pawn${i}`, "WR", 3000 + i));
  const knights = Array.from({ length: 4 }, (_, i) => makePlayer(`knight${i}`, "TE", 4600 + i));
  return [...pawns, ...knights];
}

// UCI shorthand (e.g. "e2e4" -> {from: "e2", to: "e4"}), matching rules.test.ts's
// own uci() helper. 4-char only -- no ported test here moves a pawn to its
// promotion rank.
function uci(move: string): ChessMove {
  return { from: move.slice(0, 2) as Square, to: move.slice(2, 4) as Square };
}

function lastOf<T>(items: readonly T[]): T {
  return items[items.length - 1];
}

// --- Black's book play -------------------------------------------------------

describe("Black's book play", () => {
  it("stays in book while a line matches", () => {
    const pool = nflPool();
    const [whitePlayer, ...blackPool] = pool;

    const result = playWhiteMove(new BuildState(), uci("e2e4"), whitePlayer, NFL, CONTEST, BOOK);
    expect(result.message).toBeNull();

    const blackResult = playBlackMove(result.state, BOOK, {}, 0, NFL, CONTEST, blackPool, new SeededRandom(1));

    const playedSan = lastOf(blackResult.state.blackMoves).san;
    expect(bookContinuations(["e4"], BOOK).has(playedSan)).toBe(true);
    expect(blackResult.opening).not.toBeNull(); // a name is exposed once in book
  });

  it("same seed gives the same build", () => {
    const pool = nflPool();
    const [whitePlayer, ...blackPool] = pool;
    const result = playWhiteMove(new BuildState(), uci("e2e4"), whitePlayer, NFL, CONTEST, BOOK);

    const r1 = playBlackMove(result.state, BOOK, {}, 0, NFL, CONTEST, blackPool, new SeededRandom(99));
    const r2 = playBlackMove(result.state, BOOK, {}, 0, NFL, CONTEST, blackPool, new SeededRandom(99));

    expect(lastOf(r1.state.blackMoves).san).toBe(lastOf(r2.state.blackMoves).san);
    expect(lastOf(r1.state.blackMoves).player.id).toBe(lastOf(r2.state.blackMoves).player.id);
  });

  it("different seeds can give different builds", () => {
    // Sanity check for the determinism test above: confirm the seed is
    // actually doing something, not just that nothing varies by chance.
    const pool = nflPool();
    const [whitePlayer, ...blackPool] = pool;
    const result = playWhiteMove(new BuildState(), uci("e2e4"), whitePlayer, NFL, CONTEST, BOOK);

    const sans = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      const r = playBlackMove(result.state, BOOK, {}, 0, NFL, CONTEST, blackPool, new SeededRandom(seed));
      sans.add(lastOf(r.state.blackMoves).san);
    }
    expect(sans.size).toBeGreaterThan(1);
  });
});

// --- template mode (Task 13) --------------------------------------------------

describe("template mode (Task 13)", () => {
  it("plays exactly, with the highest-projection player", () => {
    const pool = nflPool();
    const [whitePlayer, ...blackPool] = pool;
    const state = playWhiteMove(new BuildState(), uci("e2e4"), whitePlayer, NFL, CONTEST, BOOK).state;

    const result = playBlackTemplateMove(state, uci("e7e5"), NFL, CONTEST, blackPool, BOOK);

    expect(result).not.toBeNull();
    expect(lastOf(result!.state.blackMoves).san).toBe("e5");
    const expectedPlayer = blackPool.find((p) => classify(p, NFL) === Piece.PAWN)!; // highest proj, tie-break stable
    expect(lastOf(result!.state.blackMoves).player.id).toBe(expectedPlayer.id);
    expect(result!.opening).not.toBeNull();
  });

  it("returns null when DFS-illegal", () => {
    const whitePlayer = makePlayer("w1", "WR", 3000);
    const state = playWhiteMove(new BuildState(), uci("e2e4"), whitePlayer, NFL, CONTEST, BOOK).state;

    const result = playBlackTemplateMove(state, uci("e7e5"), NFL, CONTEST, [], BOOK); // no candidates at all

    expect(result).toBeNull();
  });
});

// --- Black's book-line commitment outside a template (Task 13) --------------
// A small synthetic book: two lines sharing "e4 e5 Nf3" but diverging at
// Black's *second* move (Nc6 vs Nf6) -- real enough to prove commitment
// persists across turns, not just that the same move got re-picked by luck.
const LINE_A = new BookLine({ eco: "X1", name: "Line A", moves: ["e4", "e5", "Nf3", "Nc6"] });
const LINE_B = new BookLine({ eco: "X2", name: "Line B", moves: ["e4", "e5", "Nf3", "Nf6"] });
const SYNTH_BOOK = [LINE_A, LINE_B];

describe("Black's book-line commitment outside a template (Task 13)", () => {
  it("commits to a book line and keeps it while White stays in it", () => {
    const whitePawn = makePlayer("w_pawn", "WR", 3000);
    const whiteKnight = makePlayer("w_knight", "TE", 4600);
    const blackPool = [
      ...Array.from({ length: 2 }, (_, i) => makePlayer(`b_pawn${i}`, "WR", 3000 + i)),
      ...Array.from({ length: 2 }, (_, i) => makePlayer(`b_knight${i}`, "TE", 4600 + i)),
    ];

    const state = playWhiteMove(new BuildState(), uci("e2e4"), whitePawn, NFL, CONTEST, SYNTH_BOOK).state;
    const black1 = playBlackMove(state, SYNTH_BOOK, {}, 0, NFL, CONTEST, blackPool, new SeededRandom(7));
    expect(lastOf(black1.state.blackMoves).san).toBe("e5");
    const committed = black1.state.blackCommittedLine;
    expect([LINE_A.moves, LINE_B.moves]).toContainEqual(committed);

    const state2 = playWhiteMove(black1.state, uci("g1f3"), whiteKnight, NFL, CONTEST, SYNTH_BOOK).state;

    // Vary the rng across many trials: if Black were re-rolling every ply
    // instead of honoring its commitment, some of these would land on the
    // sibling line's move (Nc6 vs Nf6) instead.
    const sans = new Set<string>();
    for (let seed = 0; seed < 30; seed++) {
      const r = playBlackMove(state2, SYNTH_BOOK, {}, 0, NFL, CONTEST, blackPool, new SeededRandom(seed));
      sans.add(lastOf(r.state.blackMoves).san);
    }
    expect(sans).toEqual(new Set([committed![3]]));
  });

  it("picks the closest-rank line", () => {
    // Line A's family rank (1) is closer to the target rank (1) than Line
    // B's (90) -- Black must pick A regardless of seed.
    const whitePawn = makePlayer("w_pawn", "WR", 3000);
    const blackPool = [
      ...Array.from({ length: 2 }, (_, i) => makePlayer(`b_pawn${i}`, "WR", 3000 + i)),
      ...Array.from({ length: 2 }, (_, i) => makePlayer(`b_knight${i}`, "TE", 4600 + i)),
    ];
    const familyRanks = { "Line A": 1, "Line B": 90 };
    const targetRank = 1;

    const state = playWhiteMove(new BuildState(), uci("e2e4"), whitePawn, NFL, CONTEST, SYNTH_BOOK).state;

    for (let seed = 0; seed < 10; seed++) {
      const result = playBlackMove(state, SYNTH_BOOK, familyRanks, targetRank, NFL, CONTEST, blackPool, new SeededRandom(seed));
      expect(result.state.blackCommittedLine).toEqual(LINE_A.moves);
    }
  });

  it("prefers a ranked line over an unranked one", () => {
    // An unranked family (missing from familyRanks) counts as farthest --
    // Line B (unranked) must lose to Line A even though A's own rank (50)
    // is numerically far from the target (1); "farthest" beats any real,
    // finite distance.
    const whitePawn = makePlayer("w_pawn", "WR", 3000);
    const blackPool = [
      ...Array.from({ length: 2 }, (_, i) => makePlayer(`b_pawn${i}`, "WR", 3000 + i)),
      ...Array.from({ length: 2 }, (_, i) => makePlayer(`b_knight${i}`, "TE", 4600 + i)),
    ];
    const familyRanks = { "Line A": 50 }; // "Line B" is absent -- unranked
    const targetRank = 1;

    const state = playWhiteMove(new BuildState(), uci("e2e4"), whitePawn, NFL, CONTEST, SYNTH_BOOK).state;

    for (let seed = 0; seed < 10; seed++) {
      const result = playBlackMove(state, SYNTH_BOOK, familyRanks, targetRank, NFL, CONTEST, blackPool, new SeededRandom(seed));
      expect(result.state.blackCommittedLine).toEqual(LINE_A.moves);
    }
  });

  it("ties between lines are broken by the seed", () => {
    // Both families unranked (missing from familyRanks) -> both count as
    // farthest -> tied -> the seed decides.
    const whitePawn = makePlayer("w_pawn", "WR", 3000);
    const blackPool = [
      ...Array.from({ length: 2 }, (_, i) => makePlayer(`b_pawn${i}`, "WR", 3000 + i)),
      ...Array.from({ length: 2 }, (_, i) => makePlayer(`b_knight${i}`, "TE", 4600 + i)),
    ];
    const state = playWhiteMove(new BuildState(), uci("e2e4"), whitePawn, NFL, CONTEST, SYNTH_BOOK).state;

    const committed = new Set<string>();
    for (let seed = 0; seed < 30; seed++) {
      const r = playBlackMove(state, SYNTH_BOOK, {}, 0, NFL, CONTEST, blackPool, new SeededRandom(seed));
      committed.add(JSON.stringify(r.state.blackCommittedLine));
    }
    expect(committed.size).toBeGreaterThan(1); // both lines turn up across enough seeds
  });

  it("re-chooses when White deviates from the line", () => {
    const whitePawn = makePlayer("w_pawn", "WR", 3000);
    const whiteKnight = makePlayer("w_knight", "TE", 4600);
    const blackPool = [
      ...Array.from({ length: 4 }, (_, i) => makePlayer(`b_pawn${i}`, "WR", 3000 + i)),
      ...Array.from({ length: 4 }, (_, i) => makePlayer(`b_knight${i}`, "TE", 4600 + i)),
    ];

    const state = playWhiteMove(new BuildState(), uci("e2e4"), whitePawn, NFL, CONTEST, SYNTH_BOOK).state;
    const black1 = playBlackMove(state, SYNTH_BOOK, {}, 0, NFL, CONTEST, blackPool, new SeededRandom(7));
    expect(black1.state.blackCommittedLine).not.toBeNull();

    // White deviates: Nc3 instead of either line's Nf3.
    const state2 = playWhiteMove(black1.state, uci("b1c3"), whiteKnight, NFL, CONTEST, SYNTH_BOOK).state;
    const black2 = playBlackMove(state2, SYNTH_BOOK, {}, 0, NFL, CONTEST, blackPool, new SeededRandom(7));

    expect(black2.state.blackCommittedLine).toBeNull(); // nothing in the synthetic book matches "e4 e5 Nc3"
  });
});

const WHITE_LINE: readonly ChessMove[] = [uci("e2e4"), uci("g1f3")]; // real book moves, always legal here regardless of Black's own replies

function driveMultiPly(seed: number): { blackSans: string[]; committedLine: readonly string[] | null } {
  const whitePool = [makePlayer("w_pawn", "WR", 3000), makePlayer("w_knight", "TE", 4600)];
  const blackPool = [
    ...Array.from({ length: 8 }, (_, i) => makePlayer(`b_pawn${i}`, "WR", 3000 + i)),
    ...Array.from({ length: 8 }, (_, i) => makePlayer(`b_knight${i}`, "TE", 4600 + i)),
  ];
  let state = new BuildState();
  const rng = new SeededRandom(seed);
  const blackSans: string[] = [];
  for (const move of WHITE_LINE) {
    const piece = pieceForChessType(state.board.get(move.from)!.type);
    const player = whitePool.find((p) => !state.lockedPlayerIds.has(p.id) && classify(p, NFL) === piece)!;
    state = playWhiteMove(state, move, player, NFL, CONTEST, BOOK).state;
    const blackResult = playBlackMove(state, BOOK, {}, 0, NFL, CONTEST, blackPool, rng);
    state = blackResult.state;
    blackSans.push(lastOf(state.blackMoves).san);
  }
  return { blackSans, committedLine: state.blackCommittedLine };
}

describe("Black's book-line commitment across multiple plies", () => {
  it("same seed gives the same build across multiple plies", () => {
    expect(driveMultiPly(99)).toEqual(driveMultiPly(99));
  });

  it("different seeds can give different multi-ply builds", () => {
    const results = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      results.add(JSON.stringify(driveMultiPly(seed).blackSans));
    }
    expect(results.size).toBeGreaterThan(1);
  });
});

// --- King modes (Task 14) -----------------------------------------------------

describe("King modes (Task 14)", () => {
  it("moveIsCompletable is true for a silent King move with an empty pool", () => {
    let state = placeKings(makePlayer("qb_w", "QB", 6500), makePlayer("qb_b", "QB", 6200), NFL, CONTEST);
    state = applyMove(state, uci("e2e4"), makePlayer("w_pawn", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("d7d5"), makePlayer("b_pawn", "WR", 3000), NFL, CONTEST);

    const kingMove = uci("e1e2");

    // PLACED: locks no one, so an empty pool is still fine. EMERGE: this
    // move would need to lock a brand-new QB, and there's none to find.
    expect(moveIsCompletable(state, kingMove, NFL, CONTEST, [], KingMode.PLACED)).toBe(true);
    expect(moveIsCompletable(state, kingMove, NFL, CONTEST, [], KingMode.EMERGE)).toBe(false);
  });

  it("Black King move in PLACED mode locks no player", () => {
    let state = placeKings(makePlayer("qb_w", "QB", 6500), makePlayer("qb_b", "QB", 6200), NFL, CONTEST);
    state = applyMove(state, uci("e2e4"), makePlayer("w_pawn", "WR", 3000), NFL, CONTEST);

    const result = playBlackTemplateMove(
      state, uci("e7e5"), NFL, CONTEST, [makePlayer("b_pawn", "WR", 3000)], BOOK, KingMode.PLACED,
    );
    expect(result).not.toBeNull();
    state = result!.state;
    expect(state.blackMoves).toHaveLength(2); // the setup-placed King + the e5 Pawn pick

    state = applyMove(state, uci("d2d4"), makePlayer("w_pawn2", "WR", 3100), NFL, CONTEST);
    const before = state.blackMoves;

    const kingMove = uci("e8e7");
    const result2 = playBlackTemplateMove(state, kingMove, NFL, CONTEST, [], BOOK, KingMode.PLACED);

    expect(result2).not.toBeNull();
    expect(result2!.state.blackMoves).toEqual(before); // unchanged -- no new lock
    expect(result2!.state.board.get("e7")?.type).toBe("k"); // the king really did move
  });

  it("King capture in PLACED mode now works", () => {
    // Previously-flagged gap: a King capture in PLACED mode was
    // unsupported, since the old capture rule needed to both suppress the
    // King's own new pick AND still transfer the captured piece, with no
    // primitive for "transfer only." Removing the mover's own pick from
    // every capture means the captured player IS the pick regardless of
    // which piece captured, so that conflict no longer exists and this
    // just works now.
    const whiteKing = makePlayer("qb_w", "QB", 6500);
    const blackKing = makePlayer("qb_b", "QB", 6200);
    const capturedKnight = makePlayer("te_captured", "TE", 4600);

    const board = new Chess("4k3/8/8/8/8/8/4n3/4K3 w - - 0 1");
    const state = new BuildState({
      board,
      whiteMoves: [new Move({ side: Side.WHITE, piece: Piece.KING, san: "(placed)", player: whiteKing })],
      blackMoves: [
        new Move({ side: Side.BLACK, piece: Piece.KING, san: "(placed)", player: blackKing }),
        new Move({ side: Side.BLACK, piece: Piece.KNIGHT, san: "Ne2", player: capturedKnight }),
      ],
      lockedPlayerIds: new Set([whiteKing.id, blackKing.id, capturedKnight.id]),
      pieceLocks: new Map([["e2" as Square, [capturedKnight]]]),
    });

    const kingCapture = uci("e1e2");
    const matched = board.moves({ verbose: true }).find((m) => m.from === kingCapture.from && m.to === kingCapture.to);
    expect(matched).toBeDefined();
    expect(matched!.isCapture()).toBe(true);

    const result = playWhiteMove(state, kingCapture, null, NFL, CONTEST, BOOK, null, KingMode.PLACED);

    expect(result.state.whiteMoves).toHaveLength(2); // the placed King + the captured Knight
    expect(lastOf(result.state.whiteMoves).player.id).toBe(capturedKnight.id);
    expect(result.state.blackMoves).toEqual([state.blackMoves[0]]); // Black keeps only its King
  });
});

// --- capturing a piece that never moved (Task 19) ----------------------------

describe("capturing a piece that never moved (Task 19)", () => {
  it("Black can capture an unmoved Knight and gets a Knight pick", () => {
    // Previously avoided (no lock history meant no legal capture at all):
    // Black's bishop captures White's knight, still on its home square g1
    // (White only ever moves its OTHER knight/pawns) -- this lets Black
    // play this now, picking its own Knight (the same highest-projection
    // placeholder every other pick uses) rather than transferring
    // anything. A real move sequence from the start position (rather than
    // a hand-built FEN) so the board's own history can still replay it.
    const board = new Chess();
    for (const san of ["Nc3", "e5", "f3", "Bc5", "a3"]) {
      board.move(san);
    }
    const state = new BuildState({ board });
    const matched = board.moves({ verbose: true }).find((m) => m.san === "Bxg1")!;
    const captureMove: ChessMove = { from: matched.from, to: matched.to, promotion: matched.promotion };
    expect(matched.isCapture()).toBe(true);

    const result = playBlackTemplateMove(state, captureMove, NFL, CONTEST, nflPool(), BOOK, KingMode.EMERGE);

    expect(result).not.toBeNull();
    expect(result!.state.blackMoves).toHaveLength(1);
    const record = result!.state.blackMoves[0];
    expect(record.piece).toBe(Piece.KNIGHT);
    expect(record.player.id).toBe("knight0"); // highest-proj eligible Knight in nflPool()
    expect(result!.state.whiteMoves).toEqual([]); // nothing removed -- there was nothing to remove
  });
});

// --- end condition -------------------------------------------------------------

describe("end condition", () => {
  it("build ends on White's completion with Black incomplete", () => {
    const whitePlayer = makePlayer("w1", "ANY", 1000);

    const result = playWhiteMove(new BuildState(), uci("e2e4"), whitePlayer, TOY_SPORT, CONTEST, []);

    expect(result.message).toBe(HAPPY_HUNTING);
    expect(new Set(result.state.whiteMoves.map((m) => m.player.id))).toEqual(new Set(["w1"]));
    expect(result.state.blackMoves).toEqual([]); // Black never got a turn, let alone finished
  });

  it("Black with a full lineup still moves without locking", () => {
    // Hand-built: Black already has its one slot filled (full under
    // TOY_SPORT) while White still has none locked -- an edge case that
    // wouldn't arise through normal alternating play with equal roster
    // sizes (White's own completion would have already ended the build),
    // but that's exactly why playBlackMove needs to be tested in this
    // state directly rather than only through a played-out sequence.
    const board = new Chess();
    board.move({ from: "e2", to: "e4" }); // so it's Black's turn
    const blackPlayer = makePlayer("b1", "ANY", 1000);
    const state = new BuildState({
      board,
      whiteMoves: [],
      blackMoves: [new Move({ side: Side.BLACK, piece: Piece.PAWN, san: "(elsewhere)", player: blackPlayer })],
      lockedPlayerIds: new Set([blackPlayer.id]),
    });
    const movesBefore = board.history().length;

    const result = playBlackMove(state, [], {}, 0, TOY_SPORT, CONTEST, [], new SeededRandom(3));

    expect(result.state.blackMoves).toEqual(state.blackMoves); // unchanged -- no one new locked
    expect(result.state.lockedPlayerIds).toEqual(state.lockedPlayerIds);
    expect(result.state.board.history().length).toBe(movesBefore + 1); // but a real move was made
    expect(result.message).toBeNull(); // White still hasn't completed; the build isn't over
  });
});

// --- capture transfer pre-check (Task 11c) -----------------------------------

describe("capture transfer pre-check (Task 11c)", () => {
  it("no error escapes playBlackMove for an infeasible capture", () => {
    // Black already has one DST locked. White's e4 pawn is also a DST
    // pick, and dxe4 would transfer it over as Black's pick for this move
    // -- giving Black two DSTs, which DST's single slot can't hold.
    // Before the fix (under the old two-pick capture rule), this exact
    // shape escaped playBlackMove as an uncaught error (reproduced on real
    // data at seeds 17/18 in the Python build, per Task 11b's log). Across
    // many seeds here, playBlackMove must never raise it, and must never
    // actually complete that transfer.
    const bDst1 = makePlayer("b_dst1", "DST", 2500);
    let state = applyMove(new BuildState(), uci("d2d4"), makePlayer("w_f1", "WR", 3000), NFL, CONTEST);
    state = applyMove(state, uci("d7d5"), bDst1, NFL, CONTEST);
    const wDstCaptured = makePlayer("w_dst_captured", "DST", 2600);
    state = applyMove(state, uci("e2e4"), wDstCaptured, NFL, CONTEST);

    const captureMove = uci("d5e4");
    const matched = state.board.moves({ verbose: true }).find((m) => m.from === captureMove.from && m.to === captureMove.to);
    expect(matched).toBeDefined();
    expect(matched!.isCapture()).toBe(true);

    const pool = [
      ...Array.from({ length: 8 }, (_, i) => makePlayer(`filler_wr${i}`, "WR", 3000 + i)),
      ...Array.from({ length: 4 }, (_, i) => makePlayer(`filler_te${i}`, "TE", 4600 + i)),
    ];

    for (let seed = 0; seed < 50; seed++) {
      const result = playBlackMove(state, [], {}, 0, NFL, CONTEST, pool, new SeededRandom(seed));
      const positions = result.state.blackMoves.map((m) => m.player.positions[0]);
      expect(positions.filter((p) => p === "DST").length).toBeLessThanOrEqual(1); // the overflowing transfer never went through
      expect(result.state.blackMoves.some((m) => m.player.id === "w_dst_captured")).toBe(false);
    }
  });
});

// --- dead-end endings (Task 11e) ---------------------------------------------

// 8 locked White players filling every non-QB slot exactly (RB x2, WR x3 +
// the 1 FLEX, TE x1, DST x1) -- only QB is left open.
function fullyBoxedWhiteRoster(): Move[] {
  const rbs = Array.from({ length: 2 }, (_, i) => makePlayer(`rb${i}`, "RB", 5200 + i, 1.0));
  const wrs = Array.from({ length: 4 }, (_, i) => makePlayer(`wr${i}`, "WR", 5000 + i, 1.0)); // 3 base + 1 FLEX
  const te = makePlayer("te0", "TE", 4600, 1.0);
  const dst = makePlayer("dst0", "DST", 2500, 1.0);
  return [
    ...rbs.map((p) => new Move({ side: Side.WHITE, piece: Piece.ROOK, san: "x", player: p })),
    ...wrs.map((p) => new Move({ side: Side.WHITE, piece: Piece.BISHOP, san: "x", player: p })),
    new Move({ side: Side.WHITE, piece: Piece.KNIGHT, san: "x", player: te }),
    new Move({ side: Side.WHITE, piece: Piece.PAWN, san: "x", player: dst }),
  ];
}

describe("dead-end endings (Task 11e)", () => {
  it("White boxed King with only QB open ends the build", () => {
    // The pristine starting position's White king (e1) already has zero
    // legal moves -- boxed by its own queen, bishop, and d2/e2/f2 pawns,
    // none of which have moved here. With every other roster slot already
    // full (hand-built below), every one of the 20 legal first moves (16
    // pawn + 4 knight) needs a slot that's already full too, so nothing
    // else can substitute for the missing king move.
    const whiteMoves = fullyBoxedWhiteRoster();
    const state = new BuildState({
      whiteMoves,
      lockedPlayerIds: new Set(whiteMoves.map((m) => m.player.id)),
    });
    expect(state.board.turn()).toBe("w");

    const result = checkWhiteDeadEnd(state, NFL, CONTEST, []);

    expect(result).not.toBeNull();
    expect(result!.message).toBe(NO_LEGAL_MOVES);
    expect(result!.openSlots).toEqual({ QB: 1 });
    expect(result!.state.whiteMoves).toEqual(whiteMoves); // nothing changed -- build just ends
  });

  it("White with a legal move is not a dead end", () => {
    // A fresh build: White has 20 legal first moves and a normal player
    // pool, so this must NOT be reported as a dead end.
    const pool = [
      ...Array.from({ length: 4 }, (_, i) => makePlayer(`pawn${i}`, "WR", 3000 + i)),
      ...Array.from({ length: 2 }, (_, i) => makePlayer(`knight${i}`, "TE", 4600 + i)),
    ];
    expect(checkWhiteDeadEnd(new BuildState(), NFL, CONTEST, pool)).toBeNull();
  });
});
