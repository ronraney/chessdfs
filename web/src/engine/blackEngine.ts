// Black's out-of-book move selection (no committed book line left to play,
// see build.ts's playBlackMove). `BlackEngine` is the seam between that pure
// decision -- "which of the legal, DFS-sound candidates does Black play" --
// and whatever actually generates centipawn evaluations for them. Kept here
// (engine/, per this directory's own "no DOM, no I/O" rule -- see index.ts)
// as an interface plus a pure, side-effect-free default (`noEngine`); the
// real Stockfish-backed implementation lives outside engine/ instead (see
// ../stockfishEngine.ts) and is wired in by BuildScreen.tsx, the one place
// in this app allowed to touch a Web Worker.
import type { ChessMove } from "./rules";
import type { SeededRandom } from "./rng";

// MultiPV cap and per-move time budget asked for by the task that added
// Stockfish support: "a fixed, quick setting (target <300 ms per move) with
// MultiPV 5." 250ms (not 300) leaves headroom for worker/message overhead
// so the real engine call comfortably lands under the 300ms target end to
// end, not just in its own UCI "go movetime" budget.
export const ENGINE_MULTIPV = 5;
export const ENGINE_MOVE_TIME_MS = 250;

// How far (in centipawns, from Black's own perspective -- higher is better
// for Black) a candidate may trail the best DFS-sound candidate and still
// be considered "sound" enough to play.
const CP_WINDOW = 50;

// One of the engine's top candidates: the move itself, plus its evaluation
// in centipawns from the side-to-move's (Black's) perspective.
export interface EngineCandidate {
  move: ChessMove;
  cp: number;
}

// The seam build.ts calls through for Black's out-of-book move. Implemented
// for real by ../stockfishEngine.ts; `noEngine` below is the harmless
// default every existing (non-Stockfish-aware) caller and test gets.
export interface BlackEngine {
  analyze(fen: string, multiPv: number, moveTimeMs: number): Promise<EngineCandidate[]>;
}

// The default `BlackEngine` -- always "no opinion," so build.ts's existing
// uniform-random fallback is exactly what runs unless a real engine (like
// ../stockfishEngine.ts's) is explicitly passed in. Keeps engine/ itself
// free of any real engine process or Worker.
export const noEngine: BlackEngine = {
  analyze: async () => [],
};

// Black's policy for choosing among already DFS-filtered, sound engine
// candidates: keep every one within CP_WINDOW centipawns of the best
// remaining candidate, then a seeded choice among those. Deliberately its
// own small function -- named for the simulator to reuse later (see the
// task that added this) -- so that future caller can swap in a different
// candidate source without touching this policy. Returns null for an empty
// candidate list (nothing sound to choose from).
export function chooseAmongSound(candidates: readonly EngineCandidate[], rng: SeededRandom): EngineCandidate | null {
  if (candidates.length === 0) return null;
  const best = Math.max(...candidates.map((c) => c.cp));
  const sound = candidates.filter((c) => c.cp >= best - CP_WINDOW);
  return rng.choice(sound);
}
