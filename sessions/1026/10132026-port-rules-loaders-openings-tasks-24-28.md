# 10132026 — Port Rules, Loaders, Openings (Tasks 24–28)

## Context

This session picked up straight from the prior session's handoff
(`sessions/1026/10132026-git-setup-and-ts-engine-port.md`), which had
scaffolded `web/` and ported `models.ts`/`sport.ts`/`pieces.ts` plus the
four pure roster/salary functions in `rules.ts` (Tasks 21–23), leaving
`is_legal_move`/`apply_move` and 11 `test_rules.py` tests deferred pending
`ContestConfig`. Before starting, `git status` showed uncommitted changes
from the prior session's own `wrap-up` call (an updated `sessions/
HANDOFF.md` and a new session log) that had never been committed. Ron
confirmed session logs are always committed (never gitignored) and
HANDOFF.md is safe to commit too, so those were committed first and
separately (`c191a3e`), before Task 24 began. Five tasks ran this
session, each its own commit, each pushed to `origin/main` immediately
after.

## What was done

**Task 24 — `config.ts` + `is_legal_move`/`apply_move`** (commit
`4c715fa`). Ported `dfs_chess/config.py`'s `ContestConfig` (`PayoutTier`,
`EntryTier`, `effectiveCap`, `fieldTier`, `entryTiers`/`entryTier`/
`rankTier`, `targetRank`, `loadContestConfig`) to `web/src/engine/
config.ts` — `loadContestConfig` takes already-parsed JSON, same as
`loadSportConfig`. `targetRank` uses a hand-written `roundHalfToEven`
instead of `Math.round`, since Python's `round()` ties to even and JS's
doesn't (no ported test lands on an exact `.5` tie, but it's there for
exactness anyway). Added `isLegalMove`/`applyMove` to `rules.ts` for
ordinary (non-capturing, non-castling) moves only: a `ChessMove` type
(`{from, to, promotion?}`) stands in for Python's `chess.Move` (chess.js
has no public move constructor); a private `findLegalMove` looks up the
move in `board.moves({verbose: true})` by from/to(/promotion), which also
hands back `.piece`/`.san` for the pre-move position in one call, standing
in for Python's separate `piece_type_at`/`san()` calls. Castling/capture
early-rejects inside `isLegalMove` mirror Python's own permanent
rejects (`is_legal_move` always routes those elsewhere — not a
TS-specific placeholder). Ported all 11 deferred `test_rules.py` tests
plus all 16 `test_config.py` tests. 61 Vitest tests passing after this
task (34 prior + 16 + 11); `pytest` 180 passed, unchanged.

**Task 25 — castling, captures, King modes** (commit `0ff3681`). Added
`canCastle`/`castle`, `switchKing`/`placeKings`, `isLegalCapture`/
`applyCaptureMove` to `rules.ts` — the rest of `dfs_chess/rules.py`. A
private `castlingRookSquares` works out the rook's own [from, to] from the
king's two-square hop (chess.js's castling `Move` only carries the king's
move). `capturedSquare` handles en passant (captured pawn sits beside
`to`, not on it) via chess.js's `.isEnPassant()`. Updated `isLegalMove`'s
reject comments from "not yet ported (future task)" to "use castle()"/
"use applyCaptureMove()" now that those exist — the reject behavior
itself was always permanent, matching Python. **Not ported**:
`push_silent_move` — zero `test_rules.py` coverage (confirmed by grep),
only ever called from `build.py`/`cli.py`, both out of scope. Ported all
21 remaining `test_rules.py` tests (6 castling, 8 King modes, 7
captures); also checked `test_build.py`/`test_cli.py` for other coverage
of these functions — found only full build-loop/CLI integration tests,
none in scope. 82 Vitest tests passing after this task; `pytest` 180
unchanged.

**Task 26 — ETR loader and ownership by field size** (commit `270995c`).
Added `papaparse` + `@types/papaparse` as dependencies. Extended
`web/scripts/sync-data.mjs` with a third copy entry, `data/samples/` →
`web/src/data/samples/` (same gitignored-destination pattern as
`openings/`/`config/`). New `web/src/engine/loaders.ts` with `loadEtrCsv`
(+ `parseSalary`/`parsePercent`/`ETR_COLUMN_MAP`, camelCase keys since
it's an internal lookup, not an on-disk schema) — takes the CSV's
contents as a string and parses internally via PapaParse, unlike
`loadSportConfig`/`loadContestConfig`'s "take already-parsed data"
convention (this is one step earlier in the pipeline, parsing the raw
format itself). Ported all 5 ETR-CSV `test_loaders.py` tests, reading the
synced sample CSV via Node's `fs.readFileSync`. Flagged: "ownership-by-
field-size logic" in the task prompt turned out to already be covered by
`Player.ownFor` (Task 22) — confirmed via grep there's no separate
field-size ownership function in `dfs_chess/`. 87 Vitest tests passing
after this task; `pytest` 180 unchanged.

**Task 27 — opening book: naming, continuations, legal depth** (commit
`9a5d90d`). New `web/src/engine/openings.ts`: `BookLine`, `openingName`,
`findOpeningLines`, `continuingLines`, `bookContinuations`, `bookWeights`,
`splitFamily`, `legalDepth` (+ private `pieceEligiblePositions`/
`proxyPlayer`). `legalDepth`'s real porting wrinkle: chess.js has no
public equivalent of python-chess's `board.parse_san(san)` (resolve
without pushing) — worked around by matching the SAN string against
`board.moves({verbose: true})` before pushing via `board.move(san)`,
verified against real `data/openings/*.tsv` check-suffix conventions
(grepped for `+` in the TSVs to confirm chess.js's own SAN generator
would match). Extended `loaders.ts` with `loadOpeningBook` (TSV contents,
tab-delimited PapaParse), `loadPopularity`, `loadLineStats` — all three
take string contents. Ported all 17 in-scope `test_openings.py` tests and
all 6 previously-deferred `test_loaders.py` tests (opening book,
popularity, line stats). Added a 4-test ownership-cutoff block to
`config.test.ts` (1,999/2,000/9,999/10,000 entries through
`fieldTier()`+`ownFor()` together) since no existing Python or TS test
exercised all four cutoffs end-to-end — this was an explicit instruction
in the task prompt, not organic opening-book coverage. **Not ported**:
`rankFamilies`/family ranking (12 tests) and `opening_preview` (3 tests)
— explicitly out of scope / not named in the task's "covers" list,
respectively. 114 Vitest tests passing after this task; `pytest` 180
unchanged.

**Task 28 — family ranking, suggestion, opening preview** (commit
`4aef214`). Added `RankedFamily`, `DEFAULT_EXCLUDED_FAMILIES` (a
`ReadonlySet`), `rankFamilies` to `openings.ts` — the real porting
wrinkle was Python's 3-tuple tie-break key `(games, -len(moves), eco)`
compared with a plain `>` (Python tuples compare lexicographically
natively; TS doesn't), worked around with hand-written `repKey`/
`keyGreater`, plus a `compareStrings` helper using plain `<`/`>` (not
`.localeCompare()`) to match Python's codepoint-based default string
ordering exactly. Added a `RankableLine` interface (eco/name/moves/games
only) kept independent of `loaders.ts`'s fuller `LineStatsEntry` to avoid
a circular import (`loaders.ts` already imports `BookLine` from
`openings.ts`). Added `OpeningPreview`/`openingPreview`, reusing
`legalDepth` for `breakPly` and the same verbose-move-matching pattern
Task 27 established. **Scope finding**: "the field-size tier lookup and
the suggested opening" has no standalone Python function to port — the
tier lookup (`ContestConfig.entryTier`/`rankTier`) and target-rank formula
(`ContestConfig.targetRank`) were already fully ported in Task 24; the
actual suggestion *selection* (`by_rank[target_rank]`) exists only inline
inside `cli.py`'s `_prompt_for_opening_setup`, with no isolated unit test
outside full CLI-integration tests. No new "suggestion picker" function
was written, since there's no Python spec for one outside the CLI.
Ported all 12 `rank_families` tests and all 3 `opening_preview` tests,
including the real-data top-9-families-pinned-in-exact-order test, which
passed first try against real `line_stats.json`. 129 Vitest tests passing
after this task (final count); `pytest` 180 unchanged.

## Verification summary (all five tasks)

Every task ended with: `npx tsc -b` clean, `npm run test` all green
(growing 61 → 82 → 87 → 114 → 129), `npm run build` clean, `pytest tests/`
180 passed (Python engine completely untouched this session — all five
tasks were additive, TypeScript-only). Each task got its own commit
(`Task NN — <title>`) and was pushed to `origin/main` immediately after;
each also got its own dated session log (listed below) before this
end-of-session wrap-up log.

## Open threads

- **"The field-size tier lookup and the suggested opening" (Task 28)**:
  no pure "suggestion picker" function exists in Python outside
  `cli.py`'s `_prompt_for_opening_setup`, so none was written in TS either
  — `rankFamilies` + `ContestConfig`'s tier/rank methods are the complete
  reusable pieces; wiring them into an actual suggestion is CLI-port work
  for a future task. See `sessions/1026/10132026-port-family-ranking-
  suggestion-opening-preview.md`.
- **`opening_preview`/`OpeningPreview` scope question (raised in Task
  27, resolved in Task 28)**: Task 27 left it unported since it wasn't
  named in that task's "covers" list even though it wasn't tangled with
  anything excluded; Task 28 explicitly asked for it and it's now ported.
  Resolved, no longer open.
- **`push_silent_move`** (Task 25) — still unported. Zero `test_rules.py`
  coverage, only called from `build.py`/`cli.py` (both still out of
  scope). Will need porting whenever the build loop itself is ported.
- **Chess.js has no public "resolve SAN without pushing" method** (first
  hit in Task 24, recurring in Tasks 27/28) — the established workaround
  (match the verbose `board.moves({verbose: true})` list by `.san` before
  calling the pushing `board.move(san)`) has now been used in four
  separate functions (`findLegalMove`, `legalDepth`, `openingPreview`,
  and indirectly via `findLegalMove` in `castle`/`isLegalCapture`/
  `applyCaptureMove`). Not consolidated into a shared helper across
  `rules.ts`/`openings.ts`, mirroring Python's own un-factored
  duplication between `legal_depth` and `opening_preview` — intentional
  fidelity, not an oversight, but worth knowing if a future task wants to
  factor it.
- **Ownership-cutoff test** (added in Task 27, inside `config.test.ts`)
  is cross-cutting -- it tests `ContestConfig.fieldTier()` +
  `Player.ownFor()` together at four specific contest-entry cutoffs
  (1,999/2,000/9,999/10,000), requested directly by that task's prompt,
  not something that emerged organically from porting the opening book.
- All prior-session open items (task-numbering collision, Scotch
  Game/King's Indian Defense acceptance, `excluded_families`/tier-boundary
  defaults living in Python not config, CLI opening-setup wording,
  `openings.book_weights()`/`load_popularity()` having no engine caller,
  no `contest_type` field, pawn promotion's DFS classification, the
  `logs/` vs `sessions/` doc-process mismatch, `Top_Ten` distinction,
  Kings never captured as the King piece) remain unchanged and
  unaddressed this session — carried forward, not re-verified.
- Full narrative detail for each task: `sessions/1026/10132026-port-
  contest-config-and-ordinary-move-rules.md` (Task 24),
  `10132026-port-castling-captures-and-king-modes.md` (Task 25),
  `10132026-port-etr-loader.md` (Task 26), `10132026-port-opening-book.md`
  (Task 27), `10132026-port-family-ranking-suggestion-opening-preview.md`
  (Task 28).
