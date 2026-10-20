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
screen) → build → finish**. A hidden admin screen (`#/admin`) handles the
one CSV upload instead, with real slate validation. Secrets
(`LICHESS_API_TOKEN`, `VITE_ADMIN_PASSWORD`) live in gitignored `.env`
files, never printed. Club (light) and Slate (dark) themes exist app-wide,
CSS-variable driven, with a header toggle.

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

**Captures are always legal (rule change, 2026-10-19), in both engines and
the TS UI**: a historied transfer that would overflow the capturing side's
roster/salary no longer blocks the capture — the captured player instead
leaves the opposing side and returns to the pool (available to either
side), and the capturing piece locks no one. An unmoved-piece capture with
no fitting replacement works the same way: still legal, locks no one.
`apply_capture_move`/`applyCaptureMove` decide transfer-vs-return-to-pool
internally; they no longer raise for either case. The TS UI shows a notice
in the existing status-line spot when a capture returns someone to the
pool (`"<SAN>: <Name> (<POS>) doesn't fit <your/the Field's> roster. He
returns to the pool."`), for both White's and Black's own captures.

**TS UI now explains blocked moves**: `dests` (BuildBoard's drag
destinations) includes every legal chess move, not just the DFS-legal
ones — dropping on a move that's legal chess but blocked by the DFS rules
still refuses to commit, with the engine's own reason in the status line
(`buildFlow.blockedMoveReason`, covering every ordinary-move and castling
block reason in the real `canCastle`/pick-list check order). A capture of
an unmoved piece whose own pick list comes up empty now auto-resolves
(locks no one) instead of opening a pick modal with nothing to pick.

**DK roster slots are a separate concept from pieces, computed on demand**:
`assignRosterSlots`/`assign_roster_slots` (`engine/rules.ts`/
`dfs_chess/rules.py`) takes a locked roster and returns which named DK slot
(QB/RB/WR/TE/FLEX/DST) each player occupies, via Kuhn's-algorithm bipartite
matching. Shown on the finish screen and in "Copy lineup" as a "Slot"
column. `engine/optimizer.ts`'s exact lineup solver is a second, separate
consumer of `sport.rosterSlots` — `assignRosterSlots` only proves a roster
*can* be completed and picks *some* valid assignment; it has no notion of
"best." The optimizer uses **`yalps`** (small, pure TypeScript LP/MILP
solver, MIT-licensed, no WASM) — the same library `rraney/nfl-dfs`'s own
Google Apps Script field-generation sim vendors, for the same job (one
LP solve per sampled lineup, ownership-biased objective).

