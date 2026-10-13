# 10122026 — Lichess popularity data and the contest aggression scale

## Context

Picked up after the templates/book-exit/King-modes session (125 tests,
see `10122026-templates-book-exit-king-modes.md`). Two tasks landed:
9b, filling in the real-world opening-popularity data that Task 9's
`tools/fetch_popularity.py` had been blocked on (the Lichess Opening
Explorer API still 401s on every query, token or not), and then 15,
which replaced the placeholder temperament/k weighting with the real
"Contest aggression scale" RULES.md had just gained between the two
tasks — Ron updated RULES.md mid-session to add that section, rewrite
"Opening templates"'s setup list (initially written as "the 6 closest
variations" in the task prompt itself, corrected to 12 by the user a
message later), and rewrite "Black (the field)" to match.

## What was done

### Task 9b — popularity and results from the Lichess game database

Wrote `tools/count_popularity.py` (new one-time script): streams
`https://database.lichess.org/standard/lichess_db_standard_rated_2026-09.pgn.zst`
(the most recent full month, computed from today's date, 2026-10-12),
decompressing on the fly via `zstandard` (new tools-only dependency —
`tools/requirements.txt`, never added to the engine's own
`requirements.txt`). Walks each qualifying game's (both `WhiteElo` and
`BlackElo` >= 1800) first 20 plies; stops at 2,000,000 qualifying games;
never downloads or stores the file whole (closes the HTTP response as
soon as the target is hit).

Before committing to the full run, live-sampled the real dump (not
just synthetic fixtures) and caught a real bug: the per-game header
parser was unconditionally resetting the headers dict on the blank
line between a game's header block and its movetext line — i.e.
*before* `WhiteElo`/`BlackElo` could ever be read off them. A 300MB
sample showed 0/925,801 qualifying games with the bug (statistically
impossible for Lichess's real rating distribution — that's what gave
it away), 310,825/925,801 (33.6%) once fixed. Also discovered live that
this month's dump embeds Lichess's own move-quality annotations
(`f4?!`, `Bd6??`) inline on SAN tokens, which would silently break
exact-match comparison against the book's clean SAN — stripped via
`ANNOTATION_SUFFIX_RE = re.compile(r"[!?]+$")` before any comparison.

Full run: 1668s (~27.8 min), 1.97 GB compressed streamed, 6,014,958
games scanned to find 2,000,000 qualifying, 301 of those with an
unresolved Result header (`"*"`) contributing no move/result tally.

Wrote `data/openings/popularity.json` (overwritten from `{}`): kept
the exact `{"<moves joined by ' '>": {<move>: <count>}}` shape
`openings.book_weights`/`loaders.load_popularity` already read, so
*zero* code changes were needed there — added two reserved top-level
keys real position keys can never collide with (SAN sequences are
never `_`-prefixed): `_meta` (source month, rating filter, ply depth,
game counts) and `_results` (same `{position: {move: ...}}` shape, but
each move's value is `{white, draws, black}` instead of a bare int —
the per-move result counts the task asked for, kept out of the
plain-int shape so `book_weights`/the (then-existing)
`build.temperament_weights` — which did `count ** k` — needed no code
changes).

Wrote `data/openings/line_stats.json` (new): one entry per book line
— each of the 3,865 vendored TSV rows, *not* deduplicated by name
(688 of them share a name with another row — transpositions/vendor
duplicates) — with `eco`/`name`/`moves`/`games` (reaching that exact
final position) and `white_rate`/`draw_rate`/`black_rate`.

Report (from chat, not saved separately): top 5 replies to 1. e4 — c5
(242,705), e5 (237,829), e6 (128,061), d5 (113,873), c6 (113,784).
Lowest draw-rate lines with >=1000 games: Englund Gambit Declined
2.80%, King's Gambit Accepted: King's Knight's Gambit 2.88%,
Nimzowitsch Defense: Kennedy Variation 2.93%, King's Gambit Accepted
(C37) 2.99%, Rat Defense: Harmonist 3.00%. Highest: Ruy Lopez: Berlin
Defense, Rio Gambit Accepted 37.21%, Berlin Defense: Anti-Berlin
27.13%, Berlin Defense (C65) 21.66%, QGD: Three Knights 20.90%, Berlin
Defense (C65, larger sample) 20.25% — the famous "Berlin Wall"
reputation showing up directly in the real data was a good sanity
check on the whole pipeline. 125/125 tests still passing (no engine
code touched this task — only new data files and a new tool).

