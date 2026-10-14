// Task 37: replaces the old "Build -- coming next" placeholder with real
// template play. Both sides' moves come from the chosen opening line
// (ChosenOpening.kind === "line"); White's pick is interactive (PickModal),
// Black's is automatic (build.playBlackTemplateMove) -- same split as
// dfs_chess/cli.py's _play_white_template_move/play_black_template_move.
// "Play your own opening" (ChosenOpening.kind === "own") has no line to
// play at all -- depth (0) is already >= templateMoves.length (0), so it
// falls straight to the same "Line complete" placeholder; free play isn't
// built yet (explicitly out of scope this task).
//
// computeNextStep is the one place that decides what happens at the
// current position -- open White's pick modal, auto-advance (Black's
// move, or a PLACED-mode silent King move), stop with the template
// finished, or stop because the next move needs UI this task doesn't
// build yet (a capture or castling for White; "no captures UI, castling
// prompts... yet"). It's a pure function of `state`, so advanceThroughAutoSteps
// below can call it (and playBlackTemplateMove, itself pure) repeatedly to
// walk an entire chain of automatic moves and hand back just the one
// resulting BuildState to commit -- no setState-inside-an-effect chain
// reacting to its own output, and no move is ever resolved twice.
import { useMemo, useState } from "react";
import "./BuildScreen.css";
import { BOOK, NFL } from "./appData";
import BoardPreview from "./BoardPreview";
import { eligiblePlayers, sideStats, type SideStats } from "./buildStats";
import { playBlackTemplateMove, playWhiteMove } from "./engine/build";
import type { ContestConfig, ContestPreset } from "./engine/config";
import { BuildState, KingMode, Piece, type Move, type Player } from "./engine/models";
import { openingLine, splitFamily, type BookLine } from "./engine/openings";
import { pieceForChessType } from "./engine/pieces";
import { isCaptureMove, placeKings, pushSilentMove, type ChessMove } from "./engine/rules";
import type { ChosenOpening } from "./OpeningSetupScreen";
import PickModal from "./PickModal";
import ThemeToggle from "./ThemeToggle";

const PIECE_LABEL: Record<Piece, string> = {
  KING: "King",
  QUEEN: "Queen",
  ROOK: "Rook",
  BISHOP: "Bishop",
  KNIGHT: "Knight",
  PAWN: "Pawn",
};

type NextStep =
  | { kind: "templateDone" }
  | { kind: "openModal"; chessMove: ChessMove; piece: Piece }
  | { kind: "autoAdvance"; state: BuildState }
  | { kind: "unsupported"; reason: string };

function computeNextStep(
  state: BuildState,
  templateMoves: readonly string[],
  kingMode: KingMode,
  players: readonly Player[],
  contest: ContestConfig,
): NextStep {
  const depth = state.board.history().length;
  if (depth >= templateMoves.length) return { kind: "templateDone" };

  const san = templateMoves[depth];
  const matched = state.board.moves({ verbose: true }).find((m) => m.san === san);
  if (matched === undefined) {
    return { kind: "unsupported", reason: `"${san}" is not a legal move here -- stopping the template.` };
  }
  const chessMove: ChessMove = { from: matched.from, to: matched.to, promotion: matched.promotion };

  if (state.board.turn() === "b") {
    const result = playBlackTemplateMove(state, chessMove, NFL, contest, players, BOOK, kingMode);
    if (result === null) {
      return { kind: "unsupported", reason: "This line is no longer playable for Black here -- stopping the template." };
    }
    return { kind: "autoAdvance", state: result.state };
  }

  if (matched.isKingsideCastle() || matched.isQueensideCastle()) {
    return {
      kind: "unsupported",
      reason: "This opening's next move is castling, which the build screen doesn't support yet.",
    };
  }
  if (isCaptureMove(matched)) {
    return {
      kind: "unsupported",
      reason: "This opening's next move is a capture, which the build screen doesn't support yet.",
    };
  }
  const piece = pieceForChessType(matched.piece);
  if (kingMode === KingMode.PLACED && piece === Piece.KING) {
    return { kind: "autoAdvance", state: pushSilentMove(state, chessMove) };
  }
  return { kind: "openModal", chessMove, piece };
}

