// Task 38b: redrawn as the centered, dimmed-overlay modal shown in
// design/4-club-build-pick.png and 6-slate-build-pick.png -- replaces Task
// 38's always-open side panel. Candidates are fixed-sorted by projection
// (the design shows no interactive sort controls, just "sorted by
// projection"; no test exercised the old sortable-header behavior, so this
// is a straight simplification, not a loss of coverage) and the flow is
// now select-then-confirm: clicking a row only highlights it as the
// current selection (defaulting to the top projection, i.e. the first
// row) and updates the "After this pick" footer live; "Lock player" is
// the one thing that actually calls onPick. Cancel (or the × button)
// closes without picking -- BuildScreen never committed the move to engine
// state in the first place, so there's nothing to undo.
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
import { pieceBandLabel, sideStats } from "./buildStats";
import type { ContestConfig } from "./engine/config";
import type { Piece, Player } from "./engine/models";
import type { SportConfig } from "./engine/sport";

const PIECE_LABEL: Record<Piece, string> = {
  KING: "King",
  QUEEN: "Queen",
  ROOK: "Rook",
  BISHOP: "Bishop",
  KNIGHT: "Knight",
  PAWN: "Pawn",
};

const NO_REASONS: ReadonlyMap<string, string> = new Map();

interface Props {
  piece: Piece;
  moveLabel: string; // e.g. "4. Ba4"
  openingLabel: string | null; // e.g. "Morphy Defense" -- null out of book
  candidates: readonly Player[];
  currentPlayers: readonly Player[];
  sport: SportConfig;
  contest: ContestConfig;
  reasons?: ReadonlyMap<string, string>; // player id -> why greyed out; absent means feasible
  onPick: (player: Player) => void;
  onCancel: () => void;
  error: string | null;
}

export default function PickPanel({
  piece,
  moveLabel,
  openingLabel,
  candidates,
  currentPlayers,
  sport,
  contest,
  reasons = NO_REASONS,
  onPick,
  onCancel,
  error,
}: Props) {
  const sorted = useMemo(() => [...candidates].sort((a, b) => b.proj - a.proj), [candidates]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = sorted.find((p) => p.id === selectedId) ?? null;
  const selectedReason = selected !== null ? (reasons.get(selected.id) ?? null) : null;
  const tier = contest.fieldTier();
  const band = pieceBandLabel(piece, sport);

  const after = useMemo(
    () => (selected === null ? null : sideStats([...currentPlayers, selected], sport, contest)),
    [selected, currentPlayers, sport, contest],
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
            <p className="pick-subtitle">
              {band !== null && `${band} · `}
              sorted by projection
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

        {candidates.length === 0 ? (
          <p className="hint">No eligible {PIECE_LABEL[piece]} players available for that move.</p>
        ) : (
          <>
            <div className="pick-column-header">
              <span>Player</span>
              <span>Salary</span>
              <span>Proj</span>
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
                      {player.name} · {player.team}
                      {reason !== null && <span className="pick-row-reason"> · {reason}</span>}
                    </span>
                    <span>${player.salary.toLocaleString()}</span>
                    <span>{player.proj.toFixed(1)}</span>
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
