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

**DK roster slots are a separate concept from pieces, computed on demand**:
`assignRosterSlots`/`assign_roster_slots` (`engine/rules.ts`/
`dfs_chess/rules.py`) takes a locked roster and returns which named DK slot
(QB/RB/WR/TE/FLEX/DST) each player occupies, via Kuhn's-algorithm bipartite
matching. Shown on the finish screen and in "Copy lineup" as a "Slot"
column. **This session added a second, separate consumer of `sport.
rosterSlots`**: `engine/optimizer.ts`'s exact lineup solver (see below) —
`assignRosterSlots` only proves a roster *can* be completed and picks
*some* valid assignment; it has no notion of "best."

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
(`test-setup.ts` now stubs a no-op one, since `BuildBoard.tsx` constructs a
real one on mount — see this session's Task below). Any future task asking
for a rendered-layout/viewport-geometry test needs either a real browser
(still not launchable here — Playwright's cached Chromium fails on missing
`libasound.so.2`, no sudo to install it) or a mechanism/DOM-structure test
instead, clearly labeled as such.

**A growing list of real-chessground/real-engine `userEvent` tests sit
close to Vitest's 5000ms default timeout under full-suite parallel load**
(this machine: ~23 vitest workers on 8 cores when running the full suite —
confirmed via `/proc/loadavg`/`nproc` this session). Each occurrence so far
has been genuine, not a removable inefficiency — confirmed via isolated
timing runs — and fixed the same way: an explicit per-test timeout (15000–
20000ms) matching the test's own real cost. **This session added three more
occurrences** (see the Lineup Optimizer task below) after a new, small
per-render computation tipped previously-comfortable tests over the
default; **one of those three turned out to be a genuine, fixable
inefficiency instead** (a redundant full book-array rescan on every render,
in the Template/Continuations task below) — worth checking for an actual
fix before reaching for a timeout bump, since a bump alone doesn't reduce
real CPU cost system-wide, it just hides it in one spot. `npx vitest
run --testTimeout=20000` remains the belt-and-suspenders form when a clean
count absolutely must not flake.

## Where We Are

- **GPL-3.0 is accepted, decided 2026-10-14**, covering both GPL-3.0
  dependencies in this repo: chessground (previously an open item above)
  and Stockfish (`stockfish` npm package, added this session for Black's
  out-of-book move — see web/src/stockfishEngine.ts). No further license
  decision needed for either.
- **387 Vitest tests passing, 233 pytest passing**, `tsc -b` and `oxlint`
  both clean (re-confirmed after each of this session's three commits,
  full `npm run test` re-run 3+ times per commit to rule out flakes under
  full-suite parallel load).
- **Three commits this session**, all pushed to `origin/main`:

  1. **`8121748`** ("Rule change — Board clicks land one square off").
     Bug: chessground memoizes its own board bounds and only recomputes
     them from inside `redrawAll()`; a layout shift above/around the board
     (status line length, banner, Book continues, pick panel width) moved
     the real board element without chessground finding out, so clicks
     landed against stale bounds. Fix (`BuildBoard.tsx`): a `ResizeObserver`
     on the board's own container (catches size changes) plus a second
     effect with no dependency array that calls `redrawAll()` after every
     render (catches a pure position shift from a sibling, which a
     `ResizeObserver` can't see — relies on `BuildBoard` re-rendering
     whenever `BuildScreen` does, since it isn't memoized). **Finding**:
     chessground already runs its own internal `ResizeObserver` on the
     same container (`events.ts`'s `bindDocument`) for a lighter bounds-
     cache clear — the added one is partly redundant with it for pure size
     changes, kept anyway since the task named it explicitly; the no-dep
     effect is what actually closes the real gap. jsdom can't verify real
     bounds/positioning (only that the wiring fires) — unverified in a
     real browser, same standing limitation as everything else below.
  2. **`dfbd7ca`** ("Rule change — Lineup optimizer + points from
     optimal"). New `engine/optimizer.ts`: the best legal DK Classic
     lineup by total projection, subject to `sport.rosterSlots` (FLEX
     handled generically, no special-casing) and a salary cap, with
     optional locked/excluded players. Modeled as a 0/1 MILP (one binary
     variable per eligible player/slot pair) and solved exactly by
     **`yalps`** (new dependency — small, pure TypeScript, no WASM — named
     per the task's own "you may add one small LP/ILP dependency"
     allowance). A real ~300-player slate took 2.3s to solve naively; a
     dominance-pruning pre-pass (provably safe — see the module's own
     comment for the proof) cut that to ~180ms with an identical answer;
     a `WeakMap` cache (keyed by the `players` array's own identity, same
     pattern `rules.ts`'s `findLegalMove` cache uses for a board) then
     makes "slate optimal" (no locks, no exclusions) a true compute-once-
     per-slate/contest cost. "Best completion" (locks forced, Black's
     picks excluded) recomputes in a few ms per pick. **Deviation flagged**:
     the task suggested dropping 0-projection players as the performance
     lever; the real sample slate has none, so dominance pruning (strictly
     more general) was used instead. `BuildScreen.tsx`'s White panel (under
     Core projection) and the finish screen both show "Pts from optimal"
     (`buildStats.ts`'s `pointsFromOptimal`), "—" if either solve is ever
     infeasible. Python engine untouched — display feature, not a rule.
  3. **`d09e81e`** ("Rule change — Black follows the chosen template;
     continuations by real popularity"). Two bugs reported together, both
     traced to Task 38's "line only suggests White's moves" rewrite, which
     swapped Black's driver to `playBlackMove` but never seeded
     `BuildState.blackCommittedLine` from the user's chosen opening —
     Black re-chose by rank-closeness on its very first reply, every
     build, regardless of what White chose. **Fix 1**: `BuildScreen.tsx`'s
     initial state now seeds `blackCommittedLine` from `chosenOpening.line.
     moves` when the user picked a specific "line" (not "own opening") —
     no engine change needed, `playBlackMove`'s own existing "keep the
     committed line while it matches, re-choose once it doesn't" logic
     does the rest. **Fix 2**: "Book continues" sorted by `RANK_BY_FAMILY`
     alone — a whole-family, whole-corpus popularity rank, not how often a
     move is actually played *from this position* — letting a real,
     heavily-played reply (e.g. 2. Nf3 after 1. e4 e5) rank `Infinity`
     whenever its family was `DEFAULT_EXCLUDED_FAMILIES` or lacked a ≥6-ply
     representative line, pushing it past the top-8 cut. `data/openings/
     popularity.json` (real per-position Lichess game counts) was already
     vendored and loaded by `loaders.ts` but never wired to anything
     (flagged dead in last session's handoff) — `appData.ts` now exports
     it as `POPULARITY`; the continuation sort uses it as the primary key,
     family rank only as a tiebreak. **Hypothesis assessment** (user's own,
     given with the bug report): partly confirmed — Black's template
     commitment being dropped, and Black's own choice being ordered by
     rank-closeness, are both exactly right; "the continuations list
     ordered by closeness to target rank" is rejected as literally stated
     (`targetRank` never appears in that sort), though the list's actual
     bug produces the same visible symptom. No Python changes — the CLI's
     own template mode already drives Black correctly via
     `play_black_template_move`; "Book continues" has no CLI equivalent.

## Where We're Headed

1. **Real-browser verification** — still the standing, unresolved gap: no
   browser can launch in this environment at all. Growing list of CSS-only
   and interaction changes that need a real device/browser pass (mobile
   responsiveness, Explorer row wrapping, piece-icon boxes, the pick-modal
   metric column, the reordered PLACED-mode castling flow, this session's
   chessground resize fix, and the "Pts from optimal" display).
2. The Monte Carlo sim port from `rraney/nfl-dfs` — still needed. (Note:
   this is NOT the same thing as this session's new lineup optimizer —
   the optimizer answers "what's the single best legal lineup," the sim
   answers "what's this lineup's distribution of outcomes.")
3. Simulated "Top 10%" metric — still a known gap.
4. Ron needs to create **`web/.env`** with his own `VITE_ADMIN_PASSWORD=...`
   — still not created, deliberately.
5. `CONTINUATION_LIMIT = 8` (Book continues' cap) is still a guessed
   number, not spec'd — flag if it needs tuning either direction. Now also
   worth revisiting alongside this session's popularity-sort fix: with
   real per-position popularity driving the order, 8 may surface a
   different, more "obviously right" set of moves than it did before.
6. PLACED king mode's "silent King move while dragging" path still has no
   dedicated test.
7. If the engine changes, re-run `tools/export_parity.py` and `npm run
   test` to keep the parity fixture honest. **Note**: `engine/optimizer.ts`
   is NOT in the parity harness — it has no Python equivalent at all
   (display-only), so there's nothing to keep in parity.
8. If more tests start flaking under full-suite load, the same "extend
   this specific test's timeout to match its real cost" treatment applies
   — but check for a genuine fixable inefficiency first (this session
   found one: a redundant full-book rescan, fixed instead of just padding
   the timeout).
9. **`tools/sim_builds.py`** still calls `classify(p, sport)` with the old
    2-arg signature and assumes Rook is RB-only — unchanged, out of scope,
    flagged again.
10. **DEFAULT_EXCLUDED_FAMILIES serves two different purposes now** (see
    Open Items) — worth deciding whether that's intentional.

## Open Items

- **`DEFAULT_EXCLUDED_FAMILIES` (openings.ts) is used for two different
  questions that don't necessarily have the same answer**: "should this
  family ever be *suggested* as a named opening" (its original purpose —
  e.g. "King's Knight Opening" is too generic a catch-all to usefully
  suggest) and, as of this session's fix, "how should this move be
  *ordered* in Book continues relative to others." The continuation sort
  now uses real per-position popularity as its PRIMARY key specifically so
  excluded-family moves (like 2. Nf3) no longer rank last just for being
  unranked — `rank`/`RANK_BY_FAMILY` is now only a tiebreak. Flagged as a
  design question, not fixed further: is a family that's "too generic to
  suggest" also something Ron wants visually de-emphasized in Book
  continues, or should real popularity be the only signal there now?
  Unconfirmed either way.
- **`yalps` (the lineup optimizer's MILP solver) is a new runtime
  dependency** — small (~15KB unminified, ~280KB on disk with its own
  package metadata), pure TypeScript, no WASM/native bindings, MIT-
  licensed per its own `package.json`. Not yet reviewed by Ron beyond this
  session's own justification in the commit message.
- **The dominance-pruning pre-pass in `engine/optimizer.ts` is a real,
  nontrivial piece of logic** (not just a cache) — worth a second pair of
  eyes given how subtle the first draft's bug was (it initially dropped
  ALL copies of an exact-tied group needed to fill a multi-count slot,
  caught and fixed before it shipped via a dedicated regression test:
  "keeps enough identical RBs to fill RB + FLEX, even though they're all
  tied").
- **Points from optimal's display hasn't been seen in a real browser** —
  same standing limitation as everything else; the stat itself is
  computed/tested in `engine/optimizer.test.ts`, but its actual on-screen
  layout (under Core projection, and on the finish screen) is unverified.
- **DST (and any other non-RB/WR/TE/QB position) lost Queen eligibility**
  (prior session) — unchanged, still flagged, still unconfirmed whether
  wanted as a permanent rule.
- **The pick modal's "greyed out, infeasible" row display is dead code in
  practice** (prior session) — unchanged, left in place defensively.
- **Click-to-move's real root cause for a *first*-move failure is still
  genuinely unconfirmed** (prior session) — unchanged; the *second*-move
  desync and this session's board-resize bug are both independently
  fixed, but the original first-move report predates both and can't be
  explained by either.
- **`assignRosterSlots`/`validate_etr_csv` aren't in the parity harness**
  (prior session) — unchanged. `engine/optimizer.ts` is ALSO not in the
  parity harness, but for a different reason (no Python equivalent exists
  at all, not "not yet added").
- **Which interchangeable player draws "FLEX" vs. its own dedicated slot
  is a cosmetic artifact** of `assignRosterSlots`'s matching search (prior
  session) — unchanged. Note: `engine/optimizer.ts`'s OWN best-lineup
  solver has the same kind of tie-break arbitrariness when two candidates
  are exactly equal on both salary and projection (an explicit, tested,
  deterministic id tiebreak, not left to chance) — a different mechanism
  solving a similar-looking problem; don't conflate the two if revisiting
  either.
- **`openings.py`'s `_piece_eligible_positions`/TS equivalent had a real
  bug fixed two sessions ago but with no dedicated new test** (prior
  session) — unchanged.
- **"Stop with this core" sits in the same place at every screen width**
  (prior session) — unchanged, not confirmed either way.
- **Bug 2/Bug 3's own root cause distinction** (prior session,
  `10152026-endings-mobile-pass-bug-fixes.md`) — unchanged.
- **`data/samples/repro-slate.csv`** stays on disk, deliberately
  uncommitted — confirmed excluded again this session.
- **`design/`** (PNGs, HTML mockups) remains uncommitted — Ron's call.
- **No "Back" navigation to the PREVIOUS screen** — still a known gap.
- **`openingPreview`/`legalDepth` are slow (~49ms/call) and uncached** at
  the engine level (prior session) — unchanged; `appData.ts`'s own
  `previewFor` memoization is still the only mitigation.
- `cloneBoard`'s PGN-round-trip clone, chess.js's missing APIs,
  `build.ts`'s generic "illegal move" error — all unchanged.
- Task-numbering collision, Scotch Game rank 2 / King's Indian Defense
  drop confirmation, `excluded_families` and tier-boundary numbers
  hardcoded, CLI wording unconfirmed, `contest_type` field, pawn
  promotion's DFS classification, `logs/` vs `sessions/` doc-process
  mismatch, `Top_Ten` sim-vs-postmortem distinction, Kings structurally
  uncapturable (emergent) — all still open, all unchanged, carried
  forward across several sessions; see `sessions/1026/
  10132026-pin-top-9-opening-ranks-test.md` and `sessions/1026/
  10132026-never-moved-captures-field-tiers-and-family-ranking.md`.
- Full narrative for this session: `sessions/1026/
  10192026-board-resize-optimizer-template-fix.md`. Prior sessions in
  `sessions/1026/` for everything predating today.
