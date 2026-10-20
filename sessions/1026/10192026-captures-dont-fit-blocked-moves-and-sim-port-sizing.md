# Session — Captures that don't fit; explain blocked moves + sim-port sizing
**Date:** 2026-10-19

Two unrelated pieces of work this session: (1) a full rule-change task,
implemented and shipped; (2) a read-only investigation/report, no code
touched.

---

## Part 1 — Rule change: Captures that don't fit; explain blocked moves

**Prompt (from Ron, relayed from claude.ai planning):**
1. Captures (Python + TS engines, plus parity fixture): a capture that
   doesn't fit the capturing side's roster/salary is still legal — the
   captured player returns to the pool instead of transferring, and the
   capturing piece locks no one. Capturing an unmoved piece with no
   fitting replacement: same deal, still legal, locks no one. QBs still
   can't be captured (true already, structurally, via real chess rules —
   confirmed, not touched). Show a notice when a capture returns someone
   to the pool, in the same status-line spot as existing notices.
2. Blocked moves (TS UI only): a move that's legal chess but blocked by
   the DFS rules should still refuse to commit, with the engine's own
   reason shown in the status line.
3. Tests: transfer-fits (existing), return-to-pool (new), unmoved-no-fit
   (new), Black mirrors of both (new), one test per blocked-move reason.

### What was built

**Python (`dfs_chess/`):**
- `rules.py`'s `apply_capture_move` restructured: computes `fits` via
  `lineup_still_completable` for both the historied-transfer and
  unmoved-replacement branches, then branches on it instead of raising.
  Not-fits path: capturing piece's own `piece_locks` entry stays as its
  pre-move history (no append); no new `Move` record; `locked_player_ids`
  loses the captured player's id (historied case) or gains nothing
  (unmoved case). `is_legal_capture`'s own math was untouched — it
  already correctly answered "would this fit," it just used to also gate
  whether the move was allowed at all.
- `build.py`'s `_resolve_players` capture branch never returns `None`
  anymore (always at least `()`, meaning "legal, locks no one," same
  convention PLACED-mode silent King moves already used). `_apply_resolved_
  players`'s capture branch now takes `players[0] if players else None`
  instead of a tuple-unpack that would've raised on an empty tuple.
- `cli.py`: two necessary consequential fixes, not asked for directly but
  required for correctness once the rule changed. `_play_capture_move`'s
  unmoved branch now checks the pick-list candidates BEFORE printing
  "pick a X" — empty list auto-commits the capture (locks no one) instead
  of backing out (which would have wrongly blocked an unmoved capture the
  engine now says is legal). `_capture_message` used to read
  `moves[-1].player` to name who was captured — under the new rule that's
  wrong whenever the transfer didn't happen (reads some unrelated earlier
  move). Fixed to read the captured player directly off `piece_locks`
  history, then check membership in the post-move side to decide which
  message to show.

**TypeScript mirrors** (`web/src/engine/rules.ts`, `build.ts`) — same
restructuring, same reasoning, confirmed via the parity harness.

**Parity fixture**: two new scenarios added to `tools/export_parity.py`
(`capture_returns_to_pool`, `capture_unmoved_no_fitting_player`), both
tagged `kind: "capture_no_lock"` with a shared new checker in
`parity.test.ts` (`checkCaptureNoLock`) asserting move counts and
`locked_player_ids` match between Python and TS. Fixture regenerated (47
→ 49 scenarios).

**TS UI** (`web/src/buildFlow.ts`, `BuildScreen.tsx`):
- New `buildFlow.blockedMoveReason(state, move, sport, contest, players,
  kingMode)` — given a move already known to be chess-legal but not
  DFS-legal, works out why by walking the real check order: for castling,
  `canCastle`'s own three checks (already-castled → EMERGE-mode-King-
  already-locked → Knight+Bishop-not-both-locked), then — if `canCastle`
  is true — King-list-empty vs. Rook-list-empty (PLACED) vs.
  no-eligible-Rook-teammate (EMERGE, via `castleQbCandidates`). For an
  ordinary move, always "no player in the `<Piece>` list fits your
  remaining roster and salary" (the only way an ordinary move can be
  chess-legal-but-blocked). Captures are never blocked post-rule-change,
  so the function never needs to classify one.
