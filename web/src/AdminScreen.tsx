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
import { loadEtrCsv } from "./engine/loaders";
import { clearProjectionsCsv, getSavedProjectionsCsv, saveProjectionsCsv } from "./projectionsStore";

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

function countSavedPlayers(): number | null {
  const csv = getSavedProjectionsCsv();
  if (csv === null) return null;
  try {
    return loadEtrCsv(csv).length;
  } catch {
    return null;
  }
}

function AdminScreen() {
  const [authed, setAuthed] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState(false);
  const [playerCount, setPlayerCount] = useState<number | null>(() => countSavedPlayers());
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

  async function handleUpload(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      const parsed = loadEtrCsv(text);
      if (parsed.length === 0) {
        throw new Error("no players found in that file");
      }
      saveProjectionsCsv(text);
      setPlayerCount(parsed.length);
      setUploadError(null);
    } catch {
      setUploadError("Couldn't read that file as a projections CSV -- check it's a valid DK projections export.");
    }
  }

  function handleClear(): void {
    clearProjectionsCsv();
    setPlayerCount(null);
    setUploadError(null);
  }

  if (!authed) {
    return (
      <main className="setup">
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
      <h1>Admin</h1>
      <section className="step">
        <h2>Projections</h2>
        <label className="file-label" htmlFor="admin-projections-csv">
          Projections CSV
        </label>
        <input id="admin-projections-csv" type="file" accept=".csv" onChange={handleUpload} />
        {playerCount !== null && <p className="status">{playerCount} players loaded</p>}
        {playerCount === null && uploadError === null && <p className="status">No projections saved yet.</p>}
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
