# 10112026 — Rules Engine Build, Captures, and Sim Metrics Investigation

## Context

Continuation of today's first session (Task 1 scaffold + the `wrap-up` skill's
own creation — see `10112026-core-engine-scaffold-and-session-handoff-skill.md`
for that half). From here, CLAUDE.md went through several rounds of real
rewrites mid-task, and `rules.py` went from a stub to a fully exercised
legality engine.

## CLAUDE.md evolution this session (each landed mid-task, not at a clean boundary)

- Piece rules rewritten to half-open bands + Pawn-as-catch-all (prompted Task 1b).
- Ownership resolved: `Small Field`/`Large Field`, stored as 0-1 fractions;
  names trimmed on load (prompted Task 3).
- Castling resolved: King+Rook, one move, requires locked Knight+Bishop,
  at most once, no same-team requirement.
- **Big one:** "No win condition... single-lineup builder" language first
  suggested Black has no roster of its own — I built Task 3 that way (roster/
  salary checks White-only). CLAUDE.md was then corrected to say Black builds
  its **own** complete, legal DK lineup under the same rules — Task 3b
  reverted the White-only branch in the same files before Task 3 was ever
  reported as genuinely final. Documented explicitly in `Tasks.md` so the
  reversal doesn't look like two independent, contradictory decisions.
- Repo name for the "Later" port target corrected from `rraney/nfl` to
  `rraney/nfl-dfs` (the actual location, confirmed via `git remote -v` —
  `rraney/nfl` has zero matches for any of the sim metrics).
- Biggest structural change: the two-phase "Opening → Draft" model was
  dropped entirely in favor of **"Move flow (no separate phases)"** — every
  turn is a chess move on the board; the piece type moved filters eligible
  players by position/salary band; that side locks one. Captures became
  explicit **Crazyhouse**: captured player leaves the opponent's lineup and
  joins the capturer's, no turn cost, illegal if it breaks the capturer's
  roster/salary. Objective/contest-type sections added (target finish,
  GPP/H2H, which sim metrics Black optimizes toward).
- All Open Questions present at various points this session were resolved
  by these rewrites — the section is empty as of the latest read.

## Task 2 — Lock ETR column map

Mapped `loaders.py` to the real sample headers (`DK Salary`, `DK Pos`, `Small
Field`/`Large Field`, `DK_ID` not `id`). Added `ContestConfig.field_tier()`
and `Player.own_for(tier)`. Caught and fixed my own earlier row-count error
(301 real rows, not 300 — a `wc -l` undercount from a missing trailing
newline).

## Task 3 / 3b — rules.py: exclusivity, castling, roster/salary

Built `is_legal_move`, `apply_move`, `can_castle`, `castle` in `rules.py`.
Roster/salary feasibility is a count-based overflow check (`_lineup_still_
completable`): QB/DST capped at 1 (no FLEX coverage), RB/WR/TE's combined
excess over their dedicated minimums (2/3/1) capped at 1 (only one FLEX slot
exists — this took a moment to get right: a naive "combined total <= 7"
check wrongly allows two positions to simultaneously overflow their own
minimums, which isn't actually feasible with just one FLEX slot). Initially
scoped to White only, then made symmetric for Task 3b once CLAUDE.md
confirmed Black needs a real lineup too.

## Task 4 — sim metrics investigation (read-only, `rraney/nfl-dfs`)

`Cash_Rate`, `Top1pctScore_ROI` (user wrote "Top1PctScore"), and
`Bottom99pct_ROI` are all live Monte Carlo trial-loop outputs in
`sim_trial_loop.js` (`aggregateSimResults_`/`computeTopBottomRoi_`) — real
numbers computed for a **not-yet-played** candidate lineup. `Bottom99pct_ROI`
specifically exists to keep the top ~1%-by-payout trials (floored at a
minimum of 30 trials to avoid a documented saturation artifact at low trial
counts) from burying what a *typical* trial actually returns, inside one
blended `Sim_ROI` average.

The one real surprise: `Top_Ten` is **not** part of that sim subsystem at
all. It only exists in `lineup_features.js`/`lineup_runner.js` as a
real-contest-postmortem classifier — whether an **already-played,
already-graded** lineup's actual rank landed in the real top 10% of that
contest's field. No simulated "Top 10%" ROI counterpart exists to port.
Flagged in `Tasks.md` Follow-ups and in CLAUDE.md's "Later" section as
net-new simulation work, not a port, if ever wanted.

## Task 5 — Move flow + Crazyhouse captures

`Move` gained a `san: str` field. `apply_capture` implemented for real:
locks the mover's own new pick via the existing `apply_move` path, then
transfers the named captured player from the opponent's lineup onto the
capturer's, atomically — illegal if that second addition breaks the
capturer's roster/salary feasibility. `GameState` still has no explicit
turn-sequencing concept, so "capture doesn't consume the turn" is tested
indirectly (one `apply_capture` call grants the capturer both players, not
split across two calls) rather than against a real turn counter. Castling's
two `Move` records now both carry `san="O-O"` — a simplifying assumption,
since nothing in CLAUDE.md distinguishes kingside/queenside here.

## Where things stand

- `dfs_chess/{models,pieces,config,loaders,rules}.py` all implemented;
  `rules.py` is the only one that went through a real design iteration
  (White-only → symmetric) rather than landing right the first time.
- 56 tests passing (`tests/test_{pieces,config,loaders,models,rules}.py`).
- No git repo yet in `chess-dfs/` — still true, `.gitignore` exists
  (`.venv/`) in anticipation.
- `Tasks.md` has Tasks 1 through 5 (plus 1b, 3b) all `[DONE]`; Follow-ups
  holds the row-count note and the `Top_Ten` sim-vs-postmortem distinction.

## Open threads

- No Lichess book integration yet (explicitly deferred, Task 5 said so
  directly) — Black currently has no real move-selection logic at all,
  despite CLAUDE.md now fully specifying how it should work ("Move flow,"
  book-following, falling back to free play once no line matches).
- No UI, no notation rendering, no phase/turn tracking in `GameState`.
- Castling SAN (`"O-O"` for both records) is an assumption, not confirmed.
- `loaders.py`'s column map is locked against the one real sample on disk —
  still unverified against any second real export.
