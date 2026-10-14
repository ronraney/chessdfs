// Task 38: reworks Task 37's forced-both-sides template into "the chosen
// line only suggests White's moves; White may play any legal move." White
// drags on the board (BuildBoard); Black always replies via the engine's
// own book-committed free play (build.playBlackMove, not
// playBlackTemplateMove -- it already implements exactly "follow the
// committed line while it matches, re-choose when it doesn't," RULES.md
// "Black (the field)," so there's no template bookkeeping left to drive
// here at all) after a short pause so the move reads as its own turn.
//
// A White move is never committed to `state` until its pick is confirmed:
// BuildBoard's `fen` is `previewFen` (the current `state` plus the
// tentative move, computed with a scratch chess.js clone -- a pure chess-
// mechanics preview, not a DFS rule) while a pick is pending, and plain
// `state.board.fen()` otherwise. Cancel just drops `pendingMove`, which
// snaps `previewFen` back to `state`'s own fen -- no engine-level undo is
// needed (see the session report for the explicit "is this supported"
// check this task asked for).
import { Chess } from "chess.js";
import type { Dests, Key } from "@lichess-org/chessground/types";
import { useEffect, useMemo, useRef, useState } from "react";
import "./BuildScreen.css";
import { BOOK, LAST_RANK, NFL, RANKED_FAMILIES } from "./appData";
import BuildBoard from "./BuildBoard";
import { chessMoveForSan, dfsLegalMoves, suggestionFor } from "./buildFlow";
import { eligiblePlayers, sideStats, type SideStats } from "./buildStats";
import { playBlackMove, playWhiteMove } from "./engine/build";
import type { ContestPreset } from "./engine/config";
import { BuildState, KingMode, Piece, type Move, type Player } from "./engine/models";
import { openingLine, splitFamily, type BookLine } from "./engine/openings";
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
}

