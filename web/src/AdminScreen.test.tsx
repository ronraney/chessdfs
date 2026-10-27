// @vitest-environment jsdom
// Task 35: the hidden admin screen's own tests. App.test.tsx covers the
// routing side (reaching #/admin, and the saved slate showing up back on
// the player screens) -- these cover AdminScreen in isolation.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminScreen from "./AdminScreen";
import { FieldTier } from "./engine/models";
import { getCachedFieldIds, saveCachedFieldIds, slateSignature } from "./fieldCacheStore";
import { getSavedProjectionsCsv, saveProjectionsCsv } from "./projectionsStore";
import { loadEtrCsv } from "./engine/loaders";
import { SAMPLE_CSV, sampleCsvFile } from "./testFixtures";
import { getSavedVegasCsv } from "./vegasStore";

const SAMPLE_PLAYER_COUNT = loadEtrCsv(SAMPLE_CSV).length;
const PASSWORD = "letmein-test-password";

// The sample slate (data/samples/NFL Weekly DFS System - Projections.csv)
// has exactly these 22 real teams -- a slate team with no Vegas row is
// now a hard error (behavior-reversal task), so "a valid upload" against
// this slate means covering all 22, not just a couple.
const SAMPLE_SLATE_TEAMS = [
  "ARI", "CHI", "CIN", "CLE", "DEN", "DET", "GB", "HOU", "IND", "LAC", "LV",
  "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PIT", "SEA", "SF", "TEN", "WAS",
];
const VEGAS_HEADER = "Rank,Team,Implied Total,Spread,O/U,Opponent";
function vegasCsv(rows: readonly string[]): string {
  return [VEGAS_HEADER, ...rows].join("\n");
}
// Opponent is parsed but never read/validated (vegasCsv.ts) -- "XXX" is a
// deliberate, harmless placeholder, not meant to pair up real games.
const VALID_VEGAS_CSV = vegasCsv(SAMPLE_SLATE_TEAMS.map((team, i) => `${i + 1},${team},24,0,47,XXX`));
// ARI/CHI only -- a real team (KC) never appears on this 22-team sample
// slate at all, so it's a genuinely off-slate row (skipped, not rejected,
// per this task); the other 20 slate teams are simply absent from this
// CSV (the OTHER, still-fatal case: a slate team with no Vegas row).
const PARTIAL_COVERAGE_VEGAS_CSV = vegasCsv(["1,ARI,27.5,-3.5,51,CHI", "2,CHI,23.5,3.5,51,ARI"]);
function vegasCsvFile(text: string = VALID_VEGAS_CSV): File {
  return new File([text], "vegas.csv", { type: "text/csv" });
}

async function logIn(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Password"), PASSWORD);
  await user.click(screen.getByRole("button", { name: "Log in" }));
  await screen.findByLabelText("Projections CSV");
}

describe("AdminScreen", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_ADMIN_PASSWORD", PASSWORD);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows the theme toggle", () => {
    render(<AdminScreen />);
    expect(screen.getByRole("group", { name: "Theme" })).toBeInTheDocument();
  });

  it("wrong password shows no upload control", async () => {
    render(<AdminScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Password"), "not-the-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong password.");
    expect(screen.queryByLabelText("Projections CSV")).not.toBeInTheDocument();
  });

  it("correct password reveals the upload control", async () => {
    render(<AdminScreen />);
    const user = userEvent.setup();
    await logIn(user);
    expect(screen.getByLabelText("Projections CSV")).toBeInTheDocument();
  });

  // Task 43: the success status now also names the ID column used and
  // breaks the count down by position, on top of the total.
  it("uploading the sample CSV shows the player count, ID column, and position breakdown, and saves it", async () => {
    render(<AdminScreen />);
    const user = userEvent.setup();
    await logIn(user);

    await user.upload(screen.getByLabelText("Projections CSV"), sampleCsvFile());

    await waitFor(() => expect(screen.getByText(`${SAMPLE_PLAYER_COUNT} players loaded · ID column: DK_ID`)).toBeInTheDocument());
    expect(screen.getByText(/QB: \d+/)).toBeInTheDocument();
    expect(getSavedProjectionsCsv()).toBe(SAMPLE_CSV);
  });

  // Task 43: slate validation replaces the old "parses to >0 rows" check --
  // a file with none of the required columns now names exactly which ones
  // are missing, instead of the old generic fallback message.
  it("a file missing every required column names them and saves nothing", async () => {
    render(<AdminScreen />);
    const user = userEvent.setup();
    await logIn(user);

    const badFile = new File(["not,a,projections,file\n1,2,3,4"], "junk.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Projections CSV"), badFile);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Missing required column\(s\): Player, DK Pos, Team, Opp, DK Salary, DK Proj/);
    expect(getSavedProjectionsCsv()).toBeNull();
  });

  // Task 43: a rejected upload keeps whatever slate was already saved --
  // the previously-saved sample stays in place and shown, not cleared.
  it("a rejected upload keeps the previously saved slate", async () => {
    render(<AdminScreen />);
    const user = userEvent.setup();
    await logIn(user);
    await user.upload(screen.getByLabelText("Projections CSV"), sampleCsvFile());
    await waitFor(() => expect(screen.getByText(`${SAMPLE_PLAYER_COUNT} players loaded · ID column: DK_ID`)).toBeInTheDocument());

    const badFile = new File(["not,a,projections,file\n1,2,3,4"], "junk.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Projections CSV"), badFile);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Missing required column/);
    expect(screen.getByText(`${SAMPLE_PLAYER_COUNT} players loaded · ID column: DK_ID`)).toBeInTheDocument(); // unchanged
    expect(getSavedProjectionsCsv()).toBe(SAMPLE_CSV); // unchanged
  });

  it("Clear projections removes the saved slate", async () => {
    render(<AdminScreen />);
    const user = userEvent.setup();
    await logIn(user);
    await user.upload(screen.getByLabelText("Projections CSV"), sampleCsvFile());
    await waitFor(() => expect(screen.getByText(`${SAMPLE_PLAYER_COUNT} players loaded · ID column: DK_ID`)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Clear projections" }));

    expect(screen.getByText("No projections saved yet.")).toBeInTheDocument();
    expect(getSavedProjectionsCsv()).toBeNull();
  });
});

