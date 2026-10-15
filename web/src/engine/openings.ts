// Opening book queries -- pure (no I/O). Book data is loaded by
// loaders.ts (loadOpeningBook) and handed in here as BookLine[]. Ported
// from dfs_chess/openings.py in full: naming (openingName,
// findOpeningLines, splitFamily), continuations (continuingLines,
// bookContinuations, bookWeights), legal depth (legalDepth), family
// ranking (rankFamilies/RankedFamily/DEFAULT_EXCLUDED_FAMILIES), and
// opening preview (OpeningPreview/openingPreview). The field-size tier
// lookup and target-rank formula a "suggested opening" is built from
// (ContestConfig.entryTier/rankTier/targetRank) already live in
// config.ts (Task 24) -- reused here, not reimplemented.
//
// suggestOpening/randomOpening (Task 31) are the one piece of this file
// with no standalone Python function to port from: the selection itself
// (`by_rank[contest.target_rank(...)]`, and the 'r'/Random branch's
// `rng.choice(pool)`) exists only inline inside dfs_chess/cli.py's
// `_prompt_for_opening_setup`. Both are built here from already-ported,
// already-tested pieces (rankFamilies, ContestConfig.targetRank,
// SeededRandom), matching that inline selection exactly rather than
// reimplementing it some other way. The CLI and UI remain out of scope.

import { Chess } from "chess.js";
import type { ContestConfig, EntryTier } from "./config";
import { Piece, Player } from "./models";
import { pieceForChessType } from "./pieces";
import { SeededRandom } from "./rng";
import { maxAssignable } from "./rules";
import type { SportConfig } from "./sport";

export interface BookLineFields {
  eco: string;
  name: string;
  moves: readonly string[]; // SAN tokens, no move numbers
}

export class BookLine {
  readonly eco: string;
  readonly name: string;
  readonly moves: readonly string[];

  constructor(fields: BookLineFields) {
    this.eco = fields.eco;
    this.name = fields.name;
    this.moves = fields.moves;
  }
}

function movesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// The longest book line that's a prefix of `moves` (including an exact
// match), or null if no line matches at all. Task 37: the build screen's
// opening banner needs the matching line's `eco` alongside its `name` --
// two lines can share an identical name at different depths/ECOs (e.g.
// "Ruy Lopez: Morphy Defense" exists at both C70, 6-ply, and C78, 10-ply),
// so the name string alone can't be traced back to an eco.
export function openingLine(moves: readonly string[], book: readonly BookLine[]): BookLine | null {
  let best: BookLine | null = null;
  for (const line of book) {
    if (line.moves.length <= moves.length && movesEqual(line.moves, moves.slice(0, line.moves.length))) {
      if (best === null || line.moves.length > best.moves.length) {
        best = line;
      }
    }
  }
  return best;
}

// The name of the longest book line that's a prefix of `moves` (including
// an exact match), or null if no line matches at all.
export function openingName(moves: readonly string[], book: readonly BookLine[]): string | null {
  return openingLine(moves, book)?.name ?? null;
}

// Book lines whose name contains `query`, case-insensitively -- the
// "search openings by name" lookup for starting a template (RULES.md
// "Opening templates"). An empty/blank query matches every line.
export function findOpeningLines(query: string, book: readonly BookLine[]): BookLine[] {
  const q = query.trim().toLowerCase();
  return book.filter((line) => line.name.toLowerCase().includes(q));
}

// Book lines that start with `moves` and still have at least one more
// move beyond it -- the "pick a new named continuation from here" lookup
// once a template ends mid-build (RULES.md "Opening templates").
export function continuingLines(moves: readonly string[], book: readonly BookLine[]): BookLine[] {
  const depth = moves.length;
  return book.filter((line) => line.moves.length > depth && movesEqual(line.moves.slice(0, depth), moves));
}

// The set of next moves, across all book lines, that extend `moves`.
export function bookContinuations(moves: readonly string[], book: readonly BookLine[]): Set<string> {
  const depth = moves.length;
  const result = new Set<string>();
  for (const line of book) {
    if (line.moves.length > depth && movesEqual(line.moves.slice(0, depth), moves)) {
      result.add(line.moves[depth]);
    }
  }
  return result;
}

