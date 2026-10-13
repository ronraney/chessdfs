---
name: start
description: Use at the start of a chess-dfs work session (or whenever the user says "let's start", "get going", "pick up where we left off") to read sessions/HANDOFF.md and orient on current project state before taking on the next task. Do not use mid-session — this is a start-of-session action.
---

# Start

1. **Read `sessions/HANDOFF.md`** in full before doing anything else. It's the
   single source of truth for where the project stands: what's built, what's
   confirmed working, where things are headed, and open items carried over
   from prior sessions.

2. **Use the `sessions/<MMYY>/` logs for depth, not summary.** HANDOFF.md is
   deliberately short; it points to the dated session log(s) that have the
   real detail. Read the referenced log when the task at hand touches
   something HANDOFF.md only mentions in passing.

3. **If this is a git repo, check which branch is checked out** before
   touching anything — don't assume the current branch is the right one for
   the task just handed to you.

4. **Compare the task just given against HANDOFF.md.** If it doesn't fit
   "Where We're Headed," contradicts "Where We Are," or looks like it
   belongs on a different branch than what's checked out, stop and say so
   before building anything — don't quietly reinterpret the task to make it
   fit. This is the same rule CLAUDE.md states for the task prompt itself;
   it just can't be applied without first loading current state.
