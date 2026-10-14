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

  it("uploading the sample CSV shows the player count and saves it", async () => {
    render(<AdminScreen />);
    const user = userEvent.setup();
    await logIn(user);

    await user.upload(screen.getByLabelText("Projections CSV"), sampleCsvFile());

    await waitFor(() => expect(screen.getByText(`${SAMPLE_PLAYER_COUNT} players loaded`)).toBeInTheDocument());
    expect(getSavedProjectionsCsv()).toBe(SAMPLE_CSV);
  });

  it("a bad file shows a clear parse error and saves nothing", async () => {
    render(<AdminScreen />);
    const user = userEvent.setup();
    await logIn(user);

    const badFile = new File(["not,a,projections,file\n1,2,3,4"], "junk.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Projections CSV"), badFile);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't read that file/);
    expect(getSavedProjectionsCsv()).toBeNull();
  });

  it("Clear projections removes the saved slate", async () => {
    render(<AdminScreen />);
    const user = userEvent.setup();
    await logIn(user);
    await user.upload(screen.getByLabelText("Projections CSV"), sampleCsvFile());
    await waitFor(() => expect(screen.getByText(`${SAMPLE_PLAYER_COUNT} players loaded`)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Clear projections" }));

    expect(screen.getByText("No projections saved yet.")).toBeInTheDocument();
    expect(getSavedProjectionsCsv()).toBeNull();
  });
});
