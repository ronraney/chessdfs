// @vitest-environment jsdom
// Task 32: the first setup screen's own UI tests, via React Testing
// Library + jsdom. The engine itself is already covered under
// web/src/engine -- these only check that the screen wires it up right.
// jsdom is opted into per-file (not globally -- see vite.config.ts) since
// it adds real per-file overhead that the (already slow) chess.js-heavy
// engine tests don't need.
//
// Task 35 removed the projections upload from the player flow -- players
// now read a slate the admin already saved (AdminScreen.tsx via
// projectionsStore.ts), so most tests here save a slate directly through
// the store before rendering, the same way the admin screen would after a
// real upload. The admin-upload path itself (file parsing, player count,
// bad-file errors, wrong password) is covered in AdminScreen.test.tsx; the
// tests here cover the routing/integration seam between the two screens.
//
// Task 38c merges the old contest/King-mode step into SetupScreen (formerly
// reached only after a separate "Continue" step) -- the preset/King-mode-
// specific tests that used to live here moved to SetupScreen.test.tsx,
// since that's the component that now actually owns that behavior.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { PRESETS } from "./appData";
import { loadEtrCsv } from "./engine/loaders";
import { saveProjectionsCsv } from "./projectionsStore";
import { SAMPLE_CSV, sampleCsvFile } from "./testFixtures";

const SAMPLE_PLAYER_COUNT = loadEtrCsv(SAMPLE_CSV).length;
const PASSWORD = "letmein-test-password";

function renderWithSavedSlate() {
  saveProjectionsCsv(SAMPLE_CSV);
  return render(<App />);
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("App setup screen", () => {
  it('has the title "Chess DFS"', () => {
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "Chess DFS" })).toBeInTheDocument();
  });

  it("shows the theme toggle", () => {
    render(<App />);
    expect(screen.getByRole("group", { name: "Theme" })).toBeInTheDocument();
  });

  it('shows "No slate loaded yet" when no projections are saved', () => {
    render(<App />);
    expect(screen.getByText("No slate loaded yet.")).toBeInTheDocument();
  });

  it("has no upload control anywhere in the player flow", () => {
    renderWithSavedSlate();
    expect(screen.queryByLabelText(/projections csv/i)).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});

describe("admin screen routing", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_ADMIN_PASSWORD", PASSWORD);
  });

  async function logIntoAdmin(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Log in" }));
    await screen.findByLabelText("Projections CSV");
  }

  it("uploading on the admin screen makes the player setup show", async () => {
    window.location.hash = "#/admin";
    render(<App />);
    const user = userEvent.setup();
    await logIntoAdmin(user);

    await user.upload(screen.getByLabelText("Projections CSV"), sampleCsvFile());
    await waitFor(() => expect(screen.getByText(`${SAMPLE_PLAYER_COUNT} players loaded`)).toBeInTheDocument());

    act(() => {
      window.location.hash = "";
    });

    await waitFor(() => expect(screen.getByLabelText("1 · Contest")).toBeInTheDocument());
    expect(screen.queryByText("No slate loaded yet.")).not.toBeInTheDocument();
  });

  it("clearing projections on the admin screen reverts to 'No slate loaded yet'", async () => {
    saveProjectionsCsv(SAMPLE_CSV);
    window.location.hash = "#/admin";
    render(<App />);
    const user = userEvent.setup();
    await logIntoAdmin(user);
    await waitFor(() => expect(screen.getByText(`${SAMPLE_PLAYER_COUNT} players loaded`)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Clear projections" }));

    act(() => {
      window.location.hash = "";
    });

    await waitFor(() => expect(screen.getByText("No slate loaded yet.")).toBeInTheDocument());
  });
});

// Task 40: "Start again" (same contest and King mode, back to the opening
// choice) is BuildScreen's own header link, but the actual "back to
// setup" navigation -- and remembering which contest to pre-select -- is
// App.tsx's job, so this is an App-level test rather than a BuildScreen
// one.
describe("Start again (Task 40)", () => {
  function optionLabel(name: string, fieldSize: number): string {
    return `${name} — ${fieldSize.toLocaleString()} entries`;
  }

  it("Start again returns to setup with the same contest", async () => {
    renderWithSavedSlate();
    const user = userEvent.setup();
    const h2h = PRESETS.find((p) => p.name === "H2H")!;

    await user.selectOptions(screen.getByLabelText("1 · Contest"), optionLabel(h2h.name, h2h.contest.fieldSize));
    await user.click(screen.getByRole("button", { name: "(Play your own opening)" }));

    // Zero players locked yet -- the header link's own confirm is skipped
    // (see BuildScreen's requestStartAgain), so this needs no window.confirm
    // mock at all.
    await user.click(screen.getByRole("button", { name: "Start again" }));

    await waitFor(() => expect(screen.getByLabelText("1 · Contest")).toBeInTheDocument());
    expect((screen.getByLabelText("1 · Contest") as HTMLSelectElement).value).toBe(String(PRESETS.indexOf(h2h)));
  });
});
