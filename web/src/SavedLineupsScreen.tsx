// "Save lineup" task: the setup screen's own "Saved lineups" link lands
// here -- a list of everything savedLineupsStore.ts has (newest first),
// each row showing date/contest/opening/projection/salary used with its
// own Copy (same tab-separated text format as the Finish screen's own
// "Copy lineup" -- see lineupText.ts) and Delete (confirm first). "Export
// all" downloads the whole store as one JSON backup file; "Import" loads
// one back in, skipping anything already saved (by content, not id -- see
// savedLineupsStore.importLineupsJson's own comment).
//
// Reuses several of SetupScreen.css's and BuildScreen.css's own class
// names (setup-header/setup-wordmark/finish-core/finish-stats/...) rather
// than re-declaring the same look -- plain global stylesheets, not CSS
// Modules, and every screen's own .tsx is already statically imported by
// App.tsx, so those styles are always loaded regardless of which screen
// is currently showing. New, screen-specific rules (the row list, the
// toolbar, the hidden file input) live in SavedLineupsScreen.css.
import { type ChangeEvent, useRef, useState } from "react";
import "./SavedLineupsScreen.css";
import { KingMode } from "./engine/models";
import { formatLineupText, formatMoveList, type LineupTextRow } from "./lineupText";
import { deleteLineup, exportLineupsJson, getSavedLineups, importLineupsJson, type SavedLineup } from "./savedLineupsStore";
import ThemeToggle from "./ThemeToggle";

interface Props {
  onBack: () => void;
}

// Blob#text() isn't implemented by jsdom (the test environment) -- same
// FileReader-based workaround AdminScreen.tsx's own readFileAsText uses
// for the same reason.
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function kingModeLabel(kingMode: KingMode): string {
  return kingMode === KingMode.EMERGE ? "Let him emerge" : "Place your King now";
}

function toLineupTextRows(lineup: SavedLineup): LineupTextRow[] {
  return lineup.players.map((p) => ({ slot: p.slot, label: p.piece, name: p.name, pos: p.pos, team: p.team, salary: p.salary }));
}

// Exactly the Finish screen's own lineupText() output, built from the
// saved (plain-data) record instead of live Player/SideStats objects --
// see lineupText.ts's own header comment for why the formatting itself is
// shared rather than reimplemented here.
function lineupCopyText(lineup: SavedLineup): string {
  return formatLineupText(toLineupTextRows(lineup), {
    salaryUsed: lineup.totals.salaryUsed,
    salaryRemaining: lineup.totals.salaryRemaining,
    projection: lineup.totals.projection,
    ownership: lineup.totals.ownership,
    opening: lineup.finalOpening,
    moves: formatMoveList(lineup.moves),
  });
}

function downloadJsonFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function formatRoiPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export default function SavedLineupsScreen({ onBack }: Props) {
  const [lineups, setLineups] = useState<SavedLineup[]>(() => getSavedLineups());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function refresh(): void {
    setLineups(getSavedLineups());
  }

  async function copyRow(lineup: SavedLineup): Promise<void> {
    await navigator.clipboard.writeText(lineupCopyText(lineup));
    setCopiedId(lineup.id);
    if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopiedId(null), 1500);
  }

  function deleteRow(lineup: SavedLineup): void {
    if (!window.confirm(`Delete the saved lineup for "${lineup.contestName}"?`)) return;
    deleteLineup(lineup.id);
    if (selectedId === lineup.id) setSelectedId(null);
    refresh();
  }

  function exportAll(): void {
    downloadJsonFile(`chess-dfs-saved-lineups-${new Date().toISOString().slice(0, 10)}.json`, exportLineupsJson());
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = ""; // lets the very same file be re-chosen later
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      const result = importLineupsJson(text);
      setImportStatus(`Imported ${result.imported}, skipped ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"}.`);
      refresh();
    } catch (e) {
      setImportStatus(e instanceof Error ? e.message : "Import failed.");
    }
  }

  const selected = selectedId !== null ? lineups.find((lineup) => lineup.id === selectedId) ?? null : null;

  return (
    <main className="saved-screen">
      <header className="setup-header">
        <div className="setup-wordmark-group">
          <span className="setup-wordmark">Chess DFS</span>
          <span className="setup-tagline">Saved lineups</span>
        </div>
        <div className="setup-header-actions">
          <button type="button" className="saved-lineups-link" onClick={onBack}>
            Back
          </button>
          <ThemeToggle />
        </div>
      </header>

      {selected !== null ? (
        <LineupDetail lineup={selected} onBack={() => setSelectedId(null)} />
      ) : (
        <>
          <div className="saved-toolbar">
            <button type="button" disabled={lineups.length === 0} onClick={exportAll}>
              Export all
            </button>
            <button type="button" onClick={() => fileInputRef.current?.click()}>
              Import
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              className="saved-import-input"
              aria-label="Import saved lineups"
              onChange={(event) => void handleImport(event)}
            />
          </div>
          {importStatus !== null && (
            <p className="status" role="status">
              {importStatus}
            </p>
          )}

          {lineups.length === 0 ? (
            <p className="hint">No saved lineups yet.</p>
          ) : (
            <ul className="saved-list">
              {lineups.map((lineup) => (
                <li key={lineup.id} className="saved-row">
                  <button type="button" className="saved-row-main" onClick={() => setSelectedId(lineup.id)}>
                    <span className="saved-row-date">{new Date(lineup.savedAt).toLocaleString()}</span>
                    <span className="saved-row-contest">{lineup.contestName}</span>
                    <span className="saved-row-opening">{lineup.finalOpening}</span>
                    <span className="saved-row-projection">{lineup.totals.projection.toFixed(1)} pts</span>
                    <span className="saved-row-salary">${lineup.totals.salaryUsed.toLocaleString()}</span>
                  </button>
                  <div className="saved-row-actions">
                    <button type="button" onClick={() => void copyRow(lineup)}>
                      {copiedId === lineup.id ? "Copied" : "Copy"}
                    </button>
                    <button type="button" onClick={() => deleteRow(lineup)}>
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

function LineupDetail({ lineup, onBack }: { lineup: SavedLineup; onBack: () => void }) {
  return (
    <div className="finish-card saved-detail">
      <button type="button" className="saved-detail-back" onClick={onBack}>
        ← Back to list
      </button>
      <p className="finish-ended-line">
        {new Date(lineup.savedAt).toLocaleString()} · {lineup.contestName}
      </p>
      <p className="finish-opening">
        <span className="side-eyebrow">Chosen:</span> {lineup.chosenOpening}
      </p>
      <p className="finish-opening">
        <span className="side-eyebrow">Final position:</span> {lineup.finalOpening}
      </p>
      <p className="finish-opening">
        <span className="side-eyebrow">King mode:</span> {kingModeLabel(lineup.kingMode)}
      </p>

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
            {lineup.players.map((p, i) => (
              <tr key={`${p.name}-${i}`}>
                <td>{p.slot}</td>
                <td>{p.piece}</td>
                <td>{p.name}</td>
                <td>{p.pos}</td>
                <td>{p.team}</td>
                <td>${p.salary.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="finish-stats">
        <p>
          Salary used: <strong>${lineup.totals.salaryUsed.toLocaleString()}</strong>
        </p>
        <p>
          Salary remaining: <strong>${lineup.totals.salaryRemaining.toLocaleString()}</strong>
        </p>
        <p>
          Projection: <strong>{lineup.totals.projection.toFixed(1)} pts</strong>
        </p>
        <p>
          Ownership: <strong>{formatRoiPct(lineup.totals.ownership)}</strong>
        </p>
        {lineup.whiteSim !== null && (
          <p>
            Sim results{lineup.whiteSim.isBestFinish ? " (best finish)" : ""}: <strong>{formatRoiPct(lineup.whiteSim.cashRate)}</strong>
            <span className="finish-stat-sub">
              {" "}
              ROI without luckiest 1% {formatRoiPct(lineup.whiteSim.bottom99Roi)} · ROI in best 1% of games{" "}
              {formatRoiPct(lineup.whiteSim.top1PctScoreRoi)}
            </span>
          </p>
        )}
        {lineup.blackSim !== null && (
          <p>
            Field sim results{lineup.blackSim.isBestFinish ? " (best finish)" : ""}: <strong>{formatRoiPct(lineup.blackSim.cashRate)}</strong>
            <span className="finish-stat-sub">
              {" "}
              ROI without luckiest 1% {formatRoiPct(lineup.blackSim.bottom99Roi)} · ROI in best 1% of games{" "}
              {formatRoiPct(lineup.blackSim.top1PctScoreRoi)}
            </span>
          </p>
        )}
      </div>

      <p className="finish-opening">
        <span className="side-eyebrow">Moves:</span> {formatMoveList(lineup.moves)}
      </p>
    </div>
  );
}
