// Task 38: "the chosen line only suggests White's moves; White may play
// any legal move." White drags on the board (BuildBoard); Black always
// replies via the engine's own book-committed free play (build.
// playBlackMove) after a short pause so the move reads as its own turn.
//
// A White move is never committed to `state` until its pick is confirmed:
// BuildBoard's `fen` is `previewFen` (the current `state` plus the
// tentative move, computed with a scratch chess.js clone -- a pure chess-
// mechanics preview, not a DFS rule) while a pick is pending, and plain
// `state.board.fen()` otherwise. Cancel just drops `pendingMove`, which
// snaps `previewFen` back to `state`'s own fen -- no engine-level undo is
// needed.
//
// Task 38b: matches design/'s mockups. The opening banner is now driven by
// `chosenOpening` itself (its family/eco/variation/moves are fixed, shown
// regardless of how far the build has gone), not by replaying `state`'s
// history through `openingLine` on every commit the way Task 38 did --
// that's also what fixes "the banner falls back to a plain 'Chess DFS'
// title before any move has been played" (there was no chosen-line data in
// it at all until the first commit). "Now: <live name> · <eco>" and "Left
// the line after <move>" are the dynamic half, read fresh off `history`
// each render. The single "Suggested: X / Play it" banner is gone too --
// replaced by "Book continues," which lists every offerable continuation
// (not just the chosen line's own next move), the chosen one first and
// highlighted.
//
// Task 39: castling and captures now reach this screen too (buildFlow.
// dfsLegalMoves no longer excludes them -- build.moveIsCompletable, via
// resolvePlayers, already resolved them correctly; the exclusion was a
// pure UI restriction). `classifyMove` tells handleBoardMove which of five
// flows a given move drives:
//   - silentKing: pushSilentMove, exactly as before -- no pick at all.
//   - ordinary: the existing one-step pick, unchanged.
//   - captureTransfer: the captured piece already has lock history -- no
//     modal at all, the transfer is unambiguous. Committed immediately,
//     with a "You captured <player>." note for the status line.
//   - captureUnmoved: a one-step pick, same shape as "ordinary" but for
//     the CAPTURED piece's type, not the capturing piece's.
//   - castleEmerge / castlePlaced: castling, which always locks King+Rook
//     (EMERGE) or just Rook (PLACED, the King already being locked from
//     setup). EMERGE is a genuine two-step pick (PendingMove grows a
//     `king` field between steps, forcing PickPanel to remount via its
//     `key` so its own internal selection state doesn't carry over from
//     the King step to the Rook step). PLACED is ALSO two steps now
//     (RULES.md piece table, Rook = correlation): the one-time "Switch
//     your QB?" offer (Task 14) first, THEN the Rook pick, since the
//     Rook must be a teammate of whichever QB ends up final -- neither
//     step commits anything to engine state until the Rook is actually
//     chosen (castlePlacedRook carries the post-switch-or-not `baseState`
//     forward), so Black's reply never needs deferring the way the old
//     (post-commit) switch offer once did.
import { Chess } from "chess.js";
import type { Square } from "chess.js";
import type { Dests, Key } from "@lichess-org/chessground/types";
import { useEffect, useMemo, useRef, useState } from "react";
import "./BuildScreen.css";
import { BOOK, LAST_RANK, NFL, POPULARITY, RANKED_FAMILIES, RANK_BY_FAMILY } from "./appData";
import BuildBoard, { type PieceTooltipContent } from "./BuildBoard";
import { blockedMoveReason, classifyMove, type MoveKind } from "./buildFlow";
import {
  pickReason,
  pieceBandLabel,
  pointsFromOptimal,
  sideStats,
  tightFinishStatus,
  type PointsFromOptimal,
  type SideStats,
  type TightFinishLevel,
  type TightFinishStatus,
} from "./buildStats";
import { HAPPY_HUNTING, NoLegalBlackMoveError, checkWhiteDeadEnd, moveIsCompletable, playBlackMove, playWhiteMove } from "./engine/build";
import type { ContestConfig, ContestPreset } from "./engine/config";
import { BuildState, KingMode, Piece, Side, type Move, type Player } from "./engine/models";
import { bookContinuations, openingLine, openingName, splitFamily, type BookLine } from "./engine/openings";
import { optimalLineup } from "./engine/optimizer";
import { pieceForChessType } from "./engine/pieces";
import { castleQbCandidates, castleRookList, pickList } from "./engine/picklist";
import { SeededRandom } from "./engine/rng";
import {
  assignRosterSlots,
  capturedSquare,
  isLineupComplete,
  lineupStillCompletable,
  lockedQbTeam,
  placeKings,
  pushSilentMove,
  switchKing,
  type ChessMove,
} from "./engine/rules";
import type { SlateVegas } from "./engine/sim/draws";
import type { SimulatedField } from "./engine/sim/field";
import { validateVegasCsv } from "./engine/sim/vegasCsv";
import type { SimResult } from "./engine/sim/run";
import type { SportConfig } from "./engine/sport";
import { NO_FIELD_CACHED_MESSAGE, resolveCachedField, slateSignature } from "./fieldCacheStore";
import { getSavedProjectionsCsv } from "./projectionsStore";
import { getSavedVegasCsv } from "./vegasStore";
import { runSimInWorker } from "./simRunner";
import { stockfishEngine } from "./stockfishEngine";
import PickPanel, { type PickMoveContext } from "./PickPanel";
import TightFinishDialog from "./TightFinishDialog";
import type { ChosenOpening } from "./SetupScreen";
import ThemeToggle from "./ThemeToggle";

const PIECE_LABEL: Record<Piece, string> = {
  KING: "King",
  QUEEN: "Queen",
  ROOK: "Rook",
  BISHOP: "Bishop",
  KNIGHT: "Knight",
  PAWN: "Pawn",
};

const PIECE_GLYPH: Record<Piece, string> = {
  KING: "♚",
  QUEEN: "♛",
  ROOK: "♜",
  BISHOP: "♝",
  KNIGHT: "♞",
  PAWN: "♟",
};

// Every square a chess move has ever landed on in `board`'s history --
// including a castling move's own Rook destination, which chess.js's
// verbose history only records via the King's two-square hop (same
// from-square -> rook-squares mapping rules.ts's own, unexported
// castlingRookSquares uses). A piece sitting on a square NOT in this set
// has genuinely never moved (still its FEN start square, untouched by any
// move at all) -- the board-hover tooltip's "Never moved" case. One that
// HAS moved but still has no pieceLocks entry locked no one along the way
// (a silent push after the lineup filled, or a never-fitting capturer
// whose own history never gains an entry; see rules.ts's applyCaptureMove)
// -- the tooltip's "No player" case instead.
function squaresEverArrived(board: Chess): ReadonlySet<Square> {
  const squares = new Set<Square>();
  for (const move of board.history({ verbose: true })) {
    squares.add(move.to);
    if (move.isKingsideCastle() || move.isQueensideCastle()) {
      const kingside = move.isKingsideCastle();
      squares.add(move.from === "e1" ? (kingside ? "f1" : "d1") : kingside ? "f8" : "d8");
    }
  }
  return squares;
}

// Board-hover tooltip content for whichever piece sits on `square` right
// now (BuildBoard itself knows nothing about this -- see its
// PieceTooltipContent/getPieceTooltip). Null if `square` is empty.
//   - Lock history (pieceLocks has an entry) -> the most recently locked
//     player (the one a capture would transfer): name, position, salary,
//     projection, ownership. A Field (Black) piece also gets the same fit
//     check applyCaptureMove itself uses -- would transferring this player
//     to White's current roster still leave it completable.
//   - No lock history, but the square has been arrived at before
//     (squaresEverArrived) -> "No player" (moved, but never locked one --
//     e.g. a silent push after the lineup filled).
//   - No lock history, square never arrived at -> "Never moved," naming
//     the piece type a capture would let White pick fresh.
function pieceTooltipContent(
  state: BuildState,
  square: Square,
  sport: SportConfig,
  contest: ContestConfig,
  touchedSquares: ReadonlySet<Square>,
): PieceTooltipContent | null {
  const boardPiece = state.board.get(square);
  if (boardPiece === undefined) return null;

  const history = state.pieceLocks.get(square) ?? [];
  if (history.length > 0) {
    const player = history[history.length - 1];
    const tier = contest.fieldTier();
    const detail = `${player.positions[0]} · $${player.salary.toLocaleString()} · ${player.proj.toFixed(1)} pts · ${(player.ownFor(tier) * 100).toFixed(1)}% own`;
    if (boardPiece.color !== "b") {
      return { title: player.name, detail };
    }
    const cap = contest.effectiveCap(sport);
    const fits = lineupStillCompletable([...state.whiteMoves.map((m) => m.player), player], sport, cap);
    const fit = fits
      ? { fits: true, text: "Capture: joins you" }
      : { fits: false, text: "Capture: won't fit — returns to pool" };
    return { title: player.name, detail, fit };
  }

  if (touchedSquares.has(square)) {
    return { title: "No player" };
  }

  const pieceType = pieceForChessType(boardPiece.type);
  return { title: "Never moved", detail: `Capturing lets you pick a ${PIECE_LABEL[pieceType]}.` };
}

// "Fill out my core": a player the optimizer added, not locked by any
// chess move -- there's no Piece for one (no move ever locked it), so
// this stands in for PIECE_GLYPH/PIECE_LABEL wherever a roster row needs
// to show which is which. The literal text this task asks for.
const OPTIMIZER_GLYPH = "✦";
const OPTIMIZER_LABEL = "(optimizer)";

// One roster row, piece-locked or optimizer-filled -- SideColumn's own
// list, FinishCard's table, and lineupText all walk the same shape so
// White's two kinds of roster entry render identically everywhere
// (ordering: every piece-locked move first, in play order, then every
// optimizer-filled player after -- matches assignRosterSlots' own "same
// order as the input array" contract).
interface RosterEntry {
  readonly label: string; // PIECE_LABEL[piece], or OPTIMIZER_LABEL
  readonly glyph: string; // PIECE_GLYPH[piece], or OPTIMIZER_GLYPH
  readonly player: Player;
}
function rosterEntries(moves: readonly Move[], filled: readonly Player[]): RosterEntry[] {
  return [
    ...moves.map((m) => ({ label: PIECE_LABEL[m.piece], glyph: PIECE_GLYPH[m.piece], player: m.player })),
    ...filled.map((p) => ({ label: OPTIMIZER_LABEL, glyph: OPTIMIZER_GLYPH, player: p })),
  ];
}

const HOW_IT_WORKS_KEY = "chess-dfs:how-it-works-dismissed";
const HOW_IT_WORKS_TEXT =
  "You're White. Each move locks a DFS player of that piece's type: pawns are cheap plays, knights TEs, bishops WRs, rooks RBs, queens $7K+ studs, the king your QB. The Field (Black) does the same. Build a 4–5 player core, then stop or keep going.";

// Housekeeping "Faster tests": a `let`, not a `const`, so each BuildScreen-
// rendering test file can override it to near-zero (not exactly 0 -- a
// `setTimeout(fn, 0)` can still fire within a single `await
// user.click(...)`'s own turns of the event loop, racing a test that
// asserts the synchronous pre-reply state) via setBlackReplyDelayForTests
// below, right after its own imports -- shaving this fixed pause off of
// every test that waits through a Black reply (most of them) without
// touching the real app's own pacing at all. Never called from
// BuildScreen.tsx itself or from any non-test file.
let BLACK_REPLY_DELAY_MS = 600;

// Test-only override hook -- see this constant's own comment above.
export function setBlackReplyDelayForTests(ms: number): void {
  BLACK_REPLY_DELAY_MS = ms;
}