export default function BuildScreen({ preset, players, kingMode, whiteKing, blackKing, chosenOpening }: Props) {
  const [state, setState] = useState<BuildState>(() =>
    kingMode === KingMode.PLACED && whiteKing !== null && blackKing !== null
      ? placeKings(whiteKing, blackKing, NFL, preset.contest)
      : new BuildState(),
  );
  const [lastOpening, setLastOpening] = useState<BookLine | null>(() => openingLine(state.board.history(), BOOK));
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
  const isWhiteToAct = turn === "w" && pendingMove === null;

  const legalMoves = isWhiteToAct ? dfsLegalMoves(state, NFL, preset.contest, players, kingMode) : [];
  const legalSans = new Set(legalMoves.map((m) => m.san));
  const dests: Dests = new Map();
  for (const move of legalMoves) {
    const arr = dests.get(move.from) ?? [];
    arr.push(move.to);
    dests.set(move.from, arr);
  }

  const suggestion = isWhiteToAct ? filterSuggestion(suggestionFor(history, chosenOpening, BOOK), legalSans) : { kind: "none" as const };
  const suggestionArrow =
    suggestion.kind === "onLine" ? arrowFor(state, suggestion.move) : null;

  const previewFen = useMemo(() => {
    if (pendingMove === null) return state.board.fen();
    const scratch = new Chess(state.board.fen());
    scratch.move({ from: pendingMove.chessMove.from, to: pendingMove.chessMove.to, promotion: pendingMove.chessMove.promotion });
    return scratch.fen();
  }, [state, pendingMove]);

  function commit(newState: BuildState): void {
    setState(newState);
    setPendingMove(null);
    const line = openingLine(newState.board.history(), BOOK);
    if (line !== null) setLastOpening(line);

    if (blackTimerRef.current !== null) clearTimeout(blackTimerRef.current);
    blackTimerRef.current =
      newState.board.turn() !== "b"
        ? null
        : setTimeout(() => {
            try {
              const result = playBlackMove(newState, BOOK, familyRanks, targetRank, NFL, preset.contest, players, rng, kingMode);
              setState(result.state);
              const afterBlack = openingLine(result.state.board.history(), BOOK);
              if (afterBlack !== null) setLastOpening(afterBlack);
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
    setPendingMove({ chessMove, piece });
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
  const [family, variation] = lastOpening !== null ? splitFamily(lastOpening.name) : ["", ""];

  return (
    <main className="build-screen">
      <header className="app-header">
        <ThemeToggle />
      </header>

      <section className="opening-banner">
        <h1 className="opening-family">{family || "Chess DFS"}</h1>
        {variation !== "" && <p className="opening-variation">{variation}</p>}
        {lastOpening !== null && <p className="opening-eco">{lastOpening.eco}</p>}
      </section>

      {isWhiteToAct && suggestion.kind === "onLine" && (
        <section className="suggestion-banner">
          <p>
            Suggested: <strong>{suggestion.move}</strong> · {suggestion.lineName}
          </p>
          <button type="button" onClick={() => playSan(suggestion.move)}>
            Play it
          </button>
        </section>
      )}
      {isWhiteToAct && suggestion.kind === "offLine" && (
        <section className="suggestion-banner off-line">
          <p>Book continuations:</p>
          <div className="suggestion-options">
            {suggestion.options.map((option) => (
              <button key={option.move} type="button" onClick={() => playSan(option.move)}>
                {option.name} ({option.move})
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="build-layout">
        <SideColumn side="you" label="You" stats={whiteStats} moves={state.whiteMoves} />
        <div className="board-column">
          <BuildBoard
            fen={previewFen}
            dests={pendingMove === null && turn === "w" ? dests : new Map()}
            suggestionArrow={pendingMove === null ? suggestionArrow : null}
            onMove={handleBoardMove}
          />
        </div>
        <SideColumn side="field" label="Field" stats={blackStats} moves={state.blackMoves} />
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

function filterSuggestion(
  raw: ReturnType<typeof suggestionFor>,
  legalSans: ReadonlySet<string>,
): ReturnType<typeof suggestionFor> {
  if (raw.kind === "onLine") {
    return legalSans.has(raw.move) ? raw : { kind: "none" };
  }
  if (raw.kind === "offLine") {
    const options = raw.options.filter((o) => legalSans.has(o.move));
    return options.length > 0 ? { kind: "offLine", options } : { kind: "none" };
  }
  return raw;
}

function arrowFor(state: BuildState, san: string): { orig: Key; dest: Key } | null {
  const matched = chessMoveForSan(state, san);
  return matched === null ? null : { orig: matched.from, dest: matched.to };
}

function SideColumn({
  side,
  label,
  stats,
  moves,
}: {
  side: "you" | "field";
  label: string;
  stats: SideStats;
  moves: readonly Move[];
}) {
  return (
    <div className={`side-column ${side}`}>
      <h2>{label}</h2>
      <p className="side-stat">
        Salary remaining: ${stats.salaryRemaining.toLocaleString()} (avg $
        {stats.avgRemainingPerOpenSlot.toLocaleString(undefined, { maximumFractionDigits: 0 })}/open slot)
      </p>
      <p className="side-stat">Open slots: {stats.openSlotCount}</p>
      <p className="side-stat">Core projection: {stats.projTotal.toFixed(1)} pts</p>
      <p className="side-stat">Core ownership: {(stats.ownershipTotal * 100).toFixed(1)}%</p>
      <ul className="locked-players">
        {moves.map((m) => (
          <li key={m.player.id}>
            <span className="locked-piece">{PIECE_LABEL[m.piece]}</span>
            <span className="locked-name">{m.player.name}</span>
            <span className="locked-pos">{m.player.positions[0]}</span>
            <span className="locked-team">{m.player.team}</span>
            <span className="locked-salary">${m.player.salary.toLocaleString()}</span>
          </li>
        ))}
      </ul>
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
