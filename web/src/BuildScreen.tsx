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
import { Chess } from "chess.js";
import type { Dests, Key } from "@lichess-org/chessground/types";
import { useEffect, useMemo, useRef, useState } from "react";
import "./BuildScreen.css";
import { BOOK, LAST_RANK, NFL, RANKED_FAMILIES } from "./appData";
import BuildBoard from "./BuildBoard";
import { dfsLegalMoves } from "./buildFlow";
import { eligiblePlayers, pieceBandLabel, sideStats, type SideStats } from "./buildStats";
import { playBlackMove, playWhiteMove } from "./engine/build";
import type { ContestPreset } from "./engine/config";
import { BuildState, KingMode, Piece, type Move, type Player } from "./engine/models";
import { bookContinuations, openingLine, openingName, splitFamily, type BookLine } from "./engine/openings";
import { pieceForChessType } from "./engine/pieces";
import { SeededRandom } from "./engine/rng";
import { placeKings, pushSilentMove, type ChessMove } from "./engine/rules";
import type { ChosenOpening } from "./OpeningSetupScreen";
import PickPanel from "./PickPanel";
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

const BLACK_REPLY_DELAY_MS = 600;

interface Props {
  preset: ContestPreset;
  players: readonly Player[];
  kingMode: KingMode;
  whiteKing: Player | null;
  blackKing: Player | null;
  chosenOpening: ChosenOpening;
}

interface PendingMove {
  chessMove: ChessMove;
  piece: Piece;
  san: string;
}

