# 10122026 — Board state through CLI runner

## Context

Picking up from 2026-10-11's handoff: `rules.py` had a full, tested legality
engine (`is_legal_move`, `apply_move`, `can_castle`, `castle`,
`apply_capture`), 56 tests passing, but no real `chess.Board`, no Lichess
opening-book integration, and no code at all generating Black's moves.
CLAUDE.md (the then-single source of truth) still called the mechanic a
"game." This session ran Tasks 6 through 11 back to back, plus a mid-session
governance restructuring (Task 10b) that split the project's doc into a
process file and a rules file and renamed the core mechanic from "game" to
"build" throughout. Ended at **90 tests passing**, run 3x with no flakiness.

## What was done

**Task 6 — Board state.** Added `chess` (python-chess) as the project's
first real dependency. `GameState` (as it was called then) gained a real
`board: chess.Board` — turn order now comes from `board.turn`, not a
separate counter — and `piece_locks: dict[square, list[Player]]`, tracking
which players each on-the-board piece has locked across its moves.
`is_legal_move`/`apply_move` changed shape to take a `chess.Move` + `Player`
instead of a freely-labeled `Move` record; legality now requires BOTH real
chess legality (`board.legal_moves`) and the existing DFS checks. SAN comes
from `board.san()` (resolving the old open question of hardcoded `"O-O"` for
both castling sides — it's `board.san()`-derived now, correctly distinguishing
`O-O`/`O-O-O`). `apply_move` auto-detects board captures (including en
passant) and transfers the most-recently-locked player from the captured
piece's `piece_locks` history; an empty history (piece never moved) raises
`NotImplementedError`, deliberately left unresolved per CLAUDE.md's open
question at the time.

**Task 6b — Restore feasibility coverage.** Task 6's rewrite had dropped
several Task 3/3b/5 regression tests (FLEX overflow, second-DST, castle/
capture cap and roster overflow) because re-deriving them through real
chess move sequences was expensive. Re-added all of them as *direct* tests
of `_lineup_still_completable` — plain `Player` lists in, `bool` out — since
that's the one function every call site actually delegates to.
`castle_respects_exclusivity` was the one regression still missing after
this task.

**Task 7 — Multi-sport ready.** `config/sports/nfl.json` + `dfs_chess/
sport.py` (`SportConfig`/`PieceBand`/`RosterSlot` + loader) replaced
hardcoded NFL constants in `pieces.py` and `rules.py`. The old ad hoc
FLEX-counting arithmetic in `rules.py` was replaced with `max_assignable()`
— a genuine maximum bipartite matching (Kuhn's algorithm) over
`sport.roster_slots` — which also, for free, subsumed the old dedicated
"unknown position" check (no slot matches → unassignable). `Player.pos: str`
became `Player.positions: tuple[str, ...]` (tuple specifically so `Player`,
frozen and otherwise hashable, stays hashable). `castle_respects_exclusivity`
got restored here too, via a hand-built `GameState` over a
`chess.Board(fen=...)` rather than a played-out sequence.

**Task 7b — Config cleanup.** `ContestConfig.cap` became `int | None`,
defaulting to `sport.salary_cap` via a new `effective_cap(sport)` method.
`load_sport_config` now rejects any sport config with no catch-all piece
band at load time, which let `classify()` drop its defensive `ValueError`
entirely — the "every player classifies" guarantee moved from code to a
load-time data check.

**Task 8 — Opening book.** Vendored `a.tsv`–`e.tsv` and `COPYING.txt` from
`github.com/lichess-org/chess-openings` (**CC0 1.0 Universal** — public
domain, no attribution required) into `data/openings/` — ~3865 rows across
the five files. New `dfs_chess/openings.py` (pure): `BookLine`,
`opening_name()` (longest matching prefix), `book_continuations()`, and
`legal_depth()` — a piece-type-only feasibility pre-scan reusing
`rules.max_assignable` (promoted from `_max_assignable` to public for this).
Verified against real named lines: Ruy Lopez names correctly; the Najdorf
(`1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6`) breaks at ply 9 and
the Fried Liver Attack at ply 10 — both at each side's *third* Knight-type
pick, which checks out exactly against `nfl.json`'s roster shape (`TE`×1 +
`FLEX`×1 are the only two slots a Knight-tier pick can occupy).

