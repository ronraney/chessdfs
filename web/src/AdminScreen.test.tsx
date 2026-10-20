// @vitest-environment jsdom
// Task 35: the hidden admin screen's own tests. App.test.tsx covers the
// routing side (reaching #/admin, and the saved slate showing up back on
// the player screens) -- these cover AdminScreen in isolation.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminScreen from "./AdminScreen";
import { getSavedProjectionsCsv } from "./projectionsStore";
import { loadEtrCsv } from "./engine/loaders";
import { SAMPLE_CSV, sampleCsvFile } from "./testFixtures";
import { getSavedVegasCsv } from "./vegasStore";

const SAMPLE_PLAYER_COUNT = loadEtrCsv(SAMPLE_CSV).length;
const PASSWORD = "letmein-test-password";

// ARI/CHI are both real teams on the sample slate (data/samples/NFL
// Weekly DFS System - Projections.csv) -- used below for a partial-
// coverage upload (20 of the sample's 22 teams end up in missingTeams).
const VEGAS_HEADER = "Rank,Team,Implied Total,Spread,O/U,Opponent";
function vegasCsv(rows: readonly string[]): string {
  return [VEGAS_HEADER, ...rows].join("\n");
}
const VALID_VEGAS_CSV = vegasCsv(["1,ARI,27.5,-3.5,51,CHI", "2,CHI,23.5,3.5,51,ARI"]);
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
    expect(screen.getByText("Upload projections first.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Vegas CSV")).not.toBeInTheDocument();
  });

  it("once projections are loaded, the Vegas upload appears with nothing saved yet", async () => {
    const user = userEvent.setup();
    await logInAndUploadProjections(user);
    expect(screen.getByLabelText("Vegas CSV")).toBeInTheDocument();
    expect(screen.getByText("No Vegas data saved yet.")).toBeInTheDocument();
  });

  it("a valid partial-coverage upload shows the team count, warns on missing teams, and saves it", async () => {
    const user = userEvent.setup();
    await logInAndUploadProjections(user);

    await user.upload(screen.getByLabelText("Vegas CSV"), vegasCsvFile());

    await waitFor(() => expect(screen.getByText("2 team(s) loaded.")).toBeInTheDocument());
    expect(screen.getByText(/No Vegas row for: .* -- they'll use neutral defaults\./)).toBeInTheDocument();
    expect(getSavedVegasCsv()).toBe(VALID_VEGAS_CSV);
  });

  it("a file missing required columns names them and saves nothing", async () => {
    const user = userEvent.setup();
    await logInAndUploadProjections(user);

    const badFile = new File(["Rank,Team\n1,ARI"], "junk.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Vegas CSV"), badFile);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Missing required column\(s\): Implied Total, Spread, O\/U, Opponent\./);
    expect(getSavedVegasCsv()).toBeNull();
  });

  it("a row for a team not on the loaded slate is rejected and saves nothing", async () => {
    const user = userEvent.setup();
    await logInAndUploadProjections(user);

    const badFile = vegasCsvFile(vegasCsv(["1,ARI,27.5,-3.5,51,CHI", "2,ZZZ,23.5,3.5,51,ARI"]));
    await user.upload(screen.getByLabelText("Vegas CSV"), badFile);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Vegas row\(s\) for team\(s\) not on the loaded slate: ZZZ/);
    expect(getSavedVegasCsv()).toBeNull();
  });

  it("a rejected upload keeps the previously saved Vegas data", async () => {
    const user = userEvent.setup();
    await logInAndUploadProjections(user);
    await user.upload(screen.getByLabelText("Vegas CSV"), vegasCsvFile());
    await waitFor(() => expect(screen.getByText("2 team(s) loaded.")).toBeInTheDocument());

    const badFile = new File(["Rank,Team\n1,ARI"], "junk.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Vegas CSV"), badFile);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Missing required column/);
    expect(screen.getByText("2 team(s) loaded.")).toBeInTheDocument(); // unchanged
    expect(getSavedVegasCsv()).toBe(VALID_VEGAS_CSV); // unchanged
  });

  it("Clear Vegas data removes the saved Vegas CSV", async () => {
    const user = userEvent.setup();
    await logInAndUploadProjections(user);
    await user.upload(screen.getByLabelText("Vegas CSV"), vegasCsvFile());
    await waitFor(() => expect(screen.getByText("2 team(s) loaded.")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Clear Vegas data" }));

    expect(screen.getByText("No Vegas data saved yet.")).toBeInTheDocument();
    expect(getSavedVegasCsv()).toBeNull();
  });
});
