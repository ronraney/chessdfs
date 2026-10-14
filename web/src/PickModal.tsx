// Task 37: the build screen's White-pick modal -- opened for each of the
// template's White moves, listing every eligible player for the moved
// piece (buildStats.eligiblePlayers: unlocked + classify match, same as
// dfs_chess/cli.py's _eligible_sorted; not pre-filtered by legality --
// see that function's own comment). Sortable by any column; default sort
// (by projection) is applied by the caller via the `candidates` prop order.
import { useMemo, useState } from "react";
import "./PickModal.css";
import type { ContestConfig } from "./engine/config";
import type { Piece, Player } from "./engine/models";
import type { SportConfig } from "./engine/sport";
import { sideStats } from "./buildStats";

const PIECE_LABEL: Record<Piece, string> = {
  KING: "King",
  QUEEN: "Queen",
  ROOK: "Rook",
  BISHOP: "Bishop",
  KNIGHT: "Knight",
  PAWN: "Pawn",
};

type SortKey = "name" | "team" | "salary" | "proj" | "ownership" | "remaining";

interface Props {
  piece: Piece;
  candidates: readonly Player[];
  currentPlayers: readonly Player[];
  sport: SportConfig;
  contest: ContestConfig;
  onPick: (player: Player) => void;
  error: string | null;
}

export default function PickModal({ piece, candidates, currentPlayers, sport, contest, onPick, error }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("proj");
  const [sortAsc, setSortAsc] = useState(false);
  const tier = contest.fieldTier();

  const rows = useMemo(
    () =>
      candidates.map((player) => ({
        player,
        after: sideStats([...currentPlayers, player], sport, contest),
      })),
    [candidates, currentPlayers, sport, contest],
  );

  const sorted = useMemo(() => {
    const byKey: Record<SortKey, (row: (typeof rows)[number]) => number | string> = {
      name: (r) => r.player.name,
      team: (r) => r.player.team,
      salary: (r) => r.player.salary,
      proj: (r) => r.player.proj,
      ownership: (r) => r.player.ownFor(tier),
      remaining: (r) => r.after.salaryRemaining,
    };
    const key = byKey[sortKey];
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = key(a);
      const bv = key(b);
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : av - (bv as number);
      return sortAsc ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortAsc, tier]);

  function sortBy(key: SortKey): void {
    if (key === sortKey) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(key === "name" || key === "team");
    }
  }

  function headerButton(key: SortKey, label: string) {
    const active = key === sortKey;
    return (
      <button type="button" className={active ? "sort-header active" : "sort-header"} onClick={() => sortBy(key)}>
        {label}
        {active ? (sortAsc ? " ▲" : " ▼") : ""}
      </button>
    );
  }

  return (
    <div className="pick-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Pick a ${PIECE_LABEL[piece]}`}>
      <div className="pick-modal">
        <h2>Pick a {PIECE_LABEL[piece]}</h2>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {candidates.length === 0 ? (
          <p className="hint">No eligible {PIECE_LABEL[piece]} players available for that move.</p>
        ) : (
          <div className="pick-table-wrap">
            <table className="pick-table">
              <thead>
                <tr>
                  <th>{headerButton("name", "Name")}</th>
                  <th>{headerButton("team", "Team")}</th>
                  <th>{headerButton("salary", "Salary")}</th>
                  <th>{headerButton("proj", "Proj")}</th>
                  <th>{headerButton("ownership", "Own")}</th>
                  <th>{headerButton("remaining", "After pick: salary rem")}</th>
                  <th>Avg/open slot</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.map(({ player, after }) => (
                  <tr key={player.id}>
                    <td>{player.name}</td>
                    <td>{player.team}</td>
                    <td>${player.salary.toLocaleString()}</td>
                    <td>{player.proj.toFixed(1)}</td>
                    <td>{(player.ownFor(tier) * 100).toFixed(1)}%</td>
                    <td>${after.salaryRemaining.toLocaleString()}</td>
                    <td>${after.avgRemainingPerOpenSlot.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    <td>
                      <button type="button" onClick={() => onPick(player)}>
                        Pick
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
