// Task 32: the first setup screen, replacing the Vite default page.
// Originally three steps (upload projections, pick a contest, choose King
// mode); Task 35 removes the upload step from the player flow entirely --
// players now read a projections slate the admin already saved (see
// AdminScreen.tsx, projectionsStore.ts), so the flow is contest -> King
// mode -> opening. Task 34 adds the opening-setup screen after it
// (OpeningSetupScreen) and a placeholder build screen after THAT. UI-only:
// every parse/classify/rank/tier call below is the engine's own function
// from web/src/engine, never reimplemented here.
import { useEffect, useMemo, useState } from "react";
import "./App.css";
import AdminScreen from "./AdminScreen";
import { NFL, PRESETS, LAST_RANK } from "./appData";
import { loadEtrCsv } from "./engine/loaders";
import { KingMode, Piece, type Player } from "./engine/models";
import type { ChosenOpening } from "./OpeningSetupScreen";
import OpeningSetupScreen from "./OpeningSetupScreen";
import { classify } from "./engine/pieces";
import { getSavedProjectionsCsv } from "./projectionsStore";

function loadSavedPlayers(): Player[] | null {
  const csv = getSavedProjectionsCsv();
  if (csv === null) return null;
  try {
    const parsed = loadEtrCsv(csv);
    return parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function App() {
  const [isAdminRoute, setIsAdminRoute] = useState(() => window.location.hash === "#/admin");
  const [screen, setScreen] = useState<"setup" | "opening" | "build">("setup");
  const [chosenOpening, setChosenOpening] = useState<ChosenOpening | null>(null);
  const [players, setPlayers] = useState<Player[] | null>(() => loadSavedPlayers());
  const [presetIndex, setPresetIndex] = useState<number | null>(null);
  const [kingMode, setKingMode] = useState<KingMode>(KingMode.EMERGE);
  const [whiteKingId, setWhiteKingId] = useState<string | null>(null);

  useEffect(() => {
    function onHashChange() {
      const admin = window.location.hash === "#/admin";
      setIsAdminRoute(admin);
      // Re-read the saved slate on the way back from #/admin -- picks up
      // an upload or a clear made there, within this same mounted App
      // instance (not just across page reloads).
      if (!admin) {
        setPlayers(loadSavedPlayers());
      }
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const qbs = useMemo(
    () => (players ?? []).filter((p) => classify(p, NFL) === Piece.KING).sort((a, b) => b.proj - a.proj),
    [players],
  );
  const whiteKing = qbs.find((p) => p.id === whiteKingId) ?? null;
  // cli.py's `_prompt_and_place_kings`: Black's QB is the highest-projection
  // QB other than White's own pick -- not a user choice.
  const blackKing = whiteKing ? qbs.find((p) => p.id !== whiteKing.id) ?? null : null;

  const selectedPreset = presetIndex !== null ? PRESETS[presetIndex] : null;

  const canContinue =
    selectedPreset !== null && (kingMode === KingMode.EMERGE || (kingMode === KingMode.PLACED && whiteKing !== null));

  if (isAdminRoute) {
    return <AdminScreen />;
  }

  if (players === null) {
    return (
      <main className="setup">
        <h1>Chess DFS</h1>
        <p className="status">No slate loaded yet.</p>
      </main>
    );
  }

  if (screen === "opening" && selectedPreset !== null) {
    return (
      <OpeningSetupScreen
        preset={selectedPreset}
        onBack={() => setScreen("setup")}
        onChoose={(chosen) => {
          setChosenOpening(chosen);
          setScreen("build");
        }}
      />
    );
  }

  if (screen === "build" && selectedPreset !== null && chosenOpening !== null) {
    return (
      <main className="setup">
        <h1>Chess DFS</h1>
        <h2>Build — coming next</h2>
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
        <p>Opening: {chosenOpening.kind === "own" ? "Your own opening" : chosenOpening.line.name}</p>
        <button type="button" onClick={() => setScreen("opening")}>
          Back
        </button>
      </main>
    );
  }

  return (
    <main className="setup">
      <h1>Chess DFS</h1>

      <section className="step">
        <h2>1. Pick a contest</h2>
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
        <h2>2. King mode</h2>
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
            {qbs.length === 0 ? (
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

      <button type="button" className="continue" disabled={!canContinue} onClick={() => setScreen("opening")}>
        Continue
      </button>
    </main>
  );
}

export default App;
