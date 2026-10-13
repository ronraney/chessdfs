# 10122026 — Opening templates, book exit, dead ends, and King modes

## Context

Picked up this session after an earlier one today had already gotten the
board-state-through-CLI-runner engine working (90 tests, see
`10122026-board-state-through-cli-runner.md`). `RULES.md` had been updated
between sessions — by Ron, presumably from that session's proposals — to add
a "core, not a full lineup" framing, a "King modes" section, the "stop with
the core" ending, unified dead-end wording, and per-turn salary/ownership
display, none of which existed in the engine yet. Four tasks landed this
session: 11f (analysis only), 13, 13b, and 14 (the last three built out
everything RULES.md had just described).

## What was done

### Task 11f — stuck-build analysis (no engine changes)

Wrote `tools/task11f_black_stuck.py` (reusing `tools/sim_builds.py`'s
helpers) to list every seed-1–1000 build where Black had no legal move, for
two White strategies: Run A (White plays random legal moves, matching
`sim_builds.py`) and Run B (White follows a randomly-chosen book line, then
free play). Had to re-run once in the background after my own `| head -200`
silently truncated Run B out of the first attempt's output.

Results: Run A — 41/1000 stuck (9 board-cause, 32 salary-cause). Run B —
40/1000 stuck (20 board, 20 salary). Zero `roster`/`exclusivity`-cause cases
in either run, and no build hit more than one cause. Full per-case detail
(seed, move list, opening name, cause, open slots, remaining salary) was
reported in chat, grouped by cause with board cases first, per the task —
not saved to a file. Reproducible via `PYTHONHASHSEED=0 python
tools/task11f_black_stuck.py`.

### Task 13 — opening templates + Black commits to lines

Replaced Black's old per-move behavior (re-roll a weighted continuation at
every single ply, no memory) with line-level commitment, per RULES.md
"Black (the field)": `build.play_black_move` now picks one full book line
among every line matching the moves so far — weighted by popularity/
temperament, excluding any whose next move Black can't actually play — and
plays that exact line until it runs out or White's own move leaves it, only
re-choosing then. `BuildState` gained `black_committed_line: tuple[str,
...] | None` to carry this across turns (through `rules._with_board_state`
and `apply_capture`, which had to start preserving it like everything else).
New public `build.play_black_template_move` mirrors this for template mode:
same highest-proj placeholder pick, but the move itself is handed in, not
chosen.

`openings.py` gained two pure lookups: `find_opening_lines` (name search)
and `continuing_lines` (lines still matching from the current position).
`cli.py` got the actual opening-template UI on top of these: a search/pick
screen at build start, both sides' moves driven exactly while a template is
active (Black via `play_black_template_move`, White still prompted for which
player), and a numbered continuation picker once the template ends or goes
DFS-illegal, falling straight to free play if nothing matches.

Tests: +5 `test_openings.py`, +6 `test_build.py` (template-exact play,
commitment persistence proven across 30 varied seeds — not just one trial —
re-choice on White deviation, multi-ply determinism), +1 new + 3 updated
`test_cli.py`. 107/107 passing.

Manual smoke-test against real NFL data (Ruy Lopez → Benelux Variation →
"Modern Main Line") turned up what looked like an infinite loop: the
continuation picker kept re-offering `Bg5`, which was DFS-illegal (White's
roster had no WR/FLEX room left). Traced it with a throwaway diagnostic
script and confirmed it wasn't a bug — the picker re-offering a line that's
still a legitimate (if futile) choice matches RULES.md's literal wording,
and a blank answer correctly escapes to free play. That gap in the UX (an
already-known-infeasible suggestion being re-offered) is exactly what Task
13b's continuation filter fixed for real — see below.

### Task 13b — template fixes, book exit, dead ends, salary display

- `_prompt_player_choice` gained `allow_cancel`; `False` (used in template
  mode) makes `'b'` re-ask the same question instead of ending the template.
- New `build.move_is_completable` (same feasibility `_resolve_players`
  already used internally, now exposed) lets `cli._prompt_for_continuation`
  filter the continuation list to only lines that are actually playable —
  this is what makes the `Bg5` scenario above show zero continuations and go
  straight to the book-exit prompt now, instead of looping.
- New `_prompt_book_exit`: "There is no longer an opening line. Would you
  like to continue, or start again?" — `continue` falls to free play,
  `again`/`start again`/`restart` returns a `RESTART_BUILD` sentinel.
  `cli.run` now wraps a new `_run_one_build` in an outer loop, catching a new
  `_RestartBuild` exception to retry.
- `_play_white_free_turn` accepts `'stop'` to end the build immediately with
  whatever's locked so far ("Happy Hunting" regardless of completeness).
- Unified `_print_dead_end(side, open_slots)` replaces the old White-only "No
  legal moves. Lineup incomplete: ..." message and — this was a real,
  previously-uncaught crash — Black's `RuntimeError` from
  `play_black_move`, which `run()` never caught before this. New wording:
  "Black has hit a dead end."/"You have hit a dead end." then "The build
  process is done. Happy Hunting.", open slots shown if White's incomplete.
- `_print_turn_header` now shows `format_salary_ownership_table`: remaining
  salary + average per open slot, core ownership (sum of locked players'
  `own_for(field_tier)`), both sides, replacing the old White-only single
  salary line.

Found one real bug while re-testing: `_prompt_book_exit`'s question text was
only ever passed as `input_func`'s prompt argument, never `print()`ed — so
it was invisible to any `input_func` that doesn't echo its prompt (my own
test doubles, and not guaranteed for a real one either). Fixed by printing
the question explicitly and giving `input_func` just a short
`"(continue/again): "`.