**Task 9 — Book popularity snapshot.** Built `tools/fetch_popularity.py`
(stdlib-only, not part of the engine) to fetch Lichess Opening Explorer move
counts for every one of the ~6313 unique positions in the vendored book.
**The explorer API is not actually reachable right now.** First pass: both
`explorer.lichess.ovh` and the documented `explorer.lichess.org` returned a
bare nginx `401 Authorization Required` with no `WWW-Authenticate` header
and no JSON body for every query path (`/lichess`, `/masters`) — not
lichess's normal API error shape, looking like an HTTP Basic Auth gate at
the reverse proxy rather than lichess's own OAuth2. Confirmed again later
this session with a **real user-provided personal API token** (via `.env`,
`LICHESS_API_TOKEN`, read by the script, never printed) sent as a Bearer
header: still a flat 401. So this isn't a missing-token problem — a personal
API token is simply not the credential this gate wants. `data/openings/
popularity.json` stays `{}`. `loaders.load_popularity()` and `openings.
book_weights()` were built and tested against synthetic fixtures regardless
(deliberately not depending on the real, empty file, so the tests stay
deterministic either way).

**Task 10 — Build loop + Black's book moves.** `dfs_chess/game.py` (as it
was named then): `play_white_move`/`play_black_move`, each returning a
`MoveResult(state, opening, message)`. Black, while in book, picks among
`book_continuations` weighted by `book_weights()` run through a
"temperament" exponent (`count ** k`); out of book, any legal move,
uniformly. `ContestConfig` gained `temperament: dict[FieldTier, float]`
(placeholder `{SMALL: 2.0, MID: 1.0, LARGE: 0.5}`) and `temperament_k()`.
Black's within-band player pick is an explicitly-flagged TEMPORARY
placeholder (highest `proj`) pending the Monte Carlo sim port. Candidate
moves that would capture a never-moved piece are filtered out before Black
ever considers them (avoiding the Task 6 `NotImplementedError`).
Randomness only ever flows through an injected `random.Random`. Designing
the "game ends with both lineups complete" test surfaced a real
interaction CLAUDE.md's rules (at the time) didn't address: once a side
hits exactly `roster_size` players, every further move for that side is
DFS-illegal (a 10th-plus pick is always infeasible) — but chess's turn
order doesn't know that, so a side finishing first could deadlock the
other's next turn. Flagged, not fixed, in that task.