describe("AdminScreen -- Vegas upload", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_ADMIN_PASSWORD", PASSWORD);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function logInAndUploadProjections(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    render(<AdminScreen />);
    await logIn(user);
    await user.upload(screen.getByLabelText("Projections CSV"), sampleCsvFile());
    await waitFor(() => expect(screen.getByText(`${SAMPLE_PLAYER_COUNT} players loaded · ID column: DK_ID`)).toBeInTheDocument());
  }

  it("the Vegas upload is gated behind a loaded projections slate", async () => {
    render(<AdminScreen />);
    const user = userEvent.setup();
    await logIn(user);
    // Two sections share this message now -- Vegas AND Simulated fields
    // (added this session) are both gated on the same loaded-slate check.
    expect(screen.getAllByText("Upload projections first.")).toHaveLength(2);
    expect(screen.queryByLabelText("Vegas CSV")).not.toBeInTheDocument();
  });

  it("once projections are loaded, the Vegas upload appears with nothing saved yet", async () => {
    const user = userEvent.setup();
    await logInAndUploadProjections(user);
    expect(screen.getByLabelText("Vegas CSV")).toBeInTheDocument();
    expect(screen.getByText("No Vegas data saved yet.")).toBeInTheDocument();
  });

  it("a valid full-coverage upload shows the team count and saves it", async () => {
    const user = userEvent.setup();
    await logInAndUploadProjections(user);

    await user.upload(screen.getByLabelText("Vegas CSV"), vegasCsvFile());

    await waitFor(() => expect(screen.getByText("22 team(s) loaded.")).toBeInTheDocument());
    expect(screen.queryByText(/Skipped/)).not.toBeInTheDocument();
    expect(getSavedVegasCsv()).toBe(VALID_VEGAS_CSV);
  });

  // Bug fix (behavior reversal): a slate team with no Vegas row used to
  // be a non-fatal note; it's a hard error now. 20 of the sample slate's
  // 22 teams have no row in this CSV.
  it("errors and saves nothing when a slate team has no Vegas row", async () => {
    const user = userEvent.setup();
    await logInAndUploadProjections(user);

    await user.upload(screen.getByLabelText("Vegas CSV"), vegasCsvFile(PARTIAL_COVERAGE_VEGAS_CSV));

    expect(await screen.findByRole("alert")).toHaveTextContent(/No Vegas row for slate team\(s\): /);
    expect(getSavedVegasCsv()).toBeNull();
  });

  it("a file missing required columns names them and saves nothing", async () => {
    const user = userEvent.setup();
    await logInAndUploadProjections(user);

    const badFile = new File(["Rank,Team\n1,ARI"], "junk.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Vegas CSV"), badFile);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Missing required column\(s\): Implied Total, Spread, O\/U, Opponent\./);
    expect(getSavedVegasCsv()).toBeNull();
  });

  // Bug fix: a full-week Vegas sheet routinely has rows for teams this
  // slate isn't using (KC is a real team, just not one of the sample
  // slate's 22). That used to reject the whole upload; now it's skipped,
  // noted, and the upload still saves.
  it("skips a row for a real team not on the loaded slate, notes it, and still saves", async () => {
    const user = userEvent.setup();
    await logInAndUploadProjections(user);

    const extraRow = "23,KC,25,-1,48,XXX";
    await user.upload(screen.getByLabelText("Vegas CSV"), vegasCsvFile(vegasCsv([...VALID_VEGAS_CSV.split("\n").slice(1), extraRow])));

    await waitFor(() => expect(screen.getByText("22 team(s) loaded.")).toBeInTheDocument());
    expect(screen.getByText("Skipped 1 team not on this slate: KC")).toBeInTheDocument();
    expect(getSavedVegasCsv()).not.toBeNull();
  });

  it("a rejected upload keeps the previously saved Vegas data", async () => {
    const user = userEvent.setup();
    await logInAndUploadProjections(user);
    await user.upload(screen.getByLabelText("Vegas CSV"), vegasCsvFile());
    await waitFor(() => expect(screen.getByText("22 team(s) loaded.")).toBeInTheDocument());

    const badFile = new File(["Rank,Team\n1,ARI"], "junk.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Vegas CSV"), badFile);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Missing required column/);
    expect(screen.getByText("22 team(s) loaded.")).toBeInTheDocument(); // unchanged
    expect(getSavedVegasCsv()).toBe(VALID_VEGAS_CSV); // unchanged
  });

  it("Clear Vegas data removes the saved Vegas CSV", async () => {
    const user = userEvent.setup();
    await logInAndUploadProjections(user);
    await user.upload(screen.getByLabelText("Vegas CSV"), vegasCsvFile());
    await waitFor(() => expect(screen.getByText("22 team(s) loaded.")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Clear Vegas data" }));

    expect(screen.getByText("No Vegas data saved yet.")).toBeInTheDocument();
    expect(getSavedVegasCsv()).toBeNull();
  });
});

