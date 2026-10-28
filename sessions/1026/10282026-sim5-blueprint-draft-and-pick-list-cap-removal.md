# Session — 2026-10-28

Two rule-change tasks, one prompt each, both committed and pushed to
`origin/main`.

## Task 1: Sim 5 — Black drafts from the sim field

**Prompt**: replace Black's player pick (previously: top of the piece's
pick list) with a blueprint drawn from the contest tier's built field.
Applies to every Black pick: moves, castling King/Rook steps, unmoved-
piece captures, and the QB placed at setup. Blueprint rules: seeded
random draw from the tier's field, must contain every player Black's
already locked and none of White's; each pick takes whichever blueprint
player fits that piece's own eligible/available/completable list (first
by the piece's existing sort if several qualify); re-draw (next seeded
draw, restricted to lineups with a qualifying candidate) when invalid —
White took a blueprint player, or none fits this pick; fall back to
top-of-list with no field or no qualifying lineup. Black's line choice
unaffected. Same seed + moves → same picks.

### Investigation

Read through `build.ts` (`bestLegalPlayer`/`bestLegalCapturePlayer`/
`bestLegalCastlePlayers`/`resolvePlayers`/`playBlackMove`/
`playBlackTemplateMove`), `picklist.ts`, `fieldCacheStore.ts`/
`engine/sim/field.ts` (the `SimulatedField` shape), and `rules.ts`'s
`placeKings` to map out every site that currently does "top of
pickList." Found the setup QB pick is NOT engine code at all — it's
inline in `SetupScreen.tsx` (`qbs.find(p => p.id !== whiteKing.id)`),
decided entirely in the UI layer before `placeKings` ever runs.

