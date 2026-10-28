# Session — 2026-10-28 (continued)

Continuing the same day's earlier Sim 5 + pick-list-cap-removal work
(own session log: `10282026-sim5-blueprint-draft-and-pick-list-cap-removal.md`).
Three more tasks, each committed and pushed to `origin/main`.

## Task 1: Bug fix — Captures transfer the wrong player

**Report**: after `1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5 a6 5. Bxc6 dxc6`,
the notice said "Field captured your knight" and named the WRONG
player — the knight that had already been safely captured-and-transferred
in move 5, not the bishop's own pick from move 4.

### Root cause

`rules.ts`'s `applyCaptureMove`, the `fits` branch:
`newPieceLocks.set(chessMove.to, [...moverHistory, captured!]);` —
`moverHistory` is the CAPTURING piece's own lock history (fetched from
its FROM square); `captured` is the just-transferred player. Writing
BOTH under the TO square's key conflates two different pieces' identities
under one key. On move 5 (`Bxc6`), this meant c6's own history became
`[bishop's pick, transferred knight]` instead of just `[bishop's pick]`.
On move 5...(`dxc6`), `capturedHistory[capturedHistory.length - 1]`
("most recently locked" — intentional, well-tested elsewhere for a
piece that moved MULTIPLE TIMES via ordinary moves) read back the
STRAY knight entry instead of the bishop's own identity.

Confirmed via `git log -- rules.ts` + `git show eac7732` that this
exact `[...moverHistory, captured]` write predates that commit (which
only added the fits/doesn't-fit split; the "doesn't fit" branch's own
`newPieceLocks.set(chessMove.to, moverHistory)` — NO captured entry —
was already correct, just never applied to the "fits" case too). Also
checked `dfs_chess/rules.py` directly (read-only, never touched, per
"TS-only from here on") — same `mover_history + [captured]` pattern,
confirming this is a long-standing bug ported faithfully from the
original Python engine, not a TS-only regression.

### Fix

