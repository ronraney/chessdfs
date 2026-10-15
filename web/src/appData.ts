// Shared, loaded-once app data: parsed engine inputs and the small
// UI-layer joins/derivations built on top of them. UI-only -- every
// value here comes from calling the engine's own loaders/functions
// (web/src/engine), never reimplementing them; the one new piece is the
// BOOK <-> line_stats join below (statsFor/variationsForFamily), a plain
// data combination (no domain policy/judgment call) for the opening
// explorer (Task 34, drill-down restored Task 39) to show a family's
// variations with their game counts.
import contestsRaw from "./data/config/contests.json";
import nflConfig from "./data/config/sports/nfl.json";
import aTsv from "./data/openings/a.tsv?raw";
import bTsv from "./data/openings/b.tsv?raw";
import cTsv from "./data/openings/c.tsv?raw";
import dTsv from "./data/openings/d.tsv?raw";
import eTsv from "./data/openings/e.tsv?raw";
import lineStatsRaw from "./data/openings/line_stats.json?raw";
import { loadContestPresets, type ContestPreset, type RawContestPreset } from "./engine/config";
import { loadLineStats, loadOpeningBook, type LineStatsEntry } from "./engine/loaders";
import { openingPreview, rankFamilies, splitFamily, type BookLine, type OpeningPreview, type RankedFamily } from "./engine/openings";
import { loadSportConfig } from "./engine/sport";

export const NFL = loadSportConfig(nflConfig);
export const PRESETS: ContestPreset[] = loadContestPresets(contestsRaw as RawContestPreset[]);

export const BOOK: BookLine[] = loadOpeningBook([aTsv, bTsv, cTsv, dTsv, eTsv]);
const LINE_STATS: LineStatsEntry[] = loadLineStats(lineStatsRaw);

// cli.py's own "Contest tier" readout (_run_one_build) resolves last_rank
// from this same rank_families(line_stats) count -- not a fixed number.
export const RANKED_FAMILIES: RankedFamily[] = rankFamilies(LINE_STATS);
export const LAST_RANK = RANKED_FAMILIES.length;

export const RANK_BY_FAMILY: ReadonlyMap<string, RankedFamily> = new Map(
  RANKED_FAMILIES.map((family) => [family.name, family]),
);

function statsKey(eco: string, name: string, moves: readonly string[]): string {
  return `${eco}|${name}|${moves.join(" ")}`;
}

const STATS_BY_KEY: ReadonlyMap<string, LineStatsEntry> = new Map(
  LINE_STATS.map((entry) => [statsKey(entry.eco, entry.name, entry.moves), entry]),
);

// A book line's own popularity stats (games/draw_rate/...), or null if
// line_stats.json has no exact (eco, name, moves) match for it. With the
// current vendored data every one of BOOK's 3,865 lines has a match
// (verified 1:1 against data/openings/line_stats.json), but the explorer
// still handles a miss.
export function statsFor(line: BookLine): LineStatsEntry | null {
  return STATS_BY_KEY.get(statsKey(line.eco, line.name, line.moves)) ?? null;
}

export interface Variation {
  line: BookLine;
  stats: LineStatsEntry | null;
}

// Every book line belonging to `family` -- its own bare-name row (if the
// book has one) plus every "<family>: ..." row -- the same family-
// membership rule rankFamilies itself uses (splitFamily's first element),
// applied here across the full book rather than just the one
// representative line rankFamilies keeps. Sorted by game count from
// line_stats, descending; a line with no stats match sorts last. Task 39
// re-adds this (Task 38c dropped it along with the Explorer's own per-row
// expand) for the Explorer's drill-down -- deliberately no preview/piece-
// sequence data attached, since that's what made expanding a deep family
// slow before (see previewFor below); a family's variation list needs only
// its name, moves, and games.
export function variationsForFamily(family: string): Variation[] {
  const matches = BOOK.filter((line) => splitFamily(line.name)[0] === family);
  const withStats: Variation[] = matches.map((line) => ({ line, stats: statsFor(line) }));
  withStats.sort((a, b) => {
    if (a.stats === null && b.stats === null) return 0;
    if (a.stats === null) return 1;
    if (b.stats === null) return -1;
    return b.stats.games - a.stats.games;
  });
  return withStats;
}

// openingPreview replays a line's moves twice over (once for its own
// whitePieces/blackPieces walk, again inside legalDepth for breakPly), and
// neither walk goes through rules.ts's findLegalMove cache (Task 33) --
// each call costs on the order of tens of milliseconds. Only the Suggested
// card's single current selection ever needs one -- the Explorer's rows
// (flat or expanded) never call this, by design (see variationsForFamily
// above) -- but a Random click or a fresh search/expand selection can
// revisit the same line repeatedly, so results stay cached here by the
// line's own identity -- a plain memoization of a pure engine function's
// output, not a change to the function itself.
const PREVIEW_CACHE = new Map<string, OpeningPreview>();

export function previewFor(line: BookLine): OpeningPreview {
  const key = statsKey(line.eco, line.name, line.moves);
  const cached = PREVIEW_CACHE.get(key);
  if (cached !== undefined) return cached;
  const preview = openingPreview(line, NFL);
  PREVIEW_CACHE.set(key, preview);
  return preview;
}