// Bug fix: shown once Stockfish genuinely fails (not just "has no opinion"
// -- see build.ts's MoveResult.engineFailed) instead of letting the status
// line keep reading "The Field is moving…" forever while Black's reply
// actually already landed fine (the uniform-random fallback, same as
// always ran before Stockfish existed).
const ENGINE_UNAVAILABLE_NOTE = "Engine unavailable — Field moving without Stockfish.";
// At the very start of a build, `bookContinuations` returns essentially
// every first move recorded anywhere in the 3,865-line book -- dozens of
// options, not a useful menu. Capped to the chosen line's own move (always
// first, regardless of popularity) plus the N next-most-popular BY REAL
// PER-POSITION GAME COUNT (openings.bookWeights -- bug fix: this used to be
// RANKED_FAMILIES' whole-family rank, the Explorer's own ranking, which
// answers a different question -- "how played is this family overall,"
// not "how often is this move actually played from here") -- rather than
// every legal continuation; "(Play your own move)" covers anything not
// shown.
const CONTINUATION_LIMIT = 8;

interface Props {
  preset: ContestPreset;
  players: readonly Player[];
  kingMode: KingMode;
  whiteKing: Player | null;
  blackKing: Player | null;
  chosenOpening: ChosenOpening;
  // Rule change "Sim 5": SetupScreen now generates this (it needs to, for
  // Black's own QB pick at setup -- see its own ChosenSetup.buildSeed
  // comment) and passes it down, rather than this component rolling its
  // own via Math.random() -- optional only so every existing test/caller
  // that doesn't care about seed continuity across setup+build keeps
  // compiling unchanged; omitted, this falls back to the exact same
  // Math.random() roll as before this rule change.
  buildSeed?: number;
  // Task 40: "Start again" (same contest + King mode, back to the opening
  // choice) and "New contest" (full setup) -- both fired from here (the
  // header link, the book-exit prompt, and the finish screen all reach
  // back up to App.tsx, which owns screen navigation) but never acted on
  // locally; BuildScreen itself has no notion of "setup."
  onStartAgain: () => void;
  onNewContest: () => void;
}

// Task 40: how the build ended -- drives the finish screen (replacing the
// board area's own controls) and, for a dead end, which side's own message
// the status line/headline uses. `openSlots`/every other finish-screen
// field is read fresh off `state`/`whiteStats` at render time rather than
// captured here: `state` is never mutated by the failed move/pick that
// produced an ending (checkWhiteDeadEnd's own dead-end case touches
// nothing; Black's dead end is caught before any setState for it), so it's
// already exactly the right snapshot.
type Ending = { kind: "stopped" } | { kind: "complete" } | { kind: "deadEnd"; side: Side } | { kind: "filled" };

// Sim 4: one side's own Monte Carlo sim status -- "idle" (never triggered
// this build) renders nothing at all (SideColumn), the rest render a
// message or the real numbers. `isBestFinish` is known the moment a run
// starts (it only depends on whether THIS side's own lineup was already
// complete, not on anything the sim itself produces), so every non-idle
// variant carries it, including "noField" -- the "(best finish)" label
// shouldn't flicker on/off depending on whether a field happens to be
// cached.
type SideSimState =
  | { kind: "idle" }
  | { kind: "noField"; isBestFinish: boolean }
  | { kind: "running"; isBestFinish: boolean }
  | { kind: "done"; result: SimResult; isBestFinish: boolean }
  | { kind: "error"; message: string; isBestFinish: boolean };

// The finish screen's "how it ended" headline -- RULES.md/dfs_chess/cli.py
// give the dead-end wording verbatim ("Black has hit a dead end."/"You
// have hit a dead end."); "stopped"/"complete" have no CLI precedent (the
// CLI's own `stop` command and a naturally-completed lineup share one
// identical ending with no distinguishing text at all), so this invents a
// short, equally plain line for each.
function endingHeadline(ending: Ending): string {
  switch (ending.kind) {
    case "stopped":
      return "You stopped with this core.";
    case "complete":
      return "Your lineup is complete.";
    case "deadEnd":
      return ending.side === Side.BLACK ? "Black has hit a dead end." : "You have hit a dead end.";
    case "filled":
      return "Your core was filled out by the optimizer.";
  }
}

// A pending White move's own pick flow -- every variant carries the same
// `chessMove`/`san` (the move itself is fixed once a drag/tap starts it;
// only which player(s) it locks is still being decided):
//   - ordinary/captureUnmoved: one pick, for `piece`/`capturedPiece`
//     respectively.
//   - castleEmergeKing -> castleEmergeRook: two picks in sequence (King,
//     then Rook); the `king` field only exists on the second step, once
//     the first is chosen.
//   - castlePlacedSwitch -> castlePlacedRook: PLACED mode's own two
//     steps -- the King is already locked from setup, so this starts
//     with the one-time "Switch your QB?" offer (Task 14) instead of a
//     King pick, then the Rook from whichever QB is FINAL (the original,
//     or the switched-to one). RULES.md piece table: the Rook has to be
//     a teammate of that final QB, so the switch must resolve before the
//     Rook step, not after (the old order, back when Rook wasn't
//     team-dependent) -- `baseState` on the Rook step is `state` itself
//     (switch declined) or the post-switchKing state (switch accepted),
//     carried forward since neither is committed to engine state yet.
type PendingMove =
  | { kind: "ordinary"; chessMove: ChessMove; piece: Piece; san: string }
  | { kind: "captureUnmoved"; chessMove: ChessMove; capturedPiece: Piece; san: string }
  | { kind: "castleEmergeKing"; chessMove: ChessMove; san: string }
  | { kind: "castleEmergeRook"; chessMove: ChessMove; san: string; king: Player }
  | { kind: "castlePlacedSwitch"; chessMove: ChessMove; san: string }
  | { kind: "castlePlacedRook"; chessMove: ChessMove; san: string; baseState: BuildState };

interface ContinuationOption {
  san: string;
  moveLabel: string;
  openingLabel: string | null;
  lockLabel: string;
  isChosen: boolean;
  // Bug fix: real per-position popularity (openings.bookWeights, Lichess
  // game counts AT THIS EXACT POSITION) -- the actual "by popularity" this
  // list was always meant to sort by. Equal weight (no popularity data for
  // this position at all, or two moves tied) falls back to `rank` below.
  weight: number;
  // The resulting opening's family rank (lower = more played), Infinity if
  // its family isn't ranked at all -- tiebreak only (for two continuations
  // with equal `weight`), never shown.
  rank: number;
}

function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function lockDescription(piece: Piece): string {
  const band = pieceBandLabel(piece, NFL);
  return band !== null ? `Locks a ${PIECE_LABEL[piece]}: ${band}` : `Locks a ${PIECE_LABEL[piece]}`;
}

// Task 39: Book continues now also lists castling and captures (buildFlow.
// dfsLegalMoves offers them whenever they're DFS-legal) -- each needs its
// own "what does this actually lock" phrasing, since it isn't always "a
// player of the moving piece's own type" the way an ordinary move is.
function continuationLockLabel(kind: MoveKind, transferredPlayerName: string | null): string {
  switch (kind.kind) {
    case "ordinary":
      return lockDescription(kind.piece);
    case "captureTransfer":
      return transferredPlayerName !== null ? `Captures ${transferredPlayerName} (already locked)` : "Captures a locked player";
    case "captureUnmoved":
      return `Captures an unmoved ${PIECE_LABEL[kind.capturedPiece].toLowerCase()} -- ${lockDescription(kind.capturedPiece)}`;
    case "castleEmerge":
      return "Castles -- locks a King + Rook";
    case "castlePlaced":
      return "Castles -- locks a Rook";
    case "silentKing":
      return "No pick (King already placed)";
  }
}

// The status line's text while a pick is pending -- one line per
// PendingMove variant; the two castling steps share the same text (the
// modal's own heading, driven by pendingPiece below, is what actually
// distinguishes "choose your King" from "choose your Rook").
function pendingPickText(pendingMove: PendingMove): string {
  switch (pendingMove.kind) {
    case "castleEmergeKing":
    case "castleEmergeRook":
      return "Pick your QB, then your RB (castling).";
    case "castlePlacedSwitch":
      return "Switch your QB?";
    case "castlePlacedRook":
      return `Pick your ${PIECE_LABEL[Piece.ROOK]}.`;
    case "captureUnmoved":
      return `Pick your ${PIECE_LABEL[pendingMove.capturedPiece]}.`;
    case "ordinary":
      return `Pick your ${PIECE_LABEL[pendingMove.piece]}.`;
  }
}

// Which piece type the pending pick's modal is choosing a player OF --
// not always the moving piece's own type (captureUnmoved asks for the
// CAPTURED piece's type; castling asks for King then Rook, or just Rook).
function pendingPiece(pendingMove: PendingMove): Piece {
  switch (pendingMove.kind) {
    case "ordinary":
      return pendingMove.piece;
    case "captureUnmoved":
      return pendingMove.capturedPiece;
    case "castleEmergeKing":
    case "castlePlacedSwitch":
      return Piece.KING;
    case "castleEmergeRook":
    case "castlePlacedRook":
      return Piece.ROOK;
  }
}

// The roster `pickReason`/the "After this pick" footer should treat as
// already locked for this step -- ordinary/castleEmergeRook's own King
// pick included once chosen, so the Rook step's feasibility check (and
// footer) reflects both new picks together, not just the Rook alone;
// castlePlacedSwitch excludes the outgoing QB (a swap, not an addition);
// castlePlacedRook reads off its own `baseState` (the switch may have
// already replaced White's QB before this step even started).
function pendingBaseline(pendingMove: PendingMove, whiteMoves: readonly Move[]): Player[] {
  switch (pendingMove.kind) {
    case "castleEmergeRook":
      return [...whiteMoves.map((m) => m.player), pendingMove.king];
    case "castlePlacedSwitch": {
      const oldKing = whiteMoves.find((m) => m.piece === Piece.KING)?.player;
      return whiteMoves.filter((m) => m.player.id !== oldKing?.id).map((m) => m.player);
    }
    case "castlePlacedRook":
      return pendingMove.baseState.whiteMoves.map((m) => m.player);
    default:
      return whiteMoves.map((m) => m.player);
  }
}

// The pending pick's own candidate list -- RULES.md piece table: each
// piece's pick list (engine/picklist.ts's pickList, sorted by that
// piece's own metric -- uncapped, Rule change "Remove the pick list
// cap"), not a blanket "every eligible player" (eligibility/taken/roster-
// salary filters still apply). Direct Rook moves ("ordinary"/
// "captureUnmoved") pass the moving side's own locked-QB team
// (lockedQbTeam) for the stack-tier sort only (Rule change "Rook: stack
// builder" -- eligibility is no longer team-restricted at all). Castling
// is UNCHANGED: its own Rook step (castleRookList) keeps the old "QB's
// teammates only" restriction; its King step additionally restricts to
// QBs with an eligible teammate (castleQbCandidates) -- RULES.md: "If
// none, castling is illegal."
function candidatesFor(pendingMove: PendingMove, state: BuildState, players: readonly Player[], contest: ContestConfig): Player[] {
  const current = state.whiteMoves.map((m) => m.player);
  switch (pendingMove.kind) {
    case "castleEmergeKing":
      return castleQbCandidates(players, state.lockedPlayerIds, current, NFL, contest);
    case "castleEmergeRook":
      return castleRookList(players, state.lockedPlayerIds, [...current, pendingMove.king], NFL, contest, pendingMove.king.team);
    case "castlePlacedSwitch":
      return pickList(Piece.KING, players, state.lockedPlayerIds, pendingBaseline(pendingMove, state.whiteMoves), NFL, contest);
    case "castlePlacedRook": {
      const base = pendingMove.baseState;
      const qbTeam = lockedQbTeam(base, Side.WHITE);
      return qbTeam === null ? [] : castleRookList(players, base.lockedPlayerIds, base.whiteMoves.map((m) => m.player), NFL, contest, qbTeam);
    }
    case "ordinary":
      return pickList(pendingMove.piece, players, state.lockedPlayerIds, current, NFL, contest, lockedQbTeam(state, Side.WHITE));
    case "captureUnmoved":
      return pickList(pendingMove.capturedPiece, players, state.lockedPlayerIds, current, NFL, contest, lockedQbTeam(state, Side.WHITE));
  }
}

