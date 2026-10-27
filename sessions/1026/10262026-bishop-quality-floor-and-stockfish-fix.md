# Session: Bishop quality floor + Stockfish wasm-load fix

Two unrelated task prompts this session, both landed and pushed.

## Task 1 — Bishop: relative leverage with a quality floor

**Ask**: change Bishop eligibility to add a per-position median value
floor (config-settable percentile) on top of the unchanged RB/WR/TE >=
$5,000 band, computed from the whole slate before removing taken players;
change Bishop's sort to discount value by ownership relative to the
highest ownership at his own position (also whole-slate), not the old
flat field-size leverage discount.

**Scope decision (the real work of this task)**: whether this belonged in
`classify()`/`pieces.ts` (like Rook's team-restriction did) or purely in
`picklist.ts`. Traced every `classify()` call site (rules.ts's
`isLegalMove`/`applyCaptureMove`, `optimizer.ts`, `SetupScreen.tsx`,
several test files) and confirmed every real lock in this app is sourced
FROM `pickList()`'s own candidates, then re-validated by `classify()` —
since the new Bishop rule only ADDS a stricter condition on top of the
unchanged band, every picklist-approved candidate still trivially passes
the looser `classify()` check too. So the whole change lives in
`picklist.ts` + `metrics.ts`, with `classify()`/`pieces.ts`/`rules.ts`
untouched — no signature ripple through the chess-move-legality layer.

**Implementation**:
- `sport.ts`: new `bishopValuePercentile` field (default 0.5), raw
  `bishop_value_percentile`.
- `metrics.ts`: `highestOwnershipByPosition(playersPool, contest)` (max
  ownership per position, whole slate, no band restriction — deliberately
  different from the value floor's own "eligible players only" basis, per
  the task's own wording difference); `relativeLeverage(player, contest,
  highestOwnership)`; `sortMetric` gained an optional 4th param.
- `picklist.ts`: private `percentile()` (linear interpolation, same
  formula as `sim/run.ts`'s own, kept separate/undup'd deliberately),
  `bishopValueFloors()`, `meetsBishopValueFloor()`; `pickList()` wires
  both in only when `piece === BISHOP`.
- `PickPanel.tsx`/`BuildScreen.tsx`: `PickPanel` gained a `playersPool`
  prop so its own defensive re-sort + displayed metric number use the
  same `highestOwnershipByPosition` the engine used to build the list —
  otherwise the modal would've silently drifted from what it's showing.

**Test fallout** (expected per CLAUDE.md "update the affected tests, don't
drop them"): a few existing `picklist.test.ts` cases used player values
that happened to straddle the new median for reasons unrelated to what
they were actually testing (lock-exclusion, list-cap) — adjusted the
numbers only. Added dedicated new coverage for the median floor (at-or-
above boundary, per-position separation, "before removing locked players")
and the relative-ownership sort. One parity-fixture scenario
(`pick_list_caps_bishop_at_12`) now asserts Python == TS for a case where
they're deliberately no longer equal — excluded in `parity.test.ts` with a
comment, same convention as the file's one pre-existing documented
divergence (Black's free-play branch).

**Result**: 237 pytest (unchanged), 506 → 516 npm tests. Commit `689845c`,
pushed.

**Gotcha**: the commit message's first attempt mangled `$5,000` to `,000`
— `wsl.exe -- bash -lc "..."`'s outer double-quoted string ate the `$`
before the inner heredoc ever saw it (same failure mode HANDOFF.md already
warned about). Already pushed by the time this was noticed; flagged to
Ron rather than amending a pushed commit.

## Task 2 — Fix Stockfish load; confirm tight-finish warning

**Ask**: find and fix why `.wasm` requests return HTML in the browser
(Black hangs on "Field is moving"); make Black never hang on engine
failure (seeded random fallback + "Engine unavailable — Field moving
without Stockfish." status line); report whether a "tight-finish warning"
exists.

**Root-cause investigation**: read `stockfishEngine.ts` (loads
`/stockfish/stockfish.js`, a classic Emscripten worker script that
locates its own `.wasm` via `self.location.href`) and
`scripts/sync-stockfish.mjs` (copies both files from
`node_modules/stockfish/src/` into gitignored `public/stockfish/`, run by
`npm run sync-stockfish`, chained before `vite`/`vite build`/`vitest` in
package.json's own scripts — but ONLY for those exact npm scripts).
Confirmed the files exist correctly on disk with matching byte sizes when
synced. The actual repro: started a real Vite dev server (`npx vite
--port 5999`, via the Bash tool's `run_in_background`, inside WSL) with
`public/stockfish/` deliberately removed, then `curl`'d
`/stockfish/stockfish.wasm` — got HTTP 200, `Content-Type: text/html`,
body starting `<!doctype html>` (hex `3c 21 64 6f`), an EXACT byte-for-
byte match to the bug report's "found 3c 21 64 6f". Confirmed this is
Vite's own SPA/history fallback (serves its `index.html` for any
unmatched request) rather than a real 404.

**First fix attempt (wrong) and why**: added a Vite plugin with a
`buildStart` hook calling `syncStockfish()`. Verified via the same
cold-start repro that the plugin DID run and DID create the files (`ls`
confirmed them on disk before the first request) — but the `.wasm`
request STILL came back as HTML, repeatedly, even on retry. Isolated by
also testing a pre-existing static file (`favicon.svg`, present since
before server start) on the SAME server: it served fine. Conclusion: Vite
snapshots its `publicDir` file list before any plugin hook fires, so
files a `buildStart` hook creates are invisible to the static server for
that whole server lifetime regardless of being genuinely on disk by
request time.

**Real fix**: moved the `syncStockfish()` call to run directly at
`vite.config.ts`'s module-eval time (top-level, before `defineConfig`),
which happens before Vite touches `publicDir` at all. Re-ran the exact
same cold-start repro (bare `npx vite`, files absent, no npm-script
wrapper) — `.wasm` now serves correctly (`00 61 73 6d`, `application/
wasm`, correct byte length). `sync-stockfish.mjs` refactored to export
`syncStockfish()` while keeping its `node scripts/sync-stockfish.mjs` CLI
behavior (an `import.meta.url === process.argv[1]` guard); added a sibling
`.d.mts` so `vite.config.ts` (strict `nodenext`, no `allowJs`) can import
it typed without widening `tsconfig.node.json`'s compiler options.

**Second real bug found while reasoning through the hang**: regardless of
the wasm-serving root cause, `stockfishEngine.ts`'s `getReadyWorker()` had
no timeout waiting for `"uciok"` — a worker that loads but never reaches
it (its own WASM init failing in a way that doesn't fire the Worker's
`error` event is plausible, though unconfirmed exactly which Emscripten
code path that'd be) would hang that promise, and therefore every future
`analyze()` call too, since the rejected/pending promise is memoized
forever. Added `READY_TIMEOUT_MS` (10s), same pattern as the existing
`RESPONSE_TIMEOUT_MARGIN_MS` for the actual "go" search.

**engineFailed flag**: `chooseEngineMove`'s existing catch-and-fall-back-
to-uniform-random already worked and already never hung (once the above
timeout exists) — that part of "Black must never hang" needed no new
logic. What was missing was telling the UI it happened. Added
`engineFailed: boolean` to `chooseEngineMove`'s return shape and
`MoveResult`, true only for a genuine thrown/timed-out `analyze()` call —
explicitly NOT true for `noEngine`'s legitimate empty-array "no opinion"
or for a real engine whose candidates all failed the DFS-soundness filter
(both already fell back identically; only a real failure should say so).
`BuildScreen.tsx` added `engineUnavailable` state (sticky, never reset —
the worker doesn't retry) and `ENGINE_UNAVAILABLE_NOTE`, wired into both
the "is moving" wait-phase text and that turn's move-note.

**Verification**: full `npm run test` run — one failure
(`BuildScreen.secondMove.test.tsx`, a `findByRole("dialog")` timeout),
re-ran that file alone and it passed clean in ~15s — matches HANDOFF.md's
already-documented full-suite-load timing flake, not a regression (typecheck via `tsc -b` was also clean). Full suite then green: 519/519.
`python -m pytest` unaffected (237, Python untouched).

**Honest gap**: no real browser was available (Playwright/Chromium still
blocked in this WSL distro on missing `libasound.so.2`, per prior
sessions' notes — didn't re-attempt unblocking it this session). The wasm-
serving fix is verified against a real running Vite dev server via curl
(exact byte match to the reported error); the engine-failure fallback is
verified via unit tests with a fake throwing `BlackEngine`. The real
Worker/WebAssembly code path itself — the thing Ron actually hit — was
never exercised end-to-end by this session's own testing.

**Result**: 237 pytest (unchanged), 516 → 519 npm tests (net; +4 new,
one pre-existing flake retried clean). Confirmed by full-codebase grep
(TS, Python, tests, `sessions/`, `design/`) that no "tight-finish warning"
exists anywhere — reported as such, not built. Commit `79bbdd2`, pushed.
