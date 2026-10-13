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

## Session log
At the end of each task, write `logs/YYYY-MM-DD-<short-task-name>.md` with:
- Files changed
- Tests run and result
- Open questions
- Follow-ups (noted, not acted on)

Then end your reply with the same three items: files changed, tests, open questions.