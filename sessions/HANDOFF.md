# DFS Chess — Handoff
Last updated: 2026-10-19

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
uploads instead, with real validation — projections and, as of this
session, Vegas data (see below). Secrets (`LICHESS_API_TOKEN`,
`VITE_ADMIN_PASSWORD`) live in gitignored `.env` files, never printed. Club
(light) and Slate (dark) themes exist app-wide, CSS-variable driven, with a
header toggle.

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
from optimal" (best-completion-vs-slate-optimal delta) is shown for **both
sides** now — White's panel/finish-screen line, and Black's own mirrored
version (Black's locks forced in, White's picks excluded, same slate
optimal) — added this session.

**Monte Carlo sim port, `web/src/engine/sim/`** (pure TS, no I/O, no
unseeded randomness, seeded via `SeededRandom`/`rng.next()`): ported from
`rraney/nfl-dfs` across two sessions so far.
- `draws.ts` — `drawOutcome` (Part A: piecewise-linear percentile curve,
  DK Floor/Proj/Ceiling = P15/P50/P85, k=1.0 right-tail) and
  `drawSlateOutcomes` (Part B: latent-factor correlation engine — zGame/
  zTeam/individual, DST negative game loading, shootout/script regime
  shocks, 7% DST splash, **dome wGame boost**). Vegas input (`SlateVegas`)
  is keyed by team abbreviation, one optional `{ total, spread }` per
  team, mirroring nfl-dfs's own Vegas sheet (`Rank, Team, Implied Total,
  Spread, O/U, Opponent`; `spread` is that team's own signed value,
  negative = favored). Dome status is now **exact** (not an either-team
  guess): a game is dome iff its real home team — `Player.isHome`,
  derived in `loadEtrCsv` from the ETR "Opp" column's own "@" convention
  ("@NYG" = this row's team is away) before the "@" is stripped — is in
  `sport.domeTeams` (`config/sports/nfl.json`'s `dome_teams`, copied
  verbatim from nfl-dfs's `SIM_DOME_TEAMS_`). Not ported: calibration
  tooling (`calibrateCorrelation`), `sim_correlation.js`/
  `sim_foundations.js` as whole files (only their two pure math helpers,
  `randNormal`/`normCDF`, are reproduced), Showdown CPT/FLEX grouping
  (chess-dfs is classic-contest-only).
- `vegasCsv.ts` — admin-upload Vegas CSV parsing/validation
  (`validateVegasCsv`), producing `SlateVegas` directly (no adapter needed
  before passing it into `drawSlateOutcomes`). Validates required columns,
  numeric values, and that every row's team is on the loaded slate (hard
  error); a slate team with **no** Vegas row is a warning only (reported
  via `missingTeams`), not a rejection — it draws with neutral defaults.
- `field.ts` — `generateSimulatedField`: one MILP solve per lineup
  (reusing yalps), porting nfl-dfs's `generateSimulatedFieldMilp_` at its
  frozen defaults for exactly three mechanisms — the ownership-bias
  objective term, per-player exposure caps (incl. the QB-only extra cap
  and the QB/DST aggregate-capacity-guarantee rescale), and the Minimum
  Exposure Floor's catch-up boost. Everything else nfl-dfs's real function
  does (stack targeting, Field Pace Slack, Dynamic Floor Relaxation,
  nfl-dfs's own salary *floor*, all diagnostics) is **not** ported — none
  were named as "keep." Roster-slot shape (qb/dst/rb/wr/te/skill min/max
  counts) is hardcoded exactly as nfl-dfs's own DK_MAIN_ROSTER_ is, not
  derived from `sport.rosterSlots` generically the way `optimizer.ts`
  does. Ownership resolves via the existing Small/Mid/Large rule
  (`contest.fieldTier()` + `Player.ownFor`). Output is `{ lineups,
  lineupWeight }` where `lineupWeight = contest.fieldSize / sampleSize`
  (nfl-dfs itself divides by `lineups.length`; this task's own spec says
  `sampleSize`). `DEFAULT_SAMPLE_SIZE = 1000` (nfl-dfs's own default).
  **Performance**: on the real 301-player sample slate, building a field
  at the default sample size took **~155–165 seconds** (917/1000 attempts
  accepted, rest infeasible under exposure caps — expected). Not yet
  wired into any UI; whatever UI-wiring task comes next will need to
  reckon with that runtime (async/worker/progress, or a smaller default
  for interactive use) — not addressed this session.
- Still not ported (original 6-task breakdown): the trial loop/scoring
  (run many trials, score the user's build + the field, compute
  percentile/finish stats), UI wiring, and a calibration parity test.
- `Player` (models.ts) gained `isHome?: boolean` (optional, defaults to
  `false` so every pre-existing synthetic test `Player` keeps compiling
  unchanged) and `SportConfig` gained `domeTeams?: ReadonlySet<string>`
  (same optional/defaulted pattern) to support the above — both are
  sim-only concerns, no bearing on chess-move/pick-list rules.

**Environment note**: accessed from Windows via the
`\\wsl.localhost\Ubuntu\...` UNC path. Every git/npm command needs
`wsl.exe -- bash -lc "cd ~/chess-dfs/... && ..."` — plain `npm run ...`
through the Windows-side Bash tool fails outright. git needed a one-time
`git config --global --add safe.directory` exception (already applied).
Commit messages with backticks need care: even a single-quoted heredoc
delimiter (`<<'EOF'`) did NOT reliably stop backtick command substitution
in this environment's shell — a commit this session landed with
backtick-quoted words silently replaced by empty strings (and a stray
"command not found" on stderr) despite that quoting. Caught by checking
`git log -1 --format='%B'` right after committing (now worth doing as a
habit after any commit message with backticks/special characters);
fixed via `git commit --amend` (safe pre-push) using a message written to
a temp file (`-F path`) instead of inline heredoc backticks. Prefer double
quotes over backticks in commit messages here, or write the message to a
file first.

**jsdom (this project's entire test environment) runs no CSS layout
engine**: `getBoundingClientRect`/`offsetWidth`/`scrollWidth` are always 0
regardless of the real stylesheet, and `getComputedStyle` never evaluates
`@media` queries at all; it also has **no `ResizeObserver` at all**
(`test-setup.ts` stubs a no-op one). Any future task asking for a
rendered-layout/viewport-geometry test needs either a real browser (still
not launchable here) or a mechanism/DOM-structure test instead, clearly
labeled as such.

**A growing list of real-chessground/real-engine `userEvent` tests sit
close to Vitest's 5000ms default timeout under full-suite parallel load**
(this machine: ~23 vitest workers on 8 cores). Each occurrence so far has
been genuine, not a removable inefficiency, fixed with an explicit
per-test timeout matching the test's own real cost. `npx vitest run
--testTimeout=20000` remains the belt-and-suspenders form when a clean
count absolutely must not flake. Separately (new this session): MILP-
solve-based tests (yalps) can be genuinely slow at realistic scale — the
field generator's own test suite deliberately uses a small 58-player
synthetic pool (not the real ~300-player sample) to stay fast; see
`field.test.ts`'s own comment for the measured real-slate cost instead.

## Where We Are

- **237 pytest passing, 446 npm test passing** — confirmed stable across
  repeated full-suite runs (`npm run test` and `npx vitest run
  --testTimeout=20000`).
- **Five commits this session, all pushed to `origin/main`**:
  - **`23cd25d`** "Sim 1: outcome draws + correlation engine (TS only)" —
    `engine/sim/draws.ts` (drawOutcome, drawSlateOutcomes), 8 tests.
  - **`167e7a0`** "Field gets Pts from optimal" — Black's side panel and
    the finish screen now show it too; `BuildScreen.tsx`'s `FinishCard`
    prop renamed `optimalStats` → `whiteOptimalStats` + new
    `blackOptimalStats`, 2 new tests.
  - **`33aa6e3`** "Admin: Vegas upload + dome list" — `engine/sim/
    vegasCsv.ts`, `vegasStore.ts`, `AdminScreen.tsx`'s second upload,
    `config/sports/nfl.json`'s `dome_teams`, dome wGame boost in
    `draws.ts` (then still an either-team approximation), 20 new tests.
  - **`31a1ffb`** "Keep home/away; dome is the exact home team" — `Player.
    isHome`, `loadEtrCsv` deriving it from the ETR "@" convention, dome
    check corrected to the real home team only, 2 new tests.
  - **`7bd60da`** "Sim 2: simulated contest field (TS only)" — `engine/
    sim/field.ts` (generateSimulatedField), 5 new tests.
- Python engine untouched all session (every task was TS-only).

## Where We're Headed

1. **Real-browser verification** — still the standing, unresolved gap: no
   browser can launch in this environment at all.
2. **Monte Carlo sim port from `rraney/nfl-dfs`** — outcome draws +
   correlation engine (Sim 1) and the MILP field generator (Sim 2) are
   both done. Remaining from the original 6-task breakdown: the trial
   loop/scoring (run many trials, score the user's build + the field,
   compute percentile/finish stats) and UI wiring — the latter will need
   to address the field generator's ~155-165s runtime at its default
   sample size (see Project Context) before it can be interactive. A
   calibration parity test was also on the original list; not started.
3. Simulated "Top 10%" metric — still a known gap.
4. Ron needs to create **`web/.env`** with his own
   `VITE_ADMIN_PASSWORD=...` — still not created, deliberately.
5. `CONTINUATION_LIMIT = 8` (Book continues' cap) is still a guessed
   number, not spec'd.
6. PLACED king mode's "silent King move while dragging" path still has
   no dedicated test.
7. If the engine changes, re-run `tools/export_parity.py` and `npm run
   test` to keep the parity fixture honest.
8. If more tests start flaking under full-suite load, the same "extend
   this specific test's timeout to match its real cost" treatment
   applies — check for a genuine fixable inefficiency first.
9. **`tools/sim_builds.py`** still calls `classify(p, sport)` with the
   old 2-arg signature and assumes Rook is RB-only — unchanged, out of
   scope, flagged again.

## Open Items

- **`DEFAULT_EXCLUDED_FAMILIES` (openings.ts) is used for two different
  questions that don't necessarily have the same answer** — unchanged.
- **`yalps` is a runtime dependency** — unchanged; now load-bearing in a
  second place too (`engine/sim/field.ts`'s per-lineup MILP solves, on
  top of `optimizer.ts`'s single-lineup solve).
- **The dominance-pruning pre-pass in `engine/optimizer.ts`** — unchanged,
  still flagged as worth a second pair of eyes.
- **Points from optimal's display hasn't been seen in a real browser** —
  unchanged, standing limitation; now true for both sides' displays.
- **DST lost Queen eligibility** — unchanged, still unconfirmed whether
  wanted as a permanent rule.
- **The pick modal's "greyed out, infeasible" row display is dead code
  in practice** — unchanged, left in place defensively.
- **Click-to-move's real root cause for a *first*-move failure is still
  genuinely unconfirmed** — unchanged.
- **`assignRosterSlots`/`validate_etr_csv`/`engine/optimizer.ts` aren't in
  the parity harness** — unchanged. **`engine/sim/*` isn't either** (new
  this session) — no Python equivalent exists for any of it, by design
  (every sim task so far has been explicitly TS-only).
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
- **`engine/sim/field.ts`'s dome-adjacent design choices, flagged for
  Ron's review**: (a) `lineupWeight = entrants / sampleSize` per this
  task's own spec, diverging from nfl-dfs's own `/ lineups.length`; (b)
  roster-slot shape is hardcoded NFL-classic (qb/dst/rb/wr/te/skill), not
  derived from `sport.rosterSlots` generically; (c) nfl-dfs's own salary
  *floor* (FIELD_MIN_SALARY_) was not ported, only the cap.
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
- Full narrative for this session: `sessions/1026/10192026-sim2-field-
  gen-vegas-dome-homeaway.md`. Earlier today:
  `sessions/1026/10192026-captures-dont-fit-blocked-moves-and-sim-port-
  sizing.md` and `sessions/1026/10192026-pieces-sort-by-gpp-metric.md`.
  Prior sessions in `sessions/1026/` for everything predating today.
