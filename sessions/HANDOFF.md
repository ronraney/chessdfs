# DFS Chess — Handoff
Last updated: 2026-10-26

## Project Context

DFS Chess is an NFL DraftKings lineup builder that layers chess opening
strategy onto lineup construction. The user plays White; "the field"
(Black) plays too, by simulation. The goal is a *core* (typically 4–5
players), not necessarily a full lineup. Every turn is a real chess move
on a real chess board: the moved piece's type (King/Queen/Rook/Bishop/
Knight/Pawn — a salary-tier classification driven by a sport config)
filters eligible real players by position + salary band, and that side
locks one. It is a **build, not a game** — "build" in code and docs, never
"game," except when referring to chess itself.

`CLAUDE.md` (never edited by Claude directly; Ron edits it himself) says the
task **prompt** is the spec — implement it exactly as written, even where it
changes earlier behavior; the existing code and tests are the record of all
earlier rules. Git section: work on `main`, no branches unless asked, check
`git status` for unexpected uncommitted changes before starting (CLAUDE.md
and `sessions/` files are routine, not "unexpected" — commit them with
whatever else the task touched), one commit per task after all tests pass,
push to `origin/main` after every commit. Rules section also says: never use
the `AskUserQuestion` tool — ask any question inline, as plain text, instead.
Python 3.11+, stdlib + pytest + `python-chess` for the original engine;
`web/` is a Vite + React + TypeScript app (Node v24, npm) built alongside
it. The TS port of the engine is complete, with a standing parity harness
proving it matches Python on real, deterministic scenarios. The UI's player
flow is upload-free: **contest + King mode + opening (one merged setup
screen) → build → finish**. A hidden admin screen (`#/admin`) handles CSV
uploads (projections, Vegas), a **"Build fields"** section, and — as of this
session — the player-facing build screen now DOES read that cache (see Sim 4
below). Secrets (`LICHESS_API_TOKEN`, `VITE_ADMIN_PASSWORD`) live in
gitignored `.env` files, never printed. Club (light) and Slate (dark) themes
exist app-wide, CSS-variable driven, with a header toggle.

Piece classification is a **pool**, not a single tier: `classify(player,
sport, qbTeam=None)` returns every piece band a player qualifies for
(`frozenset[Piece]` in Python, `ReadonlySet<Piece>` in TS), not a
first-match winner. A move's **pick list** is `engine/picklist.ts`'s
`pickList`/`dfs_chess/picklist.py`'s `pick_list` — the pool's eligible,
unlocked, roster/salary-feasible players, sorted by that piece's own GPP
metric (`engine/metrics.ts`/`dfs_chess/metrics.py`'s `sortMetric`: King/Rook
by projection, Queen by ceiling, Bishop by leverage, Knight by floor value,
Pawn by value), and capped per-piece (`sport.json`'s `list_caps`: 12 for
Queen/Rook/Bishop/Knight, none for King/Pawn). **The cap is applied after**
removing taken/infeasible players, not before.

**Rook is team-based ("Rook = correlation")**: eligible as RB/WR/TE on
the moving side's own locked QB's team, any salary — or, if that side's QB
isn't locked yet, any RB/WR/TE regardless of team. Castling's QB step only
offers QBs with ≥1 eligible teammate; PLACED king mode's one-time "Switch
your QB?" offer resolves **before** the Rook pick, not after. Once a
player is actually locked, their displayed/captured piece is whichever one
the locking move recorded (`Move.piece`), never re-derived from
`classify()`. See `config/sports/nfl.json` for the current NFL bands.

**Captures are always legal**, in both engines and the TS UI: a historied
transfer that would overflow the capturing side's roster/salary no longer
blocks the capture — the captured player instead leaves the opposing side
and returns to the pool (available to either side), and the capturing
piece locks no one. An unmoved-piece capture with no fitting replacement
works the same way: still legal, locks no one. The TS UI shows a notice in
the status-line spot when a capture returns someone to the pool. **TS UI
also explains blocked moves**: `dests` includes every legal chess move, not
just the DFS-legal ones — dropping on a move that's legal chess but
blocked by the DFS rules still refuses to commit, with the engine's own
reason shown in the status line.