// Each book continuation after `moves`, weighted by its Lichess game count
// from `popularity` (see loaders.loadPopularity). If `moves`' position has
// no entry in `popularity` at all, every continuation gets equal weight
// (1) instead -- there's simply no data to rank them by.
export function bookWeights(
  moves: readonly string[],
  book: readonly BookLine[],
  popularity: Readonly<Record<string, Readonly<Record<string, number>>>>,
): Record<string, number> {
  const continuations = bookContinuations(moves, book);
  const counts = popularity[moves.join(" ")];
  const weights: Record<string, number> = {};
  if (counts === undefined) {
    for (const move of continuations) weights[move] = 1;
  } else {
    for (const move of continuations) weights[move] = counts[move] ?? 0;
  }
  return weights;
}

// "Ruy Lopez: Berlin Defense, Rio Gambit Accepted" -> ["Ruy Lopez",
// "Berlin Defense, Rio Gambit Accepted"] -- the vendored book's names
// follow "Family: Variation" (lichess-org/chess-openings' own
// convention). A name with no colon has no sub-variation to show -- just
// the family, on its own.
export function splitFamily(name: string): [string, string] {
  const idx = name.indexOf(":");
  if (idx === -1) return [name.trim(), ""];
  return [name.slice(0, idx).trim(), name.slice(idx + 1).trim()];
}

// Which DK positions each Piece is eligible for, per `sport`'s own piece
// bands (the inverse of classify) -- a band with positions=null (Queen,
// Pawn in NFL) is eligible for every position any roster slot accepts
// minus its own excludePositions (Queen/Pawn both exclude QB), not just
// one. Piece pools: a piece can have more than one band (Pawn does) --
// each contributes its own positions, unioned together.
function pieceEligiblePositions(sport: SportConfig): Map<Piece, Set<string>> {
  const allPositions = new Set<string>();
  for (const slot of sport.rosterSlots) {
    for (const p of slot.positions) allPositions.add(p);
  }
  const eligible = new Map<Piece, Set<string>>();
  for (const band of sport.pieceBands) {
    const bandPositions = new Set(band.positions ?? allPositions);
    if (band.excludePositions !== null) {
      for (const p of band.excludePositions) bandPositions.delete(p);
    }
    const existing = eligible.get(band.piece) ?? new Set<string>();
    for (const p of bandPositions) existing.add(p);
    eligible.set(band.piece, existing);
  }
  return eligible;
}

// A placeholder Player standing in for "some player of this piece type" --
// only `positions` matters for maxAssignable. A sport with no band at all
// for `piece` (legal -- only a catch-all PAWN band is required) gets no
// eligible positions, so maxAssignable correctly finds this proxy
// unassignable to any slot, which is exactly right: if the sport can
// never produce a player of this type, a line requiring one is infeasible
// there, full stop.
function proxyPlayer(piece: Piece, eligible: Map<Piece, Set<string>>): Player {
  return new Player({
    id: "",
    name: "",
    positions: Array.from(eligible.get(piece) ?? []),
    team: "",
    opp: "",
    salary: 0,
    proj: 0,
    ownSmall: 0,
    ownLarge: 0,
  });
}

// The 1-indexed ply at which `line` first makes either side's roster
// impossible to complete, counting piece types only (ignores salary cap
// and captures entirely -- a capture never transfers anything here, it's
// just another move of the capturing piece's type). Castling counts as
// one King pick and one Rook pick at that ply, per CLAUDE.md. Returns
// null if the line never breaks feasibility.
export function legalDepth(line: readonly string[], sport: SportConfig): number | null {
  const eligible = pieceEligiblePositions(sport);
  const board = new Chess();
  const proxies: { w: Player[]; b: Player[] } = { w: [], b: [] };

  for (let ply = 1; ply <= line.length; ply++) {
    const san = line[ply - 1];
    const matched = board.moves({ verbose: true }).find((m) => m.san === san);
    if (!matched) {
      throw new Error(`"${san}" is not a legal move at ply ${ply}`);
    }
    const side = board.turn();
    const piecesMoved: Piece[] =
      matched.isKingsideCastle() || matched.isQueensideCastle()
        ? [Piece.KING, Piece.ROOK]
        : [pieceForChessType(matched.piece)];

    proxies[side] = [...proxies[side], ...piecesMoved.map((p) => proxyPlayer(p, eligible))];

    if (maxAssignable(proxies[side], sport.rosterSlots) < proxies[side].length) {
      return ply;
    }

    board.move(san);
  }

  return null;
}

