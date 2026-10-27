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
import { buildAndCacheFields, BUILD_TIERS, TARGET_DISTINCT_LINEUPS } from "./buildFieldCache";
import { SlateValidationError, validateSlateCsv } from "./engine/loaders";
import type { FieldTier, Player } from "./engine/models";
import { VegasValidationError, validateVegasCsv } from "./engine/sim/vegasCsv";
import { clearFieldCache, getCachedFieldIds, slateSignature } from "./fieldCacheStore";
import { clearProjectionsCsv, getSavedProjectionsCsv, saveProjectionsCsv } from "./projectionsStore";
import ThemeToggle from "./ThemeToggle";
import { clearVegasCsv, getSavedVegasCsv, saveVegasCsv } from "./vegasStore";

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

// Re-parses the saved projections CSV, same "run fresh wherever read"
// reasoning as projectionsStore's own comment -- null if nothing's saved
// or it no longer validates (e.g. a since-changed sport config). The
// Vegas upload's team-matching needs the actual players, not just
// summarizeSavedSlate's own display-only tally.
function getSavedSlatePlayers(): Player[] | null {
  const csv = getSavedProjectionsCsv();
  if (csv === null) return null;
  try {
    return validateSlateCsv(csv, NFL).players;
  } catch {
    return null;
  }
}

// Every team on the loaded slate -- the union of `team` and `opp` across
// every player, not just `team` alone, so a team with zero rostered
// players on this particular slate (shouldn't happen for a real NFL
// week, but not assumed) still counts as "on the slate" via its
// opponents' own `opp` values.
function slateTeams(players: readonly Player[]): Set<string> {
  const teams = new Set<string>();
  for (const p of players) {
    teams.add(p.team);
    teams.add(p.opp);
  }
  return teams;
}

interface VegasSummary {
  teamCount: number;
  skippedTeams: readonly string[];
}

// Null whenever there's no saved projections slate to validate team
// coverage against -- the Vegas upload itself is gated on this (see the
// "Upload projections first" message below). Also null if the saved
// Vegas CSV no longer validates against the CURRENT slate (e.g. a slate
// team now has no Vegas row at all -- a hard error since the behavior-
// reversal task) -- same catch-and-null pattern this function already
// had for every other validation failure, not new to this change.
function summarizeSavedVegas(players: readonly Player[] | null): VegasSummary | null {
  if (players === null) return null;
  const csv = getSavedVegasCsv();
  if (csv === null) return null;
  try {
    const { vegas, skippedTeams } = validateVegasCsv(csv, slateTeams(players));
    return { teamCount: vegas.size, skippedTeams };
  } catch {
    return null;
  }
}

// How many lineups are cached for each tier, against the CURRENT saved
// slate's own signature -- {} (nothing shown as cached) whenever there's
// no slate loaded at all, same "null in, null/empty out" shape as the
// other summarize* helpers above.
// `accepted` is every stored attempt (duplicates included -- that
// repetition IS each combo's simulated frequency, see field.ts's own
// comment); `distinct` re-derives the DIFFERENT-combos count from the
// same stored ids (no separate storage needed) so the status line can
// report this task's own target/shortfall without a cache-format change.
interface FieldCacheTierStatus {
  accepted: number;
  distinct: number;
}

function computeFieldCacheStatus(csv: string | null): Partial<Record<FieldTier, FieldCacheTierStatus>> {
  if (csv === null) return {};
  const signature = slateSignature(csv);
  const status: Partial<Record<FieldTier, FieldCacheTierStatus>> = {};
  for (const tier of BUILD_TIERS) {
    const ids = getCachedFieldIds(signature, tier);
    if (ids !== null) {
      const distinct = new Set(ids.map((lineupIds) => [...lineupIds].sort().join(","))).size;
      status[tier] = { accepted: ids.length, distinct };
    }
  }
  return status;
}