**Task 10b — Build end condition and rename.** This is the session's
biggest structural change, and it came from the user restructuring the
project's own doc set mid-session: `CLAUDE.md` was rewritten as a lean
"how to work with Ron" process doc (never edit, read the session-log
format, "do only the task in the current prompt"), and a new `RULES.md`
became the actual source of truth for game rules — explicitly stating "It
is a build, not a game: use 'build' in code and docs, never 'game,' except
when referring to chess itself." Concretely: `GameState` → `BuildState`
(`models.py`), `game.py` → `build.py`, `is_game_over` → `is_build_over`.
More importantly, the END CONDITION changed and directly resolved Task 10's
deadlock flag: **the build now ends when White's lineup alone is
complete** (`is_build_over` only checks `white_moves`), and "if Black's
lineup fills first, Black's board moves lock no player" — implemented as
new `rules.push_silent_move()` (pushes a legal, non-capturing,
non-castling move, relocating `piece_locks` but adding no `Move` record,
no new locked id). `build.play_black_move` now checks whether Black is
already full and, if so, restricts its own candidates to non-capture/
non-castling moves (both inherently lock a player, which no longer makes
sense once Black isn't drafting) and routes through `push_silent_move`
instead of `apply_move`/`castle`. `Tasks.md` (the per-task scratch log this
session had been using up to this point) was deleted per the task's
explicit instruction, with its accumulated Follow-ups migrated below
rather than lost.

**Task 11 — Command-line runner.** New `dfs_chess/cli.py`: `python -m
dfs_chess.cli --etr <csv> --contest <json> [--seed N]`. All I/O (argparse,
file loads, `input()`/`print()`) lives here — `run()` takes an injectable
`input_func` purely for testability, defaulting to the real builtin. Each
White turn prints the board (`str(board)`), move list, a Player|Field
table, the current opening name, and White's remaining salary, then prompts
for a SAN move and (for a regular move) one numbered player pick, or (for
castling) QB then RB in that order. Illegal move text, illegal/infeasible
picks, and the never-moved-piece-capture `NotImplementedError` are all
caught and re-prompt with a stated reason rather than crashing; missing
input files are also caught (`OSError`) and reported cleanly.

Building the test for this one surfaced the Task 10 deadlock concern again,
concretely: a hand-scripted attempt to walk a *real* 9-pick NFL build
through the CLI (seed 42, a ~40-player synthetic ETR pool) hit `RuntimeError:
Black has no legal move available` partway through — Black, with only 5
players locked (nowhere near full), ran out of moves whose required
piece-band still had an eligible, unlocked player in the small test pool.
Rather than fight that fragility, both `test_cli.py` tests instead
`monkeypatch` `cli.DEFAULT_SPORT_PATH` to a tiny 2-slot synthetic sport, so
a build completes in two predictable White picks with one real Black
auto-reply (`1. e4 b6`, Owen Defense) in between. `main()`/real users are
untouched by this — only the test overrides the default. The castling
prompt flow (QB then RB) was confirmed working by hand during that same
abandoned full-NFL experiment, but is not covered by an automated test —
flagged below.

## Confirmed vs. believed

- **Confirmed by actually running them**: all 90 tests pass, 3 consecutive
  full-suite runs with no flakiness. The Lichess Opening Explorer 401 (both
  without a token and with a real user-provided one). The CLI's full
  interactive loop end-to-end via piped stdin, both for the final toy-sport
  tests and for the abandoned full-NFL experiment (up to the point it hit
  the RuntimeError above).
- **Believed true, not independently re-verified by an automated test**:
  the castling CLI prompt order (QB, then RB) — verified once by hand, not
  in `test_cli.py`.

## Open threads

- **Lichess Opening Explorer access is still unresolved.** `data/openings/
  popularity.json` stays `{}`. The 401 behavior (no `WWW-Authenticate`, no
  JSON body, same for `/lichess` and `/masters`, same with or without a
  real personal token) doesn't match lichess's normal API auth failures —
  this looks like it needs someone with authority over that reverse proxy,
  not a different token or scope. The user separately left a note mid-session
  ("Task 9b — WAITING, run on a non-phone connection") about retrying
  later — carrying that forward verbatim since it was never acted on.
- **No dedicated `contest_type` (GPP/H2H) field exists** in `ContestConfig`.
  RULES.md's Data section describes contest type as part of the schema, but
  Task 10's "H2H uses SMALL temperament" requirement is satisfied purely
  because a real H2H's tiny `field_size` (2) already resolves to `SMALL`
  via the existing `field_tier()` logic — no field was added speculatively.
  Worth revisiting if something *other* than temperament ever needs to key
  off contest type directly.
- **Kings can structurally never be captured.** Real chess never allows
  capturing a king (checkmate ends the game first), and a QB-tier player
  can only ever be locked via an actual king move. So a locked QB-tier
  player can never transfer via the Crazyhouse capture rule — not a bug,
  just an emergent consequence of binding `Piece` to real chess piece type,
  worth knowing about.
- **Pawn promotion's DFS classification is unresolved.** `apply_move`
  classifies a move by the piece at its *origin* square, so a promoting
  pawn move (e.g. `e7e8q`) is treated as a Pawn-tier pick, not Queen-tier,
  even though a queen lands on the board. RULES.md doesn't address
  promotion at all; not fixed in code.
- **A real (if currently synthetic-pool-only) failure mode**: `build.
  play_black_move` raises a bare `RuntimeError` if literally every legal
  move for Black is excluded (never-moved-piece capture, or no eligible
  unlocked player for the required piece band) *and Black isn't full yet*
  — a different case from the Task 10b end-condition fix, which only
  covers the "already full" case. Hit once this session against a small
  ~40-player synthetic pool; untested against the real ETR-sized player
  universe, where it's presumably far rarer but not provably impossible.
- **Castling's CLI prompt flow (QB, then RB) is unverified by an automated
  test** — confirmed working by hand once; `test_cli.py` only covers plain
  moves. Building an isolated test would need a toy sport with TE/WR slots
  too (castling's Knight+Bishop prerequisite needs somewhere for those
  picks to land), which felt like more machinery than Task 11 called for
  given `castle()` itself is already well covered in `test_rules.py`/
  `test_build.py`.
- **A documentation-process mismatch, not a code issue**: CLAUDE.md's "Do"
  section says to write `logs/YYYY-MM-DD-<short-task-name>.md` at the end
  of each task; this `/wrap-up` skill instead writes to `sessions/<MMYY>/`
  plus `sessions/HANDOFF.md`. Both now coexist in the repo (an empty
  `logs/` directory exists from Task 10b). Followed this skill's explicit
  instructions for this invocation since that's what was asked; flagging
  the mismatch for Ron to reconcile rather than guessing which one is
  meant to win going forward.
- **`Top_Ten` is not a simulated metric** (carried forward from this
  session's earlier investigation, still unaddressed): unlike `Cash_Rate`/
  `Top1pct_ROI`/`Top1pctScore_ROI` (live Monte Carlo trial-loop outputs),
  `rraney/nfl-dfs`'s `Top_Ten` is a real-contest-postmortem classifier
  computed from already-graded standings CSVs. No simulated "Top 10%" ROI
  counterpart exists to port — building one means generalizing
  `computeTopBottomRoi_()`'s hardcoded 1%-with-30-trial-floor logic to an
  arbitrary percentile, which is new simulation work, not a port.
- **Resolved, not open**: Task 10's original "side completes first can
  deadlock the other's turn loop" concern is fixed by Task 10b's new end
  condition + `push_silent_move` — noting this explicitly so it doesn't get
  re-flagged later as still-open.
