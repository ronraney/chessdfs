# Handoff — 2026-10-29

## Where things stand

DFS Chess is an NFL DraftKings lineup builder that layers chess opening
strategy onto lineup construction. The user plays White; "the field"
(Black) plays too, by simulation. The goal is a *core* (typically 4–5
players), not necessarily a full lineup. `CLAUDE.md` (never edited by
Claude; Ron edits it himself) says the task **prompt** is the spec —
implement it exactly as written; existing code/tests are the record of
all earlier rules. Git workflow: work on `main`, one commit per task
after tests pass, push to `origin/main` after every commit, never use
`AskUserQuestion` (ask inline as plain text).

Python 3.11+ engine (`dfs_chess/`, **frozen** — TS-only from here on) +
`web/` (Vite + React + TypeScript, Node v24/npm).

**Since the last handoff (2026-10-28), three tasks landed directly on
`main` without a /wrap-up in between** (commits `33c00af`, `4738f03`,
`cab7142` — all authored as Ron, not a Claude session): board piece-info
on hover (BuildBoard tooltip), tight-finish alerts reworked into three
straight salary-tightness steps (Caution ≤$5,000/open-slot, Warning
≤$4,000 at 2+ open slots, Critical/"barely completable" — remaining
minus the cheapest possible completion of every open slot, under $500,
no open-slot minimum — `engine/optimizer.ts`'s new
`cheapestCompletionCost`, a weighted bipartite min-cost assignment), plus
"Go back" on the tight-finish dialog; and a housekeeping pass that split
`BuildScreen.test.tsx` into 5 files by describe block and capped Vitest's
`maxWorkers` (this box is RAM-constrained, ~2.8GB — more workers measured
WORSE, not fewer, full-suite flakes).

**This session (4 tasks, all committed + pushed) made roster/salary
completability the real gate everywhere, not just an after-the-fact
warning:**

1. `rules.ts`'s `lineupStillCompletable` gained an optional
   `availablePlayers` 4th arg: when given, its salary check asks "is
   there enough left for the CHEAPEST way to fill every other still-open
   slot from who's actually still on the board" (`cheapestCompletionCost`,
   the same floor the tight-finish dialog's Critical level already used)
   instead of a flat "total spent <= cap." Omitted, it's the old raw
   check — deliberately backward-compatible, not a breaking signature
   change. `picklist.ts`'s `pickList`/`castleRookList` pass it (pick
   lists now correctly hide/show candidates by real completability, not
   just raw cap headroom); `rules.ts`'s `isLegalMove`, `castle`,
   `switchKing`, `placeKings`, `isLegalCapture`, `applyCaptureMove` all
   gained the same optional parameter and now get it from
   `BuildScreen.tsx` at every point a user action actually locks
   something (castling's King+Rook/Rook-only lock, the Place-your-King QB
   switch, King placement at setup, the capture hover preview). A
   transferred/replacement capture that doesn't fit still follows the
   existing rule unchanged (locks no one, returns to the pool) — only the
   completability check itself got sharper, not that behavior.
2. New UI notices in `PickPanel.tsx`: a roster-full notice ("You cannot
   select any more WR.", `rules.blockedPositions` — every slot a position
   could fill, including FLEX, already taken) and a salary-cap notice
   ("Players over $X hidden (salary cap)." — $X = salary remaining minus
   the cheapest cost to fill the OTHER open slots, `buildStats.ts`'s
   `salaryCapNotice`), independent checks, either or both can show. Each
   player row also now shows a small-text opponent next to the team
   ("DAL vs PHI" / "DAL @ PHI" using `Player.isHome`).
3. Finished-lineup UI cleanup: "Fill out my core" hides (not just
   disables) once a side has no open slots; the "$X avg/open slot · N
   open" line becomes "Lineup full." in that case too (`BuildScreen.tsx`'s
   `SideColumn`/`FinishScreen` — shared by both You and Field columns).
4. A clear "Simming…" overlay (spinner + dimmed backdrop,
   `.finish-simming-overlay` in `BuildScreen.css`) now covers the finish
   screen's results area while either side's auto-run sim is in flight.

