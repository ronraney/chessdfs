# 10142026 — Task 35: Hidden admin screen; players don't upload

## Context

Session opened with a side question: `/start` wasn't showing up as a usable
slash command even though `/wrap-up` was. Checked `.claude/skills/` directly —
both `start/SKILL.md` and `wrap-up/SKILL.md` have identical, correctly-formed
frontmatter (`name:`/`description:`), and both show up as available skills in
*this* session. Directory mtimes: `wrap-up/` Oct 11 21:07, `start/` Oct 13
15:32 — two days apart. Likely explanation given to Ron: skills are scanned
at session/window start, so a Claude Code window opened before Oct 13 15:32
wouldn't have picked up the newly-added `start/` skill yet; a reload should
fix it. Not independently verified (can't inspect another window's session
state from here) — worth confirming if `/start` still misbehaves after a
fresh window.

Then ran `/start`. HANDOFF.md (as of Oct 14, carried over from the prior
session's four-task run — Tasks 31–34) showed: TS engine port complete with a
41-scenario parity harness, a working 3-screen App (Setup → OpeningSetup →
Build-placeholder), 211 Vitest tests + 180 pytest tests passing, and two open
items (chessground's GPL-3.0 license undecided; no headless-browser
verification available in this environment — missing `libasound.so.2`, no
sudo). Branch was `main`, up to date with `origin/main`.

First real blocker: every git command failed with `fatal: detected dubious
ownership in repository at '//wsl.localhost/Ubuntu/home/raney/chess-dfs'` —
a consequence of reaching the repo over a WSL UNC path from the Windows side
rather than natively inside WSL. Flagged it before acting, per the standing
"never update git config" rule; Ron said to fix it. Added
`git config --global --add safe.directory '%(prefix)///wsl.localhost/Ubuntu/home/raney/chess-dfs'`
— a one-time trust exception for this path, no effect on authorship, remotes,
or repo behavior. `git status` then showed only the routine carryover:
`sessions/HANDOFF.md` modified (prior session's wrap-up, not yet committed)
and an untracked `sessions/1026/10142026-tasks-31-34-...md` log — both
expected per CLAUDE.md's "sessions/ files are routine" note, not a reason to
stop.

Task 35, as given:
> Remove the projections upload from the player setup. Player flow: contest
> → King mode → opening. Add a hidden admin screen at #/admin (not linked
> anywhere in the app), behind a password set in .env as
> VITE_ADMIN_PASSWORD. Note in your report that this is client-side only.
> Admin screen: upload the projections CSV (existing loadEtrCsv), show the
> player count or a clear error, and save it in browser storage so it
> survives reloads. A "Clear projections" button. Player setup reads the
> saved projections. If none are saved, show "No slate loaded yet" instead
> of the setup. Contests still come from contests.json; no admin editing
> yet. Tests: upload on admin → player setup shows; clear → "No slate loaded
> yet"; wrong password → no admin screen; the player screens have no upload
> control.

Didn't conflict with HANDOFF's "Where We're Headed" (chessground license
decision, build screen, Monte Carlo) in a blocking way — a legitimate pivot
on the existing Setup screen, so proceeded without stopping.

## What was done

**`web/src/projectionsStore.ts`** (new): three tiny functions around
`window.localStorage` under key `"chess-dfs:projections-csv"` —
`getSavedProjectionsCsv`, `saveProjectionsCsv`, `clearProjectionsCsv`. Stores
the *raw CSV text*, not parsed `Player[]` — `loadEtrCsv` (the engine's own
loader, untouched) is re-run wherever the text is read, so there's exactly
one parse path feeding both the admin's "N players loaded" count and the
player screens' actual data. Deliberately I/O at the UI layer only, not
inside `web/src/engine` — the engine stays pure per CLAUDE.md.

**`web/src/AdminScreen.tsx`** (new): password gate (plain component state,
not persisted — re-entering the password is required after a reload or after
leaving and returning to `#/admin` within the same session; this wasn't
specified either way, flagged to Ron as a judgment call) compared against
`import.meta.env.VITE_ADMIN_PASSWORD`. Once authed: a file input
(`accept=".csv"`), `loadEtrCsv` on upload, "N players loaded" or a clear
parse error (`role="alert"`), and a "Clear projections" button. Also shows
current saved status immediately on mount (`"No projections saved yet."` or
the existing count) rather than only right after a fresh upload — a small
addition beyond the literal spec, added so "survives reloads" and the Clear
button's effect are both visibly confirmable without needing to re-upload;
flagged to Ron as going slightly beyond what was asked.

Flagged explicitly per the task's own instruction: the password check runs
in client-side JS against a value baked into the built bundle at build time.
Anyone reading the shipped JS can recover the password or skip the check
outright — this keeps the screen out of casual/incidental reach, it is not
real access control.

**`web/src/App.tsx`**: removed the old upload step and its `handleUpload`/
`readFileAsText`/`uploadError` state entirely. `players` is now initialized
from `loadSavedPlayers()` (reads `projectionsStore` + `loadEtrCsv`, `null` on
no saved CSV or a parse failure). Added `#/admin` hash routing: `isAdminRoute`
state plus a single `hashchange` listener (not a separate `useEffect`
watching derived state — oxlint's `set-state-in-effect` rule flagged an
earlier version that called `setPlayers` from a `useEffect` keyed on
`isAdminRoute`, correctly: that fires `setState` synchronously as a reaction
to a prior state change rather than the actual external event. Moved the
`setPlayers(loadSavedPlayers())` re-read inside the `hashchange` handler
itself, which *is* the event that should trigger it — `npm run lint` went
from 1 warning to 0 after the fix). When `isAdminRoute`, renders
`<AdminScreen />` (not linked from anywhere else in the UI — reachable only
by typing the URL). When `players === null`, renders "No slate loaded yet."
in place of the whole setup screen. Renumbered the two remaining setup steps
("1. Pick a contest", "2. King mode") since step 1 (upload) was removed, and
dropped the now-dead `players === null` branch inside the King-mode QB-picker
(unreachable once the top-level null check already returns early). `canContinue`
no longer checks `players !== null` for the same reason.

**Tests**: `web/src/App.test.tsx` rewritten — old upload-specific tests
(uploading shows count, bad file shows error) removed from here since that
behavior now lives in AdminScreen; kept/adapted: title always shows, "No
slate loaded yet" with nothing saved, no upload control anywhere in the
player flow, preset-tier display, King-mode QB filtering (now seeded via
`saveProjectionsCsv` directly rather than a file-upload interaction), and two
new routing-integration tests — admin upload → navigate `#/admin` → `""` →
player setup shows; admin clear → same navigation → "No slate loaded yet."
reappears. **`web/src/AdminScreen.test.tsx`** (new, 5 tests): wrong password
shows no upload control (plus the "Wrong password." alert), correct password
reveals it, successful upload shows the count and persists to
`localStorage`, a bad file shows the parse error and saves nothing, Clear
removes the saved slate. **`web/src/testFixtures.ts`** (new): factored the
sample-CSV-file helper (previously inline in the old App.test.tsx) out so
both test files can share it.

**Verified, not just believed**: `npm run test` → **218 Vitest tests passing**
(was 211; net +7 = -2 removed upload tests +4 App-level additions +5
AdminScreen tests... actual arithmetic: 8 tests in the new App describe
blocks + 5 in AdminScreen = 13, vs. 6 in the old App.test.tsx = net +7,
218 total). `pytest` → **180 passed**, unchanged (Python engine untouched,
as expected). `npm run build` (`tsc -b && vite build`) clean both before and
after the lint fix. `npm run lint` (oxlint): 0 warnings, 0 errors after the
hashchange-handler fix. All four runs done via `wsl.exe -- bash -lc "cd
~/chess-dfs[/web] && ..."` since invoking `npm` directly through this
session's Windows Bash tool fails outright — npm spawns via `cmd.exe`, which
can't resolve the UNC working directory (`CMD.EXE was started with the above
path as the current directory. UNC paths are not supported.`). Worth noting
for next session: any `npm run ...` command needs the `wsl.exe` wrapper, not
just git.

**Not done, by design**: no `web/.env` file was created and no password was
invented. Flagged to Ron: `VITE_ADMIN_PASSWORD` must live in **`web/.env`**
(Vite's own project root), not the repo-root `.env` that `LICHESS_API_TOKEN`
already lives in — Vite only loads env files from its own root, confirmed by
reading `web/vite.config.ts` (no `envDir` override) and checking there's no
existing `web/.env*`. Confirmed `web/.env` is already covered by the root
`.gitignore`'s bare `.env` pattern via `git check-ignore -v web/.env` →
`.gitignore:2:.env	web/.env`. No gitignore change was needed. Ron needs to
create `web/.env` with his own `VITE_ADMIN_PASSWORD=...` before the admin
screen is usable in dev/build; the test suite doesn't depend on that file
(each admin test uses `vi.stubEnv` instead).

## Open threads

- `/start` not appearing as a slash command in whatever window Ron typed it
  in, despite the skill file being correctly formed — attributed to a
  stale skill-list scan from before `start/SKILL.md` existed (Oct 13 15:32),
  fixable by a window reload/restart. Not independently confirmed; if it
  recurs after a fresh window, worth a closer look at how/when this
  environment scans `.claude/skills/`.
- `VITE_ADMIN_PASSWORD` still needs to be set by Ron in `web/.env` (not
  created this session, deliberately — see above).
- Admin login isn't persisted across a reload or a round-trip through
  `#/admin` within the same session — every visit re-asks for the password.
  Unspecified either way; revisit if that's annoying in practice.
- Everything already open as of Tasks 31–34 remains open and untouched this
  session: chessground's GPL-3.0 license decision, no real headless-browser
  verification of any screen (missing `libasound.so.2`, no sudo), the actual
  build screen, the Monte Carlo sim port, the Top-10% metric, `openingPreview`/
  `legalDepth`'s ~49ms/call cost, the Task-20c numbering collision, and the
  rest of the longer-standing list in the prior HANDOFF.md — see
  `sessions/1026/10142026-tasks-31-34-opening-setup-and-engine-speed.md` and
  `sessions/1026/10132026-*.md` for full detail on each.
