# 10132026 — Port Contest Config and Ordinary-Move Rules (Task 24)

## Context

Going into this session (continuing straight from the prior session's Tasks
21–23), HANDOFF.md's "Where We're Headed" named this exact task next: port
`ContestConfig` to `web/src/engine/config.ts`, then `is_legal_move`/
`apply_move` (ordinary moves only) to `rules.ts`, plus the 11 `test_rules.py`
tests Task 23 deferred pending `ContestConfig`.

Before starting, `git status` showed uncommitted changes: `sessions/
HANDOFF.md` and a new `sessions/1026/10132026-git-setup-and-ts-engine-
port.md` — the prior session's own `wrap-up` output, never committed. Ron
confirmed session log files are always committed (never gitignored) and
HANDOFF.md is safe to commit too (it's fully rewritten each session). Committed
those first, separately, as `c191a3e`.

## What was done

**`web/src/engine/config.ts` (new)** — ports `dfs_chess/config.py`'s
`ContestConfig`, `PayoutTier`, `EntryTier`, and `load_contest_config`
one-for-one: `effectiveCap`, `fieldTier`, `entryTiers`, `entryTier`,
`rankTier`, `targetRank`. `loadContestConfig(data)` takes already-parsed
JSON (same `RawXxx` interface pattern as `loadSportConfig`), not a file
path, per this task's own instruction that the engine stays I/O-free.
`targetRank` uses a hand-written `roundHalfToEven` helper rather than
`Math.round` — Python's `round()` is round-half-to-even, JS's `Math.round`
rounds half away from zero; no ported test actually lands on an exact `.5`
tie (the fraction comes out of a log, so it's astronomically unlikely), but
CLAUDE.md's "match Python behavior exactly" argued for not leaving that gap
unaddressed. **Flag**: this is more defensive than any test requires —
flagging per CLAUDE.md's "flag any assumption" since it's a judgment call
to go beyond what's tested, even though the fix itself is a small, isolated
pure function.

**`web/src/engine/rules.ts`** — added `isLegalMove`/`applyMove`, ported
from `dfs_chess/rules.py`'s functions of the same name, for ordinary
(non-capturing, non-castling) moves only, matching this task's explicit
scope:
- A new `ChessMove` type (`{from: Square; to: Square; promotion?: string}`)
  stands in for Python's `chess.Move` — chess.js has no public constructor
  for a candidate move the way `chess.Move.from_uci(...)` does, so callers
  build this plain object directly (the ported tests' local `uci()` helper
  does this, mirroring Python's own test-local `uci()` wrapper).
- `findLegalMove` (private) looks up a move in `board.moves({verbose:
  true})` by from/to(/promotion) — this is both the `chess_move in
  state.board.legal_moves` check AND, since chess.js's verbose `Move`
  already carries `.piece` and `.san` for the pre-move position, stands in
  for Python's separate `piece_type_at`/`san()` calls in one lookup.
- `isLegalMove` rejects castling (`isKingsideCastle()`/
  `isQueensideCastle()`) and captures (`isCapture()`) early, exactly
  mirroring `is_legal_move`'s own `is_castling`/`is_capture` guards in
  Python — **this is this task's explicit stub for those**: castling
  (`can_castle`/`castle`), King modes (`switch_king`/`place_kings`), and
  captures (`is_legal_capture`/`apply_capture_move`) all remain unported,
  each its own future task, same as Task 23 left them.
  `applyMove` throws if `isLegalMove` is false, then clones the board via
  FEN (`new Chess(state.board.fen())` — chess.js has no `.clone()`),
  pushes the move, transfers `pieceLocks` from the from-square to the
  to-square (appending `player`), appends a `Move` record, and returns a
  freshly-constructed `BuildState` (mirroring Python's `_with_board_state`,
  which always builds a new instance rather than mutating `state` in
  place, even though `BuildState` itself is a mutable class).

**Tests** — ported the 11 deferred `test_rules.py` tests into
`rules.test.ts` (chess legality + turn order: 4; exclusivity: 2;
roster/salary for both sides: 5), plus all 16 `test_config.py` tests into a
new `config.test.ts` (field tier boundaries, cap default/override,
entry-tier/target-rank formula incl. boundary cases, `loadContestConfig`
override behavior) — the `load_contest_config(path)` tests' tmp-file-write
step is dropped, matching `sport.test.ts`'s existing precedent for
`loadSportConfig`'s own file-based tests. No test from either Python file
was left unported.

**Verified**: `npx tsc -b` clean, `npm run test` 61 passed (34 prior + 16
`config.test.ts` + 11 new `rules.test.ts`), `npm run build` clean, `pytest`
180 passed (Python untouched — this task was TypeScript-only). Committed
separately from the prior session's leftover wrap-up commit.

## Open questions / flags

- `roundHalfToEven` in `config.ts` (see above) — a stricter-than-tested
  correctness choice, flagged per CLAUDE.md.
- `ChessMove.promotion` exists for fidelity with Python's `chess.Move` but
  is untested — no ported test moves a pawn to its promotion rank. Noted
  in a comment in both `rules.ts` and the test file's `uci()` helper (which
  only parses 4-character UCI strings).
- The `logs/` vs `sessions/` doc-process mismatch (carried forward from
  prior sessions, not re-litigated here) means this log lives in
  `sessions/1026/`, not `logs/`, per established practice.

## Follow-ups (noted, not acted on)

- Castling (`can_castle`/`castle`), King modes (`switch_king`/
  `place_kings`), and captures (`is_legal_capture`/`apply_capture_move`) —
  each still fully unported, each its own future task (unchanged from
  Task 23's deferral list).
- `build.py`, `loaders.py`, `openings.py` — still entirely unported.
- HANDOFF.md itself was not rewritten this session (that's `wrap-up`'s
  job, not done mid-task).