// Resolves every automatic step in a row (Black's template moves, and a
// PLACED-mode silent King move for White) before ever committing a state
// to React -- the loop itself is the "synchronize in one place" fix for
// what would otherwise be a setState-inside-an-effect chain reacting to
// its own output.
function advanceThroughAutoSteps(
  start: BuildState,
  templateMoves: readonly string[],
  kingMode: KingMode,
  players: readonly Player[],
  contest: ContestConfig,
): BuildState {
  let current = start;
  for (;;) {
    const step = computeNextStep(current, templateMoves, kingMode, players, contest);
    if (step.kind !== "autoAdvance") return current;
    current = step.state;
  }
}

interface Props {
  preset: ContestPreset;
  players: readonly Player[];
  kingMode: KingMode;
  whiteKing: Player | null;
  blackKing: Player | null;
  chosenOpening: ChosenOpening;
}

export default function BuildScreen({ preset, players, kingMode, whiteKing, blackKing, chosenOpening }: Props) {
  const templateMoves = useMemo(
    () => (chosenOpening.kind === "line" ? chosenOpening.line.moves : []),
    [chosenOpening],
  );

  const [state, setState] = useState<BuildState>(() => {
    const initial =
      kingMode === KingMode.PLACED && whiteKing !== null && blackKing !== null
        ? placeKings(whiteKing, blackKing, NFL, preset.contest)
        : new BuildState();
    return advanceThroughAutoSteps(initial, templateMoves, kingMode, players, preset.contest);
  });
  const [lastOpening, setLastOpening] = useState<BookLine | null>(() => openingLine(state.board.history(), BOOK));
  const [pickError, setPickError] = useState<string | null>(null);

  const nextStep = useMemo(
    () => computeNextStep(state, templateMoves, kingMode, players, preset.contest),
    [state, templateMoves, kingMode, players, preset.contest],
  );

  function commit(newState: BuildState): void {
    setState(newState);
    const line = openingLine(newState.board.history(), BOOK);
    if (line !== null) setLastOpening(line);
  }

  function handlePick(player: Player): void {
    if (nextStep.kind !== "openModal") return;
    try {
      const result = playWhiteMove(state, nextStep.chessMove, player, NFL, preset.contest, BOOK, null, kingMode);
      setPickError(null);
      commit(advanceThroughAutoSteps(result.state, templateMoves, kingMode, players, preset.contest));
    } catch {
      setPickError(`${player.name} isn't a legal pick for this move right now.`);
    }
  }

  const whiteStats = sideStats(state.whiteMoves.map((m) => m.player), NFL, preset.contest);
  const blackStats = sideStats(state.blackMoves.map((m) => m.player), NFL, preset.contest);
  const [family, variation] = lastOpening !== null ? splitFamily(lastOpening.name) : ["", ""];
  const history = state.board.history();

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

      <div className="build-layout">
        <SideColumn side="you" label="You" stats={whiteStats} moves={state.whiteMoves} />
        <div className="board-column">
          <BoardPreview fen={state.board.fen()} />
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

      {nextStep.kind === "unsupported" && <p className="status build-status">{nextStep.reason}</p>}
      {nextStep.kind === "templateDone" && (
        <p className="status build-status">Line complete — next steps coming.</p>
      )}

      {nextStep.kind === "openModal" && (
        <PickModal
          piece={nextStep.piece}
          candidates={eligiblePlayers(nextStep.piece, state.lockedPlayerIds, players, NFL)}
          currentPlayers={state.whiteMoves.map((m) => m.player)}
          sport={NFL}
          contest={preset.contest}
          onPick={handlePick}
          error={pickError}
        />
      )}
    </main>
  );
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
