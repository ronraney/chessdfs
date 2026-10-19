# 10192026 — Pieces sort by GPP metric (Rook = correlation)

## Context

Picked up on a clean `main` (after Tasks 42–43, commit `72daf62`), 198
pytest / ~340 Vitest passing (exact pre-session Vitest count not re-checked
before starting). One large prompt arrived, redefining every piece's pick
list: each piece sorts by a different GPP-relevant metric instead of a
blanket projection order, Rook becomes team-based ("correlation" with the
QB) instead of RB-only, Queen/Bishop/Knight tighten from "any non-QB" to
explicit RB/WR/TE, a per-piece list cap is introduced, and the ETR loader
gains two new mapped columns (`DK Floor`/`DK Ceiling`). Applies to both
engines, with parity fixtures and new test coverage required.

## What was done (commit `0e860b1`, "Rule change — Pieces sort by GPP metric")

### Design

- **New metric functions** (`dfs_chess/metrics.py` / `engine/metrics.ts`):
  `value` (proj/salary×1000), `floorValue` (floor/salary×1000), `leverage`
  (value × (1 − ownership)), and `sortMetric(piece, player, contest)` —
  King/Rook→projection (unchanged for King; Rook's own new rule), Queen→
  ceiling, Bishop→leverage, Knight→floorValue, Pawn→value.
- **New pick-list functions** (`dfs_chess/picklist.py` / `engine/picklist.ts`):
  `pick_list`/`pickList(piece, pool, lockedIds, currentPlayers, sport,
  contest, qbTeam?)` — filters to unlocked + classify-eligible +
  roster/salary-feasible (`lineupStillCompletable`), sorts by `sortMetric`
  descending, caps via `sport.listCapFor(piece)`. `castle_qb_candidates`/
  `castleQbCandidates` further restricts King's own list to QBs with ≥1
  eligible teammate (loops `pickList(ROOK, ...)` per King candidate).
  This is now the ONE place "eligible, sorted, capped" lives — both
  engines' Black auto-resolution and both UIs' pick lists go through it.
- **`classify()` gained a third param `qbTeam: str | None = None`** — a
  `PieceBand.team_restricted`/`teamRestricted` flag (new field, Rook only)
  makes that band match only when `qbTeam` is `None`/`null` (no QB locked
  — "list all RB/WR/TE") or equals the player's own team. Threaded through
  every `classify` call site that needs the moving side's context:
  `is_legal_move`, `castle` (uses the chosen/placed King's own team),
  `apply_capture_move`/`is_legal_capture`'s never-moved branch. A new
  `locked_qb_team(state, side)`/`lockedQbTeam` helper (in `rules.py`/
  `rules.ts`, not `picklist.py` — avoids a circular import since picklist
  already depends on rules for `lineup_still_completable`) looks up the
  side's own King move.
- **`config/sports/nfl.json`**: Queen/Bishop/Knight became explicit
  `["RB","WR","TE"]` bands (floors 7000/5000/4500 unchanged); Rook became
  `["RB","WR","TE"]`, no salary bound, `team_restricted: true`; new
  `list_caps: {QUEEN:12, ROOK:12, BISHOP:12, KNIGHT:12}` (King/Pawn
  omitted = uncapped). `_position_fully_covered`'s coverage check still
  passes without relying on Rook at all — Knight (≥4500) + Pawn (<5000)
  alone already cover [0,∞) for every RB/WR/TE position, which matters
  since Rook's own coverage is team-conditional and can't be relied on for
  the "every player classifies as something" invariant.
- **Castling** (`rules.py`/`.ts`, `build.py`/`.ts`): `castle()`'s Rook
  check now requires the Rook's team to match the EMERGE-mode chosen King
  or the PLACED-mode already-locked King. `build.py`'s
  `_best_legal_castle_players` rewritten entirely around the new
  primitives — PLACED mode takes the top of `pick_list(ROOK, ..., qbTeam)`;
  EMERGE mode takes the top of `castle_qb_candidates(...)`, then the top
  of that King's own teammate-restricted Rook list. Because both lists are
  already feasibility-filtered, this is a straight "take index 0" with no
  fallback search needed — simpler than the old nested-loop version it
  replaced.
- **PLACED-mode castling order flipped**: the one-time "Switch your QB?"
  offer now resolves *before* the Rook pick, not after (both `cli.py` and
  `BuildScreen.tsx`) — the Rook has to be a teammate of whichever QB ends
  up final, so the switch can't happen post-hoc anymore. In
  `BuildScreen.tsx` this collapsed the separate `switchOffer` state/
  `SwitchOffer` interface/`finalizeSwitch` function entirely into the
  `PendingMove` union (new `castlePlacedSwitch` → `castlePlacedRook`
  steps, the latter carrying a `baseState` — the switch result, or `state`
  unchanged if declined — since neither step commits to engine state until
  the Rook step actually locks something). Also let `commit()` drop its
  now-unused `deferBlackReply` option, since nothing needs to delay
  Black's reply past a switch anymore (the switch happens before commit,
  not after).
- **Loader** (`loaders.py`/`.ts`): `floor`/`ceiling` mapped from `DK
  Floor`/`DK Ceiling` (verified against the real sample CSV's actual
  header row); `Opp` strips a leading `@` (`"@ARI"` → `"ARI"`, home games
  like `"SF"` unchanged). `validate_etr_csv`/`validateSlateCsv`'s required-
  column list grew from 6 to 8.
- **`PickPanel.tsx`**: candidate rows sort by (and display)
  `sortMetric(piece, player, contest)` instead of always `proj`; the
  column header and "sorted by ..." subtitle read the piece's own metric
  name (`METRIC_LABEL`/`METRIC_NAME` maps) — e.g. a Bishop's column reads
  "Lev" and shows values like "2.31", a Queen's reads "Ceil". King/Rook
  still read "Proj" (their metric IS projection, so no visible change for
  those two pieces specifically).
- **`buildStats.ts`**: `eligiblePlayers` removed entirely (superseded by
  `engine/picklist.ts`) — its own test coverage moved to the new
  `picklist.test.ts`, not dropped.

### Flagged behavior changes (not asked for literally, but consequences of the piece table)

1. Queen/Bishop/Knight's move from "any non-QB" to explicit RB/WR/TE means
   DST (and any other non-skill position) lost Queen eligibility at
   $7,000+. A hypothetical position that's neither QB/RB/WR/TE/DST, priced
   ≥ $5,000, now classifies as *no piece at all* — practically inert (DK
   has no such slot) but a real gap if one's ever added.
2. Najdorf/Fried Liver no longer "break" in `legal_depth`/`openingPreview`
   — Knight/Bishop pooling RB/WR/TE (7 roster slots) instead of one
   position each (2 slots) genuinely changes the answer; tests renamed and
   re-asserted (`None` instead of ply 9/10), not just patched to pass.
3. The pick modal's "greyed out, infeasible" row display is now dead in
   practice — every candidate `pickList` returns has, by construction,
   already passed the same feasibility check `pickReason` does. Left the
   mechanism in place defensively; updated the one BuildScreen test that
   depended on the old show-and-grey-out behavior (an over-cap player no
   longer appears in the list at all, rather than appearing disabled).
4. `tools/sim_builds.py` (standalone, no pytest coverage, nothing imports
   it) still calls `classify(p, sport)` 2-arg and assumes Rook-is-RB-only
   in a couple of spots — not updated, out of scope, flagged to Ron.

### Testing

Both engines mirrored line-for-line as usual. New `test_metrics.py`/
`metrics.test.ts` and `test_picklist.py`/`picklist.test.ts` (each piece's
own sort metric, the cap, the cap applying after removing taken/infeasible
players, Rook's team restriction with and without a locked QB,
`castleQbCandidates` excluding a QB with no/an-already-locked-only
teammate). New castling tests in `test_rules.py`/`rules.test.ts` (Rook
rejected across teams, both King modes) and `test_build.py`/`build.test.ts`
(Black's own castling resolution: skips a QB with no eligible teammate,
illegal when *no* QB has one, picks the top of each piece's own list not
highest-projection-overall). `test_pieces.py`/`pieces.test.ts` rewritten
for the new overlapping bands (nearly every existing assertion changed,
since Rook/Bishop/Knight sharing one position band means far more overlap
than before). `BuildScreen.test.tsx`'s PLACED-mode castling test reordered
to match (switch dialog first, then Rook dialog).

`tools/export_parity.py` regenerated (43 → 47 scenarios): added
`pick_list`/`castle_qb_candidates` scenario kinds (Queen-sorts-by-ceiling,
Rook-requires-qb-team, Bishop-caps-at-12, a lonely QB excluded from
castling candidates) on top of the existing classify/legal-move/castle/
capture scenarios, which already exercise the new Rook/team logic
incidentally (the real 301-player sample pool's `classify_all_players`
scenario now carries `ROOK` on far more entries, with no QB locked).

Final counts: **233 pytest passing, 377 Vitest passing**, `tsc -b` and
`oxlint` both clean. One commit, pushed to `origin/main`.

### Process note

Ron confirmed inline that an unnumbered rules-change prompt like this one
should use `Rule change — <title>` for the commit message (matching
`f2ff2fc`/`1d2dcb8`'s precedent), not a guessed `Task NN` — CLAUDE.md's
literal git-section template assumes a task number that this kind of
prompt doesn't carry. Saved as a feedback memory for future sessions.

## Open threads

- See HANDOFF.md's Open Items for the four behavior-change flags above,
  carried forward there in full.
- No real-browser verification of the new pick-modal metric column or the
  reordered PLACED-mode castling flow — same standing environment
  limitation as every prior session (no browser launches here).
- `tools/sim_builds.py` not updated — see flag #4 above.
