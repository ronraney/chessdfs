# 10132026 — Never-moved captures, field-size tiers, and family-ranking fixes

## Context

Picked up later the same day as `10132026-projection-totals-piece-preview-and-capture-rewrite.md`
(164 tests at that point). Four tasks landed: 19 (captures of a piece that
never moved), 20 (field-size tiers replacing the Task 15 percentile scale —
a large rewrite), 20b (a correction to Task 20's family-ranking rule), and
20c (a report-only task, no code changes). Ended at 180 tests.

## What was done

### Task 19 — capturing a piece that never moved

Task 18 (prior session) made every capture a one-pick move: the captured
player IS the pick, no new pick for the capturer. But a captured piece with
no lock history (never moved) had nothing to transfer — `is_legal_capture`
returned `False` and `apply_capture_move` raised `NotImplementedError`, so
White couldn't play such a capture at all and Black's move generation
silently skipped it. Task 19: the capturing side now picks a player of its
own instead, of the captured piece's real chess type (an unmoved pawn → a
Pawn pick, etc.), keeping the "capturing piece locks no other player" rule.

`rules.py`: `is_legal_capture`/`apply_capture_move` gained an optional
`player: Player | None = None` param, used only when the captured square
has no lock history — validated for the right type, not already locked,
and roster/salary completability. `build.py`: new `_best_legal_capture_player`
(same highest-proj placeholder convention as `_best_legal_player`);
`_resolve_players`/`_apply_resolved_players`/`play_white_move` route a
never-moved capture through it. `cli.py`: new `_play_capture_move` shared
handler prints "You play {san}, capturing an unmoved {piece}: pick a
{Piece}." and shows the normal paged pick list; `_capture_message` no
longer narrates a never-moved capture as "capturing the Field's/your X"
(nothing was actually transferred) — White's own prompt covers it, Black's
falls through to the plain "locking" announcement.

**Found and fixed a real bug along the way**: `apply_capture_move` carried
`locked_player_ids` forward unchanged, correct for a historied transfer
(the player was already locked) but wrong for the new never-moved case —
the freshly-picked player was never added to the locked set, so they
could've been picked again later by either side. Fixed by unioning in
`captured.id` (a no-op for the historied case).

Tests: 164 → 170 (replaced 1 obsolete `NotImplementedError` test, added 7:
rules-level pawn/knight mechanics + the overflow-illegal case, two CLI
prompt-level tests, one full `cli.run()` end-to-end test via a custom
4-slot template, one build-level test proving Black can now make such a
capture). Verified live: a hand-scripted `cli.run()` through
`1. e4 a6 2. e5 a5 3. e6 a4 4. exf7` printed "You play exf7+, capturing an
unmoved pawn: pick a Pawn." and completed correctly. Re-ran
`tools/sim_builds.py`'s 1000-build stress test (`PYTHONHASHSEED=0`) against
real NFL data — clean, exit 0, 159/1000 stuck (85 White/74 Black vs. the
prior session's 159/1000 at 75/84 — same total, split shifted, expected
since Black can now choose these captures).

### Task 20 — field-size tiers and opening suggestion (large rewrite)

Replaces Task 15's percentile "contest aggression scale" entirely with a
rank-based system. **Family ranking** (`data/openings/line_stats.json`):
each family (name before ":") gets a representative line, then families
are ranked 1 = most played. **Entry tiers**: Small 2–1,000 → ranks 1–9,
Mid 1,000–5,000 → 10–29, Large 5,000–100,000 → 30–60, XL 100,000+ →
61–last (boundary sizes belong to the lower tier; XL's upper bound is
`max_entries_scale`, default 416,171) — all six boundary numbers are
configurable fields on `ContestConfig` with these defaults. **Target
rank**: `round(low_rank + (ln(entries) − ln(tier_low)) / (ln(tier_high) −
ln(tier_low)) × (high_rank − low_rank))`, clamped to `[1, last_rank]`.
**Suggestion** = the representative line of the family at the target rank.