function openSlotLabels(stats: SideStats): string[] {
  const labels: string[] = [];
  for (const slot of NFL.rosterSlots) {
    const open = stats.openSlots[slot.name] ?? 0;
    for (let i = 0; i < open; i++) labels.push(slot.name);
  }
  return labels;
}

export default function BuildScreen({
  preset,
  players,
  kingMode,
  whiteKing,
  blackKing,
  chosenOpening,
  buildSeed: buildSeedProp,
  onStartAgain,
  onNewContest,
}: Props) {
  // Bug fix: a chosen "line" opening was never seeded as Black's own
  // committed line, so build.playBlackMove's "keep the committed line while
  // it still matches, re-choose by rank-closeness once it doesn't" (its own
  // long-standing, correct behavior -- see its header comment) had nothing
  // to keep: blackCommittedLine started null, so Black re-chose by rank-
  // closeness on its very FIRST reply regardless of what White chose,
  // immediately contradicting Task 38's own "Black still follows its line
  // while White stays on it" (the chosen line's line, not a never-seeded
  // one). Seeding it here is the whole fix -- playBlackMove's existing
  // logic already drops it the moment White deviates (isPrefixMatch fails)
  // or the line runs out, same as it always has for any other committed
  // line. "own opening" (no chosen line) is unaffected -- stays null,
  // Black picks by rank-closeness from the first reply, as before.
  const [state, setState] = useState<BuildState>(() => {
    const base =
      kingMode === KingMode.PLACED && whiteKing !== null && blackKing !== null
        ? placeKings(whiteKing, blackKing, NFL, preset.contest)
        : new BuildState();
    if (chosenOpening.kind === "line") base.blackCommittedLine = chosenOpening.line.moves;
    return base;
  });
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  // Task 40: how the build ended (null while still ongoing) -- see the
  // Ending type above. The only two moments White's own turn can START
  // dead are right at mount (checked once, right here) and right after
  // Black's reply lands (checked explicitly in scheduleBlackReply's own
  // success branch, below) -- White's own move/pick always hands the turn
  // to Black, and Take back only ever restores a state White already had
  // a legal move from. Deriving this from the initial `state` directly,
  // rather than a useEffect scanning every render, keeps the check tied to
  // the actual event that could cause it.
  const [ending, setEnding] = useState<Ending | null>(() =>
    checkWhiteDeadEnd(state, NFL, preset.contest, players, kingMode) !== null ? { kind: "deadEnd", side: Side.WHITE } : null,
  );
  // "Fill out my core" (White only): players the OPTIMIZER added to
  // White's open slots, distinct from `state.whiteMoves` (which only ever
  // holds players locked by an actual chess move) -- the engine's own
  // BuildState has no concept of a player locked any other way, so this
  // stays pure UI-layer state rather than a new engine mechanism. Empty
  // until fillOutCore runs; never cleared afterward (Take back is already
  // disabled once `ending` is set, so there's no path back to editing a
  // filled core -- see canTakeBack).
  const [whiteFilledPlayers, setWhiteFilledPlayers] = useState<readonly Player[]>([]);
  // Bug fix: Black's reply threw something OTHER than a genuine "no legal
  // move" (NoLegalBlackMoveError) -- not a dead end, just surfaced as-is so
  // it's visible instead of silently mislabeled. The build doesn't end:
  // `ending` stays null, so Take back (which only needs pastStates.length
  // > 0 and nothing mid-flight) is still reachable, same as the bug report
  // asks for. Cleared on the next real action (a new commit, or Take back
  // itself) so it doesn't linger once the player has moved past it.
  const [blackMoveError, setBlackMoveError] = useState<string | null>(null);
  // Bug fix: handleBoardMove used to just `return` when chessground
  // reported a move whose (orig, dest) didn't match any of White's own
  // offered dests -- silent, no feedback at all. Normally unreachable
  // (dests only ever offers matched's own from/to pairs), but a move
  // should never just vanish if it somehow does happen (e.g. a stale
  // handler reading a dests set that's since changed) -- the status line
  // says why instead. Cleared at the top of every handleBoardMove call, so
  // the next attempt (successful or not) always starts fresh.
  const [moveRejected, setMoveRejected] = useState<string | null>(null);
  // Task 40 "Take back": a stack of every `state` snapshot right BEFORE a
  // White move was committed (pushed once per commit() call, never for
  // Black's own reply -- popping one entry undoes a White move AND
  // whatever Black replied with, since that's the later state being
  // discarded). Every apply/castle/capture clones rather than mutating
  // (see rules.ts's cloneBoard), so holding onto old BuildState snapshots
  // is safe.
  const [pastStates, setPastStates] = useState<BuildState[]>([]);
  // Task 40: true from the moment Black's reply timer is scheduled until
  // it actually lands (success or a dead end) -- a plain ref can't drive
  // "disabled while Black is moving" reactively, since changing it alone
  // doesn't trigger a re-render.
  const [blackMoving, setBlackMoving] = useState(false);
  // Task 40 "Leaving the book": sticky once set -- either the player
  // explicitly clicked "Continue," or played a move while the prompt was
  // showing (handleBoardMove/playSan treat that as an implicit continue).
  // Never reset: once truly out of book, continuationOptions staying empty
  // on every later White turn would otherwise re-show the same prompt
  // forever.
  const [bookExitDismissed, setBookExitDismissed] = useState(false);
  // Task 39 status-line notes for the two "something just got captured"
  // scenarios the generic "Pick your X"/"Field played X and locked Y"
  // phrasing doesn't cover -- see the status-line priority chain below.
  // Both are write-once-per-move: `commit` always sets whiteCaptureNote
  // (to null for a non-capture commit), and blackMoveNote is recomputed
  // fresh every time Black actually moves.
  const [whiteCaptureNote, setWhiteCaptureNote] = useState<string | null>(null);
  const [blackMoveNote, setBlackMoveNote] = useState<string | null>(null);
  // Bug fix: sticky once Stockfish genuinely fails (engineFailed, not just
  // "had no opinion" -- see ENGINE_UNAVAILABLE_NOTE above) -- the worker's
  // own readyPromise is memoized forever once it rejects (stockfishEngine.ts
  // never retries), so once it's broken for one Black turn it stays broken
  // for the rest of this build; never reset.
  const [engineUnavailable, setEngineUnavailable] = useState(false);
  const [howItWorksDismissed, setHowItWorksDismissed] = useState<boolean>(
    () => window.localStorage.getItem(HOW_IT_WORKS_KEY) === "1",
  );
  const blackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (blackTimerRef.current !== null) clearTimeout(blackTimerRef.current);
    };
  }, []);

  // Sim 4: one SideSimState per side, plus the live Worker each one is
  // currently waiting on (so a new run can terminate the old one -- "if a
  // new sim starts, cancel the old one") and a monotonic run id (so a
  // stale worker's response, in flight at the moment a newer run starts,
  // is ignored even though terminate() should already prevent it from
  // ever posting -- belt and suspenders, cheap to keep).
  const [whiteSim, setWhiteSim] = useState<SideSimState>({ kind: "idle" });
  const [blackSim, setBlackSim] = useState<SideSimState>({ kind: "idle" });
  const whiteSimWorkerRef = useRef<Worker | null>(null);
  const blackSimWorkerRef = useRef<Worker | null>(null);
  const simRunIdRef = useRef(0);

  useEffect(() => {
    return () => {
      whiteSimWorkerRef.current?.terminate();
      blackSimWorkerRef.current?.terminate();
    };
  }, []);

  // Stable for the component's lifetime -- re-seeding every render (or
  // every Black move) would break play's own book-line commitment logic,
  // which depends on one continuously-advancing PRNG sequence. useState's
  // lazy initializer (not useRef's eager argument) is what keeps
  // Math.random() from being called -- impurely -- on every render; only
  // the first render's call is ever used. `buildSeed` is split out as its
  // own captured value (Sim 4) rather than reading it back off `rng` --
  // `rng` is a LIVE, continuously-advancing generator reserved for Black's
  // own book/random choices; consuming it to seed a sim run would perturb
  // Black's subsequent play non-deterministically depending on whether
  // "Sim my core" was ever clicked. "Derive from the build's own seed" is
  // satisfied by reusing this one fixed number for every sim run this
  // build ever makes, not by drawing a fresh one per click.
  //
  // Rule change "Sim 5": `buildSeedProp` (SetupScreen's own seed, already
  // spent once there on Black's QB pick) takes over whenever the caller
  // supplies one, so Black's later picks continue drafting against the
  // same number the setup pick already used -- see ChosenSetup.buildSeed.
  // Falls back to the original Math.random() roll when it's omitted
  // (every pre-Sim-5 test/caller).
  const [buildSeed] = useState<number>(() => buildSeedProp ?? Math.floor(Math.random() * 2 ** 31));
  const [rng] = useState<SeededRandom>(() => new SeededRandom(buildSeed));
  const familyRanks = useMemo(() => Object.fromEntries(RANKED_FAMILIES.map((f) => [f.name, f.rank])), []);
  const targetRank = useMemo(() => preset.contest.targetRank(LAST_RANK), [preset]);

  const turn = state.board.turn();
  const history = state.board.history();
  const moveNumber = Math.floor(history.length / 2) + 1;

  // Rule change: every real, legal chess move is now offered as a drag
  // destination, not just the DFS-legal ones -- a drop on a move that's
  // legal chess but blocked by the DFS rules must still be refusable
  // with a reason (see handleBoardMove's blockedMoveReason branch below),
  // which needs chessground to actually complete the drop and fire its
  // callback in the first place. `allMoves` and `legalMoves` (the DFS-
  // legal subset) share one chess.js move-generation call rather than
  // dfsLegalMoves' own (which would otherwise run it a second time every
  // render -- a real, avoidable cost, not just a style preference).
  const allMoves = turn === "w" ? state.board.moves({ verbose: true }) : [];
  const legalMoves = allMoves.filter((move) => {
    const chessMove: ChessMove = { from: move.from, to: move.to, promotion: move.promotion };
    return moveIsCompletable(state, chessMove, NFL, preset.contest, players, kingMode);
  });
  const legalSans = new Set(legalMoves.map((m) => m.san));
  const dests: Dests = new Map();
  for (const move of allMoves) {
    const arr = dests.get(move.from) ?? [];
    arr.push(move.to);
    dests.set(move.from, arr);
  }

  const chosenLine: BookLine | null = chosenOpening.kind === "line" ? chosenOpening.line : null;
  const playedCount = chosenLine !== null ? commonPrefixLength(history, chosenLine.moves) : 0;
  const onChosenLine = chosenLine !== null && playedCount === history.length;
  const chosenNextMove = onChosenLine && chosenLine !== null && playedCount < chosenLine.moves.length ? chosenLine.moves[playedCount] : null;

  let bannerSubtext: string | null = null;
  if (chosenLine !== null && !onChosenLine) {
    // `playedCount` is the index of the first move that broke the match
    // (frozen there even as `history` keeps growing afterward -- it's the
    // longest common prefix, which never gets longer once it's stopped
    // matching). onChosenLine is only ever false once at least one move
    // has been played (at depth 0 the empty history trivially still
    // matches, i.e. playedCount === history.length === 0), so that move
    // always exists.
    bannerSubtext = `Left the line after ${history[playedCount]}`;
  } else {
    const liveLine = openingLine(history, BOOK);
    if (liveLine !== null) bannerSubtext = `Now: ${liveLine.name} · ${liveLine.eco}`;
  }

  // Task 38d: the "what do I do now" status line above the board. Task 39
  // adds a priority level above the original chain: the castling/capture-
  // aware pendingPickText/whiteCaptureNote (the PLACED-mode "Switch your
  // QB?" text is just one more pendingPickText case now, not a separate
  // priority level of its own).
  const whiteToMoveText =
    onChosenLine && chosenNextMove !== null
      ? `Your move. Play ${chosenNextMove} to stay on ${chosenLine!.name}, pick another book move below, or drag any piece.`
      : "Your move. Drag any piece — each move locks a player of that piece's type.";
  const lastBlackMove = state.blackMoves.at(-1) ?? null;

  // Bug fix: this used to sort by RANK_BY_FAMILY alone -- a whole-family,
  // whole-corpus popularity rank (rankFamilies' single most-played line per
  // family), not how often each candidate move is actually played FROM
  // THIS POSITION. That let a real, heavily-played reply (e.g. 2. Nf3 after
  // 1. e4 e5, ~6x more played here than anything else) rank dead last --
  // worse, Infinity -- whenever its resulting family happened to be
  // DEFAULT_EXCLUDED_FAMILIES (too generic to *suggest* as an opening) or
  // lacked a >=6-ply representative line to rank at all, pushing it past
  // CONTINUATION_LIMIT's slice entirely. `weight` (real per-position
  // Lichess game counts, POPULARITY[history]) is the actual "by
  // popularity" this list was always meant to sort by; `rank` now only
  // breaks a tie. Looked up inline (the same fallback openings.bookWeights
  // uses: equal weight 1 for every continuation when this position has no
  // popularity entry at all) rather than calling bookWeights itself, which
  // would re-scan the whole ~3,865-line book a second time per render --
  // `bookContinuations(history, BOOK)` right below already did that scan
  // once.
  const positionCounts = POPULARITY[history.join(" ")];
  const continuationOptions: ContinuationOption[] =
    turn === "w"
      ? [...bookContinuations(history, BOOK)]
          .filter((san) => legalSans.has(san))
          .map((san): ContinuationOption => {
            const matched = legalMoves.find((m) => m.san === san)!;
            const resultLine = openingLine([...history, san], BOOK);
            const resultFamily = resultLine !== null ? splitFamily(resultLine.name)[0] : "";
            const kind = classifyMove(state, matched, kingMode);
            const transferredPlayerName =
              kind.kind === "captureTransfer" ? (state.pieceLocks.get(capturedSquare(matched))?.at(-1)?.name ?? null) : null;
            return {
              san,
              moveLabel: `${moveNumber}. ${san}`,
              openingLabel: resultLine?.name ?? null,
              lockLabel: continuationLockLabel(kind, transferredPlayerName),
              isChosen: san === chosenNextMove,
              weight: positionCounts === undefined ? 1 : (positionCounts[san] ?? 0),
              rank: RANK_BY_FAMILY.get(resultFamily)?.rank ?? Infinity,
            };
          })
          .sort((a, b) => {
            if (a.isChosen !== b.isChosen) return a.isChosen ? -1 : 1;
            if (a.weight !== b.weight) return b.weight - a.weight;
            if (a.rank !== b.rank) return a.rank - b.rank;
            return a.san.localeCompare(b.san);
          })
          .slice(0, CONTINUATION_LIMIT)
      : [];

  // Task 40 "Leaving the book": no offerable continuation remains for
  // White at all (continuationOptions is already capped to 8, but the cap
  // only ever shrinks a non-empty set -- empty here means the underlying
  // set, before slicing, was empty too). `bookExitDismissed` makes it
  // sticky once shown; see its own declaration above.
  const showBookExitPrompt = turn === "w" && ending === null && continuationOptions.length === 0 && !bookExitDismissed;

  // Task 40 adds showBookExitPrompt above the original chain (turn==='w',
  // out of book, not yet dismissed) -- below pendingMove (an actively open
  // choice still takes priority) but above the plain "your move"/"Field
  // played X" text, since it replaces that prompt entirely until dismissed.
  const statusLine: string =
    blackMoveError !== null
      ? `Something went wrong: ${blackMoveError}`
      : moveRejected !== null
        ? moveRejected
        : pendingMove !== null
          ? pendingPickText(pendingMove)
          : turn === "b"
            ? whiteCaptureNote ?? (engineUnavailable ? ENGINE_UNAVAILABLE_NOTE : "The Field is moving…")
            : showBookExitPrompt
              ? "There is no longer an opening line. Continue, or start again?"
              : lastBlackMove !== null
                ? `${blackMoveNote ?? `Field played ${lastBlackMove.san} and locked ${lastBlackMove.player.name}.`} ${whiteToMoveText}`
                : whiteToMoveText;

  const previewFen = useMemo(() => {
    if (pendingMove === null) return state.board.fen();
    const scratch = new Chess(state.board.fen());
    scratch.move({ from: pendingMove.chessMove.from, to: pendingMove.chessMove.to, promotion: pendingMove.chessMove.promotion });
    return scratch.fen();
  }, [state, pendingMove]);

  const lastRealMove = history.length > 0 ? (state.board.history({ verbose: true }).at(-1) ?? null) : null;
  const lastMove: { orig: Key; dest: Key } | null =
    pendingMove !== null
      ? { orig: pendingMove.chessMove.from, dest: pendingMove.chessMove.to }
      : lastRealMove !== null
        ? { orig: lastRealMove.from, dest: lastRealMove.to }
        : null;

  // Board-hover tooltip (see pieceTooltipContent above): reads the real
  // committed `state`, not `previewFen`'s tentative pick-pending move --
  // a pending pick already covers the board with its own modal.
  const touchedSquares = useMemo(() => squaresEverArrived(state.board), [state]);
  function getPieceTooltip(square: Key): PieceTooltipContent | null {
    return pieceTooltipContent(state, square as Square, NFL, preset.contest, touchedSquares);
  }

  // Starts (or restarts) Black's reply timer for `newState`. The callback
  // itself is async: out of book, playBlackMove awaits a real Stockfish
  // move (stockfishEngine.ts, a Web Worker) before resolving -- this is what
  // keeps that think time off the UI thread. The existing "The Field is
  // moving…" status line (see statusLine below) already covers the whole
  // wait regardless of its source (the fixed BLACK_REPLY_DELAY_MS pause, or
  // the engine itself) -- UNLESS the engine just failed (engineUnavailable),
  // in which case that same slot switches to ENGINE_UNAVAILABLE_NOTE from
  // here on. Either way, Black's reply itself always lands (build.ts's own
  // uniform-random fallback never hangs on a broken engine).
  function scheduleBlackReply(newState: BuildState): void {
    if (blackTimerRef.current !== null) clearTimeout(blackTimerRef.current);
    if (newState.board.turn() !== "b") {
      blackTimerRef.current = null;
      return;
    }
    setBlackMoving(true);
    blackTimerRef.current = setTimeout(async () => {
      try {
        const result = await playBlackMove(
          newState, BOOK, familyRanks, targetRank, NFL, preset.contest, players, rng, kingMode, stockfishEngine, cachedField,
        );
        if (result.engineFailed) {
          setEngineUnavailable(true);
          setBlackMoveNote(ENGINE_UNAVAILABLE_NOTE);
        } else {
          setBlackMoveNote(describeBlackMove(newState, result.state));
        }
        setState(result.state);
        // Black's reply just handed the turn back to White -- the one
        // other moment (besides mount) White's side can start dead; see
        // the `ending` useState's own comment above.
        if (checkWhiteDeadEnd(result.state, NFL, preset.contest, players, kingMode) !== null) {
          setEnding({ kind: "deadEnd", side: Side.WHITE });
        }
      } catch (e) {
        if (e instanceof NoLegalBlackMoveError) {
          // Task 40: Black has no legal (chess-AND-DFS) move at all --
          // cli.py's own _run_one_build catches the exact same RuntimeError
          // from play_black_move rather than checking for it ahead of time
          // (unlike White's own proactive checkWhiteDeadEnd); `newState`
          // (closed over above, not `state`) is White's roster exactly as
          // it stood right before this failed attempt -- the finish
          // screen's own "open slots" field reads it fresh off `state` at
          // render time, which this catch leaves unchanged since no
          // setState for it ever ran.
          setEnding({ kind: "deadEnd", side: Side.BLACK });
        } else {
          // Bug fix: anything else is a real failure, not a dead end --
          // surface it instead of lying about why the build stopped. The
          // build doesn't end (`ending` stays null); Take back is still
          // the way out.
          setBlackMoveError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setBlackMoving(false);
      }
    }, BLACK_REPLY_DELAY_MS);
  }

  // Task 40: after a White move/pick commits, either the build is over
  // (White's lineup just filled -- RULES.md: "regardless of Black's,"
  // checked the same way after every kind of White lock: ordinary,
  // castling, or a capture transfer) or Black gets its usual delayed
  // reply.
  function finishOrScheduleBlack(newState: BuildState): void {
    if (isLineupComplete(newState.whiteMoves.map((m) => m.player), NFL)) {
      setEnding({ kind: "complete" });
      return;
    }
    scheduleBlackReply(newState);
  }

  // Task 39: Black's own capture messages ("Field captured your <piece>:
  // <player> joins the Field." / "Field captured an unmoved <piece> and
  // picked <player>.") -- null (falls back to the generic "Field played X
  // and locked Y") for an ordinary move, castling, or a silently-pushed
  // move (Black's lineup already full, blackMoves unchanged -- not the
  // move just played at all, so classifying it here would be wrong).
  function describeBlackMove(before: BuildState, after: BuildState): string | null {
    const lastSan = after.board.history().at(-1)!;
    const matched = before.board.moves({ verbose: true }).find((m) => m.san === lastSan)!;
    const kind = classifyMove(before, matched, kingMode);
    const locked = after.blackMoves.length > before.blackMoves.length;

    if (kind.kind === "captureTransfer") {
      const transferred = before.pieceLocks.get(capturedSquare(matched))?.at(-1) ?? null;
      if (transferred === null) return null; // shouldn't happen -- captureTransfer implies history
      if (locked) {
        const lastMoveRecord = after.blackMoves.at(-1)!;
        return `Field captured your ${PIECE_LABEL[lastMoveRecord.piece].toLowerCase()}: ${lastMoveRecord.player.name} joins the Field.`;
      }
      // Rule change: doesn't fit the Field's roster -- still captured,
      // but returns to the pool instead of joining the Field.
      return `${matched.san}: ${transferred.name} (${transferred.positions[0]}) doesn't fit the Field's roster. He returns to the pool.`;
    }
    if (kind.kind === "captureUnmoved" && locked) {
      const lastMoveRecord = after.blackMoves.at(-1)!;
      return `Field captured an unmoved ${PIECE_LABEL[kind.capturedPiece].toLowerCase()} and picked ${lastMoveRecord.player.name}.`;
    }
    return null;
  }

  // Rule change "new levels + Go back": `reopen` is the PendingMove that
  // was active right before this very commit (the pick that's about to
  // lock), if any -- a direct lock with no pick list at all (a capture
  // transfer, a silent King move, or an unmoved capture with no fitting
  // candidate) has none. Stashed in a ref (not state -- nothing ever
  // renders it directly) so the tight-finish dialog's own "Go back" can
  // restore it later without threading it through render.
  const lastReopenRef = useRef<PendingMove | null>(null);

  function commit(newState: BuildState, opts: { captureNote?: string | null; reopen?: PendingMove | null } = {}): void {
    lastReopenRef.current = opts.reopen ?? null;
    setPastStates((past) => [...past, state]);
    setState(newState);
    setPendingMove(null);
    setWhiteCaptureNote(opts.captureNote ?? null);
    setBlackMoveError(null);
    finishOrScheduleBlack(newState);
  }

  function handleBoardMove(orig: Key, dest: Key): void {
    const matched = allMoves.find((m) => m.from === orig && m.to === dest);
    if (matched === undefined) {
      // dests only ever offers matched's own from/to pairs, so this
      // shouldn't be reachable in practice -- but a rejected move must
      // never just vanish, so it's reported rather than assumed away.
      setMoveRejected(`${orig}-${dest} isn't a legal move right now.`);
      return;
    }
    if (!legalSans.has(matched.san)) {
      // Real, legal chess -- just not DFS-legal right now. Refused, same
      // as the "not a legal move at all" case above, but with the
      // engine's own reason instead of a generic one.
      setMoveRejected(blockedMoveReason(state, matched, NFL, preset.contest, players, kingMode));
      return;
    }
    setMoveRejected(null);
    if (showBookExitPrompt) setBookExitDismissed(true); // playing a move is an implicit "Continue"
    const chessMove: ChessMove = { from: matched.from, to: matched.to, promotion: matched.promotion };
    const kind = classifyMove(state, matched, kingMode);
    setPickError(null);

    switch (kind.kind) {
      case "silentKing":
        commit(pushSilentMove(state, chessMove));
        return;
      case "captureTransfer": {
        const transferred = state.pieceLocks.get(capturedSquare(matched))?.at(-1) ?? null;
        const result = playWhiteMove(state, chessMove, null, NFL, preset.contest, BOOK, null, kingMode);
        let captureNote: string | null = null;
        if (transferred !== null) {
          captureNote = result.state.lockedPlayerIds.has(transferred.id)
            ? `You captured ${transferred.name}.`
            : `${matched.san}: ${transferred.name} (${transferred.positions[0]}) doesn't fit your roster. He returns to the pool.`;
        }
        commit(result.state, { captureNote });
        return;
      }
      case "captureUnmoved": {
        // Rule change: capturing an unmoved piece is always legal, even
        // with no fitting replacement -- skip the pick modal entirely
        // and commit the capture (locking no one) when its own pick
        // list is empty, same as a captureTransfer's no-modal path.
        const candidates = pickList(
          kind.capturedPiece,
          players,
          state.lockedPlayerIds,
          state.whiteMoves.map((m) => m.player),
          NFL,
          preset.contest,
          lockedQbTeam(state, Side.WHITE),
        );
        if (candidates.length === 0) {
          const result = playWhiteMove(state, chessMove, null, NFL, preset.contest, BOOK, null, kingMode);
          commit(result.state);
          return;
        }
        setPendingMove({ kind: "captureUnmoved", chessMove, capturedPiece: kind.capturedPiece, san: matched.san });
        return;
      }
      case "castleEmerge":
        setPendingMove({ kind: "castleEmergeKing", chessMove, san: matched.san });
        return;
      case "castlePlaced":
        setPendingMove({ kind: "castlePlacedSwitch", chessMove, san: matched.san });
        return;
      case "ordinary":
        setPendingMove({ kind: "ordinary", chessMove, piece: kind.piece, san: matched.san });
        return;
    }
  }

  function playSan(san: string): void {
    const matched = legalMoves.find((m) => m.san === san);
    if (matched === undefined) return;
    handleBoardMove(matched.from, matched.to);
  }

  function handlePick(player: Player): void {
    if (pendingMove === null) return;
    try {
      switch (pendingMove.kind) {
        case "ordinary": {
          const result = playWhiteMove(state, pendingMove.chessMove, player, NFL, preset.contest, BOOK, null, kingMode);
          commit(result.state, { reopen: pendingMove });
          return;
        }
        case "captureUnmoved": {
          const result = playWhiteMove(state, pendingMove.chessMove, player, NFL, preset.contest, BOOK, null, kingMode);
          commit(result.state, { captureNote: `You captured ${player.name}.`, reopen: pendingMove });
          return;
        }
        case "castleEmergeKing":
          // Advances to the Rook step -- nothing is committed to engine
          // state yet, same as an ordinary pending pick.
          setPendingMove({ kind: "castleEmergeRook", chessMove: pendingMove.chessMove, san: pendingMove.san, king: player });
          return;
        case "castleEmergeRook": {
          const result = playWhiteMove(state, pendingMove.chessMove, pendingMove.king, NFL, preset.contest, BOOK, player, kingMode);
          commit(result.state, { reopen: pendingMove });
          return;
        }
        // The one-time "Switch your QB?" offer (Task 14), resolved
        // BEFORE the Rook pick (RULES.md piece table: the Rook must be a
        // teammate of whichever QB ends up final) -- `player` here is
        // the new QB; declining goes through handleCancel instead (its
        // own "Cancel"/× click), not this pick path. Neither the switch
        // nor the castle itself commits to engine state yet -- `state`
        // is still untouched, so Take back later undoes both in one step
        // once the Rook step actually commits.
        case "castlePlacedSwitch": {
          const switched = switchKing(state, Side.WHITE, player, NFL, preset.contest);
          const baseState = switched ?? state;
          setPendingMove({ kind: "castlePlacedRook", chessMove: pendingMove.chessMove, san: pendingMove.san, baseState });
          return;
        }
        case "castlePlacedRook": {
          const result = playWhiteMove(pendingMove.baseState, pendingMove.chessMove, null, NFL, preset.contest, BOOK, player, kingMode);
          commit(result.state, { reopen: pendingMove });
          return;
        }
      }
    } catch {
      setPickError(`${player.name} isn't a legal pick for this move right now.`);
    }
  }

  function handleCancel(): void {
    // Declining the Switch-QB offer isn't abandoning the castle -- it
    // just keeps the current QB and moves on to the Rook step, same as
    // any other "no" on that one-time offer.
    if (pendingMove !== null && pendingMove.kind === "castlePlacedSwitch") {
      setPendingMove({ kind: "castlePlacedRook", chessMove: pendingMove.chessMove, san: pendingMove.san, baseState: state });
      return;
    }
    setPendingMove(null);
    setPickError(null);
  }

  function dismissHowItWorks(): void {
    window.localStorage.setItem(HOW_IT_WORKS_KEY, "1");
    setHowItWorksDismissed(true);
  }

  // Task 40: "Stop with this core" -- ends the build with whatever's
  // locked so far (RULES.md: the same "Happy Hunting" ending as a
  // completed lineup). Disabled (see canStop below) while a pick/offer is
  // open or Black is mid-reply -- abandoning either mid-flight would leave
  // the finish screen showing a core that's about to change under it.
  // Task 41 moves the button itself from under the You card to the
  // board-column, beside Take back -- the mobile pass's own explicit
  // ordering (status line, board, Book continues, Take back / Stop, then
  // You, Field, Player | Field) has no way to place a child of the You
  // card's own grid cell ahead of that cell as a whole, so the button
  // moved out to where it can actually sit in that order; `canStop`/this
  // handler are unchanged.
  function stopWithCore(): void {
    if (blackTimerRef.current !== null) clearTimeout(blackTimerRef.current);
    setEnding({ kind: "stopped" });
  }
  const canStop = pendingMove === null && !blackMoving && ending === null;
  // Sim 4 "Sim my core" -- same gating as Stop (nothing mid-flight to
  // leave the sim's lineup snapshot stale under it), plus not already
  // simming (re-clicking while running is still allowed by
  // runSimForBothSides itself -- cancel-and-restart -- this just avoids
  // encouraging rapid-fire clicks that would only ever cancel each other).
  const simRunning = whiteSim.kind === "running" || blackSim.kind === "running";
  const canSim = pendingMove === null && !blackMoving && ending === null && !simRunning;

  // Task 40 "Take back": pops the one `pastStates` entry commit() pushed
  // right before White's last move -- restoring it undoes that move AND
  // whatever Black replied with in between, in one step, since both are
  // simply discarded in favor of the earlier snapshot. Repeatable back to
  // the start (pastStates empties out exactly at the component's own
  // initial `state`, King(s) already placed or not).
  function takeBack(): void {
    if (pastStates.length === 0) return;
    const previous = pastStates[pastStates.length - 1];
    setPastStates((past) => past.slice(0, -1));
    setState(previous);
    setWhiteCaptureNote(null);
    setBlackMoveNote(null);
    setBlackMoveError(null);
    setMoveRejected(null);
  }
  const canTakeBack = pastStates.length > 0 && pendingMove === null && !blackMoving && ending === null;

  // Task 40: the book-exit prompt's own "Continue" -- just dismisses it;
  // nothing about `state` changes (free play was always available, this
  // only stops the prompt from reappearing).
  function continueFreePlay(): void {
    setBookExitDismissed(true);
  }

  // Task 40: the header's "Start again" link -- confirms first only if any
  // player (either side -- PLACED king mode's own pre-locked Kings count)
  // is actually locked; the book-exit prompt's own "Start again" and the
  // finish screen's both skip this (see their own call sites) since each
  // is already its own deliberate, explicit choice.
  function requestStartAgain(): void {
    if (state.lockedPlayerIds.size > 0 && !window.confirm("Start again? Your current picks will be lost.")) {
      return;
    }
    onStartAgain();
  }

  // "Fill out my core" feeds Copy lineup -- whiteStats (salary remaining,
  // ownership, projection, open slots) folds in whiteFilledPlayers so
  // every display/export that already reads whiteStats picks the filled
  // roster up for free, with no separate "effective" variable to thread
  // through everywhere. Empty whiteFilledPlayers (every build, until a
  // fill happens) makes this identical to the old move-only computation.
  const whiteRoster = [...state.whiteMoves.map((m) => m.player), ...whiteFilledPlayers];
  const whiteStats = sideStats(whiteRoster, NFL, preset.contest);
  // Rule change "new levels + Go back": step 3's cheapest-completion solve
  // needs whoever's genuinely still undrafted -- not locked by either
  // side right now.
  const availablePlayers = players.filter((p) => !state.lockedPlayerIds.has(p.id));
  const whiteTightFinish = tightFinishStatus(whiteRoster, availablePlayers, NFL, preset.contest);
  const blackStats = sideStats(state.blackMoves.map((m) => m.player), NFL, preset.contest);

  // Rule change: the tight-finish copy above is easy to miss (plain inline
  // text in the You panel / pick footer) -- an in-app dialog (see
  // TightFinishDialog.tsx; dimmed backdrop, reuses the pick modal's own
  // styles) now shows too, once per level, the first time White's own
  // ACTUAL (already-locked, never the pick modal's hypothetical "after
  // this pick" preview) roster reaches it. `alertedLevelsRef` is never
  // cleared except by a fresh mount (a new build) -- Take back flapping
  // the level back and forth doesn't re-arm an already-fired level.
  // `skipNextRef` swallows the one run every effect fires on mount (this
  // component's very first render, before any pick) -- the dialog is only
  // ever about a pick that just locked.
  const [tightFinishAlert, setTightFinishAlert] = useState<TightFinishStatus | null>(null);
  const alertedLevelsRef = useRef<Set<TightFinishLevel>>(new Set());
  const skipNextTightFinishAlertRef = useRef(true);
  useEffect(() => {
    if (skipNextTightFinishAlertRef.current) {
      skipNextTightFinishAlertRef.current = false;
      return;
    }
    // Fill out my core / the finish screen aren't "a pick locked" -- no
    // dialog once the build's already over.
    if (ending !== null) return;
    if (whiteTightFinish !== null && !alertedLevelsRef.current.has(whiteTightFinish.level)) {
      alertedLevelsRef.current.add(whiteTightFinish.level);
      setTightFinishAlert(whiteTightFinish);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately
    // keyed on the level alone: re-entering the SAME level (e.g. the exact
    // dollar figure moving within "caution") must not re-alert.
  }, [whiteTightFinish?.level]);

  // Rule change "new levels + Go back": the dialog's primary action --
  // undoes the pick that just triggered it (same underlying snapshot
  // takeBack itself pops, so a Black reply already landed in the
  // background while the dialog sat open is discarded right along with
  // it, same as takeBack's own "in one step" behavior) and reopens that
  // same pick's own list (lastReopenRef -- null for a pick with no list
  // at all, e.g. a capture transfer, which just undoes). Cancels any
  // still-pending Black reply outright (clearing blackTimerRef AND
  // blackMoving -- the timer's own `finally` never runs once cancelled,
  // so nothing else resets that flag) rather than letting it land for a
  // pick that's being reconsidered. Clears `ending` too, in case Black's
  // reply (already landed) pushed White into a dead end while the dialog
  // was still up -- going back undoes that along with everything else.
  // The just-alerted level is un-marked so re-locking an equally-bad
  // player re-alerts instead of silently passing (OK, not Go back, is
  // what means "stop telling me about this level").
  function goBackFromTightFinish(): void {
    if (tightFinishAlert !== null) alertedLevelsRef.current.delete(tightFinishAlert.level);
    setTightFinishAlert(null);
    if (blackTimerRef.current !== null) {
      clearTimeout(blackTimerRef.current);
      blackTimerRef.current = null;
      setBlackMoving(false);
    }
    if (pastStates.length === 0) return; // shouldn't happen -- this dialog only ever follows a real commit
    const previous = pastStates[pastStates.length - 1];
    setPastStates((past) => past.slice(0, -1));
    setState(previous);
    setPendingMove(lastReopenRef.current);
    setEnding(null);
    setWhiteCaptureNote(null);
    setBlackMoveNote(null);
    setBlackMoveError(null);
    setMoveRejected(null);
    setPickError(null);
  }

  // The slate's own best possible lineup never depends on `state` at all --
  // no locks, no exclusions -- so it's computed once per slate/contest
  // (`players`/`preset` as deps), not on every pick. White's best
  // completion (locks forced, Black's picks excluded) DOES change on every
  // pick -- either side's own `whiteMoves`/`blackMoves` array is a brand
  // new reference each time a move commits (engine/rules.ts never mutates
  // in place), so this recomputes exactly when it needs to and no more.
  const slateOptimal = useMemo(() => optimalLineup(players, NFL, preset.contest.effectiveCap(NFL)), [players, preset]);
  const bestCompletion = useMemo(
    () =>
      optimalLineup(players, NFL, preset.contest.effectiveCap(NFL), {
        locked: state.whiteMoves.map((m) => m.player),
        excludeIds: new Set(state.blackMoves.map((m) => m.player.id)),
      }),
    [players, preset, state.whiteMoves, state.blackMoves],
  );
  const optimalStats = pointsFromOptimal(slateOptimal, bestCompletion);
  // Same computation, mirrored for Black: Black's own locks forced in,
  // White's picks excluded, against the same slate optimal.
  const blackBestCompletion = useMemo(
    () =>
      optimalLineup(players, NFL, preset.contest.effectiveCap(NFL), {
        locked: state.blackMoves.map((m) => m.player),
        excludeIds: new Set(state.whiteMoves.map((m) => m.player.id)),
      }),
    [players, preset, state.whiteMoves, state.blackMoves],
  );
  const blackOptimalStats = pointsFromOptimal(slateOptimal, blackBestCompletion);

  // "Fill out my core": commits the optimizer's own best completion
  // (bestCompletion -- the exact same OptimizerResult "Pts from optimal"
  // already computes every render) as whiteFilledPlayers, then ends the
  // build. `newlyFilled` excludes anything already move-locked, since
  // bestCompletion.lineup is the FULL completed roster (locks included),
  // not just the players it added.
  function fillOutCore(): void {
    if (bestCompletion === null) return; // no feasible completion under the cap -- nothing to fill with
    const lockedIds = new Set(state.whiteMoves.map((m) => m.player.id));
    const newlyFilled = bestCompletion.lineup.filter((p) => !lockedIds.has(p.id));
    setWhiteFilledPlayers(newlyFilled);
    if (blackTimerRef.current !== null) clearTimeout(blackTimerRef.current);
    setEnding({ kind: "filled" });
  }
  // Disabled once there's nothing left to fill -- `whiteRoster` already
  // folds in any PRIOR fill (see its own comment above), so a second
  // click after one successful fill is correctly disabled too, not just
  // a naturally-complete (every slot move-locked) core. Same pick/
  // Black-moving safety conditions as Stop/Sim -- mid-build only; always
  // true by construction on any finish screen.
  const canFillCore = pendingMove === null && !blackMoving && bestCompletion !== null && !isLineupComplete(whiteRoster, NFL);

  // Sim 4's own field/Vegas inputs. The projections CSV text (not just the
  // already-parsed `players`) is only needed for slateSignature -- read
  // fresh via projectionsStore rather than threaded down as a new prop,
  // same pattern AdminScreen.tsx already uses for the identical lookup.
  // `cachedField` is null for either real reason (no projections saved at
  // all -- shouldn't happen once a build is actually in progress, but
  // checked anyway rather than assumed -- or nothing built in Admin yet
  // for this slate+tier) and both render the same "Build fields in Admin
  // first." message, so they're not distinguished further here.
  const cachedField = useMemo((): SimulatedField | null => {
    const csv = getSavedProjectionsCsv();
    return csv === null ? null : resolveCachedField(slateSignature(csv), preset.contest, players);
  }, [preset, players]);
  // Vegas is OPTIONAL for the sim, not a hard requirement (draws.ts's own
  // drawSlateOutcomes doesn't consume Vegas data at all any more -- see
  // that file's own header for why) -- confirmed by reading draws.ts
  // directly before building this, not assumed. A missing OR invalid-for-this-
  // slate Vegas CSV (e.g. saved against a different slate, so
  // validateVegasCsv's own "a slate team has no Vegas row" check throws --
  // off-slate rows alone no longer throw, see vegasCsv.ts) both fall back
  // to an empty map rather than blocking the sim -- flagged here, not
  // silently buried, since it's a judgment call this task left open ("if
  // it can [run without it], say so in your report").
  const slateVegas: SlateVegas = useMemo(() => {
    const csv = getSavedVegasCsv();
    if (csv === null) return new Map();
    try {
      return validateVegasCsv(csv, new Set(players.map((p) => p.team))).vegas;
    } catch {
      return new Map();
    }
  }, [players]);

  // Dispatches one side's sim to a fresh Worker, wiring its result back
  // into `setSim` -- shared by both sides in runSimForBothSides below
  // rather than duplicated, since the only per-side difference is which
  // lineup/setter/worker-ref is involved, all passed in as plain params.
  // `rememberWorker` (not the ref directly) sidesteps needing a shared
  // ref type for two refs of the same shape -- simpler than it sounds.
  function dispatchSim(
    lineup: readonly Player[],
    isBestFinish: boolean,
    field: SimulatedField,
    setSim: (next: SideSimState) => void,
    rememberWorker: (worker: Worker) => void,
    runId: number,
  ): void {
    setSim({ kind: "running", isBestFinish });
    try {
      const { worker, done } = runSimInWorker({
        lineup,
        contest: preset.contest,
        entryFee: preset.buyIn,
        field,
        players,
        vegas: slateVegas,
        seed: buildSeed,
      });
      rememberWorker(worker);
      done
        .then((result) => {
          if (simRunIdRef.current === runId) setSim({ kind: "done", result, isBestFinish });
        })
        .catch((e: unknown) => {
          if (simRunIdRef.current === runId) setSim({ kind: "error", message: errorMessage(e), isBestFinish });
        });
    } catch (e) {
      // new Worker(...) itself throwing (e.g. no Worker global at all --
      // this codebase's test environment) is caught here, not left to
      // crash the render/effect that called this.
      setSim({ kind: "error", message: errorMessage(e), isBestFinish });
    }
  }

  // Runs the sim for BOTH sides at once -- the finish screen's own
  // auto-trigger effect (below) and the mid-build "Sim my core" button
  // both call this directly, never either side alone (this task's own
  // wording: "runs it for both sides on demand"). Partial cores sim the
  // optimizer's own best completion (bestCompletion/blackBestCompletion --
  // the exact same OptimizerResult "Pts from optimal" already computes
  // every render, just reading `.lineup` off it here instead of `.total`),
  // labeled "(best finish)"; an already-complete core's own completion
  // trivially reduces to its own locked players (nothing left to add), so
  // the same `.lineup` read is correct either way -- only the LABEL
  // depends on whether the side was actually partial.
  function runSimForBothSides(): void {
    const runId = ++simRunIdRef.current;
    whiteSimWorkerRef.current?.terminate();
    blackSimWorkerRef.current?.terminate();

    const whiteIsBestFinish = !isLineupComplete(state.whiteMoves.map((m) => m.player), NFL);
    const blackIsBestFinish = !isLineupComplete(state.blackMoves.map((m) => m.player), NFL);

    if (cachedField === null || cachedField.lineups.length === 0) {
      setWhiteSim({ kind: "noField", isBestFinish: whiteIsBestFinish });
      setBlackSim({ kind: "noField", isBestFinish: blackIsBestFinish });
      return;
    }
    const field = cachedField;

    if (bestCompletion === null) {
      setWhiteSim({ kind: "error", message: "No feasible lineup found.", isBestFinish: whiteIsBestFinish });
    } else {
      dispatchSim(bestCompletion.lineup, whiteIsBestFinish, field, setWhiteSim, (w) => (whiteSimWorkerRef.current = w), runId);
    }

    if (blackBestCompletion === null) {
      setBlackSim({ kind: "error", message: "No feasible lineup found.", isBestFinish: blackIsBestFinish });
    } else {
      dispatchSim(blackBestCompletion.lineup, blackIsBestFinish, field, setBlackSim, (w) => (blackSimWorkerRef.current = w), runId);
    }
  }

  // Auto-runs exactly once per ending -- `ending` is set once (setEnding)
  // and never updated again for the lifetime of a given finish screen, so
  // this fires on the stopped/complete/dead-end transition and never
  // again on its own (re-running only ever happens via the button, which
  // isn't rendered once `ending !== null` anyway).
  useEffect(() => {
    if (ending !== null) runSimForBothSides();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on `ending` alone; see comment above.
  }, [ending]);

  const [family, variation] = chosenLine !== null ? splitFamily(chosenLine.name) : ["Your own opening", ""];
  const entryTier = preset.contest.entryTier(LAST_RANK);
  // The line actually originally picked -- same name/fallback the banner's
  // own family/variation split (above) is derived from, kept as one
  // unsplit string here for the finish screen's "Chosen:" row.
  const chosenOpeningLabel = chosenLine !== null ? chosenLine.name : "Your own opening";
  // Task 40 finish screen: the opening actually reached by the end of the
  // build (openingLine's own live name off `history`), not necessarily the
  // one originally chosen -- falls back to the chosen line's own name (or
  // "Your own opening") if the final position matches no book line at all.
  // This task labels the finish screen's row "Final position:" to make
  // clear it can differ from "Chosen:" (chosenOpeningLabel) once a build
  // deviates off its chosen line.
  const finalOpeningLabel = openingLine(history, BOOK)?.name ?? chosenOpeningLabel;

  // The banner's own move list: the chosen line's reference (played moves
  // solid, the rest a preview of where it's headed) while still on it;
  // once off it -- deviated, or "own opening" with no chosen line at all
  // -- there's no fixed future left to preview, so it switches to the
  // actual played history instead (nothing "pending" in that case, since
  // bannerPlayedCount then equals the list's own length).
  const movesForBanner = onChosenLine && chosenLine !== null ? chosenLine.moves : history;
  const bannerPlayedCount = onChosenLine ? playedCount : history.length;

  // Task 43: the pick modal's own move-list display -- the chosen line's
  // full moves (with the pick highlighted at its own depth) while this
  // exact pending move still continues that line; the moves actually
  // played so far plus the pending one otherwise (off-book, or this is
  // the move that leaves the line). Either way the highlighted index is
  // `history.length` -- the pending move's own depth, since `history`
  // itself never includes it until the pick commits.
  const pendingOnChosenLine = pendingMove !== null && chosenLine !== null && onChosenLine && pendingMove.san === chosenNextMove;
  const pendingMoveContext: PickMoveContext | null =
    pendingMove !== null
      ? { moves: pendingOnChosenLine ? chosenLine!.moves : [...history, pendingMove.san], highlightIndex: history.length }
      : null;

  const pendingCandidates = pendingMove !== null ? candidatesFor(pendingMove, state, players, preset.contest) : [];
  const pendingPlayerBaseline = pendingMove !== null ? pendingBaseline(pendingMove, state.whiteMoves) : [];
  const pendingReasons = new Map<string, string>();
  for (const candidate of pendingCandidates) {
    const reason = pendingMove !== null ? pickReason(pendingPlayerBaseline, candidate, NFL, preset.contest) : null;
    if (reason !== null) pendingReasons.set(candidate.id, reason);
  }

  return (
    <main className="build-screen">
      {!howItWorksDismissed && (
        <div className="how-it-works">
          <p>{HOW_IT_WORKS_TEXT}</p>
          <button type="button" className="how-it-works-close" onClick={dismissHowItWorks}>
            Got it
          </button>
        </div>
      )}

      <header className="build-header">
        <span className="build-wordmark">Chess DFS</span>
        <div className="build-chips">
          <span className="chip">
            {preset.name} · {preset.contest.fieldSize.toLocaleString()} entries · {entryTier.name} field
          </span>
          <span className="chip">King: {kingMode === KingMode.EMERGE ? "Let him emerge" : "Place your King now"}</span>
          <button type="button" className="start-again-link" onClick={requestStartAgain}>
            Start again
          </button>
          <ThemeToggle />
        </div>
      </header>

      <section className="opening-banner">
        <div className="opening-banner-main">
          <p className="opening-eyebrow">Opening</p>
          <div className="opening-title-row">
            <h1>{family}</h1>
            {chosenLine !== null && <span className="opening-eco">{chosenLine.eco}</span>}
          </div>
          {variation !== "" && <p className="opening-variation">{variation}</p>}
          {bannerSubtext !== null && <p className="opening-subtext">{bannerSubtext}</p>}
        </div>
        {movesForBanner.length > 0 && (
          <p className="opening-moves">
            <MovesProgress moves={movesForBanner} playedCount={bannerPlayedCount} />
          </p>
        )}
      </section>

      <div className="build-layout">
        <SideColumn
          side="you"
          label="You"
          sideName="White"
          stats={whiteStats}
          moves={state.whiteMoves}
          filled={whiteFilledPlayers}
          optimalStats={optimalStats}
          sim={whiteSim}
          tightFinish={whiteTightFinish}
        />
        <div className="board-column">
          {ending !== null ? (
            <FinishCard
              ending={ending}
              chosenOpeningLabel={chosenOpeningLabel}
              finalOpeningLabel={finalOpeningLabel}
              history={history}
              whiteMoves={state.whiteMoves}
              whiteFilledPlayers={whiteFilledPlayers}
              whiteStats={whiteStats}
              whiteOptimalStats={optimalStats}
              blackOptimalStats={blackOptimalStats}
              whiteSim={whiteSim}
              blackSim={blackSim}
              canFillCore={canFillCore}
              onFillOutCore={fillOutCore}
              onStartAgain={onStartAgain}
              onNewContest={onNewContest}
            />
          ) : (
            <>
              <p className="status-line">{statusLine}</p>
              <BuildBoard
                fen={previewFen}
                // Rule change "new levels + Go back": the tight-finish
                // dialog now offers a real action (Go back undoes the
                // very last commit) -- a move played while it's still up
                // would both race Go back's own "undo the last commit"
                // assumption and leave two modals stacked at once. Inert,
                // same mechanism (an empty dests map) BuildBoard already
                // uses for "a pick is pending."
                dests={pendingMove === null && tightFinishAlert === null ? dests : new Map()}
                lastMove={lastMove}
                onMove={handleBoardMove}
                getPieceTooltip={getPieceTooltip}
              />

              {turn === "w" &&
                (showBookExitPrompt ? (
                  <div className="book-exit">
                    <button type="button" onClick={continueFreePlay}>
                      Continue
                    </button>
                    <button type="button" onClick={onStartAgain}>
                      Start again
                    </button>
                  </div>
                ) : (
                  <div className="book-continues">
                    <p className="book-continues-label">Book continues</p>
                    <p className="book-continues-hint">Tap a move to play it, or drag a piece on the board.</p>
                    {continuationOptions.map((option) => (
                      <button
                        key={option.san}
                        type="button"
                        className={option.isChosen ? "continue-option chosen" : "continue-option"}
                        onClick={() => playSan(option.san)}
                      >
                        <span className="continue-move">{option.moveLabel}</span>
                        <span className="continue-detail">
                          <span className="continue-name">{option.openingLabel ?? option.san}</span>
                          <span className="continue-lock">{option.lockLabel}</span>
                        </span>
                      </button>
                    ))}
                    <p className="play-own-move">(Play your own move)</p>
                  </div>
                ))}

              <div className="build-controls">
                <button type="button" className="take-back" disabled={!canTakeBack} onClick={takeBack}>
                  Take back
                </button>
                {state.whiteMoves.length > 0 && (
                  <button type="button" className="stop-with-core" disabled={!canStop} onClick={stopWithCore}>
                    Stop with this core
                  </button>
                )}
                {state.whiteMoves.length > 0 && (
                  <button type="button" className="sim-core" disabled={!canSim} onClick={runSimForBothSides}>
                    {simRunning ? "Simming…" : "Sim my core"}
                  </button>
                )}
                {state.whiteMoves.length > 0 && whiteStats.openSlotCount > 0 && (
                  <button type="button" className="fill-out-core" disabled={!canFillCore} onClick={fillOutCore}>
                    Fill out my core
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <SideColumn
          side="field"
          label="Field"
          sideName="Black"
          stats={blackStats}
          moves={state.blackMoves}
          optimalStats={blackOptimalStats}
          sim={blackSim}
        />
      </div>

      <section className="player-field-table">
        <h2>Player | Field</h2>
        <PlayerFieldTable white={state.whiteMoves} black={state.blackMoves} />
      </section>

      {pendingMove !== null && (
        <PickPanel
          key={pendingMove.kind}
          piece={pendingPiece(pendingMove)}
          moveLabel={`${moveNumber}. ${pendingMove.san}`}
          openingLabel={openingName([...history, pendingMove.san], BOOK)}
          moveContext={pendingMoveContext}
          candidates={pendingCandidates}
          currentPlayers={pendingPlayerBaseline}
          playersPool={players}
          lockedPlayerIds={state.lockedPlayerIds}
          sport={NFL}
          contest={preset.contest}
          reasons={pendingReasons}
          onPick={handlePick}
          onCancel={handleCancel}
          error={pickError}
        />
      )}

      {tightFinishAlert !== null && (
        <TightFinishDialog
          status={tightFinishAlert}
          onDismiss={() => setTightFinishAlert(null)}
          onGoBack={goBackFromTightFinish}
        />
      )}
    </main>
  );
}

// Played moves are solid; the one at `playedCount` (if the list extends
// that far -- it won't once there's no fixed future left to preview, see
// bannerPlayedCount above) gets a small accent marker calling it out as
// next; anything beyond that is a plain muted preview, not dimmed-looking
// the way an opacity fade reads as "disabled."
function MovesProgress({ moves, playedCount }: { moves: readonly string[]; playedCount: number }) {
  const pairs: { num: number; white: string; black: string | undefined; whiteIdx: number; blackIdx: number }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push({ num: i / 2 + 1, white: moves[i], black: moves[i + 1], whiteIdx: i, blackIdx: i + 1 });
  }
  function moveClass(idx: number): string {
    if (idx === playedCount) return "next";
    return idx < playedCount ? "played" : "pending";
  }
  function Move({ idx, san }: { idx: number; san: string }) {
    return (
      <span className={moveClass(idx)}>
        {idx === playedCount && (
          <span className="next-marker" aria-hidden="true">
            ▸{" "}
          </span>
        )}
        {san}
      </span>
    );
  }
  return (
    <>
      {pairs.map((pair) => (
        <span key={pair.num} className="move-pair">
          <span className="move-number">{pair.num}.</span> <Move idx={pair.whiteIdx} san={pair.white} />
          {pair.black !== undefined && (
            <>
              {" "}
              <Move idx={pair.blackIdx} san={pair.black} />
            </>
          )}{" "}
        </span>
      ))}
    </>
  );
}

// A completion can never beat the slate's own unconstrained optimum, so
// `delta` is never positive -- `(-0).toFixed(1)` would print "-0.0", hence
// the explicit zero-check (pointsFromOptimal already normalizes an exact
// -0, but floating-point summation order can still land a hair off zero).
function formatPtsFromOptimal(delta: number): string {
  const rounded = Number(delta.toFixed(1));
  return (rounded === 0 ? 0 : rounded).toFixed(1);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Sim failed.";
}

// The sim stat block's own eyebrow suffix/value text -- shared by
// SideColumn and FinishCard so the two never drift apart on wording.
function simEyebrowSuffix(sim: SideSimState): string {
  return sim.kind !== "idle" && sim.isBestFinish ? " (best finish)" : "";
}

function simStatusText(sim: SideSimState): string | null {
  switch (sim.kind) {
    case "idle":
      return null;
    case "noField":
      return NO_FIELD_CACHED_MESSAGE;
    case "running":
      return "Simming…";
    case "error":
      return sim.message;
    case "done":
      return null; // the real numbers render separately -- see call sites
  }
}

function SideColumn({
  side,
  label,
  sideName,
  stats,
  moves,
  filled = [],
  optimalStats,
  sim,
  tightFinish,
}: {
  side: "you" | "field";
  label: string;
  sideName: string;
  stats: SideStats;
  moves: readonly Move[];
  // "Fill out my core" (White only) -- Field never has this, so every
  // existing "field" SideColumn call site keeps compiling unchanged.
  filled?: readonly Player[];
  optimalStats?: PointsFromOptimal | null;
  sim: SideSimState;
  // Tight-finish warning (White only) -- undefined for every "field" call
  // site, same convention as `filled` above.
  tightFinish?: TightFinishStatus | null;
}) {
  const rosterRows = rosterEntries(moves, filled);
  const openSlots = openSlotLabels(stats);
  return (
    <div className={`side-column ${side}`}>
      <div className="side-header">
        <h2>{label}</h2>
        <span className="side-meta">
          {sideName} · {moves.length} locked
        </span>
      </div>

      <div className="side-stat-block">
        <p className="side-eyebrow">Salary remaining</p>
        <p className="side-salary">${stats.salaryRemaining.toLocaleString()}</p>
        <p className="side-detail">
          {stats.openSlotCount === 0 ? (
            "Lineup full."
          ) : (
            <>
              <span className="mono">${stats.avgRemainingPerOpenSlot.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span> avg / open
              slot · {stats.openSlotCount} open
            </>
          )}
        </p>
        {tightFinish != null && <p className={`side-tight-finish ${tightFinish.level}`}>{tightFinish.message}</p>}
      </div>

      <div className="side-stat-block">
        <p className="side-eyebrow">Core ownership</p>
        <p className="side-ownership">{(stats.ownershipTotal * 100).toFixed(1)}%</p>
      </div>

      <div className="side-stat-block">
        <p className="side-eyebrow">Core projection</p>
        <p className="side-projection">{stats.projTotal.toFixed(1)} pts</p>
      </div>

      {optimalStats !== undefined && (
        <div className="side-stat-block">
          <p className="side-eyebrow">Pts from optimal</p>
          <p className="side-pts-from-optimal">{optimalStats === null ? "—" : formatPtsFromOptimal(optimalStats.delta)}</p>
          {optimalStats !== null && (
            <p className="side-detail">
              best finish {optimalStats.bestCompletion.toFixed(1)} · optimal {optimalStats.slateOptimal.toFixed(1)}
            </p>
          )}
        </div>
      )}

      {sim.kind !== "idle" && (
        <div className="side-stat-block">
          <p className="side-eyebrow">Sim results{simEyebrowSuffix(sim)}</p>
          {sim.kind === "done" ? (
            <>
              <p className="side-sim-roi">{(sim.result.roi * 100).toFixed(1)}%</p>
              <p className="side-detail">
                Cash {(sim.result.cashRate * 100).toFixed(1)}% · Top 1% {(sim.result.top1PctRate * 100).toFixed(1)}%
              </p>
            </>
          ) : (
            <p className="side-detail">{simStatusText(sim)}</p>
          )}
        </div>
      )}

      <ul className="locked-players">
        {rosterRows.map((entry) => (
          <li key={entry.player.id}>
            <span className="locked-glyph" aria-hidden="true">
              {entry.glyph}
            </span>
            <span className="locked-name">
              {entry.player.name} · {entry.player.positions[0]}
              {entry.label === OPTIMIZER_LABEL && <span className="locked-optimizer"> {OPTIMIZER_LABEL}</span>}
            </span>
            <span className="locked-salary">${entry.player.salary.toLocaleString()}</span>
          </li>
        ))}
      </ul>

      {openSlots.length > 0 && <p className="side-open">Open: {openSlots.join(" · ")}</p>}
    </div>
  );
}

// Task 40: replaces the board area's own controls (status line, board,
// book continues, take-back) once the build has ended, for every ending
// kind. `whiteStats`/`whiteMoves` are read straight off the live `state`
// at render time -- see the Ending type's own comment for why that's
// already exactly the right snapshot for every ending, dead ends included.
function FinishCard({
  ending,
  chosenOpeningLabel,
  finalOpeningLabel,
  history,
  whiteMoves,
  whiteFilledPlayers,
  whiteStats,
  whiteOptimalStats,
  blackOptimalStats,
  whiteSim,
  blackSim,
  canFillCore,
  onFillOutCore,
  onStartAgain,
  onNewContest,
}: {
  ending: Ending;
  chosenOpeningLabel: string;
  finalOpeningLabel: string;
  history: readonly string[];
  whiteMoves: readonly Move[];
  whiteFilledPlayers: readonly Player[];
  whiteStats: SideStats;
  whiteOptimalStats: PointsFromOptimal | null;
  blackOptimalStats: PointsFromOptimal | null;
  whiteSim: SideSimState;
  blackSim: SideSimState;
  canFillCore: boolean;
  onFillOutCore: () => void;
  onStartAgain: () => void;
  onNewContest: () => void;
}) {
  const openSlots = openSlotLabels(whiteStats);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "Fill out my core" entries first, piece-locked moves then optimizer
  // fills, same order rosterEntries always uses -- Task 43's DK roster
  // slot (QB/RB/WR/TE/FLEX/DST) assignment runs over the SAME combined
  // list, one slot per entry, same order; see assignRosterSlots' own
  // comment for why WHICH interchangeable player draws "FLEX" vs. its own
  // dedicated slot is a cosmetic artifact of the matching search, not
  // lock/fill order.
  const entries = useMemo(() => rosterEntries(whiteMoves, whiteFilledPlayers), [whiteMoves, whiteFilledPlayers]);
  const slots = useMemo(() => assignRosterSlots(entries.map((e) => e.player), NFL.rosterSlots), [entries]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  async function copyLineup(): Promise<void> {
    await navigator.clipboard.writeText(lineupText(entries, slots, whiteStats, finalOpeningLabel, history));
    setCopied(true);
    if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="finish-card">
      <p className="finish-ended-line">{endingHeadline(ending)}</p>
      <p className="finish-opening">
        <span className="side-eyebrow">Chosen:</span> {chosenOpeningLabel}
      </p>
      <p className="finish-opening">
        <span className="side-eyebrow">Final position:</span> {finalOpeningLabel}
      </p>

      {/* Task 41: a 5-column table doesn't fit 360px gracefully -- this
          scrolls internally rather than forcing the whole page wider.
          Task 43 adds a 6th (Slot) -- still scrolls, not a new concern. */}
      <div className="finish-core-scroll">
        <table className="finish-core">
          <thead>
            <tr>
              <th>Slot</th>
              <th>Piece</th>
              <th>Player</th>
              <th>Pos</th>
              <th>Team</th>
              <th>Salary</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, i) => (
              <tr key={entry.player.id}>
                <td>{slots[i]}</td>
                <td>{entry.label}</td>
                <td>{entry.player.name}</td>
                <td>{entry.player.positions[0]}</td>
                <td>{entry.player.team}</td>
                <td>${entry.player.salary.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="finish-stats">
        <p>
          Salary remaining: <strong>${whiteStats.salaryRemaining.toLocaleString()}</strong>
        </p>
        <p>
          Core projection: <strong>{whiteStats.projTotal.toFixed(1)} pts</strong>
        </p>
        <p>
          Pts from optimal:{" "}
          <strong>{whiteOptimalStats === null ? "—" : formatPtsFromOptimal(whiteOptimalStats.delta)}</strong>
          {whiteOptimalStats !== null && (
            <span className="finish-stat-sub">
              {" "}
              best finish {whiteOptimalStats.bestCompletion.toFixed(1)} · optimal {whiteOptimalStats.slateOptimal.toFixed(1)}
            </span>
          )}
        </p>
        <p>
          Field pts from optimal:{" "}
          <strong>{blackOptimalStats === null ? "—" : formatPtsFromOptimal(blackOptimalStats.delta)}</strong>
          {blackOptimalStats !== null && (
            <span className="finish-stat-sub">
              {" "}
              best finish {blackOptimalStats.bestCompletion.toFixed(1)} · optimal {blackOptimalStats.slateOptimal.toFixed(1)}
            </span>
          )}
        </p>
        <p>
          Core ownership: <strong>{(whiteStats.ownershipTotal * 100).toFixed(1)}%</strong>
        </p>
        <p>
          Sim ROI{simEyebrowSuffix(whiteSim)}:{" "}
          <strong>{whiteSim.kind === "done" ? `${(whiteSim.result.roi * 100).toFixed(1)}%` : simStatusText(whiteSim) ?? "—"}</strong>
          {whiteSim.kind === "done" && (
            <span className="finish-stat-sub">
              {" "}
              Cash {(whiteSim.result.cashRate * 100).toFixed(1)}% · Top 1% {(whiteSim.result.top1PctRate * 100).toFixed(1)}%
            </span>
          )}
        </p>
        <p>
          Field sim ROI{simEyebrowSuffix(blackSim)}:{" "}
          <strong>{blackSim.kind === "done" ? `${(blackSim.result.roi * 100).toFixed(1)}%` : simStatusText(blackSim) ?? "—"}</strong>
          {blackSim.kind === "done" && (
            <span className="finish-stat-sub">
              {" "}
              Cash {(blackSim.result.cashRate * 100).toFixed(1)}% · Top 1% {(blackSim.result.top1PctRate * 100).toFixed(1)}%
            </span>
          )}
        </p>
      </div>

      {openSlots.length > 0 && <p className="finish-open">Open slots: {openSlots.join(" · ")}</p>}

      <p className="finish-happy">{HAPPY_HUNTING}</p>

      <div className="finish-actions">
        {whiteStats.openSlotCount > 0 && (
          <button type="button" className="fill-out-core" disabled={!canFillCore} onClick={onFillOutCore}>
            Fill out my core
          </button>
        )}
        <button type="button" onClick={() => void copyLineup()}>
          {copied ? "Copied" : "Copy lineup"}
        </button>
        <button type="button" onClick={onStartAgain}>
          Start again
        </button>
        <button type="button" onClick={onNewContest}>
          New contest
        </button>
      </div>
    </div>
  );
}

// Finish screen's "Copy lineup" -- plain tab-separated text (pastes cleanly
// into a spreadsheet), one row per roster entry (piece-locked OR
// "Fill out my core" optimizer-filled -- see rosterEntries) matching the
// on-screen finish-core table (Slot/Piece/Player/Pos/Team/Salary) plus a
// totals block. "Salary used" has no stored field of its own (SideStats
// only tracks salaryRemaining) -- it's just the roster's own salaries
// summed (whiteStats itself already folds in any filled players too, see
// its own comment). `slots` is parallel to `entries`, from assignRosterSlots.
function lineupText(
  entries: readonly RosterEntry[],
  slots: readonly string[],
  whiteStats: SideStats,
  openingLabel: string,
  history: readonly string[],
): string {
  const rows = entries.map((entry, i) =>
    [slots[i], entry.label, entry.player.name, entry.player.positions[0], entry.player.team, `$${entry.player.salary.toLocaleString()}`].join(
      "\t",
    ),
  );
  const salaryUsed = entries.reduce((sum, entry) => sum + entry.player.salary, 0);
  const totals = [
    `Salary used: $${salaryUsed.toLocaleString()}`,
    `Salary remaining: $${whiteStats.salaryRemaining.toLocaleString()}`,
    `Projection: ${whiteStats.projTotal.toFixed(1)} pts`,
    `Ownership: ${(whiteStats.ownershipTotal * 100).toFixed(1)}%`,
    `Opening: ${openingLabel}`,
    `Moves: ${formatMoveList(history)}`,
  ];
  return [...rows, "", ...totals].join("\n");
}

function formatMoveList(history: readonly string[]): string {
  const pairs: string[] = [];
  for (let i = 0; i < history.length; i += 2) {
    const num = i / 2 + 1;
    const black = history[i + 1];
    pairs.push(black !== undefined ? `${num}. ${history[i]} ${black}` : `${num}. ${history[i]}`);
  }
  return pairs.join(" ");
}

function PlayerFieldTable({ white, black }: { white: readonly Move[]; black: readonly Move[] }) {
  const rows = Math.max(white.length, black.length);
  if (rows === 0) return <p className="hint">(no picks yet)</p>;
  return (
    <table className="player-field">
      <thead>
        <tr>
          <th>Player</th>
          <th>Field</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, i) => (
          <tr key={i}>
            <td>{white[i] ? `${PIECE_LABEL[white[i].piece]}: ${white[i].player.name}` : ""}</td>
            <td>{black[i] ? `${PIECE_LABEL[black[i].piece]}: ${black[i].player.name}` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
