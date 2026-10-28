# Handoff — 2026-10-28

## Where things stand

DFS Chess is an NFL DraftKings lineup builder that layers chess opening
strategy onto lineup construction. The user plays White; "the field"
(Black) plays too, by simulation. The goal is a *core* (typically 4–5
players), not necessarily a full lineup. `CLAUDE.md` (never edited by
Claude; Ron edits it himself) says the task **prompt** is the spec —
implement it exactly as written; existing code/tests are the record of
all earlier rules. Git workflow: work on `main`, one commit per task
after tests pass, push to `origin/main` after every commit, never use
`AskUserQuestion` (ask inline as plain text).

Python 3.11+ engine (`dfs_chess/`, **frozen** — TS-only from here on) +
`web/` (Vite + React + TypeScript, Node v24/npm). The TS port of the
chess/DFS engine and the Monte Carlo sim (`web/src/engine/sim/`) are both
complete and wired into the UI. `field.ts` (the MILP that builds "the
field") still has NO awareness of the real-correlation model
(`draws.ts`'s own Gaussian copula) — still its own older ownership-bias/
noise objective; see Open items.

**Black drafts from a sim-field blueprint, not top-of-list** (earlier
today): `build.ts`'s `chooseBlueprintPlayer` — every Black pick (moves,
castling King/Rook, an unmoved-piece capture, the setup QB pick) drafts
from one lineup drawn by seeded random from the contest tier's own built
field, containing every player Black's already locked and none of
White's; re-drawn when invalid (White took a blueprint player, or none
fits the pick), falling back to top-of-list with no field built or no
lineup qualifying. `BuildState.blackBlueprint` carries it forward.
`buildSeed` now originates in `SetupScreen.tsx` (needed there for the
setup QB pick) and flows down via `ChosenSetup.buildSeed` →
`BuildScreen`'s own (optional) prop.

**Pick lists are no longer capped** (earlier today): the old per-piece
`sport.listCapFor` cap (12 for Queen/Rook/Bishop/Knight) is gone from
`picklist.ts`/`sport.ts` entirely. `config/sports/nfl.json` still
carries its own `list_caps` key, kept ONLY because the frozen Python
engine's own `test_picklist.py` reads that exact shared file and still
asserts the old cap — TS's loader just ignores the key now.

