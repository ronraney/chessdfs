# 10132026 — Projection totals, opening piece-preview, and the captures rewrite

## Context

Picked up after the popularity-data/aggression-scale session (144 tests,
see `10122026-popularity-data-and-aggression-scale.md`). Three tasks
landed: 16 (projection totals), 17 (opening piece-preview data, sent
twice — the second was an exact duplicate), and 18 (play-test fixes).
Task 18 also triggered a real process change mid-session: `RULES.md`
turned out to have been removed, and `CLAUDE.md` was updated to make
the task prompt itself the spec. Ended at 164 tests.

## What was done

### Task 16 — projection totals

Added `cli.proj_total(state, side)` (sum of a side's locked players'
`.proj`). `_side_stats`/`format_salary_ownership_table` gained a third
row, "Core projection: X pts", next to Salary Remaining and Core
ownership, both sides, every White turn. `_prompt_player_choice` gained
a required `preview_base: float` parameter and a `-> {total} total pts`
column per candidate row — updated all 6 call sites with the right
base: `0.0` for the very first pick (`_prompt_and_place_kings`, before
any `BuildState` exists), the running total for an ordinary pick, the
running total *plus* the just-chosen-but-not-yet-applied QB's own
projection for an EMERGE-mode castle's RB half (same move, same lock),
and the running total *minus* the outgoing King's projection for the
one-time QB-switch offer (a swap, not an addition). `_print_ending`
already printed "Total projection" for the final core (pre-existing,
Task 13b era) — added a dedicated test for it since none had existed.

Tests: 144 → 149. New: `proj_total` sums correctly; the table shows
both sides' totals; the pick-preview equals `preview_base + proj`; the
ending shows White's total; a capture (via `rules.apply_move` at the
time) moves the captured player's projection from one side's total to
the other's with nothing invented or lost — this last test had to be
rewritten in Task 18 once the capture mechanics themselves changed
(see below).

### Task 17 — opening preview data (sent twice)

`openings.py` gained `OpeningPreview` (fen, white_pieces, black_pieces,
break_ply) and `opening_preview(line: BookLine, sport: SportConfig) ->
OpeningPreview` — the task text said `opening_preview(line)`, but
`sport` is required, same as `legal_depth` (which `opening_preview`
calls directly for `break_ply`, rather than re-deriving it). Walks
`line.moves` once for the FEN and each side's ordered piece-type
sequence (castling = King then Rook, same convention `legal_depth`
already used).

Wiring this into `cli.py`'s setup screen surfaced a real, previously
latent bug: `_proxy_player` indexed `eligible[piece]` directly, which
`KeyError`s the moment a sport's `piece_bands` doesn't cover some
`Piece` type at all — legal per the engine's own rules (only a PAWN
catch-all band is required to load). Nothing had ever called
`legal_depth` from a live code path before; `opening_preview`'s cli.py
wiring was the first, and it crashed immediately against the test
suite's intentionally minimal `TOY_SPORT` fixture (PAWN band only).
Fixed via `.get(piece, frozenset())` — a missing band now means "no
eligible positions at all," which `max_assignable` already treats as
unassignable, so the line correctly reports breaking at that ply
instead of crashing. Added a direct regression test for this
(`test_legal_depth_handles_a_sport_missing_a_piece_band`).

`cli.py` gained `_format_piece_sequence()` (collapses an adjacent
King+Rook pair to the single word "Castle" for display, per the task's
own example "Pawn, Knight, Bishop, Castle" — the structured data in
`openings.py` itself keeps them as two separate entries, matching
`legal_depth`'s convention; only the CLI's display collapses them).
`_prompt_for_opening_setup` now takes `sport` and prints each of the 12
options' White piece-type sequence beneath the family/variation lines.

