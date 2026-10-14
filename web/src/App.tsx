// Task 32: the first setup screen, replacing the Vite default page. Three
// steps (upload projections, pick a contest, choose King mode) feed a
// single "Continue" that's enabled once each is resolved, leading to a
// placeholder screen for the opening-setup screen a future task builds.
// UI-only: every parse/classify/rank/tier call below is the engine's own
// function from web/src/engine, never reimplemented here.
import { useMemo, useState, type ChangeEvent } from "react";
import "./App.css";
import contestsRaw from "./data/config/contests.json";
import lineStatsRaw from "./data/openings/line_stats.json?raw";
import nflConfig from "./data/config/sports/nfl.json";
import { loadContestPresets, type ContestPreset, type RawContestPreset } from "./engine/config";
import { loadEtrCsv, loadLineStats } from "./engine/loaders";
import { KingMode, Piece, type Player } from "./engine/models";
import { rankFamilies } from "./engine/openings";
import { classify } from "./engine/pieces";
import { loadSportConfig } from "./engine/sport";

// Blob#text() isn't implemented by jsdom (the RTL test environment), so
// FileReader is used instead -- universally supported, including there.
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

const NFL = loadSportConfig(nflConfig);
const PRESETS: ContestPreset[] = loadContestPresets(contestsRaw as RawContestPreset[]);
// cli.py's own "Contest tier" readout (_run_one_build) resolves this from
// the same rank_families(line_stats) count -- not a fixed number.
const LAST_RANK = rankFamilies(loadLineStats(lineStatsRaw)).length;

function App() {
  const [screen, setScreen] = useState<"setup" | "placeholder">("setup");
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [presetIndex, setPresetIndex] = useState<number | null>(null);
  const [kingMode, setKingMode] = useState<KingMode>(KingMode.EMERGE);
  const [whiteKingId, setWhiteKingId] = useState<string | null>(null);

  const qbs = useMemo(
    () => (players ?? []).filter((p) => classify(p, NFL) === Piece.KING).sort((a, b) => b.proj - a.proj),
    [players],
  );
  const whiteKing = qbs.find((p) => p.id === whiteKingId) ?? null;
  // cli.py's `_prompt_and_place_kings`: Black's QB is the highest-projection
  // QB other than White's own pick -- not a user choice.
  const blackKing = whiteKing ? qbs.find((p) => p.id !== whiteKing.id) ?? null : null;

  const selectedPreset = presetIndex !== null ? PRESETS[presetIndex] : null;

  async function handleUpload(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      const parsed = loadEtrCsv(text);
      if (parsed.length === 0) {
        throw new Error("no players found in that file");
      }
      setPlayers(parsed);
      setWhiteKingId(null);
      setUploadError(null);
    } catch {
      setPlayers(null);
      setUploadError("Couldn't read that file as a projections CSV -- check it's a valid DK projections export.");
    }
  }

  const canContinue =
    players !== null &&
    selectedPreset !== null &&
    (kingMode === KingMode.EMERGE || (kingMode === KingMode.PLACED && whiteKing !== null));

  if (screen === "placeholder" && selectedPreset !== null) {
    return (
      <main className="setup">
        <h1>Chess DFS</h1>
        <h2>Opening setup — coming next</h2>
        <p>
          Contest: {selectedPreset.name} ({selectedPreset.contest.fieldSize.toLocaleString()} entries, $
          {selectedPreset.buyIn.toLocaleString()} buy-in)
        </p>
        <p>
          King mode: {kingMode === KingMode.EMERGE ? "Let him emerge" : "Place your King now"}
          {kingMode === KingMode.PLACED && whiteKing && blackKing && (
            <>
              {" "}
              — White: {whiteKing.name}, Black: {blackKing.name}
            </>
          )}
        </p>
        <button type="button" onClick={() => setScreen("setup")}>
          Back
        </button>
      </main>
    );
  }

  return (
    <main className="setup">
      <h1>Chess DFS</h1>

      <section className="step">
        <h2>1. Upload your projections</h2>
        <label className="file-label" htmlFor="projections-csv">
          Projections CSV
        </label>
        <input id="projections-csv" type="file" accept=".csv" onChange={handleUpload} />
        {players !== null && <p className="status">{players.length} players loaded</p>}
        {uploadError !== null && (
          <p className="error" role="alert">
            {uploadError}
          </p>
        )}
      </section>

      <section className="step">
        <h2>2. Pick a contest</h2>
        <ul className="presets">
          {PRESETS.map((preset, index) => {
            const tier = preset.contest.entryTier(LAST_RANK);
            const selected = presetIndex === index;
            return (
              <li key={preset.name}>
                <button
                  type="button"
                  className={selected ? "preset selected" : "preset"}
                  aria-pressed={selected}
                  onClick={() => setPresetIndex(index)}
                >
                  <span className="preset-name">{preset.name}</span>
                  <span className="preset-detail">
                    {preset.contest.fieldSize.toLocaleString()} entries · ${preset.buyIn.toLocaleString()} buy-in ·{" "}
                    {tier.name} tier
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="step">
        <h2>3. King mode</h2>
        <label className="radio">
          <input
            type="radio"
            name="king-mode"
            checked={kingMode === KingMode.EMERGE}
            onChange={() => setKingMode(KingMode.EMERGE)}
          />
          Let him emerge
        </label>
        <label className="radio">
          <input
            type="radio"
            name="king-mode"
            checked={kingMode === KingMode.PLACED}
            onChange={() => setKingMode(KingMode.PLACED)}
          />
          Place your King now
        </label>

        {kingMode === KingMode.PLACED && (
          <div className="qb-picker">
            {players === null ? (
              <p className="hint">Upload your projections above to pick a QB.</p>
            ) : qbs.length === 0 ? (
              <p className="hint">No QBs found in that file.</p>
            ) : (
              <>
                <label htmlFor="white-qb">White&apos;s QB</label>
                <select
                  id="white-qb"
                  value={whiteKingId ?? ""}
                  onChange={(event) => setWhiteKingId(event.target.value || null)}
                >
                  <option value="">Choose a QB…</option>
                  {qbs.map((qb) => (
                    <option key={qb.id} value={qb.id}>
                      {qb.name} — ${qb.salary.toLocaleString()} — {qb.proj.toFixed(1)} pts
                    </option>
                  ))}
                </select>
                {blackKing && <p className="hint">Black&apos;s QB: {blackKing.name}</p>}
              </>
            )}
          </div>
        )}
      </section>

      <button type="button" className="continue" disabled={!canContinue} onClick={() => setScreen("placeholder")}>
        Continue
      </button>
    </main>
  );
}

export default App;