Key design decision: keep `resolvePlayers`/`bestLegalPlayer`/
`bestLegalCapturePlayer`/`bestLegalCastlePlayers` as the SAME pure,
RNG-free top-of-list functions they always were, but thread an optional
`pick: (candidates) => Player` callback through them (default:
`candidates[0]`). Every *probing* call site (`checkWhiteDeadEnd`,
`moveIsCompletable`, `playableContinuations`, the free-play candidate
filter inside `playBlackMove`) leaves `pick` at its default — this was
the load-bearing choice that keeps probing deterministic and RNG-free:
if blueprint drafting lived inside the probe path itself, the number of
RNG draws consumed per turn would depend on how many legal moves/book
continuations got probed (an implementation detail, not "moves
played"), which would have made "same seed + same moves → same picks"
fragile. Only the two ACTUAL commit calls (in `playBlackMove` and
`playBlackTemplateMove`) build a blueprint-aware `pick` closure and pass
it in.

New `chooseBlueprintPlayer` (exported from `build.ts`): given the
piece's already-filtered/sorted `candidates`, the field,
`blackLockedIds`/`whiteLockedIds` snapshots, the current committed
blueprint, and a `SeededRandom` — implements the whole invalidate/
redraw/fallback state machine in one place. Reused directly by
`SetupScreen.tsx` for the QB pick (no `BuildState` needed there at all).

### The buildSeed wrinkle

Including the setup QB pick in scope meant `buildSeed` (previously
generated fresh inside `BuildScreen`'s own `useState`, via
`Math.random()`) had to exist BEFORE `SetupScreen` even renders its QB
picker. Lifted `buildSeed` generation into `SetupScreen` itself (one
`useState`, used both for its own QB draw and threaded through
`ChosenSetup.buildSeed` → `App.tsx` → `BuildScreen`'s new optional
`buildSeed` prop). Made the prop OPTIONAL (not required) specifically so
every existing `BuildScreen` test/caller that doesn't pass one keeps
working unchanged, falling back to the old `Math.random()` roll — this
avoided touching the ~10 existing `BuildScreen.test.tsx`/
`BuildScreen.secondMove.test.tsx` render call sites.

SetupScreen's own QB draw uses a FRESH `new SeededRandom(buildSeed)`,
not `BuildScreen`'s live, continuously-advancing `rng` — matched the
EXISTING convention `BuildScreen` already uses for sim runs (its own
code comment explains why: consuming the live `rng` for something
unrelated would non-deterministically perturb Black's subsequent book/
move choices). This is a judgment call, not literally spec'd — flagged
as such in the task report.

Also gave `playBlackTemplateMove` the same `field`/`rng` treatment for
consistency (it's currently NOT wired into any live UI screen — template
mode is dead code reachable only from its own tests — but the task said
"each Black pick," not "each reachable Black pick"). Both new params
default to no-ops (`field = null`, `rng = new SeededRandom(0)`, unused
unless `field` is also passed) so every existing test call site needed
zero changes.

### Tests added (6, in `build.test.ts`)

- `chooseBlueprintPlayer` determinism by seed (two fresh `SeededRandom`
  instances, same seed → same player + blueprint).
- Re-draw once White has taken a player out of the committed blueprint.
- Re-draw once the committed blueprint has no player for this pick.
- Fallback to top-of-list with null field and with an empty-lineups
  field.
- A 25-seed sweep proving the draw never lands on a lineup containing a
  White-held player.
- One end-to-end wiring test through `playBlackTemplateMove`'s castling
  path, proving the King/Rook picks actually come from a blueprint
  lineup rather than `pickList`'s own top. First attempt at this test
  failed (got the top-of-list Rook, not the blueprint's) because the
  test fixture's field lineup didn't include the 3 players Black had
  ALREADY locked from `stateReadyForBlackKingsideCastle()`'s own setup
  moves — the containment check (blueprint must contain every player
  Black's locked) correctly invalidated/fell back. Fixed by including
  those 3 already-locked players (by id) in the test's own field
  lineup.

Ran `npm run test`: 585 passed (579 + 6 new). `pytest`: 237 passed,
unchanged (frozen engine, untouched). Two pre-existing known-flaky
BuildScreen tests (castling, deviation-banner) failed under full-suite
load, re-confirmed passing in isolation — same pattern HANDOFF.md
already documents from prior sessions.

Committed as `7ba7a05`, pushed.

## Task 2: Remove the pick list cap

**Prompt**: pick lists no longer capped — every player passing the
other filters shows, same sort order. Applies to every pick list both
sides (King/Queen/Rook/Bishop/Knight/Pawn, castling King/Rook steps,
unmoved-capture pick, setup QB pick). All other filters unchanged.
Black's pick logic unchanged (blueprint-first, fallback-to-top).
Pick modal must scroll when long, desktop and mobile bottom sheet.
Remove the cap constant if nothing else uses it; update cap-asserting
tests.

### Where the cap lived

`picklist.ts`'s `pickList`/`castleRookList` both did
`sport.listCapFor(piece)` → `.slice(0, listCap)`. `sport.ts`'s
`SportConfig.listCaps` (a `Map<Piece, number>`) was populated from
`config/sports/nfl.json`'s `"list_caps": {"QUEEN": 12, "ROOK": 12,
"BISHOP": 12, "KNIGHT": 12}`.

### The shared-config trap

First pass: removed `list_caps` from `config/sports/nfl.json` directly
(the file `web/src/`'s own copy syncs FROM via `scripts/sync-data.mjs`,
itself gitignored under `web/src/data/` per CLAUDE.md — caught that in
time and edited the real source at the repo root instead). Then
realized: this exact JSON file is ALSO read directly by the FROZEN
Python engine's own test suite —
`tests/test_picklist.py`'s `NFL = load_sport_config(... "config" /
"sports" / "nfl.json")`, and it has its own
`test_pick_list_caps_queen_rook_bishop_knight_to_12` asserting the old
cap-of-12 behavior against that SAME shared file. Removing the key
would have silently broken a frozen, supposedly-untouched test suite —
exactly the kind of out-of-scope behavior change CLAUDE.md says to
avoid. The task's own instruction ("remove the cap constant if nothing
else uses it") gave the literal resolution: something else (Python,
frozen) DOES still use it, so the shared JSON key stays. Reverted that
edit; instead stripped `list_caps`/`listCapFor`/`listCaps` entirely out
of the TS side only (`sport.ts`'s `RawSportConfig`/`SportConfigFields`/
`SportConfig`/`loadSportConfig`) — TS now ignores the key on read.
Verified via `pytest tests/test_picklist.py` (16 passed) that Python's
own cap tests are completely unaffected.

### Scrolling

Read `PickPanel.css` before touching anything: `.pick-row-list` already
had `overflow-y: auto; max-height: 44vh;` unconditionally (not sized to
assume 12 rows), and the `@media (max-width: 760px)` bottom-sheet rule
already kept `.pick-modal` itself scrollable too as a backup. Both were
written generically against viewport units already — no CSS changes
needed. Confirmed this holds with a new `BuildScreen.test.tsx` test
(develop the g1 Knight, assert `.pick-row` count > 12 in the real
dialog against the real sample slate).

### Tests updated

`picklist.test.ts`: the 3 tests that asserted a literal cap-of-12
(`"caps Queen/Rook/Bishop/Knight to 12"`, and two separate `"is still
capped at 12"` tests for `pickList(ROOK)` and `castleRookList`) flipped
to assert the full, uncapped length (20) instead, renamed accordingly.
The pre-existing "King and Pawn are uncapped" test needed NO change —
it was already asserting the behavior that's now universal. One more
test's comment (about cap-vs-filter-ordering) was softened since that
distinction no longer exists, but its assertion was left as-is (still
correctly empty either way).

### Full-suite flakiness investigation

Two consecutive full `npm run test` runs produced DIFFERENT failure
sets (5 failures first run across App/BuildScreen/SetupScreen test
files; 2 failures second run, one repeat + one brand-new "dests is not
iterable" error) — not the same 2 tests HANDOFF.md documents as
"known flaky." Treated this as worth verifying rather than assuming:
- Every single failing test, across both runs, passed cleanly when
  re-run in isolation.
- The most suspicious one ("shows the Field's move once Black
  replies...", a real-timer status-line race unrelated to pick lists)
  was additionally run against the UNMODIFIED baseline via `git stash`
  — it ALSO failed there, in isolation, proving it predates this
  session's changes entirely.
This confirms the broader flakiness this session saw is environmental
(machine load, real-timer races), not caused by removing the cap —
documented in HANDOFF.md as a wider-than-previously-known flaky set,
not silently ignored.

Committed as `b210366`, pushed.

## State at end of session

`npm run test`: 586 tests, green modulo the documented full-suite-only
flakiness (confirmed non-regressing via isolation + baseline checks
above). `pytest`: 237 passed, untouched. Both commits pushed to
`origin/main`. No uncommitted changes from this session's own work;
the pre-existing untracked-file pile (data samples, design mockups,
3 session logs from 10-27) is unchanged, still sitting there.
