# DFS Chess — Handoff
Last updated: 2026-10-14

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
the `AskUserQuestion` tool — ask any question inline, as plain text, instead
(added 2026-10-14). Python 3.11+, stdlib + pytest + `python-chess` for the
original engine; `web/` is a Vite + React + TypeScript app (Node v24, npm)
built alongside it. The TS port of the engine is complete, with a standing
parity harness proving it matches Python on real, deterministic scenarios,
and now has a real first UI: upload projections → pick a contest → pick King
mode → pick an opening, with a build screen still to come. Secrets
(`LICHESS_API_TOKEN`) live in a gitignored `.env`, never printed.

## Where We Are

- **180 Python tests passing.** The Python engine itself is unchanged since
  the web port began — every web-port task so far has been additive,
  TypeScript-only.
- **211 Vitest tests passing** (`npm run test`), `tsc -b` and `npm run
  build` both clean. Confirmed stable across repeated runs — the full
  suite now reliably finishes in 15–20s under default timeouts (see Task
  33 below; no test file has a custom timeout anymore).
- **`web/src/engine/`** covers the entire pure Python engine plus
  TS-only additions with no Python original (`suggestOpening`/
  `randomOpening` in `openings.ts`, Task 31), proven against a 41-scenario
  parity harness (`tools/export_parity.py` + `web/src/engine/__fixtures__/
  parity.json` + `parity.test.ts`). `rules.ts`'s `findLegalMove` was
  rewritten for speed this session (Task 33, see below) with no behavior
  change — still fully covered by parity and `rules.test.ts`.
