// @vitest-environment jsdom
// Task 34: the opening setup screen's own tests, via React Testing
// Library + jsdom (same per-file opt-in as App.test.tsx -- see its own
// header comment for why this isn't the global default).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LAST_RANK, PRESETS, RANKED_FAMILIES } from "./appData";
import OpeningSetupScreen from "./OpeningSetupScreen";

const H2H = PRESETS.find((preset) => preset.name === "H2H")!;

function renderScreen() {
  const onChoose = vi.fn();
  const onBack = vi.fn();
  render(<OpeningSetupScreen preset={H2H} onChoose={onChoose} onBack={onBack} />);
  return { onChoose, onBack };
}

describe("OpeningSetupScreen", () => {
  it("shows the suggested opening for H2H (Sicilian Defense)", () => {
    renderScreen();
    expect(screen.getByRole("heading", { level: 2, name: "Sicilian Defense" })).toBeInTheDocument();
  });

  it("pre-selects the contest's own tier chip", () => {
    // H2H (2 entries) resolves to the Small tier.
    renderScreen();
    expect(screen.getByRole("button", { name: "Small" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Mid" })).toHaveAttribute("aria-pressed", "false");
  });

  it('search "Najdorf" finds a Sicilian line', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.type(screen.getByLabelText("Search openings"), "Najdorf");
    // The book names several depths of the same line identically ("Sicilian
    // Defense: Najdorf Variation" at B90/B94/B95/B96/B98) -- at least one
    // result row for it is what matters here, not a single unique match.
    expect(screen.getAllByText("Najdorf Variation").length).toBeGreaterThan(0);
  });

  it("Random stays within the selected chip", async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(screen.getByRole("button", { name: "Large" }));
    const largeTier = H2H.contest.entryTiers(LAST_RANK).find((tier) => tier.name === "Large")!;

    for (let i = 0; i < 6; i++) {
      await user.click(screen.getByRole("button", { name: "Random" }));
      const familyName = screen.getByRole("heading", { level: 2 }).textContent;
      const family = RANKED_FAMILIES.find((f) => f.name === familyName);
      expect(family).toBeDefined();
      expect(family!.rank).toBeGreaterThanOrEqual(largeTier.lowRank);
      expect(family!.rank).toBeLessThanOrEqual(largeTier.highRank);
    }
  });

  it("an off-tier pick shows the tag (e.g. Large-style)", async () => {
    const user = userEvent.setup();
    renderScreen(); // H2H's own tier is Small
    await user.click(screen.getByRole("button", { name: "Large" }));
    await user.click(screen.getByRole("button", { name: "Random" }));
    expect(screen.getByText("Large-style")).toBeInTheDocument();
  });
});
