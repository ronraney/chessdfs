// Task 38b: redrawn as the centered, dimmed-overlay modal shown in
// design/4-club-build-pick.png and 6-slate-build-pick.png -- replaces Task
// 38's always-open side panel. Candidates are fixed-sorted (the design
// shows no interactive sort controls) and the flow is now select-then-
// confirm: clicking a row only highlights it as the current selection
// (defaulting to the top of the list, i.e. the first row) and updates the
// "After this pick" footer live; "Lock player" is the one thing that
// actually calls onPick. Cancel (or the × button) closes without picking
// -- BuildScreen never committed the move to engine state in the first
// place, so there's nothing to undo.
//
// RULES.md piece table: each piece sorts by its own metric now, not a
// blanket "by projection" -- the column that used to always read "Proj"
// is now whichever metric actually sorted this list (e.g. "Lev 2.31" for
// a Bishop), via engine/metrics.ts's sortMetric (the same function the
// engine itself uses to build/cap the list BuildScreen hands in here).
//
// Bug fix (post-Task-40): `reasons` greys out (and labels) any candidate
// buildStats.pickReason flags as infeasible -- those rows can't be
// selected at all now (clicking one is a no-op), so "Lock player" staying
// disabled for them is moot in practice, but the check stays as a second
// guard. Nothing is pre-selected: the row list opens with no selection at
// all (`selectedId` starts null), "Lock player" stays disabled, and the
// footer stays blank until the player actually clicks a (feasible) row --
// matching design/4-club-build-pick.png and 6-slate-build-pick.png, where
// the picked row carries a visible accent outline + tinted background and
// the footer names who's selected.
import { useMemo, useState } from "react";
import "./PickPanel.css";
import { blockedPositionsNotice, pieceBandLabel, salaryCapNotice, sideStats, tightFinishStatus } from "./buildStats";
import type { ContestConfig } from "./engine/config";
import { highestOwnershipByPosition, sortMetric } from "./engine/metrics";
import { Piece, type Player } from "./engine/models";
import type { SportConfig } from "./engine/sport";

const PIECE_LABEL: Record<Piece, string> = {
  KING: "King",
  QUEEN: "Queen",
  ROOK: "Rook",
  BISHOP: "Bishop",
  KNIGHT: "Knight",
  PAWN: "Pawn",
};

// RULES.md piece table: King/Rook still sort by projection; Queen by
// ceiling; Bishop by leverage; Knight by floor (per $1,000 salary); Pawn
// by value (also per $1,000). Short labels for the pick-row column;
// `METRIC_NAME` is the longer form for the modal's own subtitle.
const METRIC_LABEL: Record<Piece, string> = {
  KING: "Proj",
  QUEEN: "Ceil",
  ROOK: "Proj",
  BISHOP: "Lev",
  KNIGHT: "Flr",
  PAWN: "Val",
};
const METRIC_NAME: Record<Piece, string> = {
  KING: "projection",
  QUEEN: "ceiling",
  ROOK: "projection",
  BISHOP: "leverage",
  KNIGHT: "floor",
  PAWN: "value",
};
// Points-based metrics (Proj/Ceil) read naturally at 1 decimal, matching
// every other points display on this screen; the rate-based ones
// (leverage/floor/value, all "per $1,000 salary") read better at 2.
function metricDecimals(piece: Piece): number {
  return piece === Piece.QUEEN || piece === Piece.BISHOP || piece === Piece.KNIGHT || piece === Piece.PAWN ? 2 : 1;
}

const NO_REASONS: ReadonlyMap<string, string> = new Map();

// Task 43: the move list shown under the title -- the chosen line's own
// full moves (on-book picks) or the moves actually played so far plus the
// one being decided (off-book picks); either way `highlightIndex` is the
// move being picked right now. Null for the switch-QB offer (not a real
// chess move pick), same as `openingLabel`.
export interface PickMoveContext {
  moves: readonly string[];
  highlightIndex: number;
}

interface Props {
  piece: Piece;
  moveLabel: string; // e.g. "4. Ba4"
  openingLabel: string | null; // e.g. "Morphy Defense" -- null out of book
  moveContext: PickMoveContext | null;
  candidates: readonly Player[];
  currentPlayers: readonly Player[];
  // The whole slate, not just `candidates` -- Bishop's own relativeLeverage
  // sort needs the highest ownership at a position across every player,
  // which a pre-filtered candidate list can't answer on its own; the
  // "after this pick" tight-finish preview (Rule change "new levels + Go
  // back") also needs it, filtered by `lockedPlayerIds`, to find the
  // cheapest possible finish from whoever's genuinely still undrafted.
  playersPool: readonly Player[];
  // Every player already locked by EITHER side right now (not just
  // White's own `currentPlayers`) -- who's actually left to draft for the
  // tight-finish preview's own cheapest-completion solve.
  lockedPlayerIds: ReadonlySet<string>;
  sport: SportConfig;
  contest: ContestConfig;
  reasons?: ReadonlyMap<string, string>; // player id -> why greyed out; absent means feasible
  onPick: (player: Player) => void;
  onCancel: () => void;
  error: string | null;
}

