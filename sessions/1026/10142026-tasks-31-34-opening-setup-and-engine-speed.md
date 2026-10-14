# 10142026 — Tasks 31–34: Opening Suggestion/Explorer UI, App Shell, Engine Speed

## Context

Picked up right after Task 30 (parity harness, en passant fix) via `/start`.
`git status` was clean at the start. Four tasks landed this session, each
with its own commit: 31 (engine add-ons for setup), 32 (App shell: upload/
contest/King mode), 33 (engine speed), 34 (opening setup screen: suggestion,
explorer, board preview). Ron also added a new line to CLAUDE.md's Rules
section mid-session: "Never use AskUserQuestion. Always ask questions
inline." — saved to auto-memory (`feedback_no_askuserquestion.md`) since
it's a durable, project-wide rule, not a one-off.

## What was done

### Task 31 — Engine add-ons for setup (commit `5c3d08c`)

- `openings.ts`: added `suggestOpening(contest, rankedFamilies)` and
  `randomOpening(rankedFamilies, tier | "all", seed)`. Neither has a
  standalone Python original — the selection logic
  (`by_rank[contest.target_rank(...)]`, `rng.choice(pool)`) exists only
  inline inside `dfs_chess/cli.py`'s `_prompt_for_opening_setup`. Built from
  already-ported pieces (`rankFamilies`, `ContestConfig.targetRank`,
  `rng.ts`'s `SeededRandom`) to match that inline selection exactly.
- `config.ts`: added `loadContestPresets`, taking a list of named contest
  presets (name/entries/buy-in plus any `ContestConfig` field) and
  returning `ContestConfig[]` (per that task's literal wording — later
  changed in Task 32, see below).
- `config/contests.json`: new file, seeded with the existing
  `contest.example.json` contest and a hand-built H2H preset (2 entries) —
  this got fully replaced in Task 32.
- `tools/export_parity.py`: added `scenario_suggested_opening` for field
  sizes 2/100/1,000/1,001/5,000/10,000/100,000/416,171 — all computed via
  real `rank_families`/`ContestConfig.target_rank` calls, never
  reimplemented. Parity fixture grew from 33 to 41 scenarios.
- Confirmed: H2H (field_size=2) suggests rank 1, Sicilian Defense — matches
  the task's own stated expectation and real data.
- Flagged assumptions (buy-in values were pure placeholders with no real
  source anywhere in the repo) — all moot once Task 32 replaced the file
  wholesale from real data.
- Tests: 198 Vitest passed, 180 pytest passed (Python untouched).

### Task 32 — App shell: projections, contest, King mode (commit `9a62cf3`)

- Replaced the Vite default page with the real first setup screen in
  `App.tsx`: Step 1 (upload the projections CSV via a file `<input>`,
  parsed with `loadEtrCsv`, nothing sent anywhere), Step 2 (pick a contest
  preset, showing name/entries/buy-in/field tier), Step 3 (King mode radio
  — "Let him emerge" / "Place your King now", with a QB `<select>` for
  Placed mode; Black's QB auto-derived as the highest-projection QB other
  than White's pick, matching `cli.py`'s `_prompt_and_place_kings`).
  "Continue" enabled once all three are resolved.
- **Real bug found via jsdom, not via reading the diff**: `File.prototype
  .text()` isn't implemented by jsdom (the RTL test environment) — a bare
  `await file.text()` in the upload handler silently caught its own
  `TypeError` and showed the generic parse-error message, with no hint
  anything was jsdom-specific. Fixed by switching to `FileReader` (`web/
  src/App.tsx`'s `readFileAsText`), which works in both real browsers and
  jsdom.
- Added React Testing Library (`@testing-library/react`,
  `@testing-library/jest-dom`, `@testing-library/user-event`) + `jsdom` as
  devDependencies — named per the task's own instruction. `vite.config.ts`
  keeps the *global* test environment as `'node'` (engine tests don't need
  a DOM and jsdom adds real per-file overhead); `App.test.tsx` opts into
  jsdom per-file via a `// @vitest-environment jsdom` comment. Also needed
  `afterEach(cleanup)` in a new `test-setup.ts` — RTL's own auto-cleanup
  looks for a *global* `afterEach`, which this project's Vitest config
  (`test.globals` not enabled) never provides, so without this fix every
  test's `render()` stacked on top of the previous test's DOM.
- Changed `loadContestPresets`'s return shape from `ContestConfig[]` to
  `{ name, buyIn, contest }[]` (the task explicitly asked for this) —
  updated `config.test.ts` accordingly.
- Replaced `config/contests.json` entirely with the 19 real contests from
  `data/samples/NFL Weekly DFS System - Sim_Contest.csv` (Contest_Name/
  Total_Entrants/Entry_Fee/Contest_Type, plus prize pool/pct-to-first/
  min-cash/cash-line/max-entries-per-user kept as unused "extra fields for
  later"), skipping "NFL GIANT $25 Double-Up" (cash game, unsupported) but
  keeping H2H (also nominally "cash" in that file) per the task's explicit
  carve-out. CSV itself untouched, committed as `data/samples/NFL Weekly
  DFS System - Sim_Contest.csv`.
- **Flaky pre-existing timeout, confirmed unrelated**: `build.test.ts`'s
  capture-transfer test intermittently blew its (then-still-present) 20s
  custom timeout under full-suite CPU contention, while passing cleanly in
  isolation every time. Diagnosed, not silently patched — reported to Ron,
  who said the slowness gets its own task next (Task 33) and to commit
  Task 32 once `--testTimeout=30000` proved there was no real bug, noting
  the flakiness in the report rather than touching `build.test.ts`.
- Tests at commit time: 205/206 Vitest (the 1 failure was exactly that
  flaky timeout), 180/180 pytest.

### Task 33 — Engine speed (commit `40df385`)

- **Profiled first, as asked.** Added temporary `performance.now()`
  counters around `cloneBoard` and `findLegalMove` in `rules.ts`, ran the
  slow test, read the numbers, then removed the instrumentation. The
  *suspected* hotspot (PGN-round-trip board cloning) was real but minor —
  only ~6–16% of the slow test's time, since it runs once per move
  actually applied, not once per candidate. The *actual* dominant cost
  (~85%+) was `findLegalMove`: called once per candidate player in loops
  of up to ~90 NFL players deep, and every call ran a full, unscoped
  `board.moves({ verbose: true })` — regenerating every legal move for
  every piece on the board, including chess.js's own make/check/undo
  legality filter for each one, just to look up one already-known move.
- Fix, in `findLegalMove` only, no behavior change: (1) pass `square:
  move.from` to chess.js's `moves()`, scoping generation to the one piece
  being checked (confirmed by reading chess.js's own `_moves()` source —
  `square` genuinely restricts the generation loop to one square, not just
  the output); (2) cache the result per board instance
  (`WeakMap<Chess, Map<string, Move>>`) — safe because a `BuildState.board`
  is never mutated in place after creation (every apply/castle/capture
  clones first).
- `cloneBoard`'s PGN round-trip left as-is — profiling showed it was
  already minor next to the fix above; a replay-based rewrite risked
  subtlety (non-default starting FEN via PGN's `[SetUp]`/`[FEN]` headers)
  for marginal gain.
- Removed `build.test.ts`'s one custom 20s timeout (the capture-transfer
  test) — it now finishes in under 1s.
- Before/after, confirmed by direct measurement (not estimated): full
  suite 85s+ with 1–3 failures → 15–17s clean across repeated runs;
  `build.test.ts` alone ~77s (with failures) → ~9s, 21/21; slowest single
  test ~18.9s → ~1–3s.
- Tests: 206/206 Vitest (all 41 parity scenarios included), 180/180
  pytest, `tsc -b` clean.

### Task 34 — Setup: suggested opening + explorer + board preview (commit `9a7dfd3`)

- New `appData.ts`: consolidates every loaded-once engine input (`NFL`,
  `PRESETS`, `BOOK`, `RANKED_FAMILIES`, `LAST_RANK`, `RANK_BY_FAMILY`) in
  one place — `App.tsx` was recomputing some of these itself; refactored it
  to import from here instead, avoiding double-parsing the same files.
  Also hosts the one new UI-layer data combination this task needed:
  `statsFor`/`variationsForFamily`, a join between `BOOK` (the full
  3,865-line reference, via `loadOpeningBook`) and `line_stats.json` (via
  `loadLineStats`) by exact `(eco, name, moves)` — **verified 1:1 against
  the real vendored data** (wrote a one-off Python check: 3,865 lines each
  side, zero mismatches either direction) before trusting the join. This
  is plain data combination for display (no domain policy), reusing the
  already-exported `splitFamily`, not a new engine rule — flagged as a
  judgment call per the task's explicit "no new engine rules, say what's
  missing" caution.
- New `OpeningSetupScreen.tsx`/`.css`/`.test.tsx`, `BoardPreview.tsx`.
  Replaces the "Opening setup — coming next" placeholder. One shared
  `selection` state (seeded by `suggestOpening`) feeds both the top card
  and the board preview — tapping any line anywhere on the screen (a
  family's representative, a variation, a search result, or Random)
  updates it, and the single "Play this" button commits whichever is
  current. Flagged as a judgment call: the spec didn't say whether the top
  suggested-opening card should stay frozen with some separate commit path
  for the explorer, and a single shared selection seemed clearly simpler
  to use.
- Tier chips (Small/Mid/Large/XL/All) pre-selected to the contest's own
  tier (`ContestConfig.entryTier`); off-tier picks show "`{tier}`-style"
  via `ContestConfig.rankTier` compared against the contest's own tier.
  Random uses `randomOpening` with a fresh `Math.floor(Math.random() *
  2**31)` seed per click — the one place real (non-seeded) randomness
  enters, matching how any product would pick a random seed; the engine's
  own `randomOpening` stays pure/seeded underneath.
- **Dependency substitution, flagged**: the plain `chessground` package on
  npm is deprecated ("no longer supported — contact support"). Used the
  maintained fork `@lichess-org/chessground` (v10.4.2) instead — same
  concept, actively maintained. **License flag, not yet resolved by Ron**:
  chessground is GPL-3.0; its own README states "your combined work may be
  distributed only under the GPL. You must release your source code to the
  users of your website." That's a real obligation for a shipped product,
  surfaced clearly but not acted on — Ron moved to `/wrap-up` without
  responding to it specifically.
- **Performance finding, UI-layer fix only**: `openingPreview`/
  `legalDepth` (built in Tasks 17/27, untouched by Task 33) don't go
  through `findLegalMove`'s new cache at all — they call `board.moves({
  verbose: true })` directly per ply, and `openingPreview` calls
  `legalDepth` internally, so a single line gets walked twice. Measured
  directly: ~49ms per `openingPreview` call. The explorer can render
  dozens of these in one view (a deep family expanded, or a broad search),
  and an unbounded search could try to preview nearly all 3,865 lines for
  a one-letter query — confirmed this by timing `findOpeningLines("n",
  BOOK)` (3,820 matches) plus 40 previews (~1,960ms) directly, and by
  hitting a genuine multi-second hang in `OpeningSetupScreen.test.tsx`
  before fixing it. Fix was UI-layer only, no engine change: a
  memoization cache (`previewFor` in `appData.ts`, wrapping the pure
  `openingPreview` call) plus a 3-character minimum search length and a
  20-result display cap, both real mobile-UX safeguards and not just
  test-timing fixes.
- Tests: the 5 scenarios the task named exactly — H2H suggests Sicilian
  Defense, the contest's chip is pre-selected, searching "Najdorf" finds a
  Sicilian line (the book names five different depths of "Sicilian
  Defense: Najdorf Variation" identically — the test checks "at least one
  match," not a single unique one), Random stays within the selected chip
  (property-checked over 6 random picks, not a specific value), an
  off-tier pick shows the tag. All pass. Full suite: 211/211 Vitest,
  180/180 pytest, `tsc -b` and `npm run build` both clean.
- **Could not get real browser verification.** No project skill covers
  running this app yet. Started the Vite dev server and tried to drive it
  with Playwright (no `chromium-cli` available) — headless Chromium failed
  to launch on a missing system library (`libasound.so.2`); installing it
  needs `sudo`, which isn't available non-interactively in this
  environment (`sudo -n true` fails). Cleaned up the temporary `playwright`
  install, the dev server, and the driver script afterward — none of that
  is in the final diff. Relied on the RTL/jsdom test suite instead, and
  said so explicitly rather than claiming visual confirmation.

## Open threads

- **chessground's GPL-3.0 license** — flagged to Ron, not yet decided.
  Worth a direct answer before this goes further: accept the source-release
  obligation, or swap the board renderer for something permissively
  licensed.
- **No real browser verification of Task 34's UI** — blocked on a missing
  system library (`libasound.so.2`) that needs `sudo` to install. Someone
  with shell access to this WSL instance (or a differently-provisioned
  environment) should either install it, or set up a project "run" skill
  (`/run-skill-generator`) once it's resolved so future sessions don't hit
  the same wall.
- **`openingPreview`/`legalDepth`'s own per-ply, unscoped move generation**
  (~49ms/call) — worked around at the UI layer (caching + display caps),
  not fixed in the engine. Worth a dedicated task if the explorer needs to
  scale further, or if the eventual Monte Carlo sim calls either in a hot
  loop.
- The "suggested opening" gap tracked in prior logs (`10132026-port-
  family-ranking-suggestion-opening-preview.md`) is now closed —
  `suggestOpening`/`randomOpening` exist and are wired into the real UI.
- Everything else carried in the prior HANDOFF's Open Items (task-numbering
  collision, Scotch Game/King's Indian rank questions, `excluded_families`/
  tier-boundary config-file migration, CLI wording, `book_weights`/
  `load_popularity` having no caller, no `contest_type` field, pawn
  promotion classification, `logs/` vs `sessions/` doc mismatch, `Top_Ten`
  distinction, the untested generic-illegal-move-error path in `build.ts`,
  Kings never being captured as the King piece) is unchanged — none of
  these four tasks touched any of it.
- The "build" screen (after opening selection) is still a placeholder
  showing contest/King mode/chosen opening only — actually playing the
  build turn-by-turn in the UI is the next big piece of work.
