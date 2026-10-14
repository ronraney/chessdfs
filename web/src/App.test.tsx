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
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
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

  it("picking a preset shows its field tier", async () => {
    renderWithSavedSlate();
    const user = userEvent.setup();
    // H2H (2 entries) always resolves to the "Small" entry-size tier.
    const h2hButton = screen.getByText("H2H").closest("button")!;
    expect(h2hButton).toHaveTextContent(/Small tier/); // shown even before it's picked
    await user.click(h2hButton);
    expect(h2hButton).toHaveAttribute("aria-pressed", "true");
  });

  it("Place your King now lists only QBs", async () => {
    renderWithSavedSlate();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Place your King now"));

    const select = await screen.findByLabelText("White's QB");
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent ?? "");

    expect(options.some((text) => text.startsWith("Joe Burrow"))).toBe(true); // a real QB
    expect(options.some((text) => text.startsWith("Christian McCaffrey"))).toBe(false); // a real RB
    expect(options.some((text) => text.startsWith("Jaxon Smith-Njigba"))).toBe(false); // a real WR
  });

  it("Let him emerge (the default) shows no QB picker", () => {
    renderWithSavedSlate();
    expect(screen.queryByLabelText("White's QB")).not.toBeInTheDocument();
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

    await waitFor(() => expect(screen.getByText("1. Pick a contest")).toBeInTheDocument());
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