export interface OpeningPreviewFields {
  fen: string;
  whitePieces: readonly Piece[];
  blackPieces: readonly Piece[];
  breakPly: number | null;
}

export class OpeningPreview {
  readonly fen: string;
  readonly whitePieces: readonly Piece[];
  readonly blackPieces: readonly Piece[];
  readonly breakPly: number | null;

  constructor(fields: OpeningPreviewFields) {
    this.fen = fields.fen;
    this.whitePieces = fields.whitePieces;
    this.blackPieces = fields.blackPieces;
    this.breakPly = fields.breakPly;
  }
}

// A book line's DFS-relevant preview (Task 17): the final chess position
// (FEN) after playing every one of `line.moves` in full -- independent of
// `breakPly` below, this is just the position the line's own moves reach;
// for each side, the ordered sequence of piece types its moves would lock
// (castling counts as one King pick then one Rook pick, same convention
// legalDepth already uses); and the ply (1-indexed) at which the line
// first makes either side's roster impossible to complete, or null if it
// never does -- exactly legalDepth's own return value, reused rather than
// re-derived.
export function openingPreview(line: BookLine, sport: SportConfig): OpeningPreview {
  const board = new Chess();
  const whitePieces: Piece[] = [];
  const blackPieces: Piece[] = [];

  for (const san of line.moves) {
    const matched = board.moves({ verbose: true }).find((m) => m.san === san);
    if (!matched) {
      throw new Error(`"${san}" is not a legal move`);
    }
    const sidePieces = board.turn() === "w" ? whitePieces : blackPieces;
    if (matched.isKingsideCastle() || matched.isQueensideCastle()) {
      sidePieces.push(Piece.KING, Piece.ROOK);
    } else {
      sidePieces.push(pieceForChessType(matched.piece));
    }
    board.move(san);
  }

  return new OpeningPreview({
    fen: board.fen(),
    whitePieces,
    blackPieces,
    breakPly: legalDepth(line.moves, sport),
  });
}

export interface RankedFamilyFields {
  name: string;
  rank: number; // 1 = most played
  games: number; // the representative line's own games
  line: BookLine;
}

export class RankedFamily {
  readonly name: string;
  readonly rank: number;
  readonly games: number;
  readonly line: BookLine;

  constructor(fields: RankedFamilyFields) {
    this.name = fields.name;
    this.rank = fields.rank;
    this.games = fields.games;
    this.line = fields.line;
  }
}

// Task 20b: "umbrella" families whose own name is too broad/generic to
// usefully suggest (every opening starting 1. e4 is nominally a "King's
// Pawn Game") -- excluded from ranking outright, by name, regardless of
// how many games any of their rows have. Not derived from the data by a
// rule; a caller may override this list via rankFamilies's own parameter.
export const DEFAULT_EXCLUDED_FAMILIES: ReadonlySet<string> = new Set([
  "King's Pawn Game",
  "Queen's Pawn Game",
  "King's Knight Opening",
  "Indian Defense",
]);

// A line_stats.json entry -- just the fields rankFamilies reads
// (eco/name/moves/games). Loaders.ts's LineStatsEntry (the full loader
// return shape, with white_rate/draw_rate/black_rate too) is structurally
// assignable here; this stays independent of loaders.ts the same way
// Python's rank_families never imports anything from loaders.py either.
export interface RankableLine {
  eco: string;
  name: string;
  moves: readonly string[];
  games: number;
}

