// Task 35: hidden admin screen at #/admin (see App.tsx's hash check -- no
// link to this screen exists anywhere else in the app). Lets the admin
// upload the projections CSV once so every player visiting the normal flow
// reads a saved slate instead of uploading one themselves (see
// projectionsStore.ts). The password gate below is enforced entirely in
// client-side JS against a value baked into the built bundle
// (VITE_ADMIN_PASSWORD) -- it keeps the screen out of casual reach, not a
// real access control; anyone reading the shipped JS can recover the
// password or skip the check outright.
import { useState, type ChangeEvent, type FormEvent } from "react";
import "./App.css";
import { NFL } from "./appData";
import { SlateValidationError, validateSlateCsv } from "./engine/loaders";
import type { Player } from "./engine/models";
import { clearProjectionsCsv, getSavedProjectionsCsv, saveProjectionsCsv } from "./projectionsStore";
import ThemeToggle from "./ThemeToggle";

// Blob#text() isn't implemented by jsdom (the test environment), so
// FileReader is used instead -- same reasoning as the old App.tsx upload.
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

interface SlateSummary {
  playerCount: number;
  byPosition: readonly (readonly [string, number])[];
  idColumn: string;
}

// Task 43: "by position" is a plain tally of each player's own first
// listed position (QB/RB/WR/TE/DST) -- independent of validateSlateCsv's
// own roster-SLOT feasibility check (RosterSlot.positions, e.g. FLEX's
// RB/WR/TE), since this is just describing what's in the file, not
// re-deriving DK slot eligibility.
function countByPosition(players: readonly Player[]): readonly (readonly [string, number])[] {
  const counts = new Map<string, number>();
  for (const p of players) {
    const pos = p.positions[0];
    counts.set(pos, (counts.get(pos) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function summarizeSavedSlate(): SlateSummary | null {
  const csv = getSavedProjectionsCsv();
  if (csv === null) return null;
  try {
    const { players, idColumn } = validateSlateCsv(csv, NFL);
    return { playerCount: players.length, byPosition: countByPosition(players), idColumn };
  } catch {
    return null;
  }
}

function AdminScreen() {
  const [authed, setAuthed] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState(false);
  const [slate, setSlate] = useState<SlateSummary | null>(() => summarizeSavedSlate());
  const [uploadError, setUploadError] = useState<string | null>(null);

  function handleSubmitPassword(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (passwordInput === import.meta.env.VITE_ADMIN_PASSWORD) {
      setAuthed(true);
      setPasswordError(false);
    } else {
      setPasswordError(true);
    }
  }

  // Task 43: a rejected upload keeps whatever slate was already saved --
  // saveProjectionsCsv/setSlate only run on the success path below, same
  // as before; validateSlateCsv just replaces the old "parses to >0 rows"
  // check with real rigor (ID column present and complete, no duplicate
  // IDs, every required column present, enough players for every roster
  // slot), and its own SlateValidationError message (naming exactly what's
  // wrong) is shown as-is instead of a generic fallback.
  async function handleUpload(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      const { players, idColumn } = validateSlateCsv(text, NFL);
      saveProjectionsCsv(text);
      setSlate({ playerCount: players.length, byPosition: countByPosition(players), idColumn });
      setUploadError(null);
    } catch (e) {
      setUploadError(
        e instanceof SlateValidationError ? e.message : "Couldn't read that file as a projections CSV -- check it's a valid DK projections export.",
      );
    }
  }

  function handleClear(): void {
    clearProjectionsCsv();
    setSlate(null);
    setUploadError(null);
  }

  if (!authed) {
    return (
      <main className="setup">
        <header className="app-header">
          <ThemeToggle />
        </header>
        <h1>Admin</h1>
        <form className="step" onSubmit={handleSubmitPassword}>
          <label htmlFor="admin-password">Password</label>
          <input
            id="admin-password"
            type="password"
            value={passwordInput}
            onChange={(event) => setPasswordInput(event.target.value)}
          />
          <button type="submit" className="continue">
            Log in
          </button>
          {passwordError && (
            <p className="error" role="alert">
              Wrong password.
            </p>
          )}
        </form>
      </main>
    );
  }

  return (
    <main className="setup">
      <header className="app-header">
        <ThemeToggle />
      </header>
      <h1>Admin</h1>
      <section className="step">
        <h2>Projections</h2>
        <label className="file-label" htmlFor="admin-projections-csv">
          Projections CSV
        </label>
        <input id="admin-projections-csv" type="file" accept=".csv" onChange={handleUpload} />
        {slate !== null && (
          <div className="status">
            <p>
              {slate.playerCount} players loaded · ID column: {slate.idColumn}
            </p>
            <p>{slate.byPosition.map(([pos, count]) => `${pos}: ${count}`).join(" · ")}</p>
          </div>
        )}
        {slate === null && uploadError === null && <p className="status">No projections saved yet.</p>}
        {uploadError !== null && (
          <p className="error" role="alert">
            {uploadError}
          </p>
        )}
        <button type="button" className="continue" onClick={handleClear}>
          Clear projections
        </button>
      </section>
    </main>
  );
}

export default AdminScreen;