**DK roster slots are a separate concept from pieces, computed on demand**:
`assignRosterSlots`/`assign_roster_slots` takes a locked roster and returns
which named DK slot (QB/RB/WR/TE/FLEX/DST) each player occupies, via Kuhn's-
algorithm bipartite matching. `engine/optimizer.ts`'s exact lineup solver is
a second, separate consumer of `sport.rosterSlots` — a 0/1 MILP solved by
**yalps**. "Pts from optimal" (best-completion-vs-slate-optimal delta) is
shown for both sides. `optimizer.ts` also has a private `pruneDominated`
pre-pass, tried and REJECTED as a `field.ts` speedup two sessions ago (see
Open Items) — stays private/unexported.

**"Fill out my core" (new this session, White only)**: a button, in the
mid-build controls row and on every finish-screen variant, that fills
White's open slots with `bestCompletion` — the exact same `OptimizerResult`
"Pts from optimal" already computes, read via `.lineup` instead of `.total`.
The newly-added players live in new `whiteFilledPlayers` React state, NOT in
the engine's own `BuildState` — the engine has no concept of a player locked
any way other than a chess move, so this stays a pure UI-layer addition.
Filled players render with "(optimizer)" (a new `RosterEntry` shape — label
+ glyph + player — that `SideColumn`/`FinishCard`/`lineupText` all walk
instead of `Move[]` directly, so piece-locked and optimizer-filled rows
render identically everywhere). Clicking it sets a new `Ending` kind,
`"filled"`, and ends the build. `whiteStats` now reads `state.whiteMoves +
whiteFilledPlayers` together (`whiteRoster`) so Copy lineup's totals and the
sim both pick up a fill for free — the sim needed literally no new code,
since `runSimForBothSides` already used `bestCompletion.lineup` for White
whenever the move-locked core was incomplete (Sim 4, same session).

**Monte Carlo sim port, `web/src/engine/sim/`** (pure TS, no I/O, no
unseeded randomness, seeded via `SeededRandom`/`rng.next()`): ported from
`rraney/nfl-dfs` across five sessions now. **The full engine-side port is
done as of this session** (draws → field → trial loop/payouts); what's left
is real-browser verification of the new UI layer (see Open Items).
- `draws.ts` — `drawOutcome` (piecewise-linear percentile curve) +
  `drawSlateOutcomes` (latent-factor correlation: zGame/zTeam/individual,
  DST negative game loading, shootout/script regime shocks, dome wGame
  boost keyed off `Player.isHome`/`sport.domeTeams`). `SlateVegas` keyed by
  team abbreviation.
- `vegasCsv.ts` — `validateVegasCsv`. **Rewritten twice this session**:
  - Full team names ("Detroit Lions") in the Team OR Opponent column are
    normalized to abbreviations before anything else runs
    (`FULL_TEAM_NAME_TO_ABBREVIATION`, all 32 teams). Built fresh (nfl-dfs's
    own table lives in a Google Sheet this repo can't reach) and
    cross-checked against every real team code actually on disk — JAX
    (Jacksonville) is the one code that never appears in any real file
    here, so it's unconfirmed against an ETR file either way (chose JAX
    over "JAC").
  - **LA/LAR (the Rams) resolved dynamically, not hardcoded**:
    `TEAM_ALIAS_GROUPS = [["LA", "LAR"]]` — confirmed real conflicting data
    on disk (`config/sports/nfl.json`'s `dome_teams` uses "LAR",
    `data/samples/repro-slate.csv` uses "LA"); whichever alias the CURRENT
    slate actually uses wins.
  - **Behavior reversal, this session's own explicit ask**: a Vegas row
    for a team NOT on the slate is now skipped + noted (`skippedTeams`,
    replacing the old `missingTeams` field) instead of rejecting the whole
    upload — a full-week sheet routinely covers teams a given slate isn't
    using. The FLIP SIDE is now the hard error instead: a SLATE team with
    NO Vegas row used to be a non-fatal note ("neutral defaults"); it now
    rejects the upload outright. These two checks are deliberately
    asymmetric now. Consequence, flagged: there's no "is this a real team"
    check independent of slate membership, so a typo'd/garbage Team value
    is silently skipped the same as any other off-slate row.
