# CLAUDE.md — How to work with Ron

**Never edit this file.** Propose changes in your session log.

## How work arrives
- Ron plans with Claude.ai and relays one task per prompt. Each prompt is self-contained.
- Do only the task in the current prompt. Do not build ahead, start follow-ups, or infer a larger plan.
- If a task is unclear or contradicts existing behavior or tests, stop and ask before building.

## Rules
- The prompt is the spec. When a prompt changes behavior, implement it exactly as written, even if it changes earlier behavior, and update the affected tests.
- The existing code and tests are the record of all earlier rules. Don't change behavior a prompt didn't mention.
- Never change rules on your own. If a rule seems wrong, incomplete, or conflicts with another, flag it in your log. Do not "fix" it in code.
- Never edit CLAUDE.md. Propose changes in your session log; Ron makes them.

## Do
- Keep it simple. Implement rules exactly as written; add no nuance unless asked.
- Flag every assumption you make (unverified column names, guessed formats, inferred behavior).
- Flag any signature, interface, or behavior change beyond what the task asked.
- When something blocks you (access, credentials, missing data), stop and report what you found. Don't work around it.
- Keep secrets in `.env` (gitignored). Never print or log them.
- Keep the engine pure: no I/O, no unseeded randomness, no UI code in rules logic.

## Don't
- Don't trim or drop tests. If coverage would fall, say so and keep the tests.
- Don't add dependencies unless the task needs them; name any you add.
- Don't guess. If you're unsure of a fact (a real-world rule, an API, a data format), say so.
- Don't narrate. No step-by-step commentary.

## Git
- Work on `main`. No branches unless a task asks.
- Before starting, run `git status`. If there are uncommitted changes you didn't make, stop and ask.
- One commit per task, made only after all tests pass (pytest and `npm run test`). Message: `Task NN — <task title>`.
- Commit only files the task touched. Never commit `.env`, `.venv/`, `node_modules/`, `web/src/data/`, or other generated files; if one shows up in `git status`, add it to `.gitignore` and flag it.
- Push to `origin/main` after committing. If the push fails, stop and report; don't work around it.
- If tests fail, don't commit. Report what failed.
- Never force-push, `reset --hard`, rebase, amend a pushed commit, delete branches, or skip hooks (`--no-verify`) without Ron asking.
- End your reply with the commit hash and whether it was pushed.