`config.py`: removed `contest_position()` and the old aggression-scale
docstring entirely; added `EntryTier` dataclass and
`ContestConfig.entry_tiers()`/`entry_tier()`/`rank_tier()`/`target_rank()`,
plus the six new config fields (`small/mid/large_max_entries`,
`small/mid/large_max_rank`). `openings.py`: removed `opening_positions()`,
`closest_variations()`, `RankedVariation`, `_representative_lines()`; added
`RankedFamily` + `rank_families()` (first cut — corrected in Task 20b,
below). `build.py`: `play_black_move`/`_choose_black_committed_line` now
take `family_ranks: dict[str, int]`/`target_rank: int` instead of
`opening_positions: dict[str, float]` — Black outside a template commits to
the matching line whose family rank is closest to the target rank;
unranked = farthest (`math.inf`), seeded tie-break. `cli.py`:
`_prompt_for_opening_setup` fully rewritten — prints the contest's tier and
suggested opening (Enter accepts it), then every ranked family grouped by
tier (contest's own tier first, then Small/Mid/Large/XL in order,
excluding its own), paged `PICK_LIST_PAGE_SIZE` (15) at a time with `m`
(more)/`s` (search the whole book by name, via new `find_opening_lines`
wiring — this was built in an earlier session but never actually used
until now)/`r` (random, from the contest's own tier)/`p` (play your own
opening); a family outside the contest's own tier gets a quiet
`"{Tier}-style"` tag. New helpers `_prompt_opening_search`,
`_ordered_opening_rows`, `_print_family_option`. `SETUP_LIST_SIZE` removed.
`tools/sim_builds.py`/`tools/task11f_black_stuck.py`: minimal fix for the
now-broken `play_black_move` call signature (kept runnable, not a feature
upgrade — same "NOT part of the engine" scope boundary as every prior
session's treatment of these two scripts).

Rewriting the setup screen's behavior broke many existing CLI tests whose
scripted inputs assumed "blank = decline the opening, go to free play" —
blank now means "accept the suggestion," so free play needs an explicit
`'p'`. About 10 tests across `test_cli.py` needed their scripted-input
sequences fixed (`'p'` instead of a second blank), and a few needed their
fixture book-lines padded to ≥6 plies (bare name) to actually rank, or
rewritten to reach their fixture via `'s'` search instead of a numbered
pick when padding would have broken the "template ends mid-build" flow
they were testing (search works over the whole book regardless of
ranking). Tests: 170 → 175 net (test_config.py, test_openings.py,
test_build.py, test_cli.py all touched).

Live-verified: ran `_prompt_for_opening_setup` directly against real data
with a 3,000-entry (Mid-tier) contest — correct tier/suggestion header,
tier-grouped paged list (Mid first, then `[Small-style]`/`[Large-style]`
tagged entries), and `'r'` Random picked a Mid-tier-only family. Re-ran
`tools/sim_builds.py` — clean, exit 0, 145/1000 stuck (close to the prior
159/1000; the shift is expected, Black's book-line selection rule changed
from percentile-distance to rank-distance).

### Task 20b — fix family ranking

Task 20's own `rank_families()` restricted a family's representative line
to its bare-name (no colon) row only, reasoning from the task's two
examples (Sicilian Defense ranks 1; King's Pawn Game/Queen's Pawn Game are
unranked) — with real data, that reasoning held up (Sicilian's bare row
qualifies; King's/Queen's Pawn Game's bare rows never reach 6 plies) but
it was the wrong mechanism. Task 20b's correction: the representative can
be **any** row whose name is the family or starts with `"<family>: "` —
exactly Task 20's original reading before I second-guessed it. The real
fix for excluding umbrella families (King's Pawn Game, Queen's Pawn Game,
King's Knight Opening, Indian Defense) is an **explicit name-based
exclusion list**, not a ply/row-shape rule — because a literal "any row,
≥6 plies, most games" reading, with no exclusion list, actually ranks
King's Pawn Game via an obscure 6-ply/58-game sub-line, which is real data,
not a bug.

`openings.py`: `rank_families(line_stats, excluded_families=
DEFAULT_EXCLUDED_FAMILIES)` — the new frozenset parameter (with that
4-name default) is checked before the ≥6-ply filter; the bare-name
restriction is gone. `cli.py`/`build.py`/`tools/*` needed no changes (they
already call `rank_families()` generically; the new param has a default).

Verified against real data: Sicilian Defense still rank 1; Ruy Lopez's
representative line is exactly `Ruy Lopez: Morphy Defense` (e4 e5 Nf3 Nc6
Bb5 a6, 9,731 games) — matches the task's own example precisely; all 4
umbrella families unranked; 104 families rank total (task said "about
85+"). Tests: 175 → 180 (inverted the two Task 20 tests that had asserted
the now-wrong bare-name-only behavior; added exclusion-list tests, an
override test, and real-data tests for the Ruy Lopez line / ≥85 count).

**Found a real, flagged discrepancy, not resolved**: with today's real
`data/openings/line_stats.json`, 8 of the task's 9 named "top 9" families
land exactly in ranks 1–9, but **King's Indian Defense lands at rank 10**,
displaced by "Scotch Game" (not on the task's list) at rank 2 — Caro-Kann
Defense (on the list) also moves to rank 3 rather than 9. Every other fact
in the task's example (the exact Ruy Lopez line, the exclusions, the ~85+
count) matched precisely, so this reads as real-data drift (the Lichess
snapshot `tools/count_popularity.py` produces is refetched monthly) rather
than a rule bug — flagged to Ron directly in the chat response rather than
silently forced to match. The test (`test_the_top_named_families_rank_
near_the_top_with_real_data` in `test_openings.py`) asserts each of the 9
ranks ≤ 10, with a comment explaining why, rather than an exact top-9 set.

### Task 20c — report family ranking details (no code changes)

Reported the top 12 ranked families (rank, family, representative line
name, moves, games) and traced `tools/count_popularity.py`'s
`_write_line_stats`/main-loop logic to answer: a line's `games` count is
**games that passed through that line's exact position**, not games whose
"final"/deepest-matching opening name is that line. For every qualifying
real game, every prefix length of its actual moves is checked against
every book line's *full* move tuple; any line matching at its own length
gets +1, independent of what the game does afterward — so **one game can
increment several different lines' counts** (e.g. both a 5-ply "Ruy Lopez"
and a 6-ply "Ruy Lopez: Morphy Defense" line from the same game). This is
also why a shallow line (bare "Sicilian Defense," 2 plies, ~242,705 games)
always dwarfs its own deeper named sub-variations (24,356 for "Open") —
it's counting every game that ever reached that early position, not just
the ones that stayed on one specific deeper path. No code or tests
touched, per the task's explicit instruction.

## Open threads

- **The Scotch Game / King's Indian Defense ranking discrepancy (Task
  20b)** — Ron to decide: add "Scotch Game" to the exclusion list, or
  accept today's real ranking (which already satisfies every other stated
  fact) as correct and let the task's "top 9" example be slightly stale.
- The `excluded_families` list and the six tier-boundary numbers are
  implemented as Python-level defaults/parameters (overridable by the
  caller/`ContestConfig` fields), not a separate JSON config file — flagged
  as an interpretive choice since the task just said "config settings"/
  "config list" without describing file-loading mechanics for either.
- CLI wording for the whole new opening-setup screen (the `'p'` key for
  free play, the `"{Tier}-style"` tag format, Small→Mid→Large→XL ordering
  for non-home tiers) is a reasonable guess, not confirmed UX — same
  standing caveat as every prior session's prompt text, now covering a lot
  more surface area.
- `openings.book_weights()`/`loaders.load_popularity()`/
  `data/openings/popularity.json` still have no engine caller (unchanged,
  carried forward several sessions now).
- No dedicated `contest_type` (GPP/H2H) field in `ContestConfig`; pawn
  promotion's DFS classification unresolved; the `logs/` vs `sessions/`
  doc-process mismatch; the `Top_Ten` sim-vs-postmortem distinction — all
  still open, unchanged this session.
- Kings still structurally can never be captured as the King piece itself
  (checkmate ends the position first) — unrelated to Task 19's
  never-moved-piece work, not touched.