interface ContinuationOption {
  san: string;
  moveLabel: string;
  openingLabel: string | null;
  lockLabel: string;
  isChosen: boolean;
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

function openSlotLabels(stats: SideStats): string[] {
  const labels: string[] = [];
  for (const slot of NFL.rosterSlots) {
    const open = stats.openSlots[slot.name] ?? 0;
    for (let i = 0; i < open; i++) labels.push(slot.name);
  }
  return labels;
}

export default function BuildScreen({ preset, players, kingMode, whiteKing, blackKing, chosenOpening }: Props) {
  const [state, setState] = useState<BuildState>(() =>
    kingMode === KingMode.PLACED && whiteKing !== null && blackKing !== null
      ? placeKings(whiteKing, blackKing, NFL, preset.contest)
      : new BuildState(),
  );
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
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

  const continuationOptions: ContinuationOption[] =
    turn === "w"
      ? [...bookContinuations(history, BOOK)]
          .filter((san) => legalSans.has(san))
          .map((san): ContinuationOption => {
            const matched = legalMoves.find((m) => m.san === san)!;
            return {
              san,
              moveLabel: `${moveNumber}. ${san}`,
              openingLabel: openingName([...history, san], BOOK),
              lockLabel: lockDescription(pieceForChessType(matched.piece)),
              isChosen: san === chosenNextMove,
            };
          })
          .sort((a, b) => (a.isChosen === b.isChosen ? a.san.localeCompare(b.san) : a.isChosen ? -1 : 1))
      : [];

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

  function commit(newState: BuildState): void {
    setState(newState);
    setPendingMove(null);

    if (blackTimerRef.current !== null) clearTimeout(blackTimerRef.current);
    blackTimerRef.current =
      newState.board.turn() !== "b"
        ? null
        : setTimeout(() => {
            try {
              const result = playBlackMove(newState, BOOK, familyRanks, targetRank, NFL, preset.contest, players, rng, kingMode);
              setState(result.state);
            } catch {
              // Black has no legal move at all -- a dead end this task
              // doesn't handle yet (not reachable by anything this task
              // tests); left as a no-op rather than crashing the screen.
            }
          }, BLACK_REPLY_DELAY_MS);
  }

  function handleBoardMove(orig: Key, dest: Key): void {
    const matched = legalMoves.find((m) => m.from === orig && m.to === dest);
    if (matched === undefined) return; // dests only ever offers matched's own from/to pairs
    const chessMove: ChessMove = { from: matched.from, to: matched.to, promotion: matched.promotion };
    const piece = pieceForChessType(matched.piece);
    if (kingMode === KingMode.PLACED && piece === Piece.KING) {
      commit(pushSilentMove(state, chessMove));
      return;
    }
    setPickError(null);
    setPendingMove({ chessMove, piece, san: matched.san });
  }

  function playSan(san: string): void {
    const matched = legalMoves.find((m) => m.san === san);
    if (matched === undefined) return;
    handleBoardMove(matched.from, matched.to);
  }

  function handlePick(player: Player): void {
    if (pendingMove === null) return;
    try {
      const result = playWhiteMove(state, pendingMove.chessMove, player, NFL, preset.contest, BOOK, null, kingMode);
      commit(result.state);
    } catch {
      setPickError(`${player.name} isn't a legal pick for this move right now.`);
    }
  }

  function handleCancel(): void {
    setPendingMove(null);
    setPickError(null);
  }

  const whiteStats = sideStats(state.whiteMoves.map((m) => m.player), NFL, preset.contest);
  const blackStats = sideStats(state.blackMoves.map((m) => m.player), NFL, preset.contest);
  const [family, variation] = chosenLine !== null ? splitFamily(chosenLine.name) : ["Your own opening", ""];
  const entryTier = preset.contest.entryTier(LAST_RANK);

  return (
    <main className="build-screen">
      <header className="build-header">
        <span className="build-wordmark">Chess DFS</span>
        <div className="build-chips">
          <span className="chip">
            {preset.name} · {preset.contest.fieldSize.toLocaleString()} entries · {entryTier.name} field
          </span>
          <span className="chip">King: {kingMode === KingMode.EMERGE ? "Let him emerge" : "Place your King now"}</span>
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
        {chosenLine !== null && (
          <p className="opening-moves">
            <MovesProgress moves={chosenLine.moves} playedCount={playedCount} />
          </p>
        )}
      </section>

      <div className="build-layout">
        <SideColumn side="you" label="You" sideName="White" stats={whiteStats} moves={state.whiteMoves} />
        <div className="board-column">
          <BuildBoard fen={previewFen} dests={pendingMove === null ? dests : new Map()} lastMove={lastMove} onMove={handleBoardMove} />

          {turn === "w" && (
            <div className="book-continues">
              <p className="book-continues-label">Book continues</p>
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
          )}
        </div>
        <SideColumn side="field" label="Field" sideName="Black" stats={blackStats} moves={state.blackMoves} />
      </div>

      <section className="move-list">
        <h2>Moves</h2>
        <MoveList sans={history} />
      </section>

      <section className="player-field-table">
        <h2>Player | Field</h2>
        <PlayerFieldTable white={state.whiteMoves} black={state.blackMoves} />
      </section>

      {pendingMove !== null && (
        <PickPanel
          piece={pendingMove.piece}
          moveLabel={`${moveNumber}. ${pendingMove.san}`}
          openingLabel={openingName([...history, pendingMove.san], BOOK)}
          candidates={eligiblePlayers(pendingMove.piece, state.lockedPlayerIds, players, NFL)}
          currentPlayers={state.whiteMoves.map((m) => m.player)}
          sport={NFL}
          contest={preset.contest}
          onPick={handlePick}
          onCancel={handleCancel}
          error={pickError}
        />
      )}
    </main>
  );
}

function MovesProgress({ moves, playedCount }: { moves: readonly string[]; playedCount: number }) {
  const pairs: { num: number; white: string; black: string | undefined; whiteIdx: number; blackIdx: number }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push({ num: i / 2 + 1, white: moves[i], black: moves[i + 1], whiteIdx: i, blackIdx: i + 1 });
  }
  return (
    <>
      {pairs.map((pair) => (
        <span key={pair.num} className="move-pair">
          <span className="move-number">{pair.num}.</span>{" "}
          <span className={pair.whiteIdx < playedCount ? "played" : "pending"}>{pair.white}</span>
          {pair.black !== undefined && (
            <>
              {" "}
              <span className={pair.blackIdx < playedCount ? "played" : "pending"}>{pair.black}</span>
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
}: {
  side: "you" | "field";
  label: string;
  sideName: string;
  stats: SideStats;
  moves: readonly Move[];
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
    </div>
  );
}

function MoveList({ sans }: { sans: readonly string[] }) {
  if (sans.length === 0) return <p className="hint">(no moves yet)</p>;
  const lastIndex = sans.length - 1;
  const pairs: { num: number; whiteIdx: number; blackIdx: number | null }[] = [];
  for (let i = 0; i < sans.length; i += 2) {
    pairs.push({ num: i / 2 + 1, whiteIdx: i, blackIdx: i + 1 < sans.length ? i + 1 : null });
  }
  return (
    <p className="moves-line">
      {pairs.map((pair) => (
        <span key={pair.num} className="move-pair">
          {pair.num}. <span className={pair.whiteIdx === lastIndex ? "current-move" : ""}>{sans[pair.whiteIdx]}</span>
          {pair.blackIdx !== null && (
            <>
              {" "}
              <span className={pair.blackIdx === lastIndex ? "current-move" : ""}>{sans[pair.blackIdx]}</span>
            </>
          )}{" "}
        </span>
      ))}
    </p>
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
