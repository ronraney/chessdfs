import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";

describe("chess.js smoke test", () => {
  it("plays 1. e4 e5 and reports the move list", () => {
    const chess = new Chess();
    chess.move("e4");
    chess.move("e5");

    expect(chess.history()).toEqual(["e4", "e5"]);
  });
});