// Build fields itself spins up a real Web Worker (fieldWorker.ts via
// buildFieldCache.ts) -- jsdom doesn't implement Worker at all, the same
// standing gap as stockfishEngine.ts's own Worker (see HANDOFF.md: "no
// browser can launch in this environment at all"), so these tests never
// click "Build fields" -- they cover gating, reading back a pre-seeded
// cache, and clearing on upload/clear, all without touching the worker.
describe("AdminScreen -- simulated fields cache", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_ADMIN_PASSWORD", PASSWORD);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function logInAndUploadProjections(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    render(<AdminScreen />);
    await logIn(user);
    await user.upload(screen.getByLabelText("Projections CSV"), sampleCsvFile());
    await waitFor(() => expect(screen.getByText(`${SAMPLE_PLAYER_COUNT} players loaded · ID column: DK_ID`)).toBeInTheDocument());
  }

  // Seeds a slate as already saved from a PRIOR visit (no live upload
  // action) -- the only way to test "a pre-existing cache shows up," since
  // handleUpload always clears the cache on any successful upload (this
  // task's own spec), which would just wipe whatever was pre-seeded.
  async function logInWithSavedSlate(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    saveProjectionsCsv(SAMPLE_CSV);
    render(<AdminScreen />);
    await logIn(user);
  }

  it("is gated behind a loaded projections slate", async () => {
    render(<AdminScreen />);
    const user = userEvent.setup();
    await logIn(user);
    expect(screen.queryByRole("button", { name: "Build fields" })).not.toBeInTheDocument();
  });

  it("once projections are loaded, shows the build button and 'not built yet' for every tier", async () => {
    const user = userEvent.setup();
    await logInAndUploadProjections(user);

    expect(screen.getByRole("button", { name: "Build fields" })).toBeInTheDocument();
    expect(screen.getByText("SMALL: not built yet")).toBeInTheDocument();
    expect(screen.getByText("MID: not built yet")).toBeInTheDocument();
    expect(screen.getByText("LARGE: not built yet")).toBeInTheDocument();
  });

  it("shows a pre-cached field's lineup count without needing to build", async () => {
    const signature = slateSignature(SAMPLE_CSV);
    saveCachedFieldIds(signature, FieldTier.LARGE, [["p1", "p2"], ["p3", "p4"], ["p5", "p6"]]);

    const user = userEvent.setup();
    await logInWithSavedSlate(user);

    expect(screen.getByText("LARGE: 3 lineups cached")).toBeInTheDocument();
    expect(screen.getByText("SMALL: not built yet")).toBeInTheDocument();
  });

  it("uploading new projections clears every cached field", async () => {
    const signature = slateSignature(SAMPLE_CSV);
    saveCachedFieldIds(signature, FieldTier.SMALL, [["p1"]]);
    saveCachedFieldIds(signature, FieldTier.MID, [["p2"]]);

    const user = userEvent.setup();
    await logInAndUploadProjections(user); // re-upload the same CSV -- still a "new" save
    await waitFor(() => expect(screen.getByText("SMALL: not built yet")).toBeInTheDocument());

    expect(screen.getByText("MID: not built yet")).toBeInTheDocument();
    expect(getCachedFieldIds(signature, FieldTier.SMALL)).toBeNull();
    expect(getCachedFieldIds(signature, FieldTier.MID)).toBeNull();
  });

  it("Clear projections also clears every cached field", async () => {
    const signature = slateSignature(SAMPLE_CSV);
    saveCachedFieldIds(signature, FieldTier.LARGE, [["p1"]]);

    const user = userEvent.setup();
    await logInWithSavedSlate(user);
    expect(screen.getByText("LARGE: 1 lineups cached")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear projections" }));

    expect(screen.queryByRole("button", { name: "Build fields" })).not.toBeInTheDocument();
    expect(getCachedFieldIds(signature, FieldTier.LARGE)).toBeNull();
  });
});
