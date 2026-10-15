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
//     the King step to the Rook step); PLACED is one step, followed by a
//     SEPARATE, already-committed "Switch your QB?" offer (switchOffer
//     state) -- `commit`'s `deferBlackReply` keeps Black's reply from
//     firing until that offer is resolved (accepted or declined), since
//     it's still part of resolving this same turn.
import { Chess } from "chess.js";
import type { Dests, Key } from "@lichess-org/chessground/types";
import { useEffect, useMemo, useRef, useState } from "react";
import "./BuildScreen.css";
import { BOOK, LAST_RANK, NFL, RANKED_FAMILIES, RANK_BY_FAMILY } from "./appData";
import BuildBoard from "./BuildBoard";
import { classifyMove, dfsLegalMoves, type MoveKind } from "./buildFlow";
import { eligiblePlayers, pickReason, pieceBandLabel, sideStats, type SideStats } from "./buildStats";
import { HAPPY_HUNTING, NoLegalBlackMoveError, checkWhiteDeadEnd, playBlackMove, playWhiteMove } from "./engine/build";
import type { ContestPreset } from "./engine/config";
import { BuildState, KingMode, Piece, Side, type Move, type Player } from "./engine/models";
import { bookContinuations, openingLine, openingName, splitFamily, type BookLine } from "./engine/openings";
import { SeededRandom } from "./engine/rng";
import { capturedSquare, isLineupComplete, placeKings, pushSilentMove, switchKing, type ChessMove } from "./engine/rules";
import PickPanel from "./PickPanel";
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

const HOW_IT_WORKS_KEY = "chess-dfs:how-it-works-dismissed";
const HOW_IT_WORKS_TEXT =
  "You're White. Each move locks a DFS player of that piece's type: pawns are cheap plays, knights TEs, bishops WRs, rooks RBs, queens $7K+ studs, the king your QB. The Field (Black) does the same. Build a 4–5 player core, then stop or keep going.";

const BLACK_REPLY_DELAY_MS = 600;
// At the very start of a build, `bookContinuations` returns essentially
// every first move recorded anywhere in the 3,865-line book -- dozens of
// options, not a useful menu. Capped to the chosen line's own move (always
// first, regardless of rank) plus the N next-most-popular by family rank
// -- the same ranking the Explorer already uses -- rather than every
// legal continuation; "(Play your own move)" covers anything not shown.
const CONTINUATION_LIMIT = 8;

interface Props {
  preset: ContestPreset;
  players: readonly Player[];
  kingMode: KingMode;
  whiteKing: Player | null;
  blackKing: Player | null;
  chosenOpening: ChosenOpening;
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
type Ending = { kind: "stopped" } | { kind: "complete" } | { kind: "deadEnd"; side: Side };

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
//   - castlePlaced: one pick (the Rook only -- the King is already
//     locked from setup).
type PendingMove =
  | { kind: "ordinary"; chessMove: ChessMove; piece: Piece; san: string }
  | { kind: "captureUnmoved"; chessMove: ChessMove; capturedPiece: Piece; san: string }
  | { kind: "castleEmergeKing"; chessMove: ChessMove; san: string }
  | { kind: "castleEmergeRook"; chessMove: ChessMove; san: string; king: Player }
  | { kind: "castlePlaced"; chessMove: ChessMove; san: string };

// Task 14's one-time "Switch your QB?" offer, shown right after a PLACED-
// mode castle commits (see the module comment above) -- a separate,
// already-committed-board follow-up, not part of the castle's own pick
// flow. `oldKing` is whoever's currently locked as White's QB (so the
// offer's own PickPanel can exclude them from `currentPlayers`, matching
// rules.switchKing's own "every other player" completability check).
interface SwitchOffer {
  afterState: BuildState;
  oldKing: Player;
}

interface ContinuationOption {
  san: string;
  moveLabel: string;
  openingLabel: string | null;
  lockLabel: string;
  isChosen: boolean;
  // The resulting opening's family rank (lower = more played), Infinity if
  // its family isn't ranked at all -- ordering/capping only, never shown.
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
    case "castlePlaced":
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
      return Piece.KING;
    case "castleEmergeRook":
    case "castlePlaced":
      return Piece.ROOK;
  }
}

