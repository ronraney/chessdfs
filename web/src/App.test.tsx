// @vitest-environment jsdom
// Task 32: the first setup screen's own UI tests, via React Testing
// Library + jsdom. The engine itself is already covered under
// web/src/engine -- these only check that the screen wires it up right.
// jsdom is opted into per-file (not globally -- see vite.config.ts) since
// it adds real per-file overhead that the (already slow) chess.js-heavy
// engine tests don't need.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { loadEtrCsv } from "./engine/loaders";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_CSV_PATH = path.join(dirname, "data", "samples", "NFL Weekly DFS System - Projections.csv");
const SAMPLE_CSV = readFileSync(SAMPLE_CSV_PATH, "utf-8");
const SAMPLE_PLAYER_COUNT = loadEtrCsv(SAMPLE_CSV).length; // same engine call the app itself makes

function sampleCsvFile(): File {
  return new File([SAMPLE_CSV], "projections.csv", { type: "text/csv" });
}

async function uploadSampleCsv(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const input = screen.getByLabelText("Projections CSV") as HTMLInputElement;
  await user.upload(input, sampleCsvFile());
  // handleUpload reads the file asynchronously (File.text()) -- wait for
  // its state update to land before the test's next interaction.
  await waitFor(() => expect(screen.getByText(`${SAMPLE_PLAYER_COUNT} players loaded`)).toBeInTheDocument());
}

describe("App setup screen", () => {
  beforeEach(() => {
    render(<App />);
  });

  it('has the title "Chess DFS"', () => {
    expect(screen.getByRole("heading", { level: 1, name: "Chess DFS" })).toBeInTheDocument();
  });

  it("uploading the sample CSV shows the player count", async () => {
    const user = userEvent.setup();
    await uploadSampleCsv(user); // asserts the player count itself
  });

  it("a bad file shows a clear parse error", async () => {
    const user = userEvent.setup();
    const input = screen.getByLabelText("Projections CSV") as HTMLInputElement;
    const badFile = new File(["not,a,projections,file\n1,2,3,4"], "junk.csv", { type: "text/csv" });
    await user.upload(input, badFile);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("picking a preset shows its field tier", async () => {
    const user = userEvent.setup();
    // H2H (2 entries) always resolves to the "Small" entry-size tier.
    const h2hButton = screen.getByText("H2H").closest("button")!;
    expect(h2hButton).toHaveTextContent(/Small tier/); // shown even before it's picked
    await user.click(h2hButton);
    expect(h2hButton).toHaveAttribute("aria-pressed", "true");
  });

  it("Place your King now lists only QBs", async () => {
    const user = userEvent.setup();
    await uploadSampleCsv(user);
    await user.click(screen.getByLabelText("Place your King now"));

    const select = await screen.findByLabelText("White's QB");
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent ?? "");

    expect(options.some((text) => text.startsWith("Joe Burrow"))).toBe(true); // a real QB
    expect(options.some((text) => text.startsWith("Christian McCaffrey"))).toBe(false); // a real RB
    expect(options.some((text) => text.startsWith("Jaxon Smith-Njigba"))).toBe(false); // a real WR
  });

  it("Let him emerge (the default) shows no QB picker", () => {
    expect(screen.queryByLabelText("White's QB")).not.toBeInTheDocument();
  });
});
