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
the `AskUserQuestion` tool — ask any question inline, as plain text, instead.
Python 3.11+, stdlib + pytest + `python-chess` for the original engine;
`web/` is a Vite + React + TypeScript app (Node v24, npm) built alongside
it. The TS port of the engine is complete, with a standing parity harness
proving it matches Python on real, deterministic scenarios. The UI's player
flow is now upload-free: **contest → King mode → opening** — a hidden admin
screen handles the one CSV upload instead (see below). Secrets
(`LICHESS_API_TOKEN`, `VITE_ADMIN_PASSWORD`) live in gitignored `.env` files,
never printed.

**Environment note**: this session accessed the repo from Windows via the
`\\wsl.localhost\Ubuntu\...` UNC path. Two consequences worth knowing up
front: (1) git needed a one-time `git config --global --add safe.directory`
exception for that path (already applied) or every git command fails with
"detected dubious ownership"; (2) `npm` cannot be invoked directly through
that path — it spawns via `cmd.exe`, which rejects UNC working directories
outright. Every `npm run ...` in this session went through
`wsl.exe -- bash -lc "cd ~/chess-dfs/web && npm run ..."` instead.

## Where We Are

- **180 Python tests passing.** The Python engine itself is unchanged since
  the web port began — every web-port task so far has been additive,
  TypeScript-only.
- **218 Vitest tests passing** (`npm run test`), `tsc -b`, `npm run build`,
  and `npm run lint` (oxlint) all clean.
- **`web/src/engine/`** covers the entire pure Python engine plus
  TS-only additions with no Python original (`suggestOpening`/
  `randomOpening` in `openings.ts`), proven against a 41-scenario parity
  harness (`tools/export_parity.py` + `web/src/engine/__fixtures__/
  parity.json` + `parity.test.ts`). Untouched this session.
