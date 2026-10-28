// Task 32: the first setup screen, replacing the Vite default page.
// Originally three steps (upload projections, pick a contest, choose King
// mode); Task 35 removes the upload step from the player flow entirely --
// players now read a projections slate the admin already saved (see
// AdminScreen.tsx, projectionsStore.ts). Task 38c merges the remaining
// contest/King-mode step and the opening-setup step (formerly
// OpeningSetupScreen, Task 34) into one SetupScreen, matching design/'s
// combined mockup -- there's no "Continue" step left in between; SetupScreen
// hands back everything a build needs (preset, King mode, both Kings, and
// the chosen opening) in one go. UI-only: every parse/classify call below
// is the engine's own function from web/src/engine, never reimplemented
// here.
import { useEffect, useState } from "react";
import "./App.css";
import AdminScreen from "./AdminScreen";
import { PRESETS, refreshPresets } from "./appData";
import BuildScreen from "./BuildScreen";
import { loadEtrCsv } from "./engine/loaders";
import type { KingMode } from "./engine/models";
import type { Player } from "./engine/models";
import { getSavedProjectionsCsv } from "./projectionsStore";
import type { ChosenSetup } from "./SetupScreen";
import SetupScreen from "./SetupScreen";
import ThemeToggle from "./ThemeToggle";

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
  const [screen, setScreen] = useState<"setup" | "build">("setup");
  const [chosenSetup, setChosenSetup] = useState<ChosenSetup | null>(null);
  const [players, setPlayers] = useState<Player[] | null>(() => loadSavedPlayers());
  // Task 40: "Start again" (same contest + King mode, back to the opening
  // choice) carries these into SetupScreen's own initial state; "New
  // contest" (full setup) leaves this null, same as a first-ever visit.
  const [setupDefaults, setSetupDefaults] = useState<{ presetIndex: number; kingMode: KingMode } | null>(null);
  // PRESETS is now a dynamic list (an admin contest upload, or
  // contests.json) that can change mid-session -- chosenSetup.preset is
  // matched back by NAME (not object identity: refreshPresets() always
  // builds fresh ContestPreset objects, even when nothing actually
  // changed) against the CURRENT PRESETS. A contest whose name no longer
  // appears there falls back to the first contest, with a notice shown
  // on SetupScreen.
  const [contestNotice, setContestNotice] = useState<string | null>(null);

  function startAgain(): void {
    if (chosenSetup !== null) {
      const matchIndex = PRESETS.findIndex((p) => p.name === chosenSetup.preset.name);
      if (matchIndex === -1) {
        setSetupDefaults({ presetIndex: 0, kingMode: chosenSetup.kingMode });
        setContestNotice(`"${chosenSetup.preset.name}" is no longer available -- showing "${PRESETS[0].name}" instead.`);
      } else {
        setSetupDefaults({ presetIndex: matchIndex, kingMode: chosenSetup.kingMode });
        setContestNotice(null);
      }
    }
    setChosenSetup(null);
    setScreen("setup");
  }

  function newContest(): void {
    setSetupDefaults(null);
    setContestNotice(null);
    setChosenSetup(null);
    setScreen("setup");
  }

  useEffect(() => {
    function onHashChange() {
      const admin = window.location.hash === "#/admin";
      setIsAdminRoute(admin);
      // Re-read the saved slate on the way back from #/admin -- picks up
      // an upload or a clear made there, within this same mounted App
      // instance (not just across page reloads). PRESETS is refreshed the
      // same way, for the same reason.
      if (!admin) {
        setPlayers(loadSavedPlayers());
        refreshPresets();
      }
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (isAdminRoute) {
    return <AdminScreen />;
  }

  if (players === null) {
    return (
      <main className="setup">
        <header className="app-header">
          <ThemeToggle />
        </header>
        <h1>Chess DFS</h1>
        <p className="status">No slate loaded yet.</p>
      </main>
    );
  }

  if (screen === "build" && chosenSetup !== null) {
    return (
      <BuildScreen
        preset={chosenSetup.preset}
        players={players}
        kingMode={chosenSetup.kingMode}
        whiteKing={chosenSetup.whiteKing}
        blackKing={chosenSetup.blackKing}
        chosenOpening={chosenSetup.opening}
        buildSeed={chosenSetup.buildSeed}
        onStartAgain={startAgain}
        onNewContest={newContest}
      />
    );
  }

  return (
    <SetupScreen
      players={players}
      initialPresetIndex={setupDefaults?.presetIndex}
      initialKingMode={setupDefaults?.kingMode}
      contestNotice={contestNotice}
      onChoose={(chosen) => {
        setChosenSetup(chosen);
        setScreen("build");
      }}
    />
  );
}

export default App;
