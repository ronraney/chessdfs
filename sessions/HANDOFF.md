# Handoff — 2026-10-29

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
`web/` (Vite + React + TypeScript, Node v24/npm).

This was a short, two-part session, both already committed/pushed to
`main` (no branch involved — nothing to merge).

1. **Check-only question, no code change**: confirmed Black's captures
   and Black's castling QB step already run through the completability
   check (not a raw cap check) — `rules.ts`'s `castle`, `isLegalCapture`,
   and `applyCaptureMove` are side-agnostic (keyed off
   `sideToMove(state.board)`, no separate White/Black implementation),
   and each already calls `lineupStillCompletable(...)` with the full
   `available` pool. This was true going into the session (landed in the
   prior session's "Completability for captures/castling/King placement"
   work) — just verified, not changed. Flagged (not fixed, per
   `CLAUDE.md`) a stale comment at `rules.ts:75-98` that still describes
   the OLD pre-rule-change behavior ("every caller... still calls this
   with 3 arguments") and now contradicts both the code directly below it
   and the newer comment at `rules.ts:125+`.
2. **"Start over during the build"** (commit `b7e1334`) — added a "Start
   over" button to the build-controls action row (alongside Take back /
   Stop with this core / Sim my core / Fill out my core in
   `BuildScreen.tsx`). Always confirms first
   (`window.confirm("Start over? This build will be lost.")`, unlike the
   header's "Start again" link which only confirms once a player is
   locked); on confirm, calls the same `onStartAgain()` prop the finish
   screen's own "Start again" button uses. New test in
   `BuildScreen.endings.test.tsx` covers both the cancel path (build
   untouched) and the confirm path (same effect as Start again).

**Gotcha worth remembering**: mid-edit, `BuildScreen.tsx`'s working-tree
copy somehow picked up CRLF line endings (cause unclear — not reproduced
on a second pass), which would have made the commit's diff show ~4,200
changed lines instead of the real ~13. Caught it via `git diff
--ignore-all-space` before pushing, normalized back to LF with `sed -i
's/\r$//'`, and amended the not-yet-pushed commit. Worth a quick
`file <path>` / `git diff --stat` sanity check after editing this file in
particular, at least until the root cause is understood.

## What happened this session

- Answered the completability check-only question (see above) — read-only
  investigation across `rules.ts`, `rules.test.ts`, `build.ts`,
  `BuildScreen.tsx`; no files changed.
- Added "Start over" (`requestStartOver` in `BuildScreen.tsx`, button
  markup in the build-controls row, `.start-over` styling in
  `BuildScreen.css` grouped with the other neutral action buttons, test
  in `BuildScreen.endings.test.tsx`).
- Ran `npm run test` full suite twice: 636/637 and 635/637 passed across
  the two runs, with a different 1-2 tests failing each time
  (`BuildScreen.movePick.test.tsx`'s transient "The Field is moving…"
  status-text assertion, `BuildScreen.castling.test.tsx` once) — confirmed
  this is pre-existing timing flakiness under this box's heavy parallel
  worker load (38 workers), not a regression: both failing files pass
  cleanly when run alone. Same class of flakiness noted in the prior
  handoff's "Open items."
- Committed as `b7e1334` ("Rule change — Start over during the build"),
  amended once (unpushed at the time) to fix the CRLF issue above, then
  pushed to `origin/main`.
- Confirmed via `git branch --show-current` that the repo was already on
  `main` with nothing to merge, per this wrap-up's own prompt.

## Open items / blockers

- **Stale comment in `rules.ts:75-98`** still describes the pre-
  "Completability for captures/castling/King placement" behavior and
  contradicts the code below it — flagged to Ron, not touched (per
  `CLAUDE.md`: never change rules/comments about rules on my own).
- **Full-suite test flakiness under parallel load** — unchanged
  standing item from the prior handoff; a different 1-2 timing-sensitive
  tests fail on different runs of the full suite, always passing in
  isolation. Not investigated further this session (out of scope for
  either task).
- The CRLF gotcha above (unclear root cause) — if it recurs, worth
  checking whether it's something in the VSCode extension environment's
  save/sync path specifically for files with an open editor tab.
- `field.ts` still doesn't know about the real-correlation model — same
  long-standing item, unchanged again this session.
- Untracked-file pile in `data/samples/` (a DraftKings projections
  export, two contest-standings files, `repro-slate.csv`) — predates
  this session, left alone again.

## Next steps

1. Whenever a prompt touches `rules.ts`'s completability docs, fold in a
   fix for the stale `rules.ts:75-98` comment.
2. `field.ts`'s real-correlation-model rework — still the standing bigger
   item whenever it's next picked up.
3. Housekeeping: the `data/samples/` untracked pile could use a decision
   (commit, `.gitignore`, or explicitly leave as-is) whenever someone's
   looking at that area anyway.