// "1. e4 e5 2. Nf3 ..." with the move at `highlightIndex` (the one being
// picked right now) visually called out -- the rest read as plain context,
// same move-numbering convention as BuildScreen's own MovesProgress/
// SetupScreen's formatMoves.
function PickMoveList({ moves, highlightIndex }: PickMoveContext) {
  const pairs: { num: number; whiteIdx: number; white: string; blackIdx: number; black: string | undefined }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push({ num: i / 2 + 1, whiteIdx: i, white: moves[i], blackIdx: i + 1, black: moves[i + 1] });
  }
  function moveClass(idx: number): string {
    return idx === highlightIndex ? "pick-move highlight" : "pick-move";
  }
  return (
    <p className="pick-move-list">
      {pairs.map((pair) => (
        <span key={pair.num} className="pick-move-pair">
          <span className="pick-move-number">{pair.num}.</span> <span className={moveClass(pair.whiteIdx)}>{pair.white}</span>
          {pair.black !== undefined && (
            <>
              {" "}
              <span className={moveClass(pair.blackIdx)}>{pair.black}</span>
            </>
          )}{" "}
        </span>
      ))}
    </p>
  );
}

export default function PickPanel({
  piece,
  moveLabel,
  openingLabel,
  moveContext,
  candidates,
  currentPlayers,
  playersPool,
  lockedPlayerIds,
  sport,
  contest,
  reasons = NO_REASONS,
  onPick,
  onCancel,
  error,
}: Props) {
  const highestOwnership = useMemo(
    () => (piece === Piece.BISHOP ? highestOwnershipByPosition(playersPool, contest) : undefined),
    [piece, playersPool, contest],
  );
  const sorted = useMemo(
    () =>
      [...candidates].sort(
        (a, b) => sortMetric(piece, b, contest, highestOwnership) - sortMetric(piece, a, contest, highestOwnership),
      ),
    [candidates, piece, contest, highestOwnership],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = sorted.find((p) => p.id === selectedId) ?? null;
  const selectedReason = selected !== null ? (reasons.get(selected.id) ?? null) : null;
  const tier = contest.fieldTier();
  const band = pieceBandLabel(piece, sport);
  const rosterFullNotice = useMemo(
    () => blockedPositionsNotice(piece, playersPool, lockedPlayerIds, currentPlayers, sport),
    [piece, playersPool, lockedPlayerIds, currentPlayers, sport],
  );
  const capNotice = useMemo(
    () => salaryCapNotice(piece, playersPool, lockedPlayerIds, currentPlayers, sport, contest),
    [piece, playersPool, lockedPlayerIds, currentPlayers, sport, contest],
  );

  const after = useMemo(
    () => (selected === null ? null : sideStats([...currentPlayers, selected], sport, contest)),
    [selected, currentPlayers, sport, contest],
  );
  const afterTightFinish = useMemo(
    () =>
      selected === null
        ? null
        : tightFinishStatus(
            [...currentPlayers, selected],
            playersPool.filter((p) => p.id !== selected.id && !lockedPlayerIds.has(p.id)),
            sport,
            contest,
          ),
    [selected, currentPlayers, playersPool, lockedPlayerIds, sport, contest],
  );

  return (
    <div className="pick-modal-overlay">
      <div className="pick-modal" role="dialog" aria-modal="true" aria-label={`Choose your ${PIECE_LABEL[piece]}`}>
        <div className="pick-modal-header">
          <div>
            <p className="pick-eyebrow">
              {moveLabel}
              {openingLabel !== null && ` · ${openingLabel}`}
            </p>
            <h2>Choose your {PIECE_LABEL[piece]}</h2>
            {moveContext !== null && <PickMoveList moves={moveContext.moves} highlightIndex={moveContext.highlightIndex} />}
            <p className="pick-subtitle">
              {band !== null && `${band} · `}
              sorted by {METRIC_NAME[piece]}
            </p>
          </div>
          <button type="button" className="pick-modal-close" aria-label="Close" onClick={onCancel}>
            ×
          </button>
        </div>

        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {rosterFullNotice !== null && <p className="hint">{rosterFullNotice}</p>}
        {capNotice !== null && <p className="hint">{capNotice}</p>}

        {candidates.length === 0 ? (
          <p className="hint">No eligible {PIECE_LABEL[piece]} players available for that move.</p>
        ) : (
          <>
            <div className="pick-column-header">
              <span>Player</span>
              <span>Salary</span>
              <span>{METRIC_LABEL[piece]}</span>
              <span>Own</span>
            </div>
            <div className="pick-row-list">
              {sorted.map((player) => {
                const reason = reasons.get(player.id) ?? null;
                const classes = ["pick-row"];
                if (player.id === selected?.id) classes.push("selected");
                if (reason !== null) classes.push("infeasible");
                return (
                  <button
                    key={player.id}
                    type="button"
                    className={classes.join(" ")}
                    disabled={reason !== null}
                    onClick={() => setSelectedId(player.id)}
                  >
                    <span className="pick-row-name">
                      {player.name} · {player.team}{" "}
                      <span className="pick-row-opp">
                        {player.isHome ? "vs" : "@"} {player.opp}
                      </span>
                      {reason !== null && <span className="pick-row-reason"> · {reason}</span>}
                    </span>
                    <span>${player.salary.toLocaleString()}</span>
                    <span>{sortMetric(piece, player, contest, highestOwnership).toFixed(metricDecimals(piece))}</span>
                    <span>{(player.ownFor(tier) * 100).toFixed(1)}%</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="pick-modal-footer">
          {after !== null && selected !== null && (
            <span className="pick-after">
              Selected: {selected.name} · After this pick: <strong>${after.salaryRemaining.toLocaleString()}</strong> left ·{" "}
              ${after.avgRemainingPerOpenSlot.toLocaleString(undefined, { maximumFractionDigits: 0 })} / slot ·{" "}
              {after.openSlotCount} open
              {afterTightFinish !== null && (
                <span className={`pick-tight-finish ${afterTightFinish.level}`}> · {afterTightFinish.message}</span>
              )}
            </span>
          )}
          <div className="pick-modal-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="lock-player"
              disabled={selected === null || selectedReason !== null}
              onClick={() => selected !== null && onPick(selected)}
            >
              Lock player
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
