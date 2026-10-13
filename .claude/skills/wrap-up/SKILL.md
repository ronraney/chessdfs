---
name: wrap-up
description: Use at the end of a chess-dfs work session (or whenever the user says "wrap up", "write a handoff", "log this session", "update the handoff") to write a dated session log under sessions/<MMYY>/ and fully replace sessions/HANDOFF.md with the current project state. Do not use mid-session — this is an end-of-session action.
---

# Wrap Up

Two artifacts, two different lifetimes. Keep them that way:

- **`sessions/HANDOFF.md`** — a single, *replaced-in-place* document. Its only
  job is to get a future session (yours or a developer's) from zero to useful
  context as fast as possible. It is never appended to. Every run of this
  skill overwrites it completely.
- **`sessions/<MMYY>/<MMDDYYYY>-<slug>.md`** — an *append-only* dated log,
  one new file per session. This is where detail and history actually live.
  HANDOFF.md should mostly point here for anything beyond "what's true right
  now."

## Steps

1. **Determine the filename.** Today's date gives `MMDDYYYY` (e.g. October 11,
   2026 → `10112026`) and the month/year folder is `MMYY` (→ `1026`). Create
   `sessions/<MMYY>/` if it doesn't exist. Pick a 3-6 word kebab-case slug
   describing this session's main work (e.g.
   `core-engine-scaffold-and-rule-gap-fixes`) — infer it from what actually
   happened this session, or use an explicit description if the user gave one.

2. **Reconstruct what happened this session.** Don't rely on vague memory of
   the conversation — check concrete state: `git log`/`git diff` if this is a
   repo, which files were actually created/edited, which tests were run and
   their results, which questions were raised and how (or whether) they were
   resolved. Prefer specifics (file paths, line numbers, exact test counts,
   exact rule text) over summary language.

3. **Write the dated session log** at `sessions/<MMYY>/<MMDDYYYY>-<slug>.md`.
   This is a narrative record for future reference — write it with the same
   density and concreteness as a real engineering handoff, not a bullet-point
   changelog. Structure loosely as:

   ```markdown
   # <MMDDYYYY> — <Title>

   ## Context
   What prompted this session; what state the project was in going in.

   ## What was done
   Concrete account of what was built/changed/decided, and *why* — include
   file paths, rule text, test results, specific numbers. Call out what's
   confirmed (tests pass, verified by running it) vs. merely believed true.

   ## Open threads
   Anything left unresolved, unconfirmed, or deliberately deferred.
   ```

   Never edit a previous session's log file — each session gets its own.

4. **Fully rewrite `sessions/HANDOFF.md`** — replace the entire file, don't
   patch it. Structure:

   ```markdown
   # <Project Name> — Handoff
   Last updated: <YYYY-MM-DD>

   ## Project Context
   Short, stable description of what this project is (rarely changes
   session to session — lift from CLAUDE.md if it says this better).

   ## Where We Are
   Current state in concrete terms: what exists, what's built, what's
   confirmed working vs. still unverified. This section should let someone
   open the repo and immediately know what's safe to assume.

   ## Where We're Headed
   The immediate next steps — specific enough to act on without re-deriving
   them from history.

   ## Open Items
   Running list of unresolved questions/decisions/bugs, each with a pointer
   to the session log file that has the detail, e.g.:
   `See sessions/1026/10112026-<slug>.md`
   ```

   Keep HANDOFF.md itself short and current-state-only. Anything that reads
   like history belongs in the dated log, referenced by a pointer — not
   copied into HANDOFF.md.

5. **Report tersely**: the two file paths written, and nothing else, per
   CLAUDE.md's "Terse output" rule — this skill's own output is not exempt.
