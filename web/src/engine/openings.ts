// Opening book queries -- pure (no I/O). Book data is loaded by
// loaders.ts (loadOpeningBook) and handed in here as BookLine[]. Ported
// from dfs_chess/openings.py: naming (openingName, findOpeningLines,
// splitFamily), continuations (continuingLines, bookContinuations,
// bookWeights), and legal depth (legalDepth) only, per this task's scope.
// Family ranking (rankFamilies/RankedFamily/DEFAULT_EXCLUDED_FAMILIES),
// field-size tiers, target rank, suggestion, opening preview
// (OpeningPreview/openingPreview), and the build loop are all out of
// scope -- none of them are needed by (or tangled into) what's ported
// here. See this task's session log.

import { Chess } from "chess.js";
import { Piece, Player } from "./models";
import { pieceForChessType } from "./pieces";
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

// The name of the longest book line that's a prefix of `moves` (including
// an exact match), or null if no line matches at all.
export function openingName(moves: readonly string[], book: readonly BookLine[]): string | null {
  let best: BookLine | null = null;
  for (const line of book) {
    if (line.moves.length <= moves.length && movesEqual(line.moves, moves.slice(0, line.moves.length))) {
      if (best === null || line.moves.length > best.moves.length) {
        best = line;
      }
    }
  }
  return best ? best.name : null;
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
// Pawn in NFL) is eligible for every position any roster slot accepts,
// not just one.
function pieceEligiblePositions(sport: SportConfig): Map<Piece, Set<string>> {
  const allPositions = new Set<string>();
  for (const slot of sport.rosterSlots) {
    for (const p of slot.positions) allPositions.add(p);
  }
  const eligible = new Map<Piece, Set<string>>();
  for (const band of sport.pieceBands) {
    const bandPositions = band.positions ?? allPositions;
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
