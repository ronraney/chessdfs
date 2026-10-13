# 10132026 — Port Family Ranking, Suggestion, Opening Preview (Task 28)

## Context

Continuing from Task 27 (opening book: naming/continuations/legal depth),
this task ported the rest of `dfs_chess/openings.py`: family ranking
(`rank_families`/`RankedFamily`/`DEFAULT_EXCLUDED_FAMILIES`), "the
field-size tier lookup and the suggested opening," and
`opening_preview`/`OpeningPreview`. `git status` was clean before
starting.

## Scope decision: "the field-size tier lookup and the suggested opening"

Checked `dfs_chess/openings.py` (read in full in Task 27) for a
standalone function matching this phrase -- there isn't one. The
field-size tier lookup is `ContestConfig.entryTier`/`rankTier`, and the
target-rank formula is `ContestConfig.targetRank` -- both already fully
ported and tested in Task 24 (`config.ts`/`config.test.ts`), which is
exactly what this task's "Reuse targetRank already in config.ts" points
at. The actual *selection* of a suggested opening
(`by_rank[contest.target_rank(last_rank)]`) exists only inline inside
`dfs_chess/cli.py`'s `_prompt_for_opening_setup` (confirmed by reading
that function, lines ~356-452) -- it has no standalone pure function and
no isolated unit test; every test that touches it
(`tests/test_cli.py`'s `test_opening_setup_*` tests) drives the full
input/print CLI loop, which is explicitly out of scope ("Not yet: ...
CLI"). Since "the Python code and its tests are the spec" and no such
pure, testable unit exists outside the CLI, I did not fabricate a new
"suggested opening" function with no spec to match -- `rankFamilies` (now
ported) plus the already-ported `ContestConfig` tier/rank methods are the
complete, reusable pieces; combining them into an actual suggestion
picker is CLI-port work for a future task. Flagging this reading
explicitly since it's a judgment call, same as Task 27's `opening_preview`
scope question.

## What was done

**`web/src/engine/openings.ts`** — added:
- `RankedFamily` (class), `DEFAULT_EXCLUDED_FAMILIES` (a `ReadonlySet`,
  not a Python `frozenset`, same substitution pattern used throughout),
  and `rankFamilies`. The one real porting wrinkle: Python's tie-break key
  is a 3-tuple `(games, -len(moves), eco)` compared with a plain `>`
  operator (Python tuples compare lexicographically out of the box); TS
  has no such built-in, so `repKey`/`keyGreater` implement the same
  lexicographic comparison by hand, and `compareStrings` does a plain
  codepoint comparison (`<`/`>`) for the final-sort name tiebreak rather
  than `.localeCompare()`, since Python's default string ordering is
  codepoint-based, not locale-aware.
- A new `RankableLine` interface (eco/name/moves/games only) for
  `rankFamilies`' input, kept independent of `loaders.ts`'s
  `LineStatsEntry` (which has 3 more fields) the same way Python's
  `rank_families` never imports anything from `loaders.py` either --
  importing `LineStatsEntry` from `loaders.ts` here would also create a
  circular import (`loaders.ts` already imports `BookLine` from
  `openings.ts`). `loadLineStats`'s actual return value is structurally
  compatible and passed straight through in tests with no cast needed.
- `OpeningPreview` (class) and `openingPreview` -- same "find the matching
  verbose chess.js move by `.san`, inspect it, then push by SAN" pattern
  `legalDepth` already established in Task 27 for the same
  parse-without-pushing gap in chess.js's public API. Reuses `legalDepth`
  directly for `breakPly`, same as Python reusing its own return value
  rather than re-deriving it.

**Tests** — ported all 12 `rank_families` tests and all 3
`opening_preview` tests into `openings.test.ts` (now 32 tests total in
that file). The "real data" ranking tests (Sicilian rank 1, Ruy Lopez's
representative is Morphy Defense, ~85+ families rank, top-9 pinned in
exact order) all read the real, already-synced `web/src/data/openings/
line_stats.json` via `loadLineStats`, and all passed first try --
including the top-9 exact-order pin, which is the most demanding
cross-check that the tie-break comparator and sort are byte-for-byte
faithful to Python's tuple comparison against real production data, not
just the synthetic fixtures.
- Checked for "any tier/suggestion tests not yet ported": none found --
  `test_config.py`'s `entry_tier`/`rank_tier`/`target_rank` tests were
  already ported in full in Task 24 (`config.test.ts`), and (per the
  scope decision above) there's no isolated Python suggestion test
  outside the CLI to port.

**Verified**: `npx tsc -b` clean, `npm run test` 129 passed (114 prior +
15 new, all first-try green), `npm run build` clean, `pytest` 180 passed
(Python untouched).

## Open questions / flags

- The "suggested opening" scope reading above -- no new pure function was
  written since none exists in Python outside the CLI to match; say the
  word if a `suggestedOpening()`-style helper should be added now instead
  of waiting for a CLI-port task.
- `legalDepth`/`openingPreview`'s shared "match verbose move by `.san`"
  pattern is now duplicated across two functions in `openings.ts`, mirroring
  Python's own un-factored duplication between `legal_depth` and
  `opening_preview` -- intentional fidelity, not an oversight.

## Follow-ups (noted, not acted on)

- Combining `rankFamilies` + `ContestConfig`'s tier/rank methods into an
  actual "suggested opening" picker -- CLI-port work, not done here.
- `build.py`, `loaders.py`'s already-complete set aside, CLI, UI — still
  entirely unported.
- HANDOFF.md not rewritten this session (not a `wrap-up` call).