Both branches now write just `moverHistory` at the new square (hoisted
above the fits/doesn't-fit `if`, since they're now literally identical)
— a capture never locks a new player for the CAPTURING piece itself, so
its own history can't gain an entry from one; `captured`'s fate (join
the capturing side's roster, or return to the pool) is tracked entirely
via `moves`/`locked`.

Checked whether this might be a DELIBERATE design choice before
touching it (per the task's own instruction #3) — no comment anywhere
asserted "the transferred player's identity should propagate forward as
the capturing piece's own new history," and no existing test exercised
a RECAPTURE of the same square at all (the only scenario that could
expose this), so there was nothing "blessed" to preserve.

### Take back

No separate fix needed: it only restores a prior, never-mutated
`BuildState` snapshot (pushed onto `pastStates` right before a White
move commits) — so correctness there follows automatically once the
snapshot ITSELF is correct. Verified directly with a dedicated test
(derive a later capture from a saved snapshot, confirm the snapshot's
own `whiteMoves`/`pieceLocks` are untouched by that derivation).

### Tests (2 new, `rules.test.ts`)

Reproduced Ron's exact move sequence with explicit synthetic players
per piece, and a Take-back-equivalent immutability check. Verified
BOTH tests actually FAIL against the pre-fix code (temporarily
`git stash push -- rules.ts` to isolate just the fix, ran the tests,
confirmed failure with the exact wrong-player/wrong-piece symptom,
`git stash pop` to restore) before considering the fix validated.

`npm run test`: 588 passed (586 + 2). `pytest`: 237 passed, unchanged
(frozen engine untouched despite having the identical bug).

Committed `4d1bd47`, pushed.

## Task 2 → 3: Tight-finish salary alert, window.alert then an in-app dialog

**Prompt 1** (informal): "This message: Salary getting tight: $4,200
per open slot. Needs to be a modal alert when it starts getting tight.
At every progressively worse step, there needs to be an alert."

Asked three clarifying questions inline (per CLAUDE.md: never
AskUserQuestion, ask inline) before building, since this was genuinely
ambiguous on a few real design axes:
1. Native `window.alert` vs. a custom dialog component?
2. Does "progressively worse step" mean the two existing levels
   (Caution, Warning), firing once each?
3. In addition to the existing inline text, or replacing it? Trigger
   off the real committed roster, or the pick modal's own hypothetical
   "after this pick" preview?

User's answer: "Your call on all three... must be hard to miss...
interrupt and need one click to dismiss. Fire once per level per
build, after a pick locks. Keep the inline text too." This resolved
(2) and the "after a pick locks" / "keep inline text" parts of (3)
explicitly, while deferring the MODAL-TYPE choice (part of 1) to
my judgment. Given this codebase's only existing precedent for
interrupting the user (`requestStartAgain`'s `window.confirm`), I
picked `window.alert` for the first pass — simplest, already-precedented,
literally satisfies "interrupt, one click to dismiss."

### Implementation (first pass, `4c1c660`)

`BuildScreen.tsx`: a `useEffect` keyed on `whiteTightFinish?.level`
(the ALREADY-rendered inline-text value, derived from the real
committed `whiteRoster` — never the pick modal's own separate
`afterTightFinish` preview computed inside `PickPanel.tsx`), with:
- `alertedLevelsRef` (a `Set<TightFinishLevel>`, never cleared except
  by remount) so each level fires at most once per build, even if Take
  back flaps the level back and forth and a later pick re-crosses it.
- `skipNextTightFinishAlertRef` so the effect's own unavoidable
  first-mount run (React always runs a fresh effect once after mount)
  doesn't fire for whatever the status happens to be before any pick.
- `ending !== null` guard so "Fill out my core" (which also changes
  the roster, hence `whiteTightFinish`) never pops anything — the
  build's already over by then.

### Tests (3 new, `BuildScreen.test.tsx`)

`tightFinishStatus` partially mocked (`vi.mock("./buildStats", ...)`,
real implementation kept as the default, restored fresh every test via
`vi.importActual` in `beforeEach` — a plain captured module-scope
variable didn't work here: Vitest hoists `vi.mock(...)` calls to the
literal top of the file, so a factory that assigns to a `let` declared
textually BEFORE it still hit "cannot access before initialization," since
the factory runs while resolving `BuildScreen.tsx`'s own import graph,
before this test file's later statements execute. Confirmed by
reproducing the exact `ReferenceError` once, then switching to a fresh
`vi.importActual` call inside `beforeEach` instead, which sidesteps the
hoisting entirely).

This let the 3 tests script exactly which level a pick reports without
needing a genuinely expensive, many-pick real roster against the real
$50,000 NFL cap (the threshold MATH itself already has thorough direct
coverage in `buildStats.test.ts` — not re-tested here; only the NEW
wiring was in scope). One subtlety caught and fixed while writing the
"doesn't fire from the hypothetical preview" test: a flat
`mockReturnValue(WARNING)` set right before `simulateMove` made the
MOCK appear to "change" on the very next render (opening the pick
modal, an unrelated state update) even though the real roster never
did — not a bug in the real code, just an artificial test-construction
mismatch. Fixed by using `mockImplementation` keyed on `players.length`
instead, so the mock only differs between the real (empty) roster and
PickPanel's own hypothetical (one-longer) one, matching how the real
function actually behaves.

`npm run test`: 591 passed (588 + 3). `pytest`: 237 passed.

Committed `4c1c660`, pushed.

**Prompt 2** (explicit follow-up): "Replace the tight-finish window.alert
with an in-app dialog. Reuse the pick modal's styles (theme-aware,
bottom sheet on mobile)... dimmed backdrop, clear heading by level
(Caution/Warning), the $ per open slot and the reason, one OK button."

### Implementation (`342c917`)

New `TightFinishDialog.tsx`, deliberately reusing `PickPanel.css`'s
own class names directly (`pick-modal-overlay`, `pick-modal`,
`pick-modal-header`, `pick-modal-footer`, `pick-modal-actions`,
`lock-player` for the OK button's accent styling) rather than
duplicating the overlay/backdrop/bottom-sheet rules — confirmed by
reading `PickPanel.css` that its mobile media query and
`.pick-row-list`'s scroll rule are already written against viewport
units generically, not tied to anything pick-panel-specific, so the
bottom-sheet behavior came for free with zero new CSS for that part.
Added exactly two small new rules (`.tight-finish-dialog-heading.caution`
/`.warning`) reusing the SAME color tokens (`--text-h`/`--danger`) the
existing inline `.pick-tight-finish`/`.side-tight-finish` classes
already use, so no new design tokens were invented. Body text reuses
`status.message` as-is (already contains both the dollar figure and,
at Warning, the joined reasons) rather than re-deriving/duplicating
that formatting separately.

`BuildScreen.tsx`'s effect swapped `window.alert(...)` for
`setTightFinishAlert(whiteTightFinish)` (new state); rendered
conditionally alongside the existing `PickPanel` conditional render
(mutually exclusive in practice — the tight-finish dialog can only
open right as a pick's own commit closes the pick panel).

### A real regression caught while re-running the full suite

Two PRE-EXISTING castling tests ("castling locks QB + RB", "Place now
castling offers the QB switch") broke: each locks 5 REAL top-of-list
picks via `developKnightAndBishop` + castling, and — now that the
alert is a real, queryable `role="dialog"` element instead of an
invisible-to-testing-library `window.alert` — their own
`expect(screen.queryByRole("dialog")).toBeNull()` assertions started
failing, because a tight-finish dialog now legitimately, correctly
pops up for their own expensive real picks. This had been happening
silently (to `window.alert`, un-asserted) the whole time; it only
became visible once the alert became a real DOM dialog. Fixed by
narrowing both assertions to `queryByRole("dialog", { name: /^Choose your/ })`
— the TRUE intent ("no PICK panel left open"), not "zero dialogs of
any kind," since a second, differently-named, correctly-firing dialog
coexisting there is the NEW correct behavior, not a bug.

Rewrote the 3 tests from the `window.alert` pass to assert the real
dialog instead (role, heading text "Caution"/"Warning", OK button
click to dismiss) rather than spying on `window.alert`.

`npm run test`: 591 passed, and — unlike an earlier run this same
session that saw unrelated full-suite-only flakiness (7 tests across
two runs, traced to machine load, not this session's changes) — this
particular full run was completely clean, no flakes at all.

Committed `342c917`, pushed.

## State at end of session

Three commits this half of the day (`4d1bd47`, `4c1c660`, `342c917`),
all pushed. `npm run test`: 591 passed. `pytest`: 237 passed. No
uncommitted changes from this session's own work; the untracked-file
pile (data samples, design mockups, now 4 session logs across 10-27/
10-28) is unchanged, still sitting there, same standing precedent as
before.
