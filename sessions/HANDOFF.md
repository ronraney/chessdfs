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

- **180 Python tests passing, unchanged this session** — the Python engine
  itself is still untouched since the web port began; this session's work
  was entirely TypeScript/UI, no `engine/` files touched.
- **255 Vitest tests passing** (`npm run test`), `tsc -b`, `npm run build`,
  and `npm run lint` (oxlint) all clean.
- **Task 38b ("Match the designs") + a live-feedback follow-up** reworked
  the build screen to match the `design/` mockups (6 PNGs + 3 HTML
  references — still untracked, Ron's own planning input, left alone) and
  fixed two real bugs along the way. Two commits: `392cd9d` (the design
  match itself) and `4f5f4ae` (three clarity fixes from Ron actually
  running the screen). Full narrative:
  `sessions/1026/10142026-task-38b-match-designs-clarity-polish.md`.
- **`web/src/BuildScreen.tsx`**, current shape:
  - **Header**: small row — "Chess DFS" wordmark, a contest chip, a
    King-mode chip, `ThemeToggle`. Replaces the old large "Chess DFS" h1
    fallback.
  - **Opening banner**: driven by `chosenOpening` directly (not replayed
    board history), so it shows the right line before any move is played.
    Its own move list shows the chosen line's reference while still on
    it, or the actual played history once off it (or for "own opening"
    builds) — a small `▸` accent marker calls out the move that's
    actually next; nothing is opacity-faded anymore (reads as legible-but-
    muted, not disabled). Subtext is `"Now: <live name> · <eco>"` while on
    the chosen line, `"Left the line after <move>"` once off it.
  - **Book continues**: every chess-AND-DFS-legal continuation
    (`buildFlow.dfsLegalMoves` + `engine/openings.bookContinuations`),
    capped to 8 (`CONTINUATION_LIMIT` in `BuildScreen.tsx`, a guessed
    number, not a spec'd one), ranked by family rank
    (`appData.RANK_BY_FAMILY`, same ranking the Explorer uses), chosen
    line's own move always first. Each shows the move, the resulting
    opening's name, and which piece/salary band it locks
    (`buildStats.pieceBandLabel`, shared with the pick modal's subtitle).
    A plain instruction line sits above it: "Tap a move to play it, or
    drag a piece on the board."
  - **Pick modal** (`PickPanel.tsx`, fully rewritten from Task 38's
    always-open side panel): centered, dimmed overlay, bottom sheet
    ≤760px. Candidates are a fixed projection-descending sort (no more
    interactive column sorting — nothing tested that sort, so dropping it
    was a straight simplification). Clicking a row only selects it (live
    "After this pick: $X left · $Y / slot · Z open" footer); only "Lock
    player" commits.
  - **"Moves" section is gone** (folded into the opening banner, see
    above). **"Player | Field"** (the pick-by-pick White/Black pairing —
    not visible anywhere else) moved from the bottom of the page to right
    under the board/cards row, and now gets card styling like the rest
    of the main view.
- **Board rendering fixed** — `web/src/BoardSquares.tsx`/`.css` (new): the
  checkerboard is now 64 real `<div>` elements in a CSS grid, themed from
  `--board-light`/`--board-dark` — *not* a CSS gradient. The old gradient
  override in `index.css` tiled at half the board's actual resolution (a
  4×4 grid of diagonally-split tiles instead of an 8×8 checker), which was
  the root cause of both previously-reported bugs at once: the "wedge
  shapes" themselves, and a last-move highlight that looked offset (it was
  always correctly positioned by chessground's own pixel math — see
  `node_modules/@lichess-org/chessground/src/render.ts`'s `posToTranslate`
  — just drawn against a backdrop at the wrong scale/phase).
  `BuildBoard.tsx`/`BoardPreview.tsx` now render `BoardSquares` behind a
  transparent, absolutely-positioned chessground target inside the old
  `.build-board`/`.board-preview` frame (same class names, so existing
  selectors kept working). Separately, `BuildBoard` now actually passes
  `lastMove` to chessground, which it never did before — verified by a
  test asserting `config.lastMove` is `["e2","e4"]` after playing it. The
  checker-grid alignment itself is **not** eyeball-verified in a real
  browser by this session (see Open Items); the `lastMove` wiring is.
- **`@lichess-org/chessground`** still **GPL-3.0 licensed; still not
  decided whether that's acceptable** — the board now depends on it
  slightly less for visuals (own checker pattern, not
  `chessground.brown.css`'s) but just as much for drag mechanics and
  move-dest/selected/check square colors (still imported from
  `chessground.brown.css`).
- Everything else from the prior handoff is unchanged: `config/
  contests.json` is still the source for contests (no admin editing);
  `web/src/theme.ts`/`ThemeToggle.tsx` (Club/Slate, Task 36) untouched;
  `web/src/App.tsx`/`OpeningSetupScreen.tsx` (contest/King-mode picker,
  opening explorer) **deliberately left unrestructured this session** —
  see Open Items.

## Where We're Headed

1. Captures and castling as real, offerable White moves on the build
   screen — still the next build-screen task, unchanged since Task 38;
   this session's Book-continues ranking/capping logic assumes plain
   non-capture moves and will need a look once captures are added (see
   the design mockup's own "Bxc6 · ... captures the Field's TE" row,
   deliberately not implemented yet).
2. Decide on chessground's GPL-3.0 license.
3. The Monte Carlo sim port from `rraney/nfl-dfs` — still needed.
4. Simulated "Top 10%" metric — still a known gap.
5. Ron needs to create **`web/.env`** with his own `VITE_ADMIN_PASSWORD=...`
   — still not created, deliberately.
6. Whether the setup screens (`App.tsx`'s contest/King-mode step,
   `OpeningSetupScreen.tsx`'s explorer) should be restructured toward
   `design/`'s combined two-column mockup (`1-club-setup.png`/
   `2-slate-setup.png`) is an open question, not a confirmed next step —
   this session treated those PNGs as typography/color reference only,
   since Task 38b's own bullet list and tests were entirely build-screen-
   focused.
7. If the engine changes, re-run `tools/export_parity.py` and `npm run
   test` to keep the parity fixture honest.

## Open Items

- **This session itself did no real browser verification** — Ron did (a
  screenshot of an actual running build screen drove the live-feedback
  follow-up commit), but the checker-grid alignment fix rests on reading
  chessground's own positioning source, not an eyeballed screenshot of
  the fix itself. Still worth a real look once anyone has a working
  browser in this environment — same `libasound.so.2`/no-sudo gap as
  every prior session, not re-diagnosed here.
- **`design/`** (6 PNGs, 3 HTML files, `:Zone.Identifier` sidecars) and an
  older untracked session log (`10142026-tasks-36-38-themes-and-build-
  screen-rework.md`) remain uncommitted — left alone again this session;
  Ron's call whether `design/` belongs in version control.
- **Setup-screen restructuring** — open question, not started; see Where
  We're Headed #6.
- **`CONTINUATION_LIMIT = 8`** (Book continues' cap) is a guessed number,
  not spec'd — flag if it needs tuning either direction.
- **No "Back" navigation anywhere on the build screen** — still true,
  still unconfirmed either way; carried forward unchanged.
- **PLACED king mode's "silent King move while dragging" path still has
  no dedicated test** — unchanged; every current build-screen test uses
  EMERGE mode.
- **`VITE_ADMIN_PASSWORD` not yet set**; **admin login isn't persisted**
  across reload — both unchanged.
- **`openingPreview`/`legalDepth` are slow (~49ms/call) and uncached** at
  the engine level, worked around only at the UI layer — unchanged.
  Relatedly, `openings.book_weights()`/`loaders.load_popularity()`/
  `data/openings/popularity.json` still have no engine caller — this
  session's Book-continues ranking deliberately reused the already-loaded
  `RANK_BY_FAMILY` data instead of wiring that path in, to avoid adding a
  new data dependency for one feature.
- `cloneBoard`'s PGN-round-trip clone, chess.js's missing "resolve SAN
  without pushing"/capture-detection/clone-with-history APIs (four
  workarounds centralized in `rules.ts`/`openings.ts`/`build.ts`),
  `build.ts`'s generic "illegal move" error — all unchanged, same logs as
  before.
- Task-numbering collision ("Task 20c" reused), Scotch Game rank 2 /
  King's Indian Defense drop confirmation, `excluded_families` and the
  six tier-boundary numbers still hardcoded, CLI wording unconfirmed,
  `contest_type` field, pawn promotion's DFS classification, `logs/` vs
  `sessions/` doc-process mismatch, `Top_Ten` sim-vs-postmortem
  distinction, Kings structurally uncapturable (emergent) — all still
  open, all unchanged, carried forward across several sessions; see
  `sessions/1026/10132026-pin-top-9-opening-ranks-test.md` and
  `sessions/1026/10132026-never-moved-captures-field-tiers-and-family-
  ranking.md` for detail.
- Full narrative for this session: `sessions/1026/
  10142026-task-38b-match-designs-clarity-polish.md`. Prior same-day
  sessions: `sessions/1026/10142026-tasks-36-38-themes-and-build-screen-
  rework.md` (Tasks 36–38), `sessions/1026/10142026-task-35-hidden-admin-
  screen.md` (Task 35). Earlier logs in `sessions/1026/` for everything
  predating today.