### Task 15 — contest aggression scale

RULES.md (re-read fresh, per CLAUDE.md, since it had changed since
Task 9b) now has: a "Contest aggression scale" section (continuous
0-100, contest position from `100 * (ln(entries) - ln(2)) /
(ln(max_entries_scale) - ln(2))` clamped to 0-100, opening position
from percentile-ranked usage, `max_entries_scale` defaulting to
416,171); "Opening templates"'s setup list rewritten to "the 12
variations closest to the contest's position ... grouped by family
... plus Random ... and (Play your own opening)"; "Black (the field)"
rewritten to commit to the closest-position matching line (seeded
tie-break) instead of popularity-weighted random choice.

- `config.py`: removed `temperament`/`DEFAULT_TEMPERAMENT`/
  `temperament_k()` entirely. Added `max_entries_scale: int = 416_171`
  and `contest_position()` implementing the log formula. Verified
  directly against RULES.md's own worked examples (2->0, 100->32,
  1,000->51, 10,000->70, 100,000->88, 416,171->100) by hand before
  writing tests for three of them. `field_tier()`/
  `FIELD_TIER_MID_MIN`/`FIELD_TIER_LARGE_MIN` untouched — still used
  for ownership blending, an unrelated use of field size.
- `loaders.py`: added `load_line_stats()`, mirroring `load_popularity`.
- `openings.py`: added `opening_positions()` (merges TSV rows sharing
  a name by summing `games` before percentile-ranking — so a name
  split across several rows is ranked once, not several times; a name
  with zero total games is excluded from the ranking entirely),
  `split_family()` (`"Family: Variation"` split, Lichess's own
  convention — no colon means no sub-variation to show), and
  `_representative_lines()` + `RankedVariation` + `closest_variations()`
  (the N named variations nearest a contest position, each carrying an
  actual playable `BookLine` — picked by most games when a name spans
  several rows, tie-broken by fewest plies then ECO).