function repKey(entry: RankableLine): [number, number, string] {
  return [entry.games, -entry.moves.length, entry.eco];
}

function keyGreater(a: readonly [number, number, string], b: readonly [number, number, string]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Ranks each family (Task 20, corrected by Task 20b) -- splitFamily's
// first element -- by its most-played line reaching at least 6 plies,
// from ANY row whose name IS that family or starts with "<family>:" (not
// just a bare-name row -- Task 20's original restriction to the bare
// name was a bug; a named sub-variation's own row is a perfectly good
// representative). Ties: fewest plies, then eco. `excludedFamilies`
// (default DEFAULT_EXCLUDED_FAMILIES) are left off entirely regardless of
// games -- an explicit exclusion list, not a rule derived from the data
// (Task 20b). A family with no qualifying row at all is also left off
// (unranked). Rank 1 = most played.
export function rankFamilies(
  lineStats: readonly RankableLine[],
  excludedFamilies: ReadonlySet<string> = DEFAULT_EXCLUDED_FAMILIES,
): RankedFamily[] {
  const reps = new Map<string, RankableLine>();
  for (const entry of lineStats) {
    const [family] = splitFamily(entry.name);
    if (excludedFamilies.has(family) || entry.moves.length < 6) continue;
    const current = reps.get(family);
    if (current === undefined || keyGreater(repKey(entry), repKey(current))) {
      reps.set(family, entry);
    }
  }

  const rankedNames = Array.from(reps.keys()).sort((a, b) => {
    const gamesA = reps.get(a)!.games;
    const gamesB = reps.get(b)!.games;
    if (gamesA !== gamesB) return gamesB - gamesA; // descending games
    return compareStrings(a, b); // ascending name
  });

  return rankedNames.map((name, index) => {
    const rep = reps.get(name)!;
    return new RankedFamily({
      name,
      rank: index + 1,
      games: rep.games,
      line: new BookLine({ eco: rep.eco, name: rep.name, moves: [...rep.moves] }),
    });
  });
}

// The setup screen's default suggestion (Task 31): the ranked family at
// `contest`'s own target rank, exactly cli.py's `_prompt_for_opening_setup`
// -- `by_rank = {family.rank: family for family in ranked_families}`,
// `suggestion = by_rank[contest.target_rank(last_rank)]`. Its `.line` is
// the representative line pressing Enter at the setup screen would accept.
// Throws if `rankedFamilies` has no family at that rank -- can only happen
// if `rankedFamilies` is empty (target_rank is then 0), which Python's CLI
// avoids by branching to free play before ever computing a suggestion; no
// such free-play fallback exists at this pure layer.
export function suggestOpening(contest: ContestConfig, rankedFamilies: readonly RankedFamily[]): RankedFamily {
  const byRank = new Map(rankedFamilies.map((family) => [family.rank, family]));
  const target = contest.targetRank(rankedFamilies.length);
  const suggestion = byRank.get(target);
  if (suggestion === undefined) {
    throw new Error(`no ranked family at rank ${target}`);
  }
  return suggestion;
}

// The setup screen's 'r'/Random pick (Task 31): a seeded uniform choice
// from `rankedFamilies`, restricted to `tier`'s own [lowRank, highRank]
// when one is given, or across every ranked family when `tier` is "all" --
// cli.py's `rng.choice(pool)` over `own_tier_pool or ranked_families`,
// generalized so the caller picks the pool directly rather than this
// function deriving "own tier" from a contest itself. Uses rng.ts's
// SeededRandom, not Python's random.Random -- same seed always gives the
// same TS pick, not necessarily the same pick Python would make for that
// seed number (see rng.ts's own header).
export function randomOpening(
  rankedFamilies: readonly RankedFamily[],
  tier: EntryTier | "all",
  seed: number,
): RankedFamily {
  const pool =
    tier === "all" ? rankedFamilies : rankedFamilies.filter((family) => family.rank >= tier.lowRank && family.rank <= tier.highRank);
  return new SeededRandom(seed).choice(pool);
}