// The roster `pickReason`/the "After this pick" footer should treat as
// already locked for this step -- ordinary/castleEmergeRook's own King
// pick included once chosen, so the Rook step's feasibility check (and
// footer) reflects both new picks together, not just the Rook alone.
function pendingBaseline(pendingMove: PendingMove, whiteMoves: readonly Move[]): Player[] {
  const current = whiteMoves.map((m) => m.player);
  return pendingMove.kind === "castleEmergeRook" ? [...current, pendingMove.king] : current;
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
  onStartAgain,
  onNewContest,
}: Props) {
  const [state, setState] = useState<BuildState>(() =>
    kingMode === KingMode.PLACED && whiteKing !== null && blackKing !== null
      ? placeKings(whiteKing, blackKing, NFL, preset.contest)
      : new BuildState(),
  );
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [switchOffer, setSwitchOffer] = useState<SwitchOffer | null>(null);
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
  // Bug fix: Black's reply threw something OTHER than a genuine "no legal
  // move" (NoLegalBlackMoveError) -- not a dead end, just surfaced as-is so
  // it's visible instead of silently mislabeled. The build doesn't end:
  // `ending` stays null, so Take back (which only needs pastStates.length
  // > 0 and nothing mid-flight) is still reachable, same as the bug report
  // asks for. Cleared on the next real action (a new commit, or Take back
  // itself) so it doesn't linger once the player has moved past it.
  const [blackMoveError, setBlackMoveError] = useState<string | null>(null);
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
  const [howItWorksDismissed, setHowItWorksDismissed] = useState<boolean>(
    () => window.localStorage.getItem(HOW_IT_WORKS_KEY) === "1",
  );
  const blackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (blackTimerRef.current !== null) clearTimeout(blackTimerRef.current);
    };
  }, []);

  // Stable for the component's lifetime -- re-seeding every render (or
  // every Black move) would break play's own book-line commitment logic,
  // which depends on one continuously-advancing PRNG sequence. useState's
  // lazy initializer (not useRef's eager argument) is what keeps
  // Math.random() from being called -- impurely -- on every render; only
  // the first render's call is ever used.
  const [rng] = useState<SeededRandom>(() => new SeededRandom(Math.floor(Math.random() * 2 ** 31)));
  const familyRanks = useMemo(() => Object.fromEntries(RANKED_FAMILIES.map((f) => [f.name, f.rank])), []);
  const targetRank = useMemo(() => preset.contest.targetRank(LAST_RANK), [preset]);

  const turn = state.board.turn();
  const history = state.board.history();
  const moveNumber = Math.floor(history.length / 2) + 1;

  const legalMoves = turn === "w" ? dfsLegalMoves(state, NFL, preset.contest, players, kingMode) : [];
  const legalSans = new Set(legalMoves.map((m) => m.san));
  const dests: Dests = new Map();
  for (const move of legalMoves) {
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
  // adds two priority levels above the original chain: switchOffer (a
  // separate, already-committed follow-up -- turn is already "b" by then,
  // same as any White move, but Black's reply is deliberately on hold)
  // and the castling/capture-aware pendingPickText/whiteCaptureNote.
  const whiteToMoveText =
    onChosenLine && chosenNextMove !== null
      ? `Your move. Play ${chosenNextMove} to stay on ${chosenLine!.name}, pick another book move below, or drag any piece.`
      : "Your move. Drag any piece — each move locks a player of that piece's type.";
  const lastBlackMove = state.blackMoves.at(-1) ?? null;

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
              rank: RANK_BY_FAMILY.get(resultFamily)?.rank ?? Infinity,
            };
          })
          .sort((a, b) => {
            if (a.isChosen !== b.isChosen) return a.isChosen ? -1 : 1;
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
  // out of book, not yet dismissed) -- below switchOffer/pendingMove (both
  // represent an actively open choice, which still takes priority) but
  // above the plain "your move"/"Field played X" text, since it replaces
  // that prompt entirely until dismissed.
  const statusLine: string =
    blackMoveError !== null
      ? `Something went wrong: ${blackMoveError}`
      : switchOffer !== null
        ? "Switch your QB?"
        : pendingMove !== null
          ? pendingPickText(pendingMove)
          : turn === "b"
            ? whiteCaptureNote ?? "The Field is moving…"
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

  // Starts (or restarts) Black's reply timer for `newState` -- split out
  // of commit() so the castlePlaced/switchOffer flow can commit the board
  // without immediately triggering Black (the switch offer is still part
  // of resolving White's own turn) and call this itself once that offer
  // is settled.
  function scheduleBlackReply(newState: BuildState): void {
    if (blackTimerRef.current !== null) clearTimeout(blackTimerRef.current);
    if (newState.board.turn() !== "b") {
      blackTimerRef.current = null;
      return;
    }
    setBlackMoving(true);
    blackTimerRef.current = setTimeout(() => {
      try {
        const result = playBlackMove(newState, BOOK, familyRanks, targetRank, NFL, preset.contest, players, rng, kingMode);
        setBlackMoveNote(describeBlackMove(newState, result.state));
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
  // reply. Shared by commit() and finalizeSwitch() (the Switch-QB offer
  // doesn't change roster size, but castling itself -- right before that
  // offer even appears -- can).
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
    if (after.blackMoves.length === before.blackMoves.length) return null;
    const lastSan = after.board.history().at(-1)!;
    const matched = before.board.moves({ verbose: true }).find((m) => m.san === lastSan)!;
    const kind = classifyMove(before, matched, kingMode);
    const lastMoveRecord = after.blackMoves.at(-1)!;
    if (kind.kind === "captureTransfer") {
      return `Field captured your ${PIECE_LABEL[lastMoveRecord.piece].toLowerCase()}: ${lastMoveRecord.player.name} joins the Field.`;
    }
    if (kind.kind === "captureUnmoved") {
      return `Field captured an unmoved ${PIECE_LABEL[kind.capturedPiece].toLowerCase()} and picked ${lastMoveRecord.player.name}.`;
    }
    return null;
  }

  function commit(newState: BuildState, opts: { captureNote?: string | null; deferBlackReply?: boolean } = {}): void {
    setPastStates((past) => [...past, state]);
    setState(newState);
    setPendingMove(null);
    setWhiteCaptureNote(opts.captureNote ?? null);
    setBlackMoveError(null);
    if (opts.deferBlackReply) return;
    finishOrScheduleBlack(newState);
  }

  function handleBoardMove(orig: Key, dest: Key): void {
    const matched = legalMoves.find((m) => m.from === orig && m.to === dest);
    if (matched === undefined) return; // dests only ever offers matched's own from/to pairs
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
        commit(result.state, { captureNote: transferred !== null ? `You captured ${transferred.name}.` : null });
        return;
      }
      case "captureUnmoved":
        setPendingMove({ kind: "captureUnmoved", chessMove, capturedPiece: kind.capturedPiece, san: matched.san });
        return;
      case "castleEmerge":
        setPendingMove({ kind: "castleEmergeKing", chessMove, san: matched.san });
        return;
      case "castlePlaced":
        setPendingMove({ kind: "castlePlaced", chessMove, san: matched.san });
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
          commit(result.state);
          return;
        }
        case "captureUnmoved": {
          const result = playWhiteMove(state, pendingMove.chessMove, player, NFL, preset.contest, BOOK, null, kingMode);
          commit(result.state, { captureNote: `You captured ${player.name}.` });
          return;
        }
        case "castleEmergeKing":
          // Advances to the Rook step -- nothing is committed to engine
          // state yet, same as an ordinary pending pick.
          setPendingMove({ kind: "castleEmergeRook", chessMove: pendingMove.chessMove, san: pendingMove.san, king: player });
          return;
        case "castleEmergeRook": {
          const result = playWhiteMove(state, pendingMove.chessMove, pendingMove.king, NFL, preset.contest, BOOK, player, kingMode);
          commit(result.state);
          return;
        }
        case "castlePlaced": {
          const result = playWhiteMove(state, pendingMove.chessMove, null, NFL, preset.contest, BOOK, player, kingMode);
          const king = result.state.whiteMoves.find((m) => m.piece === Piece.KING)!.player;
          commit(result.state, { deferBlackReply: true });
          setSwitchOffer({ afterState: result.state, oldKing: king });
          return;
        }
      }
    } catch {
      setPickError(`${player.name} isn't a legal pick for this move right now.`);
    }
  }

  // The Switch-QB offer's own resolution -- `newKing` null means decline
  // ("Cancel" on that PickPanel). Either way the castle itself already
  // stands (committed before this offer even appeared); this only ever
  // additionally applies switchKing, then finally lets Black's reply fire.
  function finalizeSwitch(newKing: Player | null): void {
    if (switchOffer === null) return;
    const finalState = newKing !== null ? switchKing(switchOffer.afterState, Side.WHITE, newKing, NFL, preset.contest) : null;
    const resolved = finalState ?? switchOffer.afterState;
    setState(resolved);
    setSwitchOffer(null);
    finishOrScheduleBlack(resolved);
  }

  function handleCancel(): void {
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
  function stopWithCore(): void {
    if (blackTimerRef.current !== null) clearTimeout(blackTimerRef.current);
    setEnding({ kind: "stopped" });
  }
  const canStop = pendingMove === null && switchOffer === null && !blackMoving && ending === null;

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
  }
  const canTakeBack = pastStates.length > 0 && pendingMove === null && switchOffer === null && !blackMoving && ending === null;

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

  const whiteStats = sideStats(state.whiteMoves.map((m) => m.player), NFL, preset.contest);
  const blackStats = sideStats(state.blackMoves.map((m) => m.player), NFL, preset.contest);
  const [family, variation] = chosenLine !== null ? splitFamily(chosenLine.name) : ["Your own opening", ""];
  const entryTier = preset.contest.entryTier(LAST_RANK);
  // Task 40 finish screen: the opening actually reached by the end of the
  // build (openingLine's own live name off `history`), not necessarily the
  // one originally chosen -- falls back to the chosen line's own name (or
  // "Your own opening") if the final position matches no book line at all.
  const finalOpeningLabel = openingLine(history, BOOK)?.name ?? (chosenLine !== null ? chosenLine.name : "Your own opening");

  // The banner's own move list: the chosen line's reference (played moves
  // solid, the rest a preview of where it's headed) while still on it;
  // once off it -- deviated, or "own opening" with no chosen line at all
  // -- there's no fixed future left to preview, so it switches to the
  // actual played history instead (nothing "pending" in that case, since
  // bannerPlayedCount then equals the list's own length).
  const movesForBanner = onChosenLine && chosenLine !== null ? chosenLine.moves : history;
  const bannerPlayedCount = onChosenLine ? playedCount : history.length;

  const pendingCandidates = pendingMove !== null ? eligiblePlayers(pendingPiece(pendingMove), state.lockedPlayerIds, players, NFL) : [];
  const pendingPlayerBaseline = pendingMove !== null ? pendingBaseline(pendingMove, state.whiteMoves) : [];
  const pendingReasons = new Map<string, string>();
  for (const candidate of pendingCandidates) {
    const reason = pendingMove !== null ? pickReason(pendingPlayerBaseline, candidate, NFL, preset.contest) : null;
    if (reason !== null) pendingReasons.set(candidate.id, reason);
  }

  const switchCandidates =
    switchOffer !== null ? eligiblePlayers(Piece.KING, switchOffer.afterState.lockedPlayerIds, players, NFL) : [];
  const switchBaseline =
    switchOffer !== null ? switchOffer.afterState.whiteMoves.filter((m) => m.player.id !== switchOffer.oldKing.id).map((m) => m.player) : [];
  const switchReasons = new Map<string, string>();
  for (const candidate of switchCandidates) {
    const reason = pickReason(switchBaseline, candidate, NFL, preset.contest);
    if (reason !== null) switchReasons.set(candidate.id, reason);
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
          onStop={ending === null ? stopWithCore : undefined}
          canStop={canStop}
        />
        <div className="board-column">
          {ending !== null ? (
            <FinishCard
              ending={ending}
              openingLabel={finalOpeningLabel}
              whiteMoves={state.whiteMoves}
              whiteStats={whiteStats}
              onStartAgain={onStartAgain}
              onNewContest={onNewContest}
            />
          ) : (
            <>
              <p className="status-line">{statusLine}</p>
              <BuildBoard fen={previewFen} dests={pendingMove === null ? dests : new Map()} lastMove={lastMove} onMove={handleBoardMove} />
              <button type="button" className="take-back" disabled={!canTakeBack} onClick={takeBack}>
                Take back
              </button>

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
            </>
          )}
        </div>
        <SideColumn side="field" label="Field" sideName="Black" stats={blackStats} moves={state.blackMoves} />
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
          candidates={pendingCandidates}
          currentPlayers={pendingPlayerBaseline}
          sport={NFL}
          contest={preset.contest}
          reasons={pendingReasons}
          onPick={handlePick}
          onCancel={handleCancel}
          error={pickError}
        />
      )}

      {switchOffer !== null && (
        <PickPanel
          piece={Piece.KING}
          moveLabel="Switch your QB?"
          openingLabel={null}
          candidates={switchCandidates}
          currentPlayers={switchBaseline}
          sport={NFL}
          contest={preset.contest}
          reasons={switchReasons}
          onPick={(king) => finalizeSwitch(king)}
          onCancel={() => finalizeSwitch(null)}
          error={null}
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

function SideColumn({
  side,
  label,
  sideName,
  stats,
  moves,
  onStop,
  canStop,
}: {
  side: "you" | "field";
  label: string;
  sideName: string;
  stats: SideStats;
  moves: readonly Move[];
  // Task 40: "Stop with this core" -- White's own card only (`onStop` is
  // only ever passed for side "you"); available once at least one player
  // is locked, same as the real "stop" command cli.py's free-play turn
  // accepts at any point past that.
  onStop?: () => void;
  canStop?: boolean;
}) {
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
          <span className="mono">${stats.avgRemainingPerOpenSlot.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span> avg / open
          slot · {stats.openSlotCount} open
        </p>
      </div>

      <div className="side-stat-block">
        <p className="side-eyebrow">Core ownership</p>
        <p className="side-ownership">{(stats.ownershipTotal * 100).toFixed(1)}%</p>
      </div>

      <div className="side-stat-block">
        <p className="side-eyebrow">Core projection</p>
        <p className="side-projection">{stats.projTotal.toFixed(1)} pts</p>
      </div>

      <ul className="locked-players">
        {moves.map((m) => (
          <li key={m.player.id}>
            <span className="locked-glyph" aria-hidden="true">
              {PIECE_GLYPH[m.piece]}
            </span>
            <span className="locked-name">
              {m.player.name} · {m.player.positions[0]}
            </span>
            <span className="locked-salary">${m.player.salary.toLocaleString()}</span>
          </li>
        ))}
      </ul>

      {openSlots.length > 0 && <p className="side-open">Open: {openSlots.join(" · ")}</p>}

      {onStop !== undefined && moves.length > 0 && (
        <button type="button" className="stop-with-core" disabled={!canStop} onClick={onStop}>
          Stop with this core
        </button>
      )}
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
  openingLabel,
  whiteMoves,
  whiteStats,
  onStartAgain,
  onNewContest,
}: {
  ending: Ending;
  openingLabel: string;
  whiteMoves: readonly Move[];
  whiteStats: SideStats;
  onStartAgain: () => void;
  onNewContest: () => void;
}) {
  const openSlots = openSlotLabels(whiteStats);
  return (
    <div className="finish-card">
      <p className="finish-ended-line">{endingHeadline(ending)}</p>
      <p className="finish-opening">
        <span className="side-eyebrow">Opening</span> {openingLabel}
      </p>

      <table className="finish-core">
        <thead>
          <tr>
            <th>Piece</th>
            <th>Player</th>
            <th>Pos</th>
            <th>Team</th>
            <th>Salary</th>
          </tr>
        </thead>
        <tbody>
          {whiteMoves.map((m) => (
            <tr key={m.player.id}>
              <td>{PIECE_LABEL[m.piece]}</td>
              <td>{m.player.name}</td>
              <td>{m.player.positions[0]}</td>
              <td>{m.player.team}</td>
              <td>${m.player.salary.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="finish-stats">
        <p>
          Salary remaining: <strong>${whiteStats.salaryRemaining.toLocaleString()}</strong>
        </p>
        <p>
          Core projection: <strong>{whiteStats.projTotal.toFixed(1)} pts</strong>
        </p>
        <p>
          Core ownership: <strong>{(whiteStats.ownershipTotal * 100).toFixed(1)}%</strong>
        </p>
      </div>

      {openSlots.length > 0 && <p className="finish-open">Open slots: {openSlots.join(" · ")}</p>}

      <p className="finish-happy">{HAPPY_HUNTING}</p>

      <div className="finish-actions">
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
