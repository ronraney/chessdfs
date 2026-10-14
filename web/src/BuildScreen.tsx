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
import { BOOK, LAST_RANK, NFL, RANKED_FAMILIES, RANK_BY_FAMILY } from "./appData";
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

  // Task 38d: the "what do I do now" status line above the board. Priority
  // order mirrors the sequence a build actually goes through: a pending
  // pick (modal open) always wins, then whether Black's reply is still in
  // flight (the setTimeout in commit()), and only otherwise White's own
  // to-move text -- prefixed with what Black just played, whenever there
  // is a Black move to report (i.e. every time but the very first, since
  // turn is only ever "w" again right after Black's reply resolves).
  const whiteToMoveText =
    onChosenLine && chosenNextMove !== null
      ? `Your move. Play ${chosenNextMove} to stay on ${chosenLine!.name}, pick another book move below, or drag any piece.`
      : "Your move. Drag any piece — each move locks a player of that piece's type.";
  const lastBlackMove = state.blackMoves.at(-1) ?? null;
  const statusLine: string =
    pendingMove !== null
      ? `Pick your ${PIECE_LABEL[pendingMove.piece]}.`
      : turn === "b"
        ? "The Field is moving…"
        : lastBlackMove !== null
          ? `Field played ${lastBlackMove.san} and locked ${lastBlackMove.player.name}. ${whiteToMoveText}`
          : whiteToMoveText;

  const continuationOptions: ContinuationOption[] =
    turn === "w"
      ? [...bookContinuations(history, BOOK)]
          .filter((san) => legalSans.has(san))
          .map((san): ContinuationOption => {
            const matched = legalMoves.find((m) => m.san === san)!;
            const resultLine = openingLine([...history, san], BOOK);
            const resultFamily = resultLine !== null ? splitFamily(resultLine.name)[0] : "";
            return {
              san,
              moveLabel: `${moveNumber}. ${san}`,
              openingLabel: resultLine?.name ?? null,
              lockLabel: lockDescription(pieceForChessType(matched.piece)),
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

  function dismissHowItWorks(): void {
    window.localStorage.setItem(HOW_IT_WORKS_KEY, "1");
    setHowItWorksDismissed(true);
  }

  const whiteStats = sideStats(state.whiteMoves.map((m) => m.player), NFL, preset.contest);
  const blackStats = sideStats(state.blackMoves.map((m) => m.player), NFL, preset.contest);
  const [family, variation] = chosenLine !== null ? splitFamily(chosenLine.name) : ["Your own opening", ""];
  const entryTier = preset.contest.entryTier(LAST_RANK);

  // The banner's own move list: the chosen line's reference (played moves
  // solid, the rest a preview of where it's headed) while still on it;
  // once off it -- deviated, or "own opening" with no chosen line at all
  // -- there's no fixed future left to preview, so it switches to the
  // actual played history instead (nothing "pending" in that case, since
  // bannerPlayedCount then equals the list's own length).
  const movesForBanner = onChosenLine && chosenLine !== null ? chosenLine.moves : history;
  const bannerPlayedCount = onChosenLine ? playedCount : history.length;

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
        <SideColumn side="you" label="You" sideName="White" stats={whiteStats} moves={state.whiteMoves} />
        <div className="board-column">
          <p className="status-line">{statusLine}</p>
          <BuildBoard fen={previewFen} dests={pendingMove === null ? dests : new Map()} lastMove={lastMove} onMove={handleBoardMove} />

          {turn === "w" && (
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
