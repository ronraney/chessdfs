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
flow is upload-free: **contest → King mode → opening → build** — a hidden
admin screen handles the one CSV upload instead. Secrets
(`LICHESS_API_TOKEN`, `VITE_ADMIN_PASSWORD`) live in gitignored `.env` files,
never printed. Club (light) and Slate (dark) themes exist app-wide, CSS-
variable driven, with a header toggle.

**Environment note**: this session accessed the repo from Windows via the
`\\wsl.localhost\Ubuntu\...` UNC path. Every git/npm command needs
`wsl.exe -- bash -lc "cd ~/chess-dfs/... && ..."` — plain `npm run ...`
through the Windows-side Bash tool fails outright (npm spawns via `cmd.exe`,
which rejects the UNC working directory), and git needed a one-time
`git config --global --add safe.directory` exception (already applied).

## Where We Are

- **180 Python tests passing.** The Python engine itself is unchanged since
  the web port began — every web-port task so far has been additive,
  TypeScript-only, including this session's.
- **252 Vitest tests passing** (`npm run test`), `tsc -b`, `npm run build`,
  and `npm run lint` (oxlint) all clean.
- **`web/src/engine/`** covers the entire pure Python engine plus a few
  TS-only additions with no Python original: `suggestOpening`/
  `randomOpening` (openings.ts, pre-existing) and, new this session,
  `openingLine(moves, book): BookLine | null` (openings.ts) — `openingName`
  now just calls it and keeps `.name`; the build screen's opening banner
  needs the matching line's `eco` too, which `openingName` alone couldn't
  expose (see Task 37 below). Everything still proven against the 41-
  scenario parity harness (`tools/export_parity.py` + `web/src/engine/
  __fixtures__/parity.json` + `parity.test.ts`).