**Performance note worth knowing about**: making the completability
check a real LP solve (not plain arithmetic) initially made a full
`npm run test` run go from ~80s to ~22 MINUTES, because `build.ts`'s own
move-search loop (`checkWhiteDeadEnd`/Black's move selection) calls
`pickList` once per *legal chess move* at a position (often 20-40), and
`BuildScreen.tsx`'s own `legalMoves`/`legalSans` were recomputed,
unmemoized, on every render on top of that. Fixed in two ways: (a)
`cheapestCompletionCost` now caches by its own inputs (a WeakMap keyed on
the `availablePlayers` array reference, so `pickList`/`castleRookList`
reusing ONE shared `available` array per list lets most candidates hit
the cache instead of a fresh solve each); (b) `legalMoves`/`legalSans`
are now a single `useMemo` in `BuildScreen.tsx`; (c) `build.ts`'s
`bestLegalPlayer`/`bestLegalCapturePlayer` no longer ALSO re-run the
completability check via `isLegalMove`/`isLegalCapture` on top of what
`pickList` already verified for the same candidates — that was pure
redundant work discovered mid-session (it's what caused the 22-minute
regression, more than the LP solve itself). End state: `npm run test`
with Vitest's own `maxWorkers` cap is ~150-230s (was ~80s before any of
this session's work) with the SAME pre-existing, environment-driven
flakiness pattern as before (not new); `--maxWorkers=1` (sequential) is
always clean, confirming correctness. The remaining slowdown (vs. the
~80s baseline) is real and understood, not hidden — see Open items.

**Rule change precedent this session re-confirmed**: when a TS-only
change makes a `parity.test.ts` fixture scenario (frozen Python output)
no longer comparable, exclude that one scenario by name from the
fixture-replay list and give the new behavior its own coverage in the
relevant `*.test.ts` file instead — same pattern already used for
Bishop's quality floor and Rook's stack-tier rework. Wasn't actually
needed this session (the optional-parameter design kept every existing
3-arg `lineupStillCompletable` caller, including every parity-check call
site, on the OLD unchanged behavior) but worth remembering for the next
completability-adjacent change.

## What happened this session

All 4 tasks below committed (`7e69fe8`, `23ea222`, `b560a13`, `797e19f`)
and pushed to `origin/main`; `npm run test` + `pytest` run (and, this
session, specifically re-run with `--maxWorkers=1` for a clean count)
before every commit.

1. **Roster-full notice + opponent in pick lists** (`7e69fe8`) —
   `rules.blockedPositions` (new), `buildStats.blockedPositionsNotice`
   (new), opponent display in `PickPanel.tsx` row (`player.isHome ?
   "vs" : "@"`). Flagged assumption: `isHome` has no tri-state (defaults
   `false` when a loader doesn't set it) — only `loadEtrCsv` ever sets it
   for real data, so the "no data → default to vs" case in the prompt
   never actually triggers against a real slate, only synthetic test
   fixtures.
2. **Salary-cap notice + finished-lineup cleanup** (`23ea222`) —
   `buildStats.salaryCapNotice` (new), "Fill out my core"
   hide-not-disable, "Lineup full." text swap.
3. **Pick lists must keep the lineup completable** (`b560a13`) — the
   core `lineupStillCompletable`/`cheapestCompletionCost`-caching work
   described above, scoped to `pickList`/`castleRookList` only.
   Mid-session finding: `cheapestCompletionCost` returning `null` (no
   eligible player anywhere for some slot — only possible against a
   hand-built test pool, never a real validated slate) had to mean "can't
   prove it's unaffordable," not "assume infeasible," or ~24 of
   `picklist.test.ts`'s 30 existing tests would have broken (same
   "null = unresolved, not failure" spirit `tightFinishStatus` already
   uses for its own null `cheapestCompletionCost` case).
4. **Completability for captures/castling/King placement + Simming
   indicator** (`797e19f`) — extended the same optional-parameter check
   to `isLegalMove`/`castle`/`switchKing`/`placeKings`/`isLegalCapture`/
   `applyCaptureMove`, four new `rules.test.ts` tests (one per path: QB
   step, QB switch, King placement, capture), the Simming overlay, and —
   the bulk of this task's real time — tracking down and fixing the
   22-minute full-suite regression described above. Tried and abandoned
   a dedicated automated test for the Simming overlay (mocking
   `./simRunner` to freeze the sim mid-flight) after it hit an unrelated,
   hard-to-pin-down hang in that one test file's own harness; verified by
   code review + the user's own live dev-server session instead, since
   the task didn't actually require automated coverage for that part.
   Also answered a "check only" question earlier in the session (no code
   changes) confirming a pick genuinely could leave a side stuck even
   though it looked affordable alone — which became the basis for task 3.

## Open items / blockers

- **Full `npm run test` is slower than before this session's work**
  (~150-230s vs. ~80s previously) even after the fixes above — understood
  (real LP-solve work, even cached, costs more than plain arithmetic) and
  currently accepted, but not reduced further. A deeper fix would mean
  restructuring `build.ts`'s own "try every legal move" search loop (e.g.
  caching `pickList` results across the whole sweep, keyed by piece, not
  just within one call) — flagged as a candidate follow-up, not started.
- **The Simming overlay has no automated test** — see above. If this
  matters later, the hang in the abandoned test file is worth a fresh,
  more patient debugging pass (or: ask whether it's worth the time at
  all before trying again).
- User hasn't yet confirmed the Simming overlay's actual VISUAL
  appearance (spinner + dimmed backdrop, not just the "Simming…" text)
  from their own live session — asked, not yet answered as of this
  handoff.
- `field.ts` still doesn't know about the real-correlation model — same
  long-standing item, unchanged again this session.
- Untracked-file pile: `data/samples/` has 4 files (a DraftKings
  projections export, two contest-standings files, `repro-slate.csv`)
  that predate this session and were left alone throughout (not this
  session's concern, but still sitting there).

## Next steps

1. Decide whether `build.ts`'s own move-search loop is worth
   restructuring for performance, or whether the current (correct, just
   somewhat slower) state is fine to live with.
2. Get the user's visual confirmation on the Simming overlay; revisit
   the abandoned overlay test if it still seems worth having.
3. `field.ts`'s real-correlation-model rework — still the standing
   bigger item whenever it's next picked up.
4. Housekeeping: the `data/samples/` untracked pile could use a decision
   (commit, `.gitignore`, or explicitly leave as-is) whenever someone's
   looking at that area anyway.