- **`web/src/appData.ts`** (new, Task 34): the one place that loads every
  engine input once — `NFL` (sport config), `PRESETS` (contest presets),
  `BOOK` (the full 3,865-line opening reference), `RANKED_FAMILIES`/
  `LAST_RANK`/`RANK_BY_FAMILY` (from `rankFamilies`). Also hosts
  `statsFor`/`variationsForFamily`, a UI-layer join between `BOOK` and
  `line_stats.json` by exact `(eco, name, moves)` (verified 1:1 against
  the real data), and `previewFor`, a memoization cache around
  `openingPreview` (see Open Items — that engine function is slow, ~49ms/
  call, uncached by Task 33's fix).
- **`web/src/App.tsx`** now has three real screens, not a placeholder:
  1. **Setup** (Task 32): upload the projections CSV (parsed client-side
     via `loadEtrCsv`, nothing sent anywhere — uses `FileReader`, not
     `Blob#text()`, since jsdom's test environment doesn't implement the
     latter), pick a contest preset (name/entries/buy-in/field tier shown),
     pick King mode (Let him emerge / Place your King now, with a QB
     picker in Placed mode — Black's QB auto-derived as the
     highest-projection QB other than White's pick).
  2. **Opening setup** (Task 34, `OpeningSetupScreen.tsx`): the contest's
     tier + `suggestOpening`'s pick up top (family/variation/moves/piece
     sequence/a small read-only chessground board), an explorer below
     (Small/Mid/Large/XL/All tier chips pre-selected to the contest's own
     tier, a 3-character-minimum search over all 3,865 named lines capped
     at 20 shown results, tap-to-expand family rows showing variations
     sorted by game count, a Random button, an off-tier "`{tier}`-style"
     tag when applicable, "(Play your own opening)" at the bottom). One
     shared `selection` state feeds both the top card and the board
     preview/commit button throughout.
  3. **Build placeholder**: shows the chosen contest, King mode, and
     opening (or "Your own opening") — the actual turn-by-turn build UI is
     still unbuilt.
  - `config/contests.json` (Task 31, replaced in Task 32) now holds the 19
    real contests from `data/samples/NFL Weekly DFS System -
    Sim_Contest.csv` (skips the one unsupported cash game, keeps H2H).
  - `@lichess-org/chessground` (Task 34) renders the board preview —
    **GPL-3.0 licensed; not yet decided whether that's acceptable for this
    product** (see Open Items).
  - React Testing Library + jsdom (Task 32) cover the UI: `App.test.tsx`
    (6 tests) and `OpeningSetupScreen.test.tsx` (5 tests, matching Task
    34's exact spec). Both opt into jsdom *per-file* (`// @vitest-environment
    jsdom`) — the global Vitest environment stays `'node'`, since jsdom adds
    real per-file overhead the (already chess.js-heavy) engine tests don't
    need.
- **Not yet built**: the actual build screen (playing moves, locking
  players, in the UI); the Monte Carlo sim; a CLI on the TS side (if ever
  wanted).

## Where We're Headed

1. Decide on chessground's GPL-3.0 license (see Open Items) before this
   goes further — it's a real obligation, not a technicality.
2. The actual build screen: wire `build.ts`'s `playWhiteMove`/
   `playBlackMove`/etc. into the UI so a chosen opening leads to a real,
   playable (for White) build.
3. The Monte Carlo sim port from `rraney/nfl-dfs` — still needed, unchanged.
4. Simulated "Top 10%" metric — still a known gap.
5. If the engine changes, re-run `tools/export_parity.py` and `npm run
   test` to keep the parity fixture honest.

## Open Items

- **chessground's GPL-3.0 license, unresolved.** Its own README: "your
  combined work may be distributed only under the GPL. You must release
  your source code to the users of your website." Flagged to Ron in
  Task 34's report; no decision yet. See `sessions/1026/
  10142026-tasks-31-34-opening-setup-and-engine-speed.md`.
- **No real browser verification of the opening setup screen.** Tried to
  drive it with Playwright (no project "run" skill exists for this app
  yet); headless Chromium wouldn't launch — missing system library
  `libasound.so.2`, and installing it needs `sudo`, unavailable
  non-interactively here. Verified via the RTL/jsdom test suite only. Same
  log as above has the full detail; whoever has shell/sudo access to this
  environment should either install the missing lib or note it needs a
  different environment, then consider `/run-skill-generator` once
  running the app actually works.
- **`openingPreview`/`legalDepth` are slow (~49ms/call) and uncached.**
  Built in Tasks 17/27, untouched by Task 33's `findLegalMove` fix (they
  call `board.moves({ verbose: true })` directly, unscoped, per ply — and
  `openingPreview` calls `legalDepth` internally, walking the same line
  twice). Worked around at the UI layer only (`appData.ts`'s `previewFor`
  cache, a 3-char search minimum, a 20-result cap) — not fixed in the
  engine itself. Worth its own task if the explorer needs to scale further
  or the Monte Carlo sim ever calls either in a hot loop. Same log as
  above.
- `cloneBoard`'s PGN-round-trip clone (re-serializes/re-parses the whole
  game's move text on every move) — profiled in Task 33 and confirmed
  minor (~6–16% of a hot test's time, since it runs once per move applied,
  not once per candidate). Left as-is; a replay-based rewrite risked
  subtlety (non-default starting FEN via PGN's `[SetUp]`/`[FEN]` headers)
  for marginal gain. Revisit only if it becomes the bottleneck again (e.g.
  the Monte Carlo sim driving many simulated builds at volume).
- Chess.js has no public "resolve SAN without pushing" method, no public
  "is this shape a castle/capture independent of legality" check, no
  public clone-with-history method, and treats "capture" and "en passant"
  as disjoint move flags where python-chess treats a capture as a capture
  regardless — four workarounds live across `rules.ts`/`openings.ts`/
  `build.ts` (move-list matching by from/to, resolve-then-branch-on-the-
  matched-move, the PGN-round-trip `cloneBoard`, and `isCaptureMove`),
  each deliberately centralized. Worth remembering generally: chess.js's
  move-flag semantics don't always line up one-to-one with python-chess's.
- `build.ts`'s `playWhiteMove`/`resolvePlayers`/`applyResolvedPlayers`/
  `isMovePlayableForBlack`/`playBlackTemplateMove` all resolve a
  caller-supplied move via `findLegalMove` up front and throw a single
  generic "illegal move" error if it doesn't match any legal move at all
  — Python's originals inline shape checks that route to a more specific
  error instead. No test exercises this (every call site in
  `test_build.py` only ever passes already-legal moves) — untested,
  zero-observed-behavior-difference implementation detail.
- Task-numbering collision (a prior session reused "Task 20c" for two
  different pieces of work) and whether Ron intends to accept Scotch Game
  at rank 2 / drop King's Indian Defense from the "top 9": both still
  open, see `sessions/1026/10132026-pin-top-9-opening-ranks-test.md` and
  `sessions/1026/10132026-never-moved-captures-field-tiers-and-family-
  ranking.md`.
- `excluded_families` and the six tier-boundary numbers are still
  Python-level defaults/parameters on the Python side, not a config file —
  same logs as above.
- CLI wording for the Python CLI's opening-setup screen is still an
  unconfirmed guess, not confirmed UX — same logs as above.
- `openings.book_weights()`/`loaders.load_popularity()`/
  `data/openings/popularity.json` still have no engine caller (Python
  side).
- No dedicated `contest_type` (GPP/H2H) field in `ContestConfig` (the real
  per-contest `type`/prize-pool/etc. fields now live as unused "extra
  fields for later" in `config/contests.json`'s raw JSON — see Task 32's
  log — but aren't threaded into `ContestConfig` or its loader); pawn
  promotion's DFS classification unresolved; the `logs/` vs `sessions/`
  doc-process mismatch (CLAUDE.md's "Session log" section was removed
  entirely this cycle — actual practice is this `sessions/` structure,
  written only when `/wrap-up` is explicitly invoked); the `Top_Ten`
  sim-vs-postmortem distinction — all still open, carried forward
  unchanged across several sessions.
- Kings still structurally can never be captured as the King piece itself
  (checkmate ends the position first — emergent, not a bug).
- Full narrative detail for this session's four tasks (31: suggestOpening/
  randomOpening/contests.json; 32: the App shell's three setup steps; 33:
  the engine speed fix, profiled and measured before/after; 34: the
  opening setup screen, its chessground/GPL flag, and the browser-
  verification blocker): `sessions/1026/
  10142026-tasks-31-34-opening-setup-and-engine-speed.md`. Earlier logs in
  `sessions/1026/` for everything predating that.