function AdminScreen() {
  const [authed, setAuthed] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState(false);
  const [slate, setSlate] = useState<SlateSummary | null>(() => summarizeSavedSlate());
  const [slatePlayers, setSlatePlayers] = useState<Player[] | null>(() => getSavedSlatePlayers());
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [vegas, setVegas] = useState<VegasSummary | null>(() => summarizeSavedVegas(getSavedSlatePlayers()));
  const [vegasUploadError, setVegasUploadError] = useState<string | null>(null);
  const [fieldCacheStatus, setFieldCacheStatus] = useState<Partial<Record<FieldTier, FieldCacheTierStatus>>>(() =>
    computeFieldCacheStatus(getSavedProjectionsCsv()),
  );
  const [buildProgress, setBuildProgress] = useState<{ tier: FieldTier; distinct: number; targetDistinct: number } | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);

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
      setSlatePlayers(players);
      setUploadError(null);
      // A new slate may have different teams than whatever Vegas data was
      // saved against the old one -- re-derive its summary (or let it
      // disappear if it no longer validates) rather than leave a stale one.
      setVegas(summarizeSavedVegas(players));
      // A field cached against the OLD slate is meaningless against this
      // one (different players, different ownership) -- this task's own
      // spec: "Uploading new projections clears the cache."
      clearFieldCache();
      setFieldCacheStatus({});
    } catch (e) {
      setUploadError(
        e instanceof SlateValidationError ? e.message : "Couldn't read that file as a projections CSV -- check it's a valid DK projections export.",
      );
    }
  }

  function handleClear(): void {
    clearProjectionsCsv();
    setSlate(null);
    setSlatePlayers(null);
    setUploadError(null);
    setVegas(null);
    clearFieldCache();
    setFieldCacheStatus({});
  }

  async function handleBuildFields(): Promise<void> {
    const csv = getSavedProjectionsCsv();
    if (csv === null || slatePlayers === null) return;
    const signature = slateSignature(csv);
    setBuildError(null);
    try {
      await buildAndCacheFields(signature, slatePlayers, (tier, _completed, _total, distinct, targetDistinct) => {
        setBuildProgress({ tier, distinct, targetDistinct });
      });
      setFieldCacheStatus(computeFieldCacheStatus(csv));
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : "Field build failed.");
    } finally {
      setBuildProgress(null);
    }
  }

  // Validates against the CURRENT slate's teams (slatePlayers) -- disabled
  // in the UI below whenever slatePlayers is null, so this only ever runs
  // once a projections slate is actually loaded.
  async function handleVegasUpload(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file || slatePlayers === null) return;
    try {
      const text = await readFileAsText(file);
      const { vegas: parsed, skippedTeams } = validateVegasCsv(text, slateTeams(slatePlayers));
      saveVegasCsv(text);
      setVegas({ teamCount: parsed.size, skippedTeams });
      setVegasUploadError(null);
    } catch (e) {
      setVegasUploadError(
        e instanceof VegasValidationError ? e.message : "Couldn't read that file as a Vegas CSV -- check it's a valid Vegas export.",
      );
    }
  }

  function handleClearVegas(): void {
    clearVegasCsv();
    setVegas(null);
    setVegasUploadError(null);
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
      <section className="step">
        <h2>Vegas</h2>
        {slatePlayers === null ? (
          <p className="status">Upload projections first.</p>
        ) : (
          <>
            <label className="file-label" htmlFor="admin-vegas-csv">
              Vegas CSV
            </label>
            <input id="admin-vegas-csv" type="file" accept=".csv" onChange={handleVegasUpload} />
            {vegas !== null && (
              <div className="status">
                <p>{vegas.teamCount} team(s) loaded.</p>
                {vegas.skippedTeams.length > 0 && (
                  <p className="status">
                    Skipped {vegas.skippedTeams.length} team{vegas.skippedTeams.length === 1 ? "" : "s"} not on this slate:{" "}
                    {vegas.skippedTeams.join(", ")}
                  </p>
                )}
              </div>
            )}
            {vegas === null && vegasUploadError === null && <p className="status">No Vegas data saved yet.</p>}
            {vegasUploadError !== null && (
              <p className="error" role="alert">
                {vegasUploadError}
              </p>
            )}
            <button type="button" className="continue" onClick={handleClearVegas}>
              Clear Vegas data
            </button>
          </>
        )}
      </section>
      <section className="step">
        <h2>Simulated fields</h2>
        {slatePlayers === null ? (
          <p className="status">Upload projections first.</p>
        ) : (
          <>
            <button type="button" className="continue" onClick={handleBuildFields} disabled={buildProgress !== null}>
              Build fields
            </button>
            {buildProgress !== null && (
              <div className="status">
                <p>
                  Building {buildProgress.tier}: {buildProgress.distinct}/{buildProgress.targetDistinct} distinct lineups
                </p>
                <progress value={buildProgress.distinct} max={buildProgress.targetDistinct} />
              </div>
            )}
            {buildError !== null && (
              <p className="error" role="alert">
                {buildError}
              </p>
            )}
            <div className="status">
              {BUILD_TIERS.map((tier) => {
                const tierStatus = fieldCacheStatus[tier];
                if (tierStatus === undefined) return <p key={tier}>{tier}: not built yet</p>;
                const shortfall = TARGET_DISTINCT_LINEUPS - tierStatus.distinct;
                return (
                  <p key={tier}>
                    {tier}: {tierStatus.accepted} lineups cached ({tierStatus.distinct} distinct
                    {shortfall > 0 ? `, short of the ${TARGET_DISTINCT_LINEUPS} target by ${shortfall}` : `, meets the ${TARGET_DISTINCT_LINEUPS} target`})
                  </p>
                );
              })}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

export default AdminScreen;
