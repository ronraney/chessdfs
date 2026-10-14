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
import BuildScreen from "./BuildScreen";
import { loadEtrCsv } from "./engine/loaders";
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
      />
    );
  }

  return (
    <SetupScreen
      players={players}
      onChoose={(chosen) => {
        setChosenSetup(chosen);
        setScreen("build");
      }}
    />
  );
}

export default App;
