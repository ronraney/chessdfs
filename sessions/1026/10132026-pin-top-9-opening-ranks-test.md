# 10132026 — Pin the top-9 opening-ranking test

## Context

Picked up after `10132026-never-moved-captures-field-tiers-and-family-ranking.md`
(Tasks 19, 20, 20b, 180 tests), which had flagged an unresolved discrepancy:
Task 20b's worked example named 9 "top 9" families, but with today's real
`data/openings/line_stats.json`, "Scotch Game" (not on that list) ranks #2,
displacing "King's Indian Defense" (on the list) to rank 10. That session's
test (`test_the_top_named_families_rank_near_the_top_with_real_data`) had
been written as a loose "each of these 9 ranks <= 10" membership check over
an unordered set, rather than asserting an exact top-9, specifically because
the discrepancy was unresolved.

This session's task ("Task 20c — Pin the top-9 test," one line, no further
code task attached) gave an explicit, ordered top-9 list: Sicilian Defense,
Scotch Game, Caro-Kann Defense, Scandinavian Defense, Italian Game, French
Defense, Ruy Lopez, Queen's Gambit Declined, Nimzo-Indian Defense — and
asked for the loose test to be replaced with an exact assertion of that
order. Note: Scotch Game is on this list and King's Indian Defense is not,
which reads as Ron's resolution of the prior session's open discrepancy in
favor of the real data (see Open threads).

## What was done

Confirmed the given order against real data first, rather than assuming the
task's list was correct: ran `rank_families()` directly against
`data/openings/line_stats.json` via a one-off script
(`dfs_chess.openings.rank_families` / `dfs_chess.loaders.load_line_stats`).
Ranks 1-9 came back exactly: Sicilian Defense, Scotch Game, Caro-Kann
Defense, Scandinavian Defense, Italian Game, French Defense, Ruy Lopez,
Queen's Gambit Declined, Nimzo-Indian Defense (rank 10: King's Indian
Defense) — an exact match to the task's list, in the same order.

`tests/test_openings.py`: replaced `test_the_top_named_families_rank_near_
the_top_with_real_data` (the loose membership/comment version from Task
20b, asserting `rank <= 10` for an unordered 9-name set including King's
Indian Defense) with `test_the_top_9_families_are_pinned_in_order_with_
real_data`, which asserts `[f.name for f in ranked[:9]]` equals the exact
ordered list above. No production code changed — `rank_families()` itself
was untouched, since the real data already produced the required order.

Tests: 180 -> 180 (one test replaced in place, net count unchanged). Full
suite run via `wsl.exe -- bash -lc "cd ~/chess-dfs && .venv/bin/python -m
pytest tests/ -v"` — all 180 passed.

## Open threads

- **Task numbering collision, not resolved, flagged for Ron**: the prior
  session's log already used "Task 20c" as the label for a different,
  report-only task (tracing `count_popularity.py`'s per-game prefix-length
  counting logic — see that session's log, section "Task 20c"). This
  session's prompt also began "Task 20c," for this unrelated test-pinning
  task. Did not attempt to resolve or renumber either task — just noting
  the collision in case Ron's own task list diverged from what actually
  got built.
- **The Scotch Game / King's Indian Defense discrepancy itself reads as
  resolved** by this task's exact, ordered list (Scotch Game included at
  rank 2, King's Indian Defense excluded from the pinned top 9) — but that
  inference is mine, drawn from the list Ron supplied, not a statement Ron
  made directly. If that reading is wrong, the fix is a one-line revert of
  today's test plus a new entry in `DEFAULT_EXCLUDED_FAMILIES`
  (`openings.py`) for "Scotch Game."
- All other open items carried forward unchanged from the prior log
  (`excluded_families`/tier-boundaries as Python defaults not a config
  file; opening-setup screen CLI wording unconfirmed; `book_weights()`/
  `load_popularity()` still uncalled; no `contest_type` field; pawn
  promotion's DFS classification; `logs/` vs `sessions/` doc-process
  mismatch; `Top_Ten` sim-vs-postmortem distinction; Kings structurally
  uncapturable as the King piece).