**New this session: a capture's lock history bug, fixed.**
`rules.ts`'s `applyCaptureMove` used to write
`[...moverHistory, captured]` at the capturing piece's new square when
the transfer fit — conflating the capturing piece's OWN lock history
with the just-transferred captured player's, under the same square key.
A capture never locks a new player for the capturing piece itself, so
that extra entry was wrong on its face, and on a LATER recapture of the
same square it silently became "the most recently locked player,"
handing the wrong player to the wrong side (reported: `5. Bxc6 dxc6`
transferred the knight captured on move 5 back out, instead of the
bishop's own pick from move 4). Fixed: both branches now write just
`moverHistory` (hoisted above the fits/doesn't-fit split, since they're
now identical) — a piece's own history follows it; the captured player
is tracked only via `moves`/`locked`. Take back needed no separate fix
(it only restores a prior, never-mutated snapshot). The frozen Python
engine has the identical bug (`dfs_chess/rules.py`) — left untouched
per "TS-only from here on."

**New this session: the tight-finish salary warning now interrupts,
via an in-app dialog.** `buildStats.ts`'s `tightFinishStatus` (Caution
at ≤$4,500/open-slot, Warning at ≤$4,000 + an aggravating factor) was
already shown as small inline text in the You panel and the pick
modal's "after this pick" preview — easy to miss. `TightFinishDialog.tsx`
(new) now also shows a real modal (reusing `PickPanel.css`'s own
overlay/card/footer/button styles — same dimmed backdrop, same
centered-desktop/bottom-sheet-mobile treatment, theme-aware for free)
with a level-colored heading ("Caution"/"Warning"), the same message
text, and one "OK" button — once per level per build, the moment a
LOCKED pick (never the modal's own hypothetical preview) first reaches
it, never once the build's over. Went through `window.alert` first,
then was replaced with the dialog once asked for explicitly. Fixed two
existing castling tests along the way whose own real top-of-list picks
(5 locks) legitimately reach "caution"/"warning" now that it's a real,
queryable dialog — their "no dialog left open" assertions were too
broad and needed narrowing to the pick panel's own dialog name.

**Rook's own pool** (prior session): any RB/WR/TE, any salary — team no
longer affects eligibility for any piece except castling's own Rook
step (`castleRookList`, still team-restricted).

**Admin has a contest upload** (prior session): `contestStore.ts` +
`engine/contestsCsv.ts`, falling back to `config/contests.json`.

**Environment**: accessed from Windows via `\\wsl.localhost\Ubuntu\...`.
Plain `npm`/`npx`/`git`/`python`/`node` through the Windows-side shell
fails on this UNC path for anything that shells out — every such
command needs `wsl.exe -e bash -lc "cd /home/raney/chess-dfs/... && ..."`.
No real browser is launchable here (missing `libasound.so.2`, no
passwordless sudo).

**Tests**: 237 pytest, 591 npm, both green as of this session's last
commit (`342c917`) — the most recent full `npm run test` run was clean
(no flakes at all), though a prior run today saw a wider set of full-
suite-only flaky tests than previously documented (see Open items).

## What happened this session

Continuing from earlier today's Sim 5 + pick-list-cap-removal work
(already in a prior handoff), three more tasks, all committed and
pushed:

1. **Bug fix: captures transfer the wrong player** (`4d1bd47`) — see
   "Where things stand" above. Verified both new `rules.test.ts` tests
   (the exact reported recapture sequence, and a Take-back-equivalent
   snapshot-immutability check) actually fail against the pre-fix code
   before confirming the fix.

2. **Rule change: tight-finish salary alert** (`4c1c660`) — first pass,
   `window.alert`, fired once per level after a pick locks. 3 new
   `BuildScreen.test.tsx` tests (`tightFinishStatus` partially mocked so
   these could script exact levels without needing a many-pick, real
   expensive roster — the threshold math itself already has direct unit
   coverage in `buildStats.test.ts`).

3. **Rule change: tight-finish alert as an in-app dialog** (`342c917`)
   — superseded #2's `window.alert` per explicit follow-up ask. New
   `TightFinishDialog.tsx` + two small CSS rules in `PickPanel.css`.
   Rewrote the 3 tests from #2 to check the real dialog instead of a
   `window.alert` spy; fixed 2 unrelated existing castling tests whose
   "no dialog open" assertions were too broad once a second, legitimate
   dialog type could coexist.

Every commit: ran `npm run test` + `pytest` before committing.

## Open items / blockers

- **`field.ts` still doesn't know about the real-correlation model** —
  same long-standing #1 item, unchanged this session.
- Full-suite test flakiness: one run today saw 7 distinct BuildScreen/
  App/SetupScreen tests fail (non-overlapping sets across two runs),
  every one confirmed passing in isolation, one even reproduced against
  the pre-change baseline — not traced to any of this session's changes,
  but wider than the "2 known-flaky tests" previously documented.
  Today's LATEST full run (after the tight-finish-dialog work) was
  completely clean, so this may just be load-dependent noise rather
  than a worsening trend — worth a fresh look if it recurs.
- The standalone backtest/diagnose tool (`web/src/tools/`) still
  rebuilds a fresh ~10,000-attempt field on every invocation, no
  caching — unchanged, low priority unless it becomes a recurring task.
- Still undecided: `data/backtest/` vs `data/samples/` as the real home
  for backtest input files.
- Untracked-file pile keeps growing, same standing "leave uncommitted"
  precedent: the same data/design/Zone.Identifier clutter as before,
  plus FOUR session logs from 10-27/10-28 still untracked (including
  this session's own) — none committed yet.

## Next steps

1. Decide whether `field.ts`'s own lineup-generation objective should be
   reworked to reflect the real-correlation model — still the natural
   next rule-change task.
2. Real-browser verification pass once `libasound.so.2` is available —
   Sim 4/Sim 5's UI/Worker paths still haven't been exercised end-to-end
   in an actual browser.
3. If backtests/diagnostics become a recurring thing: pick a stable home
   for input files and consider caching the built field across runs.
4. Housekeeping: the growing pile of untracked session logs (and the
   older data/design clutter) could use a decision — commit, `.gitignore`,
   or explicitly leave as-is.
