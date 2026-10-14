// Task 38: buildFlow.ts's own tests -- pure-function coverage for the
// move-first-then-pick flow's "what can White drag" and "what's
// suggested" logic, independent of the board/chessground component.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import nflConfig from "./data/config/sports/nfl.json";
import { chessMoveForSan, dfsLegalMoves, suggestionFor } from "./buildFlow";
import { ContestConfig } from "./engine/config";
import { loadOpeningBook } from "./engine/loaders";
import { BuildState, KingMode, Player } from "./engine/models";
import { applyMove } from "./engine/rules";
import { loadSportConfig } from "./engine/sport";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENINGS_DIR = path.join(dirname, "engine", "..", "data", "openings");
const BOOK = loadOpeningBook(
  ["a", "b", "c", "d", "e"].map((letter) => readFileSync(path.join(OPENINGS_DIR, `${letter}.tsv`), "utf-8")),
);
const NFL = loadSportConfig(nflConfig);
const CONTEST = new ContestConfig({ fieldSize: 1000, payouts: [] });

function makePlayer(id: string, pos: string, salary: number, proj = 10.0): Player {
  return new Player({ id, name: id, positions: [pos], team: "AAA", opp: "BBB", salary, proj, ownSmall: 0.1, ownLarge: 0.1 });
}

// Enough of each piece band (NFL's bands: QB->King, RB 5000-7000->Rook,
// WR 5000-7000->Bishop, TE 4500-7000->Knight, everything else->Pawn) to
// develop a short Italian Game and reach a real castling position.
function fullPool(): Player[] {
  return [
    ...Array.from({ length: 8 }, (_, i) => makePlayer(`pawn${i}`, "DST", 3000 + i)),
    ...Array.from({ length: 4 }, (_, i) => makePlayer(`knight${i}`, "TE", 4600 + i)),
    ...Array.from({ length: 4 }, (_, i) => makePlayer(`bishop${i}`, "WR", 5500 + i)),
  ];
}

// Drives e4 e5 Nf3 Nc6 Bc4 Bc5 (the Italian Game) so White's locked Knight
// + Bishop make O-O chess-AND-DFS-legal next -- openings.test.ts's own
// ITALIAN_CASTLES fixture is this exact sequence. applyMove reads whichever
// side is actually to move from the board itself, so it works unchanged
// for both sides -- no need for play{White,Black}Move's own book/opening
// bookkeeping here. Each ply needs a player from the band its move's
// piece actually classifies as (pawn moves need a pawn-band player, not
// just "the next player in the pool").
function italianPosition(pool: Player[]): BuildState {
  const sans = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"];
  const used = new Set<string>();
  let state = new BuildState();
  for (const san of sans) {
    const move = chessMoveForSan(state, san)!;
    const prefix = san[0] === "N" ? "knight" : san[0] === "B" ? "bishop" : "pawn";
    const player = pool.find((p) => p.id.startsWith(prefix) && !used.has(p.id))!;
    used.add(player.id);
    state = applyMove(state, { from: move.from, to: move.to }, player, NFL, CONTEST);
  }
  return state;
}

describe("chessMoveForSan", () => {
  it("resolves a legal SAN token on the current position", () => {
    const move = chessMoveForSan(new BuildState(), "e4")!;
    expect(move.from).toBe("e2");
    expect(move.to).toBe("e4");
  });

  it("null for a token that isn't legal here", () => {
    expect(chessMoveForSan(new BuildState(), "Qh5")).toBeNull();
  });
});

describe("dfsLegalMoves", () => {
  it("nothing is offered with an empty player pool", () => {
    expect(dfsLegalMoves(new BuildState(), NFL, CONTEST, [], KingMode.EMERGE)).toEqual([]);
  });

  it("excludes captures even when a replacement player exists", () => {
    const pool = fullPool();
    const afterE4 = applyMove(new BuildState(), { from: "e2", to: "e4" }, pool[0], NFL, CONTEST);
    const d5 = chessMoveForSan(afterE4, "d5")!;
    const afterD5 = applyMove(afterE4, { from: d5.from, to: d5.to }, pool[1], NFL, CONTEST); // Black's reply

    const legal = dfsLegalMoves(afterD5, NFL, CONTEST, pool, KingMode.EMERGE);
    expect(afterD5.board.moves({ verbose: true }).some((m) => m.san === "exd5")).toBe(true); // chess-legal
    expect(legal.some((m) => m.san === "exd5")).toBe(false); // not offered
  });

  it("excludes castling even when chess-AND-DFS-legal", () => {
    const pool = fullPool();
    const italian = italianPosition(pool);
    expect(italian.board.moves({ verbose: true }).some((m) => m.isKingsideCastle())).toBe(true); // chess-legal
    const legal = dfsLegalMoves(italian, NFL, CONTEST, pool, KingMode.EMERGE);
    expect(legal.some((m) => m.isKingsideCastle())).toBe(false); // not offered
  });

  it("offers an ordinary move once an eligible unlocked player exists", () => {
    const pool = fullPool();
    const legal = dfsLegalMoves(new BuildState(), NFL, CONTEST, pool, KingMode.EMERGE);
    expect(legal.some((m) => m.san === "e4")).toBe(true);
  });
});

describe("suggestionFor", () => {
  const RUY_LOPEZ_MORPHY = BOOK.find((line) => line.eco === "C70" && line.name === "Ruy Lopez: Morphy Defense")!;
  const OWN: { kind: "own" } = { kind: "own" };

  it("'own opening' never suggests anything", () => {
    expect(suggestionFor([], OWN, BOOK)).toEqual({ kind: "none" });
    expect(suggestionFor(["e4"], OWN, BOOK)).toEqual({ kind: "none" });
  });

  it("on the chosen line: suggests exactly its next move", () => {
    const chosen = { kind: "line" as const, line: RUY_LOPEZ_MORPHY };
    const suggestion = suggestionFor(["e4", "e5", "Nf3", "Nc6", "Bb5"], chosen, BOOK);
    expect(suggestion).toEqual({ kind: "onLine", move: "a6", lineName: "Ruy Lopez: Morphy Defense" });
  });

  it("off the chosen line: falls back to book continuations by name", () => {
    const chosen = { kind: "line" as const, line: RUY_LOPEZ_MORPHY };
    // Deviates on move 1 (d4 instead of e4) -- the Morphy Defense no longer matches at all.
    const suggestion = suggestionFor(["d4"], chosen, BOOK);
    expect(suggestion.kind).toBe("offLine");
    if (suggestion.kind === "offLine") {
      expect(suggestion.options.length).toBeGreaterThan(0);
      for (const option of suggestion.options) {
        expect(suggestion.options.filter((o) => o.move === option.move)).toHaveLength(1); // one entry per move
      }
    }
  });

  it("past the chosen line's own end, still suggests from the book if the position is still in it", () => {
    const chosen = { kind: "line" as const, line: RUY_LOPEZ_MORPHY };
    const suggestion = suggestionFor(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"], chosen, BOOK); // exactly the line's end
    // "Ruy Lopez: Morphy Defense" itself continues further in the real book (e.g. "Ba4").
    expect(suggestion.kind).toBe("offLine");
  });

  it("no suggestion once truly out of book", () => {
    const chosen = { kind: "line" as const, line: RUY_LOPEZ_MORPHY }; // doesn't match this prefix at all
    // Verified against the real vendored book: zero lines start this way.
    expect(suggestionFor(["e4", "a6", "a4", "h5"], chosen, BOOK)).toEqual({ kind: "none" });
  });
});