- **`web/src/App.tsx`** now has four real screens:
  1. **Setup** (Task 32, upload removed Task 35): pick a contest preset
     (name/entries/buy-in/field tier shown), pick King mode (Let him
     emerge / Place your King now, with a QB picker in Placed mode —
     Black's QB auto-derived as the highest-projection QB other than
     White's pick). Reads its player list via `players` state, initialized
     from `loadSavedPlayers()` (see `projectionsStore.ts` below) — if
     nothing is saved (or it fails to parse), the whole setup is replaced
     by a single "No slate loaded yet." message.
  2. **Opening setup** (Task 34, `OpeningSetupScreen.tsx`): unchanged this
     session.
  3. **Build placeholder**: unchanged this session.
  4. **Admin** (Task 35, new, `AdminScreen.tsx`): reachable only at the
     `#/admin` hash — no link to it exists anywhere else in the app.
     Routing lives in `App.tsx`: an `isAdminRoute` state flag, flipped by a
     single `hashchange` listener (the listener also re-reads the saved
     player list on the way back to the main flow, so an upload or a clear
     made on `#/admin` shows up immediately without a page reload). Gated
     by a password form compared against `import.meta.env.VITE_ADMIN_PASSWORD`
     — **client-side only**: the comparison runs in browser JS against a
     value baked into the built bundle, so it keeps the screen out of
     casual reach but is not real access control; anyone reading the
     shipped JS can recover the password or bypass the check. Once authed:
     upload the projections CSV (`loadEtrCsv`, same engine loader the
     player screens use), shows the player count or a clear parse error,
     a "Clear projections" button. Auth state is plain component state —
     not persisted across a reload or a round-trip through `#/admin`.
  - **`web/src/projectionsStore.ts`** (new, Task 35): three functions
    around `window.localStorage` (key `"chess-dfs:projections-csv"`) —
    `getSavedProjectionsCsv`/`saveProjectionsCsv`/`clearProjectionsCsv`.
    Stores the raw CSV text, not parsed players — `loadEtrCsv` is re-run
    wherever it's read, so there's one parse path for both the admin's
    count and the player screens' data.
  - `config/contests.json` (Task 31/32) still the source for contests;
    no admin editing of contests yet (explicitly out of scope for Task 35).
  - `@lichess-org/chessground` renders the board preview — **GPL-3.0
    licensed; still not decided whether that's acceptable for this
    product** (see Open Items, unchanged).
  - Tests: React Testing Library + jsdom. `App.test.tsx` (8 tests, rewritten
    Task 35 — seeds player state via `saveProjectionsCsv` directly instead
    of a file-upload interaction, plus two admin-routing integration
    tests), `OpeningSetupScreen.test.tsx` (5 tests, unchanged),
    `AdminScreen.test.tsx` (5 tests, new). `testFixtures.ts` (new) factors
    out the shared sample-CSV-file helper both App and AdminScreen tests
    use.
- **Not yet built**: the actual build screen (playing moves, locking
  players, in the UI); the Monte Carlo sim; a CLI on the TS side (if ever
  wanted); any admin editing of contests.

## Where We're Headed

1. Ron needs to create **`web/.env`** with his own `VITE_ADMIN_PASSWORD=...`
   — not created this session, deliberately (no secret was invented on his
   behalf). It's covered by the root `.gitignore`'s bare `.env` pattern
   already (verified via `git check-ignore`), so no gitignore change is
   needed once he adds it.
2. Decide on chessground's GPL-3.0 license (see Open Items) before this
   goes further — it's a real obligation, not a technicality.
3. The actual build screen: wire `build.ts`'s `playWhiteMove`/
   `playBlackMove`/etc. into the UI so a chosen opening leads to a real,
   playable (for White) build.
4. The Monte Carlo sim port from `rraney/nfl-dfs` — still needed, unchanged.
5. Simulated "Top 10%" metric — still a known gap.
6. If the engine changes, re-run `tools/export_parity.py` and `npm run
   test` to keep the parity fixture honest.

## Open Items

- **`VITE_ADMIN_PASSWORD` not yet set.** See "Where We're Headed" above —
  `web/.env` doesn't exist yet; the admin screen is unusable in dev/build
  until Ron adds it. Tests don't depend on it (`vi.stubEnv` instead). See
  `sessions/1026/10142026-task-35-hidden-admin-screen.md`.
- **Admin login isn't persisted** across a reload or leaving/returning to
  `#/admin` in the same session — unspecified either way, revisit if
  that's annoying in practice. Same log as above.
- **`/start` didn't appear as a slash command** at the start of this
  session even though the skill file (`'.claude/skills/start/SKILL.md'`)
  is correctly formed and identical in shape to `wrap-up`'s. Likely a
  stale skill-list scan from before that directory existed (added Oct 13,
  two days after `wrap-up`) — a window reload should fix it. Not
  independently confirmed; worth a closer look if it recurs. Same log as
  above.
- **This environment needs `wsl.exe -- bash -lc "cd ~/chess-dfs/... && ..."`
  for any `npm` command**, not just git — `npm` spawns via `cmd.exe`,
  which rejects the UNC working directory outright. Plain `npm run ...`
  through the Windows-side Bash tool fails immediately. Same log as above.
- **chessground's GPL-3.0 license, unresolved.** Its own README: "your
  combined work may be distributed only under the GPL. You must release
  your source code to the users of your website." Flagged to Ron in
  Task 34's report; no decision yet. See `sessions/1026/
  10142026-tasks-31-34-opening-setup-and-engine-speed.md`.
- **No real browser verification of any screen.** Tried to drive the app
  with Playwright during Task 34; headless Chromium wouldn't launch —
  missing system library `libasound.so.2`, and installing it needs `sudo`,
  unavailable non-interactively here. Verified via the RTL/jsdom test suite
  only. Whoever has shell/sudo access to this environment should either
  install the missing lib or note it needs a different environment, then
  consider `/run-skill-generator` once running the app actually works.
- **`openingPreview`/`legalDepth` are slow (~49ms/call) and uncached.**
  Built in Tasks 17/27, untouched since. Worked around at the UI layer only
  (`appData.ts`'s `previewFor` cache, a 3-char search minimum, a 20-result
  cap) — not fixed in the engine itself. Worth its own task if the explorer
  needs to scale further or the Monte Carlo sim ever calls either in a hot
  loop. See `sessions/1026/10142026-tasks-31-34-opening-setup-and-engine-speed.md`.
- `cloneBoard`'s PGN-round-trip clone — profiled in Task 33 and confirmed
  minor (~6–16% of a hot test's time). Left as-is; revisit only if it
  becomes the bottleneck again (e.g. the Monte Carlo sim driving many
  simulated builds at volume).
- Chess.js has no public "resolve SAN without pushing" method, no public
  "is this shape a castle/capture independent of legality" check, no
  public clone-with-history method, and treats "capture" and "en passant"
  as disjoint move flags where python-chess treats a capture as a capture
  regardless — four workarounds live across `rules.ts`/`openings.ts`/
  `build.ts` (move-list matching by from/to, resolve-then-branch-on-the-
  matched-move, the PGN-round-trip `cloneBoard`, and `isCaptureMove`),
  each deliberately centralized.
- `build.ts`'s `playWhiteMove`/`resolvePlayers`/`applyResolvedPlayers`/
  `isMovePlayableForBlack`/`playBlackTemplateMove` all resolve a
  caller-supplied move via `findLegalMove` up front and throw a single
  generic "illegal move" error if it doesn't match any legal move at all
  — Python's originals inline shape checks that route to a more specific
  error instead. No test exercises this — untested, zero-observed-
  behavior-difference implementation detail.
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
- No dedicated `contest_type` (GPP/H2H) field in `ContestConfig`; pawn
  promotion's DFS classification unresolved; the `logs/` vs `sessions/`
  doc-process mismatch; the `Top_Ten` sim-vs-postmortem distinction — all
  still open, carried forward unchanged across several sessions.
- Kings still structurally can never be captured as the King piece itself
  (checkmate ends the position first — emergent, not a bug).
- Full narrative detail for this session (Task 35: admin screen, upload
  removal, the oxlint `set-state-in-effect` fix, the WSL/UNC git + npm
  environment notes): `sessions/1026/10142026-task-35-hidden-admin-screen.md`.
  Prior session (Tasks 31–34): `sessions/1026/
  10142026-tasks-31-34-opening-setup-and-engine-speed.md`. Earlier logs in
  `sessions/1026/` for everything predating that.