- `BuildScreen.tsx`: `dests` now built from EVERY legal chess move
  (`state.board.moves({verbose:true})`), not just the DFS-legal subset —
  otherwise a blocked move could never actually be dropped on at all
  (chessground's own `dests` map is the only thing that makes a square
  draggable, `movable.free` is `false`). `handleBoardMove` matches
  against that full list; if the matched move isn't in the DFS-legal
  subset, calls `blockedMoveReason` and sets the existing `moveRejected`
  status-line state instead of proceeding — reuses the SAME status-line
  slot an earlier bug fix already built for "dests/matched mismatch,"
  just a second real reason to reach it instead of the "shouldn't
  happen" case.
- `captureTransfer` case: after applying, checks whether the transferred
  player actually ended up in `result.state.lockedPlayerIds` — if not,
  shows the return-to-pool notice instead of "You captured X."
- `captureUnmoved` case: now checks the captured piece's own pick list
  BEFORE opening the modal — empty list commits immediately (locks no
  one, no modal), matching the engine's own "legal, locks no one"
  handling instead of opening a modal with nothing to pick.
- `describeBlackMove` (Black's own status-line note) restructured the
  same way for both capture kinds — captureTransfer always has a
  `transferred` player to report on (via `pieceLocks` history), branches
  on whether they actually got locked; captureUnmoved only produces a
  note when locked (empty-list case stays silent, no note, same as a
  silent King move — not asked for beyond that).

### A real efficiency fix found along the way

First pass computed `dests` from `dfsLegalMoves(...)` (which internally
calls `state.board.moves({verbose:true})` and filters) AND separately
called `state.board.moves({verbose:true})` again for the new `allMoves` —
a genuine doubled chess.js move-generation pass every render. Fixed by
computing the raw move list once and deriving both `allMoves` and the
DFS-legal subset (via `moveIsCompletable`, imported directly from
`engine/build`) from it — `dfsLegalMoves` itself untouched, just no
longer called from `BuildScreen.tsx`.

### Test timeout bump (pre-existing flakiness, not a new regression)

`npm run test` (plain `vitest run`, no `--testTimeout` override) flaked
on different tests from run to run, both already in the "castling,
captures, and unaffordable picks" describe block, both with their OWN
explicit outer-`it()` timeouts (15000/20000ms) already set. Root cause:
`playUntilCapture`'s inner per-ply `await waitFor(..., {timeout: 2000})`
has its OWN independent timeout from testing-library, not governed by the
outer `it()`'s — confirmed by checking out the pre-session baseline
(`git stash`) and re-running the SAME test in isolation: 9770ms even
alone, even before any of this session's changes. Bumped that one inner
timeout 2000ms → 5000ms. Confirmed stable across 3× `npm run test` after.

### Verified

- `pytest`: 237 passed (was 233 — net +4 new/renamed tests: 2 Black-side
  mirrors in `test_rules.py`, 2 new in `test_cli.py`).
- `npm test`/`vitest run --testTimeout=20000`: 409 passed (was ~387+22 new
  — `buildFlow.test.ts` gained 7 `blockedMoveReason` tests, `rules.test.ts`
  gained 2 Black-side mirror tests + renamed the 2 existing ones,
  `BuildScreen.test.tsx` gained 1 new "blocked moves" wiring test). Each
  suite run 3× to rule out flakes, per this project's own standing
  precedent for full-suite-parallel-load timing issues.
- `tsc -b` and `oxlint` clean throughout.

### Flagged assumptions (Ron's replies in parens)

- Wording for 4 of the 7 blocked-move reasons wasn't given verbatim by
  the prompt (only 3 examples given, explicitly non-exhaustive) — invented
  consistent-style text for: EMERGE-mode "already locked your King",
  PLACED-mode "no player in the Rook list fits...", EMERGE-mode "no
  player in the King list fits...", EMERGE-mode "no King candidate has
  an eligible Rook teammate." **(Ron: fine as written.)**
- Extended "doesn't fit → locks nobody" to also cover an explicitly-
  supplied non-fitting replacement for an unmoved capture (not just "no
  player given at all") — a symmetry decision beyond the literal "if none
  fits" wording, not separately confirmed.
- No full `BuildScreen` end-to-end test for the return-to-pool notice
  (either side) or the captureUnmoved-auto-resolve path — both are
  mechanically simple and already covered thoroughly at the engine level
  (Python + TS); constructing the exact scenario through the real,
  randomized Black-move engine in a full component-render test was
  judged too fragile to be worth it. **(Ron: no end-to-end test needed.)**

### Shipped

Commit `eac7732`, "Rule change — Captures that don't fit; explain blocked
moves", pushed to `origin/main`. 16 files changed (912 insertions, 178
deletions). `data/samples/repro-slate.csv` (pre-existing, deliberately
uncommitted) correctly left out of the commit.

---

## Part 2 — Sim-port sizing report (read-only, no code changes)

**Ask:** size the Monte Carlo sim port from `rraney/nfl-dfs` (a separate
project, Google Apps Script) into `web/src/engine` as pure TS. Explicitly
read-only — no edits to either repo.

**Method:** read `sims.md` (the original scoping doc, Parts 1–7 plus two
later spec addenda baked into the same file) and `tasks.md` (session
handoff log) for intent/history, then read the actual current code —
`sim_foundations.js`, `sim_draws.js`, `sim_field.js`, `sim_trial_loop.js`,
`sim_batch.js`, `sim_correlation.js`, `sim_regime_sweep.js`,
`sim_leverage_report.js`, `sim_slate_registry.js`, `yalps_lib.js` — to see
what's actually implemented today vs. what the design doc originally
proposed (they diverge in real ways; the code is the source of truth,
the design doc is historical intent). Cross-checked against chess-dfs's
own `web/src/engine/config.ts`/ETR loader to assess real data
compatibility, not just in the abstract.

**Full report delivered to Ron in-chat** (not written to a file in either
repo). Summary of findings, for the record:

1. **What the sim does.** Player-outcome Monte Carlo (not play-by-play).
   Each player's score: piecewise-linear percentile curve through ETR
   `DK Floor`=P15/`DK Proj`=P50/`DK Ceiling`=P85 (verified via code
   comment against the FantasyLabs glossary definition — NOT the P10/P90
   the original design doc assumed; `sim_foundations.js`'s earlier
   log-normal-fitting approach is superseded/dead, confirmed by
   `sim_draws.js`'s own header explicitly correcting it), plus a
   right-tail extension beyond P85. Correlation: a shared latent-factor
   model (`zGame`/`zTeam`/`zPlayer` composite, position-specific weights,
   DST uses a NEGATIVE game-loading which alone reproduces the validated
   DST↔RB asymmetry without special-casing), plus two independent
   per-game "regime" shocks (`isShootout` — prob scales with Vegas total;
   `isScript` — prob scales with spread, picks a winner/loser) and a
   DST "splash" override (7%/trial, bypasses the model for pick-six/
   return-TD variance). A separate, PARKED 4-shock Gaussian-copula design
   (`sim_correlation.js`) was tried on a branch and explicitly abandoned
   (`sim_regime_sweep.js`'s own header: the copula detour confirmed
   discrete regimes were never the problem) — not to be ported. Trial
   count: 5,000, locked decision.
2. **Field simulation.** Yes, real feature, two implementations toggled
   by a Config cell: ownership-weighted sampling+rejection (older), and
   MILP (`generateSimulatedFieldMilp_`, newer/preferred, built to fix a
   real QB/DST exposure bug per `tasks.md`'s own investigation) — one
   YALPS solve per sampled lineup, ownership-biased objective, exposure
   caps, soft minimum-exposure floor. Inputs: small/large-field
   ownership, salary cap, entrants (scaled to a sample via
   `lineupWeight`).
3. **Language/size/deps/portability.** GAS, tightly coupled to
   `SpreadsheetApp` for I/O only — the actual math (draws, correlation,
   field gen, scoring) is pure functions over plain objects already (
   `drawSlateOutcomes_`'s own docstring: "No sheet reads inside the trial
   loop"). 15,430 lines across the sim files, but most of that is
   calibration/diagnostic tooling (`diagnose*`/`solve*` functions), not
   runtime code — real runtime math is roughly 2,500–3,000 lines total.
   One dependency: `yalps_lib.js`, a vendored copy of the SAME `yalps`
   library chess-dfs's own `engine/optimizer.ts` already uses. No
   Node/GAS-only APIs in the math itself — browser-safe once extracted
   from the sheet-reading wrapper functions.
4. **Runtime.** No logged production benchmark found in this repo.
   Design target (`sims.md`): "well under 1 second" per single-trial
   draw for a full slate — stated as a target/acceptance criterion, not
   a confirmed measurement (flagged as unconfirmed). GAS's 6-minute
   execution cap is why `sim_batch.js`'s trigger-chaining architecture
   exists at all — irrelevant for a browser port (no such cap); 5,000
   trials would likely want a Web Worker (chess-dfs already has one for
   Stockfish) to keep the UI thread free.
5. **"Top_Ten."** Not sim output at all. `Top1`/`Top10`/`Cashed`/
   `Bottom50` are real-contest finish-tier labels computed by a fully
   separate pipeline (`contest_postmortem.js`/`lineup_features.js`/
   `lineup_runner.js`, 1,619 lines) that archives and analyzes ACTUAL DK
   contest result exports — zero code overlap with `sim_*.js`, confirmed
   via grep in both directions. This resolves a previously-carried-
   forward chess-dfs HANDOFF open item ("Top_Ten sim-vs-postmortem
   distinction") — they're not the same thing and never were; postmortem
   analyzes history, the sim predicts it.
6. **Porting estimate — 6 one-prompt tasks:**
   1. Outcome-draw module (`drawOutcome_` port, pure TS, unit-tested).
   2. Correlation engine (`drawSlateOutcomes_` port — latent factors +
      regime shocks + DST splash — grouping chess-dfs's players into
      games via Team/Opp, Vegas inputs defaulted since chess-dfs has
      none).
   3. Field generation (MILP path only — skip the older sampling path,
      redundant once MILP works and chess-dfs already has `yalps` wired).
   4. Trial loop + scoring + aggregation, wired to chess-dfs's existing
      `ContestConfig.payouts` (which already gives the payout-curve
      lookup the sim needs — confirmed `config/contests.json`'s own doc
      comment says it was generated from a real `Sim_Contest.csv` export
      from this same `nfl-dfs` system; the two are already linked).
   5. UI wiring (trial-count input, Web Worker, results display) — not
      pure-engine work, separate from 1–4.
   6. Optional: calibration parity test, porting `calibrateCorrelation()`'s
      6 conditional-rate checks — flagged that `nfl-dfs`'s own live
      config only passes 3/6 today (frozen/accepted there), so the port
      should probably reproduce that exact behavior rather than "fix"
      calibration mid-port; left as a decision for Ron, not made
      unilaterally.
   Data gaps flagged, none blocking a first working port: Vegas total/
   spread, dome flag, weather — all gracefully defaultable (the sim's own
   code already degrades gracefully when these are absent). NOT missing:
   Floor/Proj/Ceiling, ownership (Small/Large Field), Team/Opp.

**Not done:** no code written, no file created in either repo for this
part of the session — the report lives only in this log and in the
chat transcript. If Ron wants to proceed, next session should start with
Task 1 above as its own one-prompt task.
