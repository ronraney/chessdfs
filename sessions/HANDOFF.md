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
uploads (projections, Vegas) plus, as of this session, a **"Build fields"**
section (see below) — none of it wired into the player-facing flow yet.
Secrets (`LICHESS_API_TOKEN`, `VITE_ADMIN_PASSWORD`) live in gitignored
`.env` files, never printed. Club (light) and Slate (dark) themes exist
app-wide, CSS-variable driven, with a header toggle.

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
**yalps** (small, pure-TypeScript, dependency-free LP/MILP solver). "Pts
from optimal" (best-completion-vs-slate-optimal delta) is shown for both
sides (White's panel/finish-screen line, and Black's own mirrored version).
`optimizer.ts` also has a private `pruneDominated` pre-pass (a player is
dropped only once enough OTHER players strictly dominate it on cost+proj) —
tried as a reusable speedup for `field.ts` this session, see below for why
it wasn't kept there.

**Monte Carlo sim port, `web/src/engine/sim/`** (pure TS, no I/O, no
unseeded randomness, seeded via `SeededRandom`/`rng.next()`): ported from
`rraney/nfl-dfs` across three sessions so far.
- `draws.ts` — `drawOutcome` (Part A: piecewise-linear percentile curve,
  DK Floor/Proj/Ceiling = P15/P50/P85, k=1.0 right-tail) and
  `drawSlateOutcomes` (Part B: latent-factor correlation engine — zGame/
  zTeam/individual, DST negative game loading, shootout/script regime
  shocks, 7% DST splash, dome wGame boost keyed off `Player.isHome`/
  `sport.domeTeams`). Vegas input (`SlateVegas`) is keyed by team
  abbreviation, one optional `{ total, spread }` per team, mirroring
  nfl-dfs's own Vegas sheet (`Rank, Team, Implied Total, Spread, O/U,
  Opponent`; `spread` is that team's own signed value, negative = favored).
  Not ported: calibration tooling, `sim_correlation.js`/`sim_foundations.js`
  as whole files (only `randNormal`/`normCDF` reproduced), Showdown
  CPT/FLEX grouping (chess-dfs is classic-contest-only).
- `vegasCsv.ts` — admin-upload Vegas CSV parsing/validation
  (`validateVegasCsv`), producing `SlateVegas` directly. Validates required
  columns, numeric values, and that every row's team is on the loaded
  slate (hard error); a slate team with **no** Vegas row is a warning only
  (`missingTeams`), not a rejection — it draws with neutral defaults.
- `field.ts` — `generateSimulatedField`: one MILP solve per lineup
  (reusing yalps), porting nfl-dfs's `generateSimulatedFieldMilp_` at its
  frozen defaults. Kept: the ownership-bias objective term, per-player
  exposure caps (incl. QB-only extra cap + QB/DST aggregate-capacity-
  guarantee rescale), the Minimum Exposure Floor's catch-up boost, the
  salary **floor** (`FIELD_MIN_SALARY_` = $48,500, **added this session**,
  alongside the pre-existing cap), and **stack targeting** (added this
  session: a per-attempt coin flip at `1 - FIELD_TARGET_NAKED_QB_RATE_`
  (0.175) decides stack intent; candidate teams — ≥1 QB and ≥2 WR/TE
  currently in the exposure-capped pool — are weighted-sampled without
  replacement and tried up to `STACK_TEAM_RETRY_LIMIT_` = 6 times before
  falling back to an unstacked solve). **Not ported**, per this session's
  own task wording ("skip unless the floor makes too many attempts
  infeasible"): Field Pace Slack and Dynamic Floor Relaxation — measured
  accept rate on the real slate with floor+stack was 941/1000 (94.1%),
  high enough that neither was needed; reported to Ron, not silently
  decided. `lineupWeight` now divides by **lineups actually built**
  (`contest.fieldSize / lineups.length`, nfl-dfs's own way), not
  `sampleSize` (last session's now-superseded spec). `generateSimulatedField`
  also gained an optional trailing `onProgress?: (completed, total) => void`
  callback (called once per attempt + once more at 100%) so a caller
  running this off-thread can report progress without this file doing any
  I/O itself. Roster-slot shape (qb/dst/rb/wr/te/skill min/max counts)
  stays hardcoded exactly as nfl-dfs's own `DK_MAIN_ROSTER_` is, not
  derived from `sport.rosterSlots` generically. Ownership resolves via the
  existing Small/Mid/Large rule (`contest.fieldTier()` + `Player.ownFor`).
  `DEFAULT_SAMPLE_SIZE = 1000`. **Performance is highly load-sensitive, not
  a fixed number**: an isolated run (nothing else on the CPU) measured
  ~14ms/attempt (~14s for a 1000-lineup field) this session; the identical
  code measured ~230ms/attempt when run concurrently with other test
  load, in the same environment, back to back — confirmed via a direct
  A/B control run, not assumed. Last session's ~155-165s figure was real
  for ITS moment, not a regression since fixed; don't extrapolate a fixed
  cost from any one measurement here.
- **Speedup tried and rejected, with numbers**: reusing `optimizer.ts`'s
  `pruneDominated` as a pre-pass on `field.ts`'s player pool (this
  session's own suggestion). Measured on the real 301-player sample slate:
  ~5x faster per solve (2.7ms/attempt vs. 14.2ms), but it collapsed QB
  diversity from 22 survivors to 4 and dropped the accept rate from 94.1%
  to 68.8% — a dominated player can be the ONLY legal substitute once its
  dominator gets exposure-capped out later in a batch, which a one-time
  global prune can't account for. Not applied; `pruneDominated` stays
  private/unexported in `optimizer.ts`.
- **Admin "Build fields" + caching infrastructure, added this session**:
  `fieldWorker.ts` (a Web Worker — reconstructs `Player`/`ContestConfig`
  from plain postMessage data, since structured clone drops class
  prototypes; imports the bundled `nfl.json` directly rather than
  receiving it over the wire), `buildFieldCache.ts` (orchestrates one
  sequential Worker-run build per tier — Small/Mid/Large, with its own
  guessed `BUILD_SEED` and per-tier representative `fieldSize` of
  1000/5000/50000 purely to land in the right `contest.fieldTier()`
  bucket — Admin has no real contest to build against), `fieldCacheStore.ts`
  (`localStorage`, keyed by an FNV-1a hash of the saved projections CSV
  text + tier; `resolveCachedField(signature, contest, players)`
  re-hydrates cached player IDs against a live `Player[]` and recomputes
  `lineupWeight` from whichever REAL contest is asking, since a cached
  field is tier-scoped but `lineupWeight` is contest-specific;
  `NO_FIELD_CACHED_MESSAGE` = "Build fields in Admin first."). `AdminScreen.tsx`
  got a new "Simulated fields" section: a "Build fields" button, a
  progress bar during a build, and a per-tier "N lineups cached"/"not
  built yet" readout. Uploading or clearing projections calls
  `clearFieldCache()`. **Not done, flagged rather than built ahead**:
  no screen in the player-facing flow (BuildScreen or otherwise) actually
  calls `resolveCachedField` or shows `NO_FIELD_CACHED_MESSAGE` yet — there
  is no "sim feature" UI to attach it to today (see "Where We're Headed").
  `fieldWorker.ts`/the real build-click path are **not unit-tested** —
  jsdom has no `Worker` implementation at all, same standing gap as
  `stockfishEngine.ts`'s own Worker; `AdminScreen.test.tsx` covers gating,
  reading back a pre-seeded cache, and clear-on-upload/clear, all without
  ever clicking the button.
- Still not ported (original 6-task breakdown): the trial loop/scoring
  (run many trials, score the user's build + the field, compute
  percentile/finish stats), wiring the player-facing UI to any of this,
  and a calibration parity test.
- `Player` (models.ts) has `isHome?: boolean` and `SportConfig` has
  `domeTeams?: ReadonlySet<string>` (both optional/defaulted) — sim-only
  concerns, no bearing on chess-move/pick-list rules.

**Environment note**: accessed from Windows via the
`\\wsl.localhost\Ubuntu\...` UNC path. Every git/npm command needs
`wsl.exe -- bash -lc "cd ~/chess-dfs/... && ..."` — plain `npm run ...`
through the Windows-side Bash tool fails outright. git needed a one-time
`git config --global --add safe.directory` exception (already applied).
Commit messages with special characters need care: a single-quoted
heredoc delimiter (`<<'EOF'`) inside `wsl.exe -- bash -lc "..."` does NOT
reliably protect `$` (seen this session: `\$48,500` inside the heredoc
came out as `8,500` — the outer double-quoted command string, not the
heredoc, was the culprit) or backticks (an earlier session's commit
landed with backtick-quoted words silently dropped). Caught both times
only by checking `git log -1 --format='%B'` right after committing — keep
doing this as a habit for any commit message with `$`, backticks, or
other shell-special characters. Fix: avoid the special character
entirely in the message (e.g. write "48500" not "$48,500"), or use
`git commit --amend` (safe pre-push) with the message in a plain file via
`-F path`.

**jsdom (this project's entire test environment) runs no CSS layout
engine**: `getBoundingClientRect`/`offsetWidth`/`scrollWidth` are always 0
regardless of the real stylesheet, and `getComputedStyle` never evaluates
`@media` queries at all; it also has **no `ResizeObserver` at all**
(`test-setup.ts` stubs a no-op one) and **no `Worker` implementation at
all** (confirmed again this session with `fieldWorker.ts`, same as
`stockfishEngine.ts`'s pre-existing gap). Any future task needing a
rendered-layout/viewport-geometry test, or a real Worker-driven flow
tested end-to-end, needs a real browser (still not launchable here).

**A growing list of real-chessground/real-engine `userEvent` tests sit
close to Vitest's 5000ms default timeout under full-suite parallel load**
(this machine: 23-28 vitest workers on 8 cores, varies by what else is
running). Each occurrence so far has been genuine, not a removable
inefficiency, fixed with an explicit per-test timeout matching the test's
own real cost. `npx vitest run --testTimeout=20000` is the belt-and-
suspenders form when a clean count absolutely must not flake — but note
it can't rescue a test with its OWN smaller hardcoded timeout argument
(`it(..., 15000)` wins over the CLI/global default); this session saw
`BuildScreen.secondMove.test.tsx`'s already-fixed-once castling/capture
tests flake twice under unusually heavy load (28 workers, likely from
back-to-back real-slate MILP benchmarking in the same session) before
passing clean on a third full-suite run and in isolation — treated as
environment noise, not touched, since the task didn't ask for it and a
retry resolved it.

## Where We Are

- **237 pytest passing, 463 npm test passing** (was 446 before this
  session's +17: salary floor, stack rate, onProgress, lineupWeight
  update in `field.test.ts`; 9 `fieldCacheStore.test.ts` hit/miss/clear;
  5 new `AdminScreen.test.tsx` cache/gating tests).
- **One commit this session, pushed to `origin/main`**:
  - **`e78d55b`** "Sim 2 follow-up: salary floor, stack targeting,
    lineupWeight, field caching" — `engine/sim/field.ts` (floor, stack
    targeting, `onProgress`, `lineupWeight` fix), `fieldWorker.ts`,
    `buildFieldCache.ts`, `fieldCacheStore.ts` (all new), `AdminScreen.tsx`
    "Simulated fields" section.
- Python engine untouched (TS-only task, same as the last several
  sessions).

## Where We're Headed

1. **Real-browser verification** — still the standing, unresolved gap: no
   browser can launch in this environment at all. Now also blocks ever
   exercising `fieldWorker.ts`'s real build-click path (jsdom has no
   `Worker`), same as `stockfishEngine.ts` before it.
2. **Wire a player-facing "sim feature" to `resolveCachedField`** — the
   single biggest concrete next step: nothing in `BuildScreen` (or
   anywhere else a player sees) reads the Admin-built field cache yet.
   Whatever surfaces it needs to call `fieldCacheStore.resolveCachedField`
   for the current contest and show `NO_FIELD_CACHED_MESSAGE` when it
   comes back null.
3. **Monte Carlo sim port from `rraney/nfl-dfs`** — outcome draws +
   correlation engine (Sim 1), the MILP field generator with floor/stack
   (Sim 2 + follow-up), and the Admin build/cache infra are done.
   Remaining from the original 6-task breakdown: the trial loop/scoring
   (run many trials, score the user's build + the field, compute
   percentile/finish stats) and a calibration parity test — neither
   started.
4. Simulated "Top 10%" metric — still a known gap.
5. Ron needs to create **`web/.env`** with his own
   `VITE_ADMIN_PASSWORD=...` — still not created, deliberately.
6. `CONTINUATION_LIMIT = 8` (Book continues' cap) is still a guessed
   number, not spec'd. Similarly guessed, flagged this session:
   `buildFieldCache.ts`'s `BUILD_SEED` and its per-tier representative
   `fieldSize` values (1000/5000/50000) — no real spec for either.
7. PLACED king mode's "silent King move while dragging" path still has
   no dedicated test.
8. If the engine changes, re-run `tools/export_parity.py` and `npm run
   test` to keep the parity fixture honest.
9. If more tests start flaking under full-suite load, the same "extend
   this specific test's timeout to match its real cost" treatment
   applies — check for a genuine fixable inefficiency first, and remember
   a per-test timeout argument beats the CLI default.
10. **`tools/sim_builds.py`** still calls `classify(p, sport)` with the
    old 2-arg signature and assumes Rook is RB-only — unchanged, out of
    scope, flagged again.

## Open Items

- **`DEFAULT_EXCLUDED_FAMILIES` (openings.ts) is used for two different
  questions that don't necessarily have the same answer** — unchanged.
- **`yalps` is a runtime dependency** — unchanged; load-bearing in two
  places (`optimizer.ts`'s single-lineup solve, `engine/sim/field.ts`'s
  per-lineup MILP solves — now with a floor as well as a cap, and an
  extra stack-constrained model variant).
- **`pruneDominated` (`engine/optimizer.ts`) tried as a `field.ts`
  speedup this session and rejected with measured numbers** (see Project
  Context) — stays private/unexported; the earlier "worth a second pair
  of eyes" flag on it is now resolved (it's fine for optimizer.ts's own
  single-best-lineup problem, just not reusable for a stochastic
  exposure-weighted field as-is).
- **Points from optimal's display hasn't been seen in a real browser** —
  unchanged, standing limitation.
- **DST lost Queen eligibility** — unchanged, still unconfirmed whether
  wanted as a permanent rule.
- **The pick modal's "greyed out, infeasible" row display is dead code
  in practice** — unchanged, left in place defensively.
- **Click-to-move's real root cause for a *first*-move failure is still
  genuinely unconfirmed** — unchanged.
- **`assignRosterSlots`/`validate_etr_csv`/`engine/optimizer.ts` aren't in
  the parity harness**, nor is any of `engine/sim/*` — unchanged, no
  Python equivalent exists for any of it, by design (every sim task so
  far has been explicitly TS-only).
- **Which interchangeable player draws "FLEX" vs. its own dedicated slot
  is a cosmetic artifact** of `assignRosterSlots`'s matching search —
  unchanged.
- **"Stop with this core" sits in the same place at every screen width**
  — unchanged, not confirmed either way.
- **`data/samples/repro-slate.csv`** stays on disk, deliberately
  uncommitted — Ron's call, untouched again this session.
- **No "Back" navigation to the PREVIOUS screen** — still a known gap.
- **`openingPreview`/`legalDepth` are slow (~49ms/call) and uncached** —
  unchanged.
- **No player-facing consumer of the new field cache yet** (new this
  session) — see "Where We're Headed" #2; `NO_FIELD_CACHED_MESSAGE` and
  `resolveCachedField` exist but nothing calls them outside tests.
- **`fieldWorker.ts`'s real build-click path is unverified** (new this
  session) — jsdom can't run a real Worker; only reachable in a real
  browser.
- `cloneBoard`'s PGN-round-trip clone, chess.js's missing APIs,
  `build.ts`'s generic "illegal move" error — all unchanged.
- Task-numbering collision, Scotch Game rank 2 / King's Indian Defense
  drop confirmation, `excluded_families` and tier-boundary numbers
  hardcoded, CLI wording unconfirmed, `contest_type` field, pawn
  promotion's DFS classification, `logs/` vs `sessions/` doc-process
  mismatch, Kings structurally uncapturable (emergent) — all still open,
  all unchanged, carried forward across several sessions; see
  `sessions/1026/10132026-pin-top-9-opening-ranks-test.md` and
  `sessions/1026/10132026-never-moved-captures-field-tiers-and-family-
  ranking.md`.
- Full narrative for this session: `sessions/1026/10262026-sim2-followup-
  salary-floor-stack-targeting-field-caching.md`. Prior sessions in
  `sessions/1026/` for everything predating today.