- `field.ts` — `generateSimulatedField`: one MILP solve per lineup, porting
  nfl-dfs's `generateSimulatedFieldMilp_` at its frozen defaults (ownership-
  bias objective, exposure caps, Minimum Exposure Floor catch-up boost,
  salary floor `FIELD_MIN_SALARY_` = $48,500, stack targeting at
  `FIELD_TARGET_NAKED_QB_RATE_` = 0.175 naked-QB rate). Not ported: Field
  Pace Slack, Dynamic Floor Relaxation (measured accept rate 94.1% on the
  real slate — high enough neither was needed). `lineupWeight` divides by
  lineups actually built. `DEFAULT_SAMPLE_SIZE = 1000`. Performance is
  highly load-sensitive (measured ~14ms/attempt isolated vs. ~230ms/attempt
  under concurrent load, same machine) — never trust one measurement here.
- `payouts.ts` (new this session, rewritten twice) — `generatePayoutCurve`.
  Final design: pins ALL THREE of a contest's real numbers at once. Rank 1
  pays exactly `pct_to_first × prize_pool`. Every paid place pays at least
  `min_cash` — a flat floor tier at the bottom (real DK/FD curves have
  exactly this shape: decaying power law on top, flat min-cash block
  underneath). The table still sums to exactly `prize_pool` (only the
  exponent is solved for; rank 1's dollar value is fixed). `cash_line` is
  still the last paid place. Payouts never increase down the ladder by
  construction (max of a decreasing curve and a flat floor). Infeasible
  inputs (floor ≥ rank 1; prize pool too small for the floor; prize pool
  too large for rank 1 to be biggest) throw naming which constraint broke.
  Measured against all 19 real `contests.json` presets: every one is
  feasible, rank-1 ratio and min-cash ratio both exactly 1.000000. Earlier
  this session, two OTHER curve-shaping methods were tried and superseded
  (a two-anchor method that left rank-1 only approximate; a rank-1-exact
  method that left the bottom drifting with no floor at all) — neither is
  in the code anymore, only the final 3-pin version.
- `run.ts` (new this session) — `runSimulation(lineup, contest, entryFee,
  field, players, vegas, sport, seed, trialCount?, maxFieldSample?)`: the
  trial loop. Draws one correlated outcome per player per trial
  (`drawSlateOutcomes`), scores the user's lineup + every field lineup,
  ranks via nfl-dfs's weighted-place method (ties split evenly across the
  tied place range), pays from the payout table, aggregates to `{ roi,
  cashRate, winRate, top1PctRate, finishPercentiles }`. `winRate` = fraction
  of trials finishing 1st exactly; `top1PctRate` = fraction finishing in the
  contest's own top 1% of ENTRIES (`place <= ceil(entries * 0.01)`) — a
  frequency, deliberately NOT the same thing as nfl-dfs's similarly-named
  but dollar-flavored "Top1pct_ROI". `DEFAULT_TRIAL_COUNT = 5000` (nfl-dfs's
  real live `Config!B3` default, not the 1000 a different quick-manual UI
  path there falls back to). Above `MAX_FIELD_SAMPLE` (5,000, a config
  setting, also an optional param) lineups, each trial scores a seeded
  uniform sample instead of the whole field, with `lineupWeight` recomputed
  against the sample size — measured Large-tier (50,000 lineups) timing at
  5,000 trials: ~70s uncapped → **~10s after the cap**, same ballpark as
  Mid (~8s) and Small (~2.4s).
