# DFS Chess — Handoff
Last updated: 2026-10-13

## Project Context

DFS Chess is an NFL DraftKings lineup builder that layers chess opening
strategy onto lineup construction. The user plays White; "the field"
(Black) plays too, by simulation. The goal is a *core* (typically 4–5
players), not necessarily a full lineup. Every turn is a real chess move
on a real `chess.Board`: the moved piece's type (King/Queen/Rook/Bishop/
Knight/Pawn — a salary-tier classification driven by a sport config, see
`pieces.py`/`sport.py`) filters eligible real players by position + salary
band, and that side locks one. It is a **build, not a game** — "build" in
code and docs, never "game," except when referring to chess itself.

There is no `RULES.md` anymore (removed several sessions ago). `CLAUDE.md`
(never edited directly; propose changes via a session log) says the task
**prompt** is the spec — implement it exactly as written, even where it
changes earlier behavior; the existing code and tests are the record of
all earlier rules. Python 3.11+, stdlib + pytest + `python-chess`; tools
may have their own dependencies, the engine may not. Secrets
(`LICHESS_API_TOKEN`) live in a gitignored `.env`, never printed.

## Where We Are

- **180 tests passing**, run via `wsl.exe -- bash -lc "cd ~/chess-dfs &&
  .venv/bin/python -m pytest tests/ -v"`.
- **Captures**: the captured player IS the capturing move's only pick; the
  capturing piece locks no player of its own. If the captured piece has
  lock history, it's a plain transfer (no prompt). If it never moved (no
  lock history — Task 19), the capturing side picks a player of its own,
  of the captured piece's real chess type (an unmoved pawn → a Pawn pick),
  via the normal pick list — this works for Black too, not just White.
- **Opening suggestion is rank-based (Task 20/20b), not percentile-based.**
  `openings.rank_families(line_stats, excluded_families=...)` ranks each
  family (name before ":") by its most-played line reaching ≥6 plies, from
  *any* row named that family or starting with `"<family>: "`; a short,
  explicit, overridable exclusion list (default: King's Pawn Game, Queen's
  Pawn Game, King's Knight Opening, Indian Defense) drops "umbrella"
  families regardless of their own games. `ContestConfig` has four entry
  tiers (Small/Mid/Large/XL, six configurable boundary numbers, all with
  Task 20's stated defaults) mapping total contest entries to a target
  rank via a log-interpolation formula; the opening-setup screen
  (`cli._prompt_for_opening_setup`) shows the contest's tier and suggested
  opening (Enter accepts it), then every ranked family grouped by tier
  (own tier first, others quietly tagged e.g. `"XL-style"`), paged 15 at a
  time, with `'m'`/`'s'` (search the *whole* book, ranked or not)/`'r'`
  (random, from the contest's own tier)/`'p'` (free play). Black, outside
  a template, commits to the matching book line whose family rank is
  closest to the target rank (unranked = farthest). The old percentile
  "contest aggression scale" (`ContestConfig.contest_position()`,
  `openings.opening_positions`/`closest_variations`/`RankedVariation`) is
  gone entirely.
- **The top-9 ranked families are now pinned exactly, in order (Task
  20c)**: `tests/test_openings.py::test_the_top_9_families_are_pinned_in_
  order_with_real_data` asserts ranks 1–9 are exactly Sicilian Defense,
  Scotch Game, Caro-Kann Defense, Scandinavian Defense, Italian Game,
  French Defense, Ruy Lopez, Queen's Gambit Declined, Nimzo-Indian
  Defense, against today's real `data/openings/line_stats.json` — verified
  by direct script run before writing the test, not assumed. This replaces
  Task 20b's looser test and reads as Ron's resolution of that session's
  flagged discrepancy in favor of the real data (Scotch Game legitimately
  ranks #2; King's Indian Defense correctly falls to rank 10 and is no
  longer expected in the top 9) — see Open Items, this is an inference,
  not confirmed directly.
- **A line's `games` count** (in `line_stats.json`) is games whose actual
  move sequence *passed through* that line's exact position at that ply
  depth — not games whose "final"/deepest-matching named opening is that
  line. One real game can increment several different lines' counts at
  once (every book line lying exactly along its path, at each one's own
  ply length). See `tools/count_popularity.py`'s per-game prefix-length
  loop in `main()`.
- **Full engine + CLI** otherwise unchanged in mechanism from prior
  sessions: templates, Black's book-line commitment (rank- instead of
  percentile-driven), King modes (EMERGE/PLACED), dead-ends,
  stop-and-restart, per-turn salary/ownership/projection display,
  paged/searchable player pick lists (Task 18), opening piece-preview
  (Task 17).
- **Multi-sport-ready, no git repo yet** — both unchanged.

## Where We're Headed

1. **The Monte Carlo sim port** from `rraney/nfl-dfs` — still needed to
   replace Black's highest-projection placeholder pick with real in-band
   selection, and for `Top1PctScore`/`Bottom99`. Unchanged this session.
2. **Simulated "Top 10%" metric** — still a known gap (`Top_Ten` is a
   real-results postmortem in the source repo, not a Monte Carlo output).
3. **No UI beyond the CLI** — still a working text runner only.

## Open Items

- **Task-numbering collision, not resolved**: the prior session's log used
  "Task 20c" for a report-only task (tracing `count_popularity.py`'s
  counting logic). This session's prompt also began "Task 20c," for the
  unrelated top-9-pinning task above. Not renumbered or reconciled — just
  flagged in case Ron's own task list diverged from what was actually
  built. See `sessions/1026/10132026-pin-top-9-opening-ranks-test.md`.
- Whether Ron actually intends to accept Scotch Game at rank 2 / drop
  King's Indian Defense from the "top 9" (inferred from Task 20c's exact
  list, not stated directly) — if wrong, revert is one test change plus
  adding "Scotch Game" to `DEFAULT_EXCLUDED_FAMILIES` in `openings.py`.
  Same log as above.
- `excluded_families` and the six tier-boundary numbers are Python-level
  defaults/parameters, not a separate config file — an interpretive
  choice, see `sessions/1026/10132026-never-moved-captures-field-tiers-
  and-family-ranking.md`.
- CLI wording for the whole opening-setup screen is a reasonable guess,
  not confirmed UX — same standing caveat as all prior sessions' prompt
  text, now covering more surface area. Same log.
- `openings.book_weights()`/`loaders.load_popularity()`/
  `data/openings/popularity.json` still have no engine caller.
- No dedicated `contest_type` (GPP/H2H) field in `ContestConfig`; pawn
  promotion's DFS classification unresolved; the `logs/` vs `sessions/`
  doc-process mismatch; the `Top_Ten` sim-vs-postmortem distinction — all
  still open, carried forward unchanged across several sessions.
- Kings still structurally can never be captured as the King piece itself
  (checkmate ends the position first — emergent, not a bug).
- Full narrative detail for everything in this update:
  `sessions/1026/10132026-pin-top-9-opening-ranks-test.md` (this
  session — Task 20c, test-pinning only, no production code changed);
  `sessions/1026/10132026-never-moved-captures-field-tiers-and-family-
  ranking.md` and earlier logs in `sessions/1026/` for everything
  predating that.