Tests: 149 → 155. The three required: Ruy Lopez Morphy Defense (`e4 e5
Nf3 Nc6 Bb5 a6`) → White `Pawn, Knight, Bishop`; a real castling line,
Italian Game: Classical Variation, Albin Gambit (`e4 e5 Nf3 Nc6 Bc4 Bc5
O-O Nf6 c3`) → `Pawn, Knight, Bishop, King, Rook, Pawn`; Najdorf →
`break_ply == 9` (matches `legal_depth`'s already-proven value). Plus
the `_proxy_player` regression test and cli-level tests for
`_format_piece_sequence` and the setup screen's display. Verified live
against real data (field_size=1000, seed=1): the setup list showed real
sequences like "Pawn, Knight, Bishop, Bishop, Castle, Bishop" for a Ruy
Lopez variation, "Castle" rendering correctly where castling occurred.

Task 17 arrived a second time, verbatim, immediately after. Checked
concrete state (164 — no, 155 at that point — tests still passing,
`openings.opening_preview`/`cli._format_piece_sequence` both present
and wired exactly as before) and reported back that it was already
done rather than redoing any work.

### Mid-session: RULES.md removed, CLAUDE.md rewritten

Task 18's prompt said "Read RULES.md first (note the updated 'Captures'
rule)." A fresh read (via `cat`, bypassing any tool cache) showed
`Rules.md`'s "Captures (Crazyhouse)" paragraph completely unchanged
from every earlier session — still "The captured player leaves the
opposing side and joins the capturing side's lineup," i.e. the OLD
two-pick rule — directly contradicting the task's own description of a
new one-pick rule ("the captured player IS the capturing move's pick;
the capturing piece locks no new player"). Per the CLAUDE.md in force
at the time ("Project rules live in the repo's spec doc... it is the
source of truth... never change rules on your own... stop and ask
before building" on a contradiction), stopped and asked the user to
resolve it before writing any code.

The user's response updated `CLAUDE.md` on disk. The new version drops
the "Project docs"/RULES.md-as-source-of-truth section entirely,
replacing it with a "## Rules" section: "The prompt is the spec. When a
prompt changes behavior, implement it exactly as written, even if it
changes earlier behavior, and update the affected tests" and "The
existing code and tests are the record of all earlier rules." The
"stop and ask" trigger changed from "contradicts the project docs" to
"contradicts existing behavior or tests." The user then confirmed
directly: `Rules.md` has been removed (confirmed via `ls` — only
`CLAUDE.md` remains at the repo root); proceed with Task 18 as written,
including the new capture rule, and update the Task 16 capture tests
accordingly.

This is a deliberate, standing process change for the project, not a
one-off answer — there is no separate rules doc anymore. Task prompts
and the existing code/tests are now the record. Flagged here and in
HANDOFF.md so a future session doesn't go looking for a `RULES.md`
that no longer exists.

### Task 18 — play-test fixes

**Captures, rewritten.** `rules.py`: removed `apply_capture` (the old
"transfer on top of the mover's own new pick" function) entirely. Added
`is_legal_capture(state, chess_move, sport, contest) -> bool` and
`apply_capture_move(state, chess_move, sport, contest) -> BuildState`:
the captured player IS the capturing move's only pick, for either side,
regardless of which piece did the capturing — no separate new pick, no
pick prompt. `is_legal_move`/`apply_move` now reject every capture
outright (`if state.board.is_capture(chess_move): return False` /
raise), directing callers to the new functions.

`build.py`: removed `_would_lose_a_never_moved_piece` and all 4 call
sites (`check_white_dead_end`, `move_is_completable`,
`play_black_move`'s free-choice fallback, `play_black_template_move`) —
fully redundant now, since `is_legal_capture` (reached via
`_resolve_players`) already returns `False` for a captured piece with
no lock history, so `_resolve_players` already returns `None` for it;
the separate pre-filter was pure duplication once captures got their
own branch. `_resolve_players`/`_apply_resolved_players` gained a
capture branch ahead of the King-in-PLACED-mode check.
`play_white_move`'s `white_player` parameter became `Player | None`
(`None` for a capture — there's nothing a caller could have prompted
for).

**Side effect worth flagging**: this resolves the "King captures in
PLACED mode are unsupported" gap flagged in two earlier sessions'
"Where We're Headed" (`10112026-rules-engine-build-and-sim-metrics-
investigation.md`, `10122026-templates-book-exit-king-modes.md`). The
old limitation existed specifically because PLACED mode needed to
suppress the King's own new pick while *still* doing the Crazyhouse
transfer, and there was no primitive for "transfer only." Task 18
removes the mover's own pick from *every* capture, so that conflict no
longer exists — a King capture in PLACED mode now Just Works, confirmed
by a new dedicated test (`test_king_capture_in_placed_mode_now_works`,
built directly from a custom FEN since a real King-captures-something
sequence is awkward to reach via normal play).

**Pick-list paging.** `cli._prompt_player_choice` now shows
`PICK_LIST_PAGE_SIZE` (15) candidates at a time — `'m'` reveals the
next 15, `'s'` prompts for a name substring and lists matches, `'b'`
still backs out (free play only). Numbering never changes: it's each
candidate's fixed 1-indexed position in the one sorted list computed
once up front, so paging or searching only changes what's *displayed*,
never what a given number means.

**Capture handling moved in `cli.py`.** Both `_play_white_template_move`
and `_play_white_free_turn` now check `state.board.is_capture(chess_move)`
*before* the PLACED-mode King check (previously the King check came
first and explicitly blocked King captures with "a King can't capture
once placed" — removed, since it's no longer true). A capture now goes
straight to `play_white_move(state, chess_move, None, ...)` with no
pick prompt at all.

**Check notice.** New `cli._print_check_notice(state)`: "You're in
check" or "Black is in check" depending on `state.board.turn`, printed
only when `state.board.is_check()`. Called from inside
`_print_turn_header` (White's case — the header is redrawn before every
White turn regardless of free-play or template mode, so this covers
whatever prompt follows it generically) and directly in
`_run_one_build`'s main loop right before Black's move is resolved
(Black has no interactive prompt of its own, but this is the analogous
"about to move" moment, reflecting whatever check White's own move
might have just delivered).

**Capture message.** New `cli._capture_message(pre_state, post_state,
side) -> str | None`: detects a capture by checking
`pre_state.board.is_capture(post_state.board.move_stack[-1])`, then
reads the captured player off `moves[-1]` on the capturing side (always
correct, since `apply_capture_move` always appends exactly one Move
record). "You play exd5, capturing the Field's {name}." for White,
"Black plays exd4, capturing your {name}." for Black (the task's own
example wording, mirrored). Wired into `_run_one_build`'s main loop for
both sides, replacing the plain "locking" announcement specifically
when the move was a capture.

Tests: 155 → 164. Rewrote `test_rules.py`'s capture tests for the new
one-pick semantics (`test_capture_adds_exactly_one_player_the_
captured_one`, `test_is_legal_move_rejects_every_capture`, updated
transfer/overflow/never-moved tests to call `apply_capture_move`/
`is_legal_capture` directly); updated two stale comments describing the
old two-pick mechanics (`test_build.py`'s infeasible-capture test,
`test_rules.py`'s feasibility-test-section header) without changing
their assertions, which were already correct; rewrote Task 16's
capture-projection test (`test_capture_moves_the_captured_players_
projection_between_sides`) to use `apply_capture_move` with no mover's
own pick; added the King-capture-in-PLACED-mode test; added 9 new
`test_cli.py` tests — no-pick-prompt capture (via a synthetic 1. e4 d5
2. exd5 template, chosen specifically so Black's reply is deterministic
rather than depending on its own book-choice heuristics), the exact
capture-message text, three pick-list-paging tests (initial 15-cap,
"m" reveals more with stable numbers, "s" search keeps original
numbers), and three check-notice tests (White via the real turn
header, Black via the standalone helper, silence when not in check).

**Verified live, not just via tests**: `1. e4 e5 2. Qh5 Nc6 3. Qxe5+`
against the real NFL sample data produced exactly "You play Qxe5+,
capturing the Field's Luther Burden III." immediately followed by
"Black is in check," with zero pick prompt for the capture and correct
projection totals/Player-Field table throughout (White's core
projection jumped from 42.6 to 55.3 pts in that one move, matching
Jahmyr Gibbs's existing total plus Luther Burden III's own projection).
Also ran `tools/sim_builds.py`'s full 1000-build stress test
(`PYTHONHASHSEED=0`) against the real NFL player pool end to end —
completed cleanly, exit 0, no crashes. Its reported stuck-build rate
(159/1000: 75 White-stuck, 84 Black-stuck) differs materially from the
41/1000 the `10122026-templates-book-exit-king-modes.md` log reported
for the same tool — expected, not a regression: both the capture rule
(this task) and Black's own selection logic (Task 15's aggression scale
replacing the old temperament weighting) have changed since that
earlier run, so the underlying build dynamics are genuinely different
now, not broken.

## Open threads

- `openings.book_weights()` / `loaders.load_popularity()` /
  `data/openings/popularity.json` still have no engine caller (flagged
  last session, unchanged this one).
- `tools/sim_builds.py` and `tools/task11f_black_stuck.py` still carry
  docstring/comment narrative referencing "RULES.md" by name (as
  history of what a past task's fix addressed) — left alone; accurate
  as history, and `RULES.md` no longer exists as a live doc for a
  reader to actually go open.
- No dedicated `contest_type` (GPP/H2H) field in `ContestConfig`; pawn
  promotion's DFS classification unresolved; the `logs/` vs `sessions/`
  doc-process mismatch; the `Top_Ten` sim-vs-postmortem distinction —
  all still open, carried forward unchanged.
- Exact prompt/message copy throughout the CLI — including this
  session's new check-notice and capture-message wording — is still a
  reasonable guess, not a confirmed UX decision, same standing caveat
  as every prior session's prompt text.
- Kings still structurally can never be captured in the sense of the
  King *piece itself* being the captured one (checkmate ends the chess
  position first — an emergent fact, not a bug). This is unrelated to
  the PLACED-mode King-*captures*-something gap this session resolved;
  don't conflate the two if revisiting either.
- The process shift itself (no more `RULES.md`; the prompt is the spec;
  code/tests are the record of established behavior) is now standing
  practice, documented in `CLAUDE.md` directly — not something to
  "resolve," just something a future session needs to know going in,
  since every prior session's logs (including this one, above) still
  talk about `RULES.md` as the source of truth for the work done
  *at the time*.