**Environment note**: accessed from Windows via the
`\\wsl.localhost\Ubuntu\...` UNC path. Every git/npm command needs
`wsl.exe -- bash -lc "cd ~/chess-dfs/... && ..."` — plain `npm run ...`
through the Windows-side Bash tool fails outright (npm spawns via `cmd.exe`,
which rejects the UNC working directory). git needed a one-time
`git config --global --add safe.directory` exception (already applied).
**jsdom (this project's entire test environment) runs no CSS layout
engine**: `getBoundingClientRect`/`offsetWidth`/`scrollWidth` are always 0
regardless of the real stylesheet, and `getComputedStyle` never evaluates
`@media` queries at all; it also has **no `ResizeObserver` at all**
(`test-setup.ts` stubs a no-op one). Any future task asking for a
rendered-layout/viewport-geometry test needs either a real browser (still
not launchable here — Playwright's cached Chromium fails on missing
`libasound.so.2`, no sudo to install it) or a mechanism/DOM-structure test
instead, clearly labeled as such.

**A growing list of real-chessground/real-engine `userEvent` tests sit
close to Vitest's 5000ms default timeout under full-suite parallel load**
(this machine: ~23 vitest workers on 8 cores). Each occurrence so far has
been genuine, not a removable inefficiency, and fixed the same way: an
explicit per-test timeout (15000–20000ms) matching the test's own real
cost — this session bumped one pre-existing `BuildScreen.test.tsx` inner
`waitFor` (2000ms → 5000ms; it has its OWN timeout independent of the
outer `it()`'s) after it surfaced flaky under `npm run test`'s plain
default. `npx vitest run --testTimeout=20000` remains the belt-and-
suspenders form when a clean count absolutely must not flake.

## Where We Are

- **237 pytest passing, 409 npm test passing** — confirmed stable across
  repeated full-suite runs (`npm run test` and `npx vitest run
  --testTimeout=20000`, 3× each).
- **One commit this session, pushed to `origin/main`**: **`eac7732`**
  ("Rule change — Captures that don't fit; explain blocked moves"). See
  "Captures are always legal" and "TS UI now explains blocked moves"
  above for the behavior; touched `dfs_chess/{rules,build,cli}.py`,
  `tests/{test_rules,test_cli}.py`, `tools/export_parity.py` (+2 new
  parity scenarios, fixture regenerated), and the TS mirrors
  (`engine/{rules,build}.ts`, `buildFlow.ts`, `BuildScreen.tsx`, their
  test files, `buildFlow.test.ts` new). Along the way: fixed a real bug
  the rule change would otherwise have introduced in `cli.py`'s capture
  message (it read the capturing side's *last move*, which is wrong once
  a capture can legally lock no one); consolidated `BuildScreen`'s
  `dests`/`legalMoves` to share one chess.js move-generation call instead
  of two. Castling-block wording (4 of the 7 reasons weren't given
  verbatim by the prompt) confirmed fine as written by Ron; no end-to-end
  `BuildScreen` test added for the return-to-pool notice or the
  captureUnmoved-auto-resolve path — Ron confirmed not needed (covered
  already at the engine level in both languages).
- **Separately, a read-only sizing report** (no code changes, nothing
  committed) on porting `rraney/nfl-dfs`'s Monte Carlo sim into
  `web/src/engine` as pure TS — full findings in this session's own log
  (see below). Headline: the real engine (outcome draws + latent-factor
  correlation + MILP field generation + trial loop/scoring) is pure math
  over plain objects already, no Node/GAS-only APIs in it; most of the
  15,430 sim-file lines are calibration/diagnostic tooling, not runtime
  code. Proposed as 6 one-prompt tasks (outcome draw → correlation engine
  → field gen → trial loop/scoring → UI wiring → calibration parity
  test). Chess-dfs's ETR data already covers what the sim's core needs
  (Floor/Proj/Ceiling, ownership, Team/Opp); missing: Vegas total/spread,
  dome flag, weather — all gracefully defaultable, none block a first
  working port. `ContestConfig.payouts` already gives the payout-curve
  lookup the sim needs.

## Where We're Headed

1. **Real-browser verification** — still the standing, unresolved gap: no
   browser can launch in this environment at all. Growing list of
   CSS-only and interaction changes that need a real device/browser pass.
2. **Monte Carlo sim port from `rraney/nfl-dfs`** — sizing/scoping done
   this session (see "Where We Are" and this session's log); not started.
   Pick Task 1 (outcome-draw module) next, or confirm/adjust the 6-task
   breakdown first if Ron wants changes.
3. Simulated "Top 10%" metric — still a known gap (distinct from the
   `Top1`/`Top10` real-contest-result tiers found in `rraney/nfl-dfs`'s
   separate postmortem pipeline — not the same thing, not sim output
   there either).
4. Ron needs to create **`web/.env`** with his own
   `VITE_ADMIN_PASSWORD=...` — still not created, deliberately.
5. `CONTINUATION_LIMIT = 8` (Book continues' cap) is still a guessed
   number, not spec'd — flag if it needs tuning either direction.
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
  questions that don't necessarily have the same answer** (prior
  session) — unchanged: "should this family ever be *suggested* as a
  named opening" vs. "how should this move be *ordered* in Book
  continues relative to others." Unconfirmed either way.
- **`yalps` (the lineup optimizer's MILP solver) is a runtime dependency**
  (prior session) — unchanged, not yet separately reviewed by Ron beyond
  its own commit message's justification. (Note: this session found the
  same library is already proven out server-side in `rraney/nfl-dfs`'s
  own field-generation sim — not a new or unusual choice.)
- **The dominance-pruning pre-pass in `engine/optimizer.ts`** (prior
  session) — unchanged, still flagged as worth a second pair of eyes.
- **Points from optimal's display hasn't been seen in a real browser**
  (prior session) — unchanged, standing limitation.
- **DST lost Queen eligibility** (prior session) — unchanged, still
  unconfirmed whether wanted as a permanent rule.
- **The pick modal's "greyed out, infeasible" row display is dead code
  in practice** (prior session) — unchanged, left in place defensively.
- **Click-to-move's real root cause for a *first*-move failure is still
  genuinely unconfirmed** (prior session) — unchanged.
- **`assignRosterSlots`/`validate_etr_csv`/`engine/optimizer.ts` aren't in
  the parity harness** (prior session) — unchanged, each for its own
  reason (optimizer has no Python equivalent at all).
- **Which interchangeable player draws "FLEX" vs. its own dedicated slot
  is a cosmetic artifact** of `assignRosterSlots`'s matching search (prior
  session) — unchanged.
- **`openings.py`'s `_piece_eligible_positions`/TS equivalent had a real
  bug fixed two sessions ago but with no dedicated new test** (prior
  session) — unchanged.
- **"Stop with this core" sits in the same place at every screen width**
  (prior session) — unchanged, not confirmed either way.
- **`data/samples/repro-slate.csv`** stays on disk, deliberately
  uncommitted. **`data/samples/"NFL Weekly DFS System - Projections/
  Sim_Contest.csv"`** and **`design/`** also remain uncommitted — Ron's
  call, untouched this session (seen in `git status` at session start,
  left as-is).
- **No "Back" navigation to the PREVIOUS screen** — still a known gap.
- **`openingPreview`/`legalDepth` are slow (~49ms/call) and uncached** at
  the engine level (prior session) — unchanged.
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
- Full narrative for this session: `sessions/1026/10192026-captures-dont-
  fit-blocked-moves-and-sim-port-sizing.md`. Prior sessions in
  `sessions/1026/` for everything predating today.
