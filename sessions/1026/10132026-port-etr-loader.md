# 10132026 — Port ETR Loader and Ownership by Field Size (Task 26)

## Context

Continuing from Task 25 (castling/captures/King modes), this task ported
`dfs_chess/loaders.py`'s ETR projections CSV loader to `web/src/engine/
loaders.ts`. `git status` was clean before starting.

## What was done

**Dependency**: added `papaparse` (CSV parsing, as the task specified) and
`@types/papaparse` (dev) to `web/package.json`. `@types/papaparse` declares
only named exports (`export function parse(...)`, no default export), so
`loaders.ts` imports `{ parse }` rather than a default `Papa` import.

**`web/scripts/sync-data.mjs`** — added a third copy entry,
`data/samples/` → `web/src/data/samples/` (same gitignored-destination
pattern as the existing `openings/`/`config/` copies). This is how the
sample ETR CSV reaches the web side without touching the original, per
this task's "copy it into the web test fixtures if needed" -- extending
the existing sync pattern was more consistent than a one-off copy
elsewhere, and keeps `web/` self-contained the same way `config/sports/
nfl.json` already is for every other test file.

**`web/src/engine/loaders.ts` (new)** — ports `load_etr_csv` (and its
`_parse_salary`/`_parse_percent` helpers, and `ETR_COLUMN_MAP`) only.
`loadEtrCsv(data: string, columnMap = ETR_COLUMN_MAP)` takes the file's
contents as a string rather than a path (the engine stays I/O-free, same
spirit as `loadSportConfig`/`loadContestConfig`). `ETR_COLUMN_MAP`'s keys
are camelCase (`ownSmall`/`ownLarge`) rather than Python's snake_case --
this map isn't an on-disk schema (unlike `RawSportConfig`'s snake_case
keys, which mirror JSON field names on disk), just an internal lookup
feeding `Player`'s already-camelCase fields, so it follows the TS side's
own naming instead of Python's.
- **Not ported** (explicitly out of scope per this task): `load_opening_book`,
  `load_popularity`, `load_line_stats` -- all belong to the opening book/
  openings, named out of scope directly in the prompt.
- **"Ownership-by-field-size logic"**: there's no separate function for
  this in `loaders.py` -- it's `Player.ownFor(tier)`, already ported in
  Task 22 (`models.ts`), plus the `own_small`/`own_large` CSV columns
  `load_etr_csv` maps into it. Confirmed via grep across `dfs_chess/` that
  no other file implements field-size-specific ownership logic. Nothing
  further to port here; flagging the interpretation since the task named
  it as if it might be separate.

**Tests** — ported all 5 `test_loaders.py` ETR-CSV tests into
`loaders.test.ts`: 301 players, salaries are integers, every player
classifies, ownership is a 0-1 fraction, names are trimmed. The test reads
the synced sample CSV via Node's `fs.readFileSync` (tests aren't part of
the I/O-free engine) rather than an ES import, since it's plain text, not
JSON.
- **Not ported**: the opening-book (2 tests) and popularity/line-stats (4
  tests) sections of `test_loaders.py` -- same out-of-scope reasoning as
  the loaders themselves.

**Verified**: `npx tsc -b` clean, `npm run test` 87 passed (82 prior + 5
new, first try), `npm run build` clean, `pytest` 180 passed (Python
untouched).

## Open questions / flags

- `parseSalary` uses `parseInt(..., 10)`, which is more lenient on
  malformed input than Python's `int(...)` (e.g. `parseInt("12abc")` is
  `12`, not an error) -- for every real ETR salary string (`"$9,800"`
  etc.) the two produce identical results, so this only matters for
  malformed input no test exercises.
- `parsePercent` uses `raw.replace(/%+$/, "")` to mirror Python's
  `rstrip("%")` (strips *all* trailing `%` chars, not just one) exactly,
  even though real ETR data only ever has a single trailing `%`.
- The "ownership-by-field-size" framing in this task's prompt (see above)
  -- resolved as already-covered by Task 22's `ownFor`, not a new
  function; flagging in case that's not what was intended.

## Follow-ups (noted, not acted on)

- `load_opening_book`, `load_popularity`, `load_line_stats`,
  `openings.py`, `build.py` — still entirely unported.
- HANDOFF.md not rewritten this session (not a `wrap-up` call).
