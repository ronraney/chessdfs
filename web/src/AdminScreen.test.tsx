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

const SAMPLE_PLAYER_COUNT = loadEtrCsv(SAMPLE_CSV).length;
const PASSWORD = "letmein-test-password";

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