- **Sim 4 — results wired into the UI, `simWorker.ts` + `simRunner.ts` +
  `BuildScreen.tsx`**: shows Sim ROI / Cash % / Top 1% for both sides in the
  You/Field side panels and the finish screen. Auto-runs on every finish-
  screen ending; a "Sim my core" button runs it on demand mid-build, both
  sides at once. Partial cores sim `bestCompletion.lineup` (same mechanism
  "Fill out my core" now also uses), labeled "(best finish)". Field:
  `resolveCachedField(slateSignature(csv), contest, players)` — null/empty
  shows "Build fields in Admin first.", no Worker attempted. Vegas is
  optional (confirmed `drawSlateOutcomes` degrades to neutral defaults for
  any uncovered team); missing or invalid-for-this-slate Vegas both fall
  back to an empty map rather than blocking the sim. Seed: a `buildSeed`
  split out of the existing `rng` state (captured once at mount, NEVER read
  from the live, continuously-advancing `rng` itself — that's reserved for
  Black's own play) feeds every sim run this build ever makes, so the same
  build gives the same numbers, and both sides are judged against identical
  simulated draws (apples-to-apples, not incidental). Cancellation: a
  monotonic run-id + `.terminate()` on the previous worker — no existing
  precedent in this codebase to follow, invented fresh. `new Worker(...)`
  itself is wrapped in try/catch (jsdom has no `Worker` at all — confirmed
  by every existing ending-reaching test passing unchanged). **Not verified
  in a real browser — see Open Items**, a genuine gap, not assumed fine.
- Not ported (unchanged): calibration tooling, `sim_correlation.js`/
  `sim_foundations.js` as whole files, Showdown CPT/FLEX grouping.

**Environment note**: accessed from Windows via the
`\\wsl.localhost\Ubuntu\...` UNC path. Every git/npm command needs
`wsl.exe -- bash -lc "cd ~/chess-dfs/... && ..."` — plain `npm run ...`
through the Windows-side Bash tool fails outright. Commit messages with
special characters need care: a single-quoted heredoc delimiter (`<<'EOF'`)
inside `wsl.exe -- bash -lc "..."` does NOT reliably protect `$` or
backticks — the OUTER double-quoted command string is the culprit, not the
heredoc. Caught historically by checking `git log -1 --format='%B'` right
after committing; this session avoided the problem by running `git commit`
via the Bash tool directly against the already-WSL-mounted UNC path instead
of through an extra `wsl.exe -- bash -lc` wrapper layer, with no corruption
seen.

**jsdom (this project's entire test environment) runs no CSS layout
engine**: `getBoundingClientRect`/`offsetWidth`/`scrollWidth` are always 0,
`getComputedStyle` never evaluates `@media` queries, **no `ResizeObserver`**
(stubbed no-op), **no `Worker` implementation at all** (now load-bearing for
BOTH `fieldWorker.ts` and the new `simWorker.ts`). A real browser is still
not launchable here — see Open Items for exactly how far this session got
trying (closer than "not launchable" suggests, but still blocked).

**A growing list of real-chessground/real-engine `userEvent` tests sit
close to Vitest's 5000ms default timeout under full-suite parallel load.**
Each occurrence so far has been genuine, not a removable inefficiency.
`BuildScreen.secondMove.test.tsx`'s castling test flaked once more this
session under heavy load, passed clean on retry and in isolation — same
treatment as before: not touched, since a retry resolves it and the task
never asked for it.

## Where We Are

- **237 pytest passing, 506 npm tests passing** (was 463 at session start;
  +43 across 7 commits this session).
- **Seven commits this session, all pushed to `origin/main`**:
  1. `173000e` "Sim 3: trial loop, scoring, payouts (TS only)" —
     `engine/sim/run.ts`, `engine/sim/payouts.ts` (both new), `config.ts`
     wiring.
  2. `53e38e2` "Sim 3 fixes: top1PctRate, exact-rank-1 payout curve, timing"
     — renamed `top1Rate`→`top1PctRate` (redefined to top-1%-of-entries,
     not place-1-only) + added `winRate`; payout curve rewrite #1
     (Pct_To_First-only, exact rank-1, dropped `minCash` as an input).
  3. `0366e38` "Sim 3 fixes round 2: 3-pin payout floor curve, field
     sampling cap" — payout curve rewrite #2 (the final 3-pin version,
     restored `minCash`); `MAX_FIELD_SAMPLE` field-sampling cap in `run.ts`.
  4. `2673699` "Sim 4: sim results in the UI (TS only)" — `simWorker.ts`,
     `simRunner.ts` (both new), `BuildScreen.tsx`/`.css` wiring.
  5. `9786b82` "Vegas upload: accept full team names" — `vegasCsv.ts` full-
     name mapping table (later superseded's LA/LAR hardcode, see commit 7).
  6. `ad11333` "Vegas upload: LA/LAR alias + skip off-slate teams" —
     `TEAM_ALIAS_GROUPS`; off-slate-skip/slate-missing-errors behavior
     reversal; `AdminScreen.tsx`/`.test.tsx` fixture rework (sample slate
     needs full 22-team Vegas coverage now, not a 2-team partial upload).
  7. `a293274` "Fill out my core button" — `BuildScreen.tsx`/`.css` only.
- Python engine untouched all session (every task was explicitly TS-only).

## Where We're Headed

1. **Real-browser verification — attempted this session, blocked on a
   concrete, fixable thing.** No project run-skill exists for launching
   this app; `chromium-cli` isn't installed. Playwright DOES resolve (via a
   scratch `npm install playwright` — the package itself installs fine,
   and a matching Chromium binary is already cached at
   `~/.cache/ms-playwright/chromium-1248`), but launching it fails: both
   the regular and headless-shell Chromium binaries need `libasound.so.2`,
   not installed in this WSL distro, and installing it needs `sudo` (no
   passwordless sudo here). **`sudo apt-get install -y libasound2` (or
   `libasound2t64`, depending on the distro's package naming) would
   unblock this** — once it's run, retry driving the dev server with
   Playwright directly (`chromium.launch({ args: ['--no-sandbox'] })`,
   `page.goto(...)`) and actually exercise `simWorker.ts`/`fieldWorker.ts`'s
   real async path for the first time ever in this project. Worth a
   `/run-skill-generator` pass once it works, so this doesn't need
   re-discovering next time.
2. **Sim 4's real-Worker path is the single biggest unverified piece of
   this session's work** — every test proves the surrounding wiring
   (field/Vegas resolution, worker dispatch, cancellation, UI states)
   without ever letting the Worker actually compute (jsdom has no
   `Worker`). Once a real browser is available (#1), drive it: upload
   projections + build at least the Small field tier in Admin, start a
   build, lock a pick or two, click "Sim my core," confirm real ROI/Cash/
   Top 1% numbers render (not an error, not "Build fields in Admin
   first."), then confirm the finish screen auto-shows the same.
3. A calibration parity test for the sim port (outcome draws/correlation
   vs. nfl-dfs's own validated rates) — still not started, carried forward
   from the original 6-task Monte Carlo breakdown.
4. Simulated "Top 10%" metric — still a known gap (top1PctRate/winRate
   exist; a percentile-of-trials "Top 10%" rate does not).
5. Ron needs to create **`web/.env`** with his own
   `VITE_ADMIN_PASSWORD=...` — still not created, deliberately (an `.env`
   DOES exist as of this session, confirmed present, just flagging that its
   value was never read/printed per CLAUDE.md's secrets rule).
6. `CONTINUATION_LIMIT = 8`, `buildFieldCache.ts`'s `BUILD_SEED` and its
   per-tier representative `fieldSize` values (1000/5000/50000) — still
   guessed, not spec'd, unchanged.
7. PLACED king mode's "silent King move while dragging" path still has no
   dedicated test.
8. If the engine changes, re-run `tools/export_parity.py` and `npm run
   test` to keep the parity fixture honest.
9. **`tools/sim_builds.py`** still calls `classify(p, sport)` with the old
   2-arg signature and assumes Rook is RB-only — unchanged, out of scope,
   flagged again.
10. **JAX vs. JAC (Jacksonville's abbreviation) is still genuinely
    unconfirmed** — no real file in this repo has ever contained that
    team. If a real Vegas/projections file surfaces with Jacksonville on
    it, check which code it actually uses against `vegasCsv.ts`'s own
    choice (JAX).

## Open Items

- **`DEFAULT_EXCLUDED_FAMILIES` (openings.ts) is used for two different
  questions that don't necessarily have the same answer** — unchanged.
- **`yalps` is a runtime dependency** — unchanged; load-bearing in
  `optimizer.ts`, `engine/sim/field.ts`, and (new) indirectly in every
  `run.ts` trial via the field it's handed.
- **`pruneDominated` (`engine/optimizer.ts`) tried as a `field.ts` speedup
  and rejected with measured numbers** (two sessions ago) — stays private/
  unexported, unchanged this session.
- **Points from optimal's display, and now the whole Sim 4 UI, have never
  been seen in a real browser** — standing limitation, see "Where We're
  Headed" #1-2 for exactly how close this session got to fixing it.
- **DST lost Queen eligibility** — unchanged, still unconfirmed whether
  wanted as a permanent rule.
- **The pick modal's "greyed out, infeasible" row display is dead code in
  practice** — unchanged, left in place defensively.
- **Click-to-move's real root cause for a *first*-move failure is still
  genuinely unconfirmed** — unchanged.
- **`assignRosterSlots`/`validate_etr_csv`/`engine/optimizer.ts` aren't in
  the parity harness**, nor is any of `engine/sim/*` — unchanged, no Python
  equivalent exists for any of it, by design.
- **Which interchangeable player draws "FLEX" vs. its own dedicated slot is
  a cosmetic artifact** of `assignRosterSlots`'s matching search —
  unchanged; "Fill out my core" inherits this same cosmetic ambiguity for
  whichever of its own filled players lands on FLEX.
- **"Stop with this core"/"Sim my core"/"Fill out my core" sit in the same
  place at every screen width** — unchanged, not confirmed either way (no
  real browser, see above).
- **`data/samples/repro-slate.csv`** stays on disk, deliberately
  uncommitted — Ron's call. Now also independently useful: it's the real
  file that confirmed the Rams' LA/LAR conflict this session.
- **No "Back" navigation to the PREVIOUS screen** — still a known gap.
- **`openingPreview`/`legalDepth` are slow (~49ms/call) and uncached** —
  unchanged.
- **`AdminScreen`'s "No Vegas row for: ... they'll use neutral defaults."
  message/field was fully removed, not just renamed** — replaced by
  `skippedTeams`/"Skipped N team(s) not on this slate: ..." (see Project
  Context). A slate team with no Vegas row is a hard error now, so that old
  message's own condition can't occur on any successful upload anymore.
- `cloneBoard`'s PGN-round-trip clone, chess.js's missing APIs, `build.ts`'s
  generic "illegal move" error — all unchanged.
- Task-numbering collision, Scotch Game rank 2 / King's Indian Defense drop
  confirmation, `excluded_families` and tier-boundary numbers hardcoded, CLI
  wording unconfirmed, `contest_type` field, pawn promotion's DFS
  classification, `logs/` vs `sessions/` doc-process mismatch, Kings
  structurally uncapturable (emergent) — all still open, all unchanged,
  carried forward across several sessions; see
  `sessions/1026/10132026-pin-top-9-opening-ranks-test.md` and
  `sessions/1026/10132026-never-moved-captures-field-tiers-and-family-
  ranking.md`.
- Full narrative for this session:
  `sessions/1026/10262026-sim3-sim4-vegas-fixes-fill-out-core.md`. Prior
  sessions in `sessions/1026/` for everything predating today.