- **`web/src/App.tsx`** has four real screens:
  1. **Setup**: pick a contest preset, pick King mode (Let him emerge /
     Place your King now). Reads `players` from `loadSavedPlayers()`
     (`projectionsStore.ts`) — "No slate loaded yet." if nothing's saved.
  2. **Opening setup** (`OpeningSetupScreen.tsx`): pick-a-line screen —
     suggested card, tier chips, search, explorer (family list expands to
     variations), Random, "Play your own opening." **Bug fixed this
     session (Task 38)**: clicking a family row previously only expanded
     it — `onSelect` was never called for a bare family click, so
     "choosing a family" silently did nothing to the current selection.
     Now it calls `onSelect(family.line)` (the family's representative
     line `rankFamilies` already resolves correctly, e.g. Morphy Defense
     for Ruy Lopez, confirmed by `openings.test.ts`) *and* still toggles
     expand, in the same click.
  3. **Build** (`BuildScreen.tsx` — rewritten twice this session, Tasks 37
     then 38; see below for the current design). Reachable after choosing
     an opening.
  4. **Admin** (`#/admin` only, no link anywhere else): CSV upload gate
     behind `VITE_ADMIN_PASSWORD` (client-side only, not real access
     control), "Clear projections."
  - `web/src/theme.ts` + `ThemeToggle.tsx`: Club (light) / Slate (dark),
    explicit choice in `localStorage` (`chess-dfs:theme`), default follows
    `prefers-color-scheme` live when there's no explicit choice. Every
    screen's header carries the toggle. All colors/fonts/board-squares are
    CSS variables in `web/src/index.css`.
  - `config/contests.json` still the source for contests; no admin editing
    of contests.
  - `@lichess-org/chessground` now does double duty: `BoardPreview.tsx`
    (view-only, used by the opening-setup screen) and the new
    `BuildBoard.tsx` (interactive — White drags, Task 38). Still **GPL-3.0
    licensed; still not decided whether that's acceptable** — flagged
    again this session since the build screen now depends on it far more
    heavily than a static preview.
  - Tests: React Testing Library + jsdom throughout, per-file opt-in (see
    any test file's own header comment for why). `OpeningSetupScreen.
    test.tsx` (7), `AdminScreen.test.tsx` (6), `App.test.tsx` (9),
    `ThemeToggle.test.tsx` (5), `buildStats.test.ts` (7), `buildFlow.
    test.ts` (11), `BuildScreen.test.tsx` (5) — the last one mocks
    `@lichess-org/chessground` outright (jsdom has no real layout engine,
    so chessground's pixel-based drag detection is unreachable here; see
    Open Items) and drives real, unmocked `BuildScreen`/engine code
    through a `simulateMove(orig, dest)` helper that calls the captured
    `movable.events.after` directly, same as a real drop eventually would.

### The build screen, current design (post–Task 38)

Arrives on an empty interactive board with both side columns visible, no
pick panel. A suggestion banner shows either the chosen opening line's next
White move (an arrow on the board + "Suggested: `<move>` · `<line name>`" +
"Play it") while White is still on that line, or every book continuation
from the current position by name (each individually clickable) once
White's left it, or nothing once truly out of book. "Play your own opening"
gets the identical flow with no suggestions at all.

White drags a legal (chess-AND-DFS-legal; captures/castling excluded
outright "for now," per Task 38's own wording — next task adds them) piece;
the move is **not** committed to the engine yet — the board shows a preview
FEN (current state + the tentative move, via a throwaway chess.js clone)
while a side panel (`PickPanel.tsx` — a true side panel on wide screens,
bottom sheet ≤760px) opens beside it, listing eligible players for the
moved piece (sortable by any column, "after this pick" salary preview).
Confirming a pick commits the move for real and schedules Black's reply
600ms later via `build.playBlackMove` (Black commits to a book line while
White stays on it, re-chooses the moment White deviates — entirely the
engine's own existing logic, not special-cased here) plus one `SeededRandom`
generated fresh per build and held stable for its whole lifetime. Cancel
just drops the pending move — the preview FEN snaps back to the real
committed state on its own, no engine-level undo needed. There's no "Line
complete" ending anymore; play just continues past wherever the chosen line
runs out.

- **Not yet built**: captures/castling as offerable White moves (explicitly
  next); any free-play ending/dead-end UI (if Black ever has zero legal
  moves, `BuildScreen.tsx` currently catches that and silently no-ops —
  flagged, not handled); the Monte Carlo sim; any admin editing of
  contests; a CLI on the TS side.

## Where We're Headed

1. Captures and castling as real, offerable White moves on the build
   screen — explicitly the next build-screen task per Task 38's own
   wording ("castling and capture moves by White are not offered as legal
   targets (next task adds them)").
2. Decide on chessground's GPL-3.0 license — now a heavier dependency than
   before (interactive board, not just a static preview).
3. The Monte Carlo sim port from `rraney/nfl-dfs` — still needed, unchanged.
4. Simulated "Top 10%" metric — still a known gap.
5. Ron needs to create **`web/.env`** with his own `VITE_ADMIN_PASSWORD=...`
   — still not created, deliberately (no secret invented on his behalf);
   covered by the root `.gitignore`'s bare `.env` pattern already.
6. If the engine changes, re-run `tools/export_parity.py` and `npm run
   test` to keep the parity fixture honest.

## Open Items

- **Still no real browser verification of any screen.** Re-confirmed again
  this session: `libasound.so.2` is absent system-wide, no sudo available,
  and even `apt-get install --dry-run`'s simulation fails on an unrelated
  Docker keyring conflict. Whoever next has shell/sudo access to this
  environment should fix it, not re-diagnose it. See `sessions/1026/
  10142026-tasks-36-38-themes-and-build-screen-rework.md`.
- **No "Back" navigation exists anywhere on the build screen**, across both
  the Task 37 and Task 38 rewrites — the old placeholder had one; neither
  task's prompt said to keep or drop it. Flagged twice now, still
  unconfirmed either way. Same log as above.
- **PLACED king mode's "silent King move while dragging" path has no
  dedicated test** — every current build-screen test uses EMERGE mode. The
  code path exists (mirrors Task 14's "later King moves lock no player"
  rule) but is currently unexercised by anything that runs. Same log.
- **A new, untracked `design/` directory appeared this session**
  (Club/Slate build-screen mockup PNGs + HTML, with the same
  `:Zone.Identifier` sidecar files already seen on the sample CSVs) — looks
  like Ron's own planning reference, not created by this session. Left
  alone, not committed. Same log.
- **`VITE_ADMIN_PASSWORD` not yet set** — `web/.env` doesn't exist yet; the
  admin screen is unusable in dev/build until Ron adds it. Tests don't
  depend on it (`vi.stubEnv` instead).
- **Admin login isn't persisted** across a reload or leaving/returning to
  `#/admin` in the same session — unspecified either way.
- **`openingPreview`/`legalDepth` are slow (~49ms/call) and uncached** at
  the engine level — worked around at the UI layer only (`appData.ts`'s
  `previewFor` cache, a 3-char search minimum, a 20-result cap). The
  explorer's "select All families" interaction now visibly costs ~12–14s
  in its own test for exactly this reason. Worth its own task if it needs
  to scale further.
- `cloneBoard`'s PGN-round-trip clone — profiled, confirmed minor. Left as-is.
- Chess.js has no public "resolve SAN without pushing," "is this shape a
  castle/capture independent of legality," clone-with-history, or capture-
  vs-en-passant-unification API — four workarounds live across `rules.ts`/
  `openings.ts`/`build.ts`, each deliberately centralized.
- `build.ts`'s `playWhiteMove`/`resolvePlayers`/etc. throw a single generic
  "illegal move" error where Python's originals route to a more specific
  one — untested, zero-observed-behavior-difference implementation detail.
- Task-numbering collision (a prior session reused "Task 20c" twice) and
  whether Ron intends to accept Scotch Game at rank 2 / drop King's Indian
  Defense from the "top 9": both still open — see `sessions/1026/
  10132026-pin-top-9-opening-ranks-test.md` and `sessions/1026/
  10132026-never-moved-captures-field-tiers-and-family-ranking.md`.
- `excluded_families` and the six tier-boundary numbers are still
  Python-level defaults/parameters, not a config file — same logs as above.
- CLI wording for the Python CLI's opening-setup screen is still an
  unconfirmed guess, not confirmed UX — same logs as above.
- `openings.book_weights()`/`loaders.load_popularity()`/
  `data/openings/popularity.json` still have no engine caller (Python side).
- No dedicated `contest_type` (GPP/H2H) field in `ContestConfig`; pawn
  promotion's DFS classification unresolved; the `logs/` vs `sessions/`
  doc-process mismatch; the `Top_Ten` sim-vs-postmortem distinction — all
  still open, carried forward unchanged across several sessions.
- Kings still structurally can never be captured as the King piece itself
  (checkmate ends the position first — emergent, not a bug).
- Full narrative detail for this session (Tasks 36–38: theming, the
  template-play build screen, then its move-first-then-pick/suggestion-only
  rework, the ECO-exposure engine addition, two bug fixes): `sessions/1026/
  10142026-tasks-36-38-themes-and-build-screen-rework.md`. Earlier same-day
  session (Task 35): `sessions/1026/10142026-task-35-hidden-admin-screen.md`.
  Earlier logs in `sessions/1026/` for everything predating today.
