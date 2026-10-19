import type { Square } from "chess.js";
import { describe, expect, it } from "vitest";
import { chooseAmongSound, noEngine, type EngineCandidate } from "./blackEngine";
import { SeededRandom } from "./rng";

function candidate(uci: string, cp: number): EngineCandidate {
  return { move: { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }, cp };
}

describe("chooseAmongSound", () => {
  it("returns null for an empty candidate list", () => {
    expect(chooseAmongSound([], new SeededRandom(1))).toBeNull();
  });

  it("keeps only candidates within 50cp of the best", () => {
    const best = candidate("e7e5", 30);
    const withinWindow = candidate("c7c5", -20); // exactly 50cp behind -- still in
    const outsideWindow = candidate("g8f6", -21); // 51cp behind -- just out
    const candidates = [best, withinWindow, outsideWindow];

    for (let seed = 0; seed < 30; seed++) {
      const chosen = chooseAmongSound(candidates, new SeededRandom(seed));
      expect(chosen).not.toBeNull();
      expect(chosen!.cp).toBeGreaterThanOrEqual(-20);
      expect(chosen!.move.to).not.toBe("f6"); // the one outside the window never wins
    }
  });

  it("same seed gives the same choice", () => {
    const candidates = [candidate("e7e5", 30), candidate("c7c5", 10), candidate("d7d5", 0)];
    const a = chooseAmongSound(candidates, new SeededRandom(42));
    const b = chooseAmongSound(candidates, new SeededRandom(42));
    expect(a).toEqual(b);
  });

  it("different seeds can give different choices among a tied window", () => {
    const candidates = [candidate("e7e5", 10), candidate("c7c5", 10), candidate("d7d5", 10)];
    const tos = new Set<string>();
    for (let seed = 0; seed < 30; seed++) {
      tos.add(chooseAmongSound(candidates, new SeededRandom(seed))!.move.to);
    }
    expect(tos.size).toBeGreaterThan(1);
  });
});

describe("noEngine", () => {
  it("always resolves with no candidates", async () => {
    expect(await noEngine.analyze("startpos", 5, 250)).toEqual([]);
  });
});