Tests: +8 new `test_cli.py`, 2 existing ones fixed (dead-end wording, Task
13's template test needed an extra book-exit step). 115/115 passing.
Re-confirmed against real data that the `Bg5` scenario now correctly shows
0 continuations and goes straight to the book-exit prompt.

### Task 14 — King modes

Before building, flagged a direct contradiction to the user: RULES.md says
King mode is chosen "before the opening"; the task said "after choosing the
opening." Confirmed: RULES.md is correct (King mode first, then the
opening), and the one-time "Switch your QB?" offer is White-only — Black
never switches (left for the simulator later).

- `models.py`: new `KingMode` enum (`EMERGE`/`PLACED`); `BuildState` gained
  `white_castled`/`black_castled` — needed because in PLACED mode a locked
  King is present *from setup*, so `can_castle` can no longer tell "already
  castled" apart from "King present" by piece-type alone the way it used to.
- `rules.py`: `can_castle`/`castle` both gained `king_mode` (default
  `EMERGE`, so every existing call/test kept working untouched). New
  `switch_king` (frees the old QB back to the pool, validates the new one
  fits — roster shape never changes, only salary can actually reject it) and
  `place_kings` (locks both sides' QBs before move 1; no chess move, no SAN
  — `Move.san="(placed)"` is a placeholder, never displayed).
- `build.py`: `king_mode` threaded (default `EMERGE`) through
  `_resolve_players`, `_best_legal_castle_players`, `check_white_dead_end`,
  `move_is_completable`, `_is_move_playable_for_black`,
  `_playable_book_moves`, `_choose_black_committed_line`, `play_white_move`,
  `play_black_move`, `play_black_template_move`. New `_apply_resolved_players`
  centralizes the castle/silent/normal dispatch — needed because
  `_resolve_players` can now return a 2-tuple (EMERGE castling), 1-tuple
  (PLACED castling, or any normal move), or empty tuple (PLACED-mode silent
  King move), and the old "dispatch by `len(players) == 2`" trick breaks
  once a 1-tuple can mean two different things.
- `cli.py`: `_prompt_for_king_mode` (before the opening search, per the
  confirmed order); `_prompt_and_place_kings` (White picks from a QB list
  sorted by projection with salary/ownership; Black auto-picked, highest
  proj excluding White's); `_offer_king_switch`; `_play_castling_move`
  (shared by template and free play, mode-aware — EMERGE prompts QB then RB,
  PLACED prompts RB only, then offers the switch); `_play_silent_king_move`
  (routes a plain King move in PLACED mode through `rules.push_silent_move`).
  Restart now increments the seed (`current_seed += 1` per `_RestartBuild`
  catch) instead of reusing it, satisfying "with `--seed N`, use N+1, N+2,
  ... per restart."

Tests: +8 `test_rules.py` (`place_kings` validation, `can_castle`/`castle`
in PLACED mode locking only the Rook and blocking re-castling via the new
explicit flag, `switch_king` success + cap-overflow rejection), +2
`test_build.py` (silent King move via `move_is_completable` and
`play_black_template_move`, both with deliberately empty player pools to
prove nothing needs resolving); 7 existing `test_cli.py` tests updated for
the new leading King-mode prompt. Along the way caught my own wrong
assertion in the restart test — it expected "Seed: 42" twice, but the
*correct* behavior (which was actually working) prints 42 then 43. Fixed the
test, not the code. 125/125 passing.

Manually confirmed end-to-end against real NFL data: placed Jared Goff as
White's QB (Black auto-got Jacoby Brissett, visible in the Player|Field
table before move 1), played e4/Nf3/Bc4 normally, castled — the prompt asked
only for an RB, never a QB — got the switch offer immediately after with a
candidate list correctly excluding both already-locked QBs, declined it,
and confirmed Goff was still White's QB in the next turn's header.

## Open threads

- **King captures while placed are unsupported.** A King move that's also a
  capture, in PLACED mode, makes `_resolve_players` return `None` (not
  playable) rather than performing the normal Crazyhouse transfer without a
  new King lock — there's no clean way to do only the latter with
  `push_silent_move`/`apply_move` as they exist. Flagged in `build.py`'s own
  docstring; no test covers it; not expected to come up in practice, but a
  real gap if it matters later.
- Exact accepted strings at the King-mode prompt (blank → `emerge`),
  book-exit prompt, and switch-QB prompt weren't specified anywhere — I
  picked short, consistent wording matching the existing prompts' style.
  Worth a look if the real UX copy matters.
- Task 11f's full 81-case breakdown (both runs, complete move lists) only
  lives in that chat reply, not a file — rerun
  `tools/task11f_black_stuck.py` (same `PYTHONHASHSEED=0` invocation) to
  regenerate it if it's needed somewhere durable.
- Noticed, not acted on: the Task-13 redesign incidentally fixed the
  `PYTHONHASHSEED` reproducibility gap `tools/sim_builds.py`'s docstring
  flags for Black's book choice — the new committed-line code samples from a
  list built by iterating the book's own (hash-independent) list order, not
  a dict/set built from `book_continuations`. Not verified against
  `sim_builds.py` itself (untouched this session), just worth knowing if
  anyone goes looking for why that old caveat doesn't reproduce anymore.
- Carried forward, unchanged this session: Lichess Opening Explorer 401
  (still blocked), no dedicated `contest_type` field on `ContestConfig`,
  Kings structurally uncapturable (emergent, not a bug), pawn promotion's
  DFS classification unresolved, the `logs/` vs `sessions/` doc-process
  mismatch (Ron still needs to pick one), and the `Top_Ten`
  sim-vs-postmortem distinction. See the two 10112026 logs and the previous
  10122026 log for full detail on each.
