# 10132026 — Port Opening Book (Task 27)

## Context

Continuing from Task 26 (ETR loader), this task ported `dfs_chess/
openings.py`'s naming/continuations/legal-depth functionality plus the
three remaining `dfs_chess/loaders.py` loaders (`load_opening_book`,
`load_popularity`, `load_line_stats`). `git status` was clean before
starting.

## Scope decision: `opening_preview`/`OpeningPreview`

The task's "covers" list was "naming, continuations, and legal depth" --
exactly three things, and its "not yet" list named family ranking/
tiers/target rank/suggestion/build loop explicitly. `opening_preview`
(Task 17: FEN + per-side piece sequence + reused `legal_depth` break_ply)
is in neither list. It isn't tangled with anything excluded (it only
calls `legal_depth`, itself in scope), so there's no "stop and say so"
tangling problem -- but it's also not named as something to port. Reading
"covers naming, continuations, and legal depth" as an exhaustive list
(matching how Task 24's "covers chess legality via chess.js, turn order,
SAN, ..." was exhaustive, not illustrative), I left `opening_preview`/
`OpeningPreview` and its 3 tests unported rather than silently expanding
scope. Flagging this explicitly since it's a judgment call, not a hard
blocker -- happy to port it as part of this task if that's what was
meant.

## What was done

**`web/src/engine/openings.ts` (new)** — `BookLine` (class), `openingName`,
`findOpeningLines`, `continuingLines`, `bookContinuations`, `bookWeights`,
`splitFamily`, `legalDepth` (plus private helpers `pieceEligiblePositions`/
`proxyPlayer` it depends on). All pure, one-for-one with Python.
- `legalDepth`'s one real porting wrinkle: chess.js has no public
  equivalent of python-chess's `board.parse_san(san)` (resolve a SAN
  string to a move *without* pushing it) -- both of chess.js's SAN<->move
  methods are private. Worked around it the same way `rules.ts` already
  does for ordinary moves (Task 24): look up the move in
  `board.moves({verbose: true})` by matching `.san` against the line's
  SAN token, which hands back `.piece`/`.isKingsideCastle()`/
  `.isQueensideCastle()` pre-push, then call `board.move(san)` (chess.js's
  public, string-based, pushing method) once those are captured. Verified
  real opening-book PGN data includes check suffixes ("+") the same way
  chess.js's own SAN generator does (grepped `data/openings/*.tsv`), so
  exact `.san` string matching holds in general, not just for the small
  hand-written test lines.
- **Not ported**: `rankFamilies`/`RankedFamily`/`DEFAULT_EXCLUDED_FAMILIES`
  (family ranking, explicitly out of scope) and `opening_preview`/
  `OpeningPreview` (see scope decision above).

**`web/src/engine/loaders.ts`** — added `loadOpeningBook` (TSV contents,
plural, via PapaParse with `delimiter: "\t"`, same as `loadEtrCsv`'s CSV
parsing) and its `parsePgnMoves` helper, `loadPopularity` (JSON.parse of
the string), and `loadLineStats` (JSON.parse, `.lines` plucked out). All
three take file contents as strings (or an array of strings for the
book's multiple TSV files), matching Task 26's `loadEtrCsv` precedent of
parsing internally rather than expecting pre-parsed data (the latter is
`loadSportConfig`/`loadContestConfig`'s pattern, for small static config
imported as ES modules -- these are larger generated data files instead).

**Tests** — ported all 17 in-scope `test_openings.py` tests into
`openings.test.ts` (2 naming, 1 continuations-set, 4 legal depth, 3
popularity weights, 3 find/continuing-lines, 2 split-family) and all 6
deferred `test_loaders.py` tests into `loaders.test.ts` (2 opening-book, 2
popularity, 2 line-stats) -- all read the real vendored files
(`data/openings/{a-e}.tsv`, `popularity.json`, `line_stats.json`) from the
already-synced `web/src/data/openings/` (synced since Task 21; no
`sync-data.mjs` change needed this time). All first-try green.
- **Not ported**: the 12 `rank_families`/family-ranking tests and the 3
  `opening_preview` tests -- both out of scope, see above.

**Ownership-cutoff check** (explicit task instruction, unrelated to the
opening book itself): grepped `tests/` for `own_for`/`field_tier` together
-- `test_config.py`'s two `field_tier` boundary tests check tier
classification only (no ownership values); `test_models.py`'s three
`own_for` tests check ownership averaging in isolation (arbitrary
small/large values, never tied to a `field_size` number); `test_cli.py`
combines them but only for one `CONTEST` fixture, not a sweep of the four
documented cutoffs. **No existing Python or TS test exercises all four
cutoffs (1,999/2,000/9,999/10,000) through `fieldTier()`+`ownFor()`
together.** Added a new `describe` block to `config.test.ts` covering
exactly that, flagged inline in a comment and here.

**Verified**: `npx tsc -b` clean, `npm run test` 114 passed (87 prior + 17
`openings.test.ts` + 6 new in `loaders.test.ts` + 4 new ownership-cutoff
tests in `config.test.ts`, all first-try green), `npm run build` clean,
`pytest` 180 passed (Python untouched).

## Open questions / flags

- `opening_preview`/`OpeningPreview` -- see scope decision above; left
  unported, cleanly separable, not named in this task's "covers" list.
- The ownership-cutoff test added to `config.test.ts` is a cross-cutting
  addition the task asked for directly, not something that emerged from
  porting the opening book itself -- noted here so it isn't mistaken for
  opening-book coverage.

## Follow-ups (noted, not acted on)

- `rankFamilies`/`RankedFamily`/`DEFAULT_EXCLUDED_FAMILIES`,
  `opening_preview`/`OpeningPreview`, field-size tiers'
  suggestion-flow usage, `build.py` — still entirely unported.
- HANDOFF.md not rewritten this session (not a `wrap-up` call).