- `build.py`: removed `temperament_weights()`. `_choose_black_committed_line`
  now computes `abs(opening_positions.get(line.name, 50.0) -
  contest.contest_position())` per matching line and `rng.choice`s
  among whichever are tied at the minimum, instead of a popularity-
  weighted `rng.choices`. Renamed `_playable_book_moves` ->
  `_playable_continuations` (now a plain `set[str]` via
  `book_continuations`, since there's no weight to carry anymore).
  `play_black_move`'s `popularity: dict[str, dict[str, int]]`
  parameter became `opening_positions: dict[str, float]` — same
  position in the signature, so every existing test call passing `{}`
  (the "no popularity data" fixture shape) kept working unchanged,
  since an empty dict means the same thing either way: every line
  defaults to tied.
- `cli.py`: replaced the free-text "search openings by name" screen
  (`_prompt_for_template`) with `_prompt_for_opening_setup` — prints
  the `SETUP_LIST_SIZE` (12, a named module constant per RULES.md's
  "the count is a config setting") closest named variations (family
  line, then variation indented beneath if the name had a colon),
  "R. Random" (seeded by the build's own `rng`), and
  "(Play your own opening)"; blank still means free play, same as
  before. No usage data at all -> skips straight to a single
  "press Enter to play your own opening" prompt rather than an empty
  numbered list. Along the way, fixed `_load_line_stats()` to read
  `DEFAULT_OPENINGS_DIR` fresh at call time (matching `_load_book()`'s
  existing pattern) rather than a module-load-time constant — the old
  `DEFAULT_POPULARITY_PATH` had the same latent issue (monkeypatching
  `DEFAULT_OPENINGS_DIR` in a test never actually redirected it), just
  never caught because popularity data didn't affect those tests'
  single-candidate synthetic books.

Found two more call sites my signature change would have left
*silently* wrong rather than broken: `tools/sim_builds.py` and
`tools/task11f_black_stuck.py` both call `play_black_move` directly
with data loaded from `popularity.json`. After the rename, they'd have
passed move-sequence-keyed popularity data into a name-keyed
`opening_positions` lookup — every lookup would miss and default to
50, silently flattening Black's book choice back to uniform-random
instead of crashing. Repointed both to load `opening_positions` from
`line_stats.json` the same way `cli.py` now does; fixed a stale
`book_weights` docstring reference in `sim_builds.py` while there.

Verified live against real data, not just the test suite: a
field_size=1000 contest (`contest_position()` ~51) surfaced moderately
*rare* lines in the setup list ("Van Geet Opening: Tübingen Gambit"),
which checks out against the formula even if it's not necessarily the
most intuitive product behavior for a "medium" contest — flagged, not
second-guessed, since it's exactly what RULES.md specifies. A
field_size=2 (H2H, position 0) surfaced the most popular top-level
names instead: King's Pawn Game, Queen's Pawn Game, Sicilian Defense,
Caro-Kann, French Defense, etc. — matches intuition and RULES.md's
"safest" framing for H2H.

Tests: 125 -> 144. Removed 2 dead `temperament_weights` tests
(`test_build.py`) and 3 dead `temperament_k` tests (`test_config.py`).
Added: `contest_position()` against RULES.md's own examples plus a
clamp-above-max case (`test_config.py`); `opening_positions`
merge-once/zero-exclusion, `split_family`, and `closest_variations`
(nearest-by-distance, representative-line, caps at `count`, and a
20-synthetic-variations case proving exactly the 12 nearest come back
when more than 12 are available) (`test_openings.py`); Black committing
to the closer of two synthetic lines regardless of seed, and ties
(no usage data) still varying by seed (`test_build.py`); `load_line_stats`
(`test_loaders.py`); rewrote the two `test_cli.py` tests that scripted
the old search flow to use a synthetic `line_stats.json` fixture
instead, and added one confirming the real vendored data renders
exactly `SETUP_LIST_SIZE` entries. 144/144 passing.

## Open threads

- `openings.book_weights()`, `loaders.load_popularity()`, and
  `data/openings/popularity.json` itself have no remaining engine
  caller after this session — Black's book choice now runs entirely
  on `line_stats.json`-derived `opening_positions`, not per-move
  popularity counts. Left in place (not deleted) since the task only
  asked to remove temperament/k, and RULES.md's "Data" section still
  lists `popularity.json` as present. Worth a call from Ron on whether
  to deprecate/remove it, or whether something else (a future
  continuation-ordering display?) is meant to pick it back up.
- Several interpretive calls RULES.md/the task didn't spell out,
  flagged in chat as they came up: `SETUP_LIST_SIZE` is a code
  constant (`cli.py`), not a new per-contest JSON field; "grouped by
  family" was read as *each* of the 12 entries showing its own
  family+variation, not multiple same-family entries merged under one
  shared header; a name spanning several TSV rows picks its
  representative line by most games (tie-broken by fewest plies, then
  ECO) — RULES.md doesn't say how to pick one; "lines with no games
  are left off the scale" (the ranking function's own output) and
  "without usage data every opening sits at 50" (the caller-side
  default for one missing name among otherwise-ranked ones) were
  treated as two different statements about two different situations,
  not a contradiction — `opening_positions()` excludes zero-game names
  from its own dict, and callers (`build.py`, `cli.py`) default a name
  missing from that dict to 50.
- Exact setup-screen prompt copy is still unconfirmed — same open item
  the previous session already flagged for the King-mode/book-exit/
  switch-QB prompts, now extended to this new screen too.
- Task 9b's own assumption still stands as written into
  `line_stats.json`: "named book line" = each TSV row, not deduplicated
  by name. Task 15's `opening_positions()` merges by name *on top of*
  that file for the aggression scale specifically — the file itself
  stays at row-level granularity.
- Carried forward, unchanged this session: no dedicated `contest_type`
  field on `ContestConfig`; Kings structurally uncapturable (emergent,
  not a bug); pawn promotion's DFS classification unresolved; King
  captures in PLACED king mode unsupported; the `logs/` vs `sessions/`
  doc-process mismatch (Ron still needs to pick one); the `Top_Ten`
  sim-vs-postmortem distinction. See the three prior 1026 logs and the
  two 10112026 logs for full detail on each.
