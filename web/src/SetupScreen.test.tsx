// @vitest-environment jsdom
// Task 34: the setup screen's own tests, via React Testing Library + jsdom
// (same per-file opt-in as App.test.tsx -- see its own header comment for
// why this isn't the global default).
//
// Task 38c merges App.tsx's old contest/King-mode step into this screen
// (formerly OpeningSetupScreen) and swaps the contest picker from a button
// list to a <select>, matching design/'s mockups -- renderScreen() always
// selects H2H first so every migrated test keeps the exact preset
// (2 entries -> Small tier) the original suite was written against;
// "picking a contest shows its tier" and "changing the contest..." below
// are the dropdown-native replacements for the old button-list test, plus
// the Task 38c bug-fix-test moves string, now numbered to match the
// design ("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6", not the old bare SAN list).
//
// Also moved here from App.test.tsx: the King-mode/QB-picker tests, since
// King mode is now owned by this screen, not App.tsx.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PRESETS, RANKED_FAMILIES } from "./appData";
import type { ContestPreset } from "./engine/config";
import { loadEtrCsv } from "./engine/loaders";
import { KingMode } from "./engine/models";
import SetupScreen from "./SetupScreen";
import { SAMPLE_CSV } from "./testFixtures";

const PLAYERS = loadEtrCsv(SAMPLE_CSV);
const H2H = PRESETS.find((preset) => preset.name === "H2H")!; // 2 entries -> Small tier

function optionLabel(preset: ContestPreset): string {
  return `${preset.name} — ${preset.contest.fieldSize.toLocaleString()} entries`;
}

async function renderScreen() {
  const onChoose = vi.fn();
  render(<SetupScreen players={PLAYERS} onChoose={onChoose} />);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText("1 · Contest"), optionLabel(H2H));
  return { onChoose, user };
}

describe("SetupScreen", () => {
  it("shows the suggested opening for H2H (Sicilian Defense)", async () => {
    await renderScreen();
    expect(screen.getByRole("heading", { level: 2, name: "Sicilian Defense" })).toBeInTheDocument();
  });

  it("shows the theme toggle", async () => {
    await renderScreen();
    expect(screen.getByRole("group", { name: "Theme" })).toBeInTheDocument();
  });

  it("pre-selects the contest's own tier chip", async () => {
    // H2H (2 entries) resolves to the Small tier.
    await renderScreen();
    expect(screen.getByRole("button", { name: "Small" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Mid" })).toHaveAttribute("aria-pressed", "false");
  });

  it("picking a contest shows its tier", async () => {
    const user = userEvent.setup();
    render(<SetupScreen players={PLAYERS} onChoose={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText("1 · Contest"), optionLabel(H2H));
    const contestCard = document.querySelector(".contest-card") as HTMLElement;
    expect(within(contestCard).getByText(/Small field/)).toBeInTheDocument();
  });

  it("changing the contest updates the Suggested card and the pre-selected tier chip", async () => {
    const user = userEvent.setup();
    // PRESETS[0] (Nickel, 9,512 entries) resolves to the Large tier --
    // a different suggestion and a different chip than H2H's Small.
    render(<SetupScreen players={PLAYERS} onChoose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Large" })).toHaveAttribute("aria-pressed", "true");

    await user.selectOptions(screen.getByLabelText("1 · Contest"), optionLabel(H2H));

    expect(screen.getByRole("heading", { level: 2, name: "Sicilian Defense" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Small" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Large" })).toHaveAttribute("aria-pressed", "false");
  });

  it('search "Najdorf" finds a Sicilian line', async () => {
    const { user } = await renderScreen();
    await user.type(screen.getByLabelText("Search openings"), "Najdorf");
    // The book names several depths of the same line identically ("Sicilian
    // Defense: Najdorf Variation" at B90/B94/B95/B96/B98) -- at least one
    // result row for it is what matters here, not a single unique match.
    expect(screen.getAllByText("Najdorf Variation").length).toBeGreaterThan(0);
  });

  // Task 43: six real re-renders of the Large-tier explorer list (plus the
  // Random click itself) legitimately cost more than most of this file's
  // other tests (confirmed via isolated timing runs -- no inefficiency
  // found to remove), leaving too little headroom against Vitest's 5000ms
  // default under full-suite load. Same fix BuildScreen.secondMove.test.tsx
  // already uses for its own heaviest tests.
  it(
    "Random stays within the selected chip",
    async () => {
      const { user } = await renderScreen();
      await user.click(screen.getByRole("button", { name: "Large" }));
      const largeTier = H2H.contest.entryTiers(RANKED_FAMILIES.length).find((tier) => tier.name === "Large")!;

      for (let i = 0; i < 6; i++) {
        await user.click(screen.getByRole("button", { name: "Random" }));
        const familyName = screen.getByRole("heading", { level: 2 }).textContent;
        const family = RANKED_FAMILIES.find((f) => f.name === familyName);
        expect(family).toBeDefined();
        expect(family!.rank).toBeGreaterThanOrEqual(largeTier.lowRank);
        expect(family!.rank).toBeLessThanOrEqual(largeTier.highRank);
      }
    },
    15000,
  );

  it("an off-tier pick shows the tag (e.g. Large-style)", async () => {
    const { user } = await renderScreen(); // H2H's own tier is Small
    await user.click(screen.getByRole("button", { name: "Large" }));
    await user.click(screen.getByRole("button", { name: "Random" }));
    expect(screen.getByText("Large-style")).toBeInTheDocument();
  });

  // Task 43: the "All" chip renders every ranked family (the explorer's
  // largest possible list) -- legitimately the slowest first paint in this
  // file (confirmed via isolated timing runs, no inefficiency found to
  // remove). Same fix as "Random stays within the selected chip" above.
  it(
    "choosing a family in the explorer plays its representative line, not the bare family row (Task 38 bug fix)",
    async () => {
      const { onChoose, user } = await renderScreen();
      await user.click(screen.getByRole("button", { name: "All" })); // Ruy Lopez regardless of H2H's own tier
      await user.click(screen.getByText("Ruy Lopez").closest("button")!);

      const card = document.querySelector(".suggested-card") as HTMLElement;
      expect(within(card).getByRole("heading", { level: 2, name: "Ruy Lopez" })).toBeInTheDocument();
      expect(within(card).getByText("Morphy Defense")).toBeInTheDocument();
      // ends 3...a6, not the bare 5-ply "Ruy Lopez" row
      expect(within(card).getByText("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Play this" }));
      expect(onChoose).toHaveBeenCalledWith(
        expect.objectContaining({
          opening: {
            kind: "line",
            line: expect.objectContaining({
              name: "Ruy Lopez: Morphy Defense",
              moves: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"],
            }),
          },
        }),
      );
    },
    15000,
  );

  // Task 43: the Suggested card's piece sequence is icons in move order now
  // (design/1-club-setup.png), not the old "White: P N B / Black: P N B"
  // text. Morphy Defense (e4 e5 Nf3 Nc6 Bb5 a6) -> White pawn, Black pawn,
  // White knight, Black knight, White bishop, Black pawn, in that order.
  it(
    "the Suggested card shows the piece sequence as icons in move order, White then Black each ply",
    async () => {
      const { user } = await renderScreen();
      await user.click(screen.getByRole("button", { name: "All" }));
      await user.click(screen.getByText("Ruy Lopez").closest("button")!);

      const card = document.querySelector(".suggested-card") as HTMLElement;
      const icons = [...card.querySelectorAll(".piece-sequence-icon")];
      expect(icons.map((el) => el.getAttribute("title"))).toEqual([
        "White Pawn",
        "Black Pawn",
        "White Knight",
        "Black Knight",
        "White Bishop",
        "Black Pawn",
      ]);
      expect(screen.queryByText(/White:/)).toBeNull(); // the old letter-code text is gone
    },
    15000,
  );

  it("expanding Ruy Lopez lists its variations, and selecting one updates the Suggested card (Task 39)", async () => {
    const { user } = await renderScreen();
    await user.click(screen.getByRole("button", { name: "All" }));
    const familyButton = screen.getByText("Ruy Lopez").closest("button")!;
    await user.click(familyButton); // expands AND selects the representative line

    expect(familyButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Ruy Lopez: Bird Variation")).toBeInTheDocument(); // a named variation, listed

    await user.click(screen.getByText("Ruy Lopez: Bird Variation").closest("button")!);

    const card = document.querySelector(".suggested-card") as HTMLElement;
    expect(within(card).getByRole("heading", { level: 2, name: "Ruy Lopez" })).toBeInTheDocument();
    expect(within(card).getByText("Bird Variation")).toBeInTheDocument();
    expect(within(card).getByText("1. e4 e5 2. Nf3 Nc6 3. Bb5 Nd4")).toBeInTheDocument();
  });

  it("Place your King now lists only QBs", async () => {
    const { user } = await renderScreen();
    await user.click(screen.getByLabelText("Place your King now"));

    const select = await screen.findByLabelText("White's QB");
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent ?? "");

    expect(options.some((text) => text.startsWith("Joe Burrow"))).toBe(true); // a real QB
    expect(options.some((text) => text.startsWith("Christian McCaffrey"))).toBe(false); // a real RB
    expect(options.some((text) => text.startsWith("Jaxon Smith-Njigba"))).toBe(false); // a real WR
  });

  it("Let him emerge (the default) shows no QB picker", async () => {
    await renderScreen();
    expect(screen.queryByLabelText("White's QB")).not.toBeInTheDocument();
  });

  it("disables Play this and Play your own opening in Placed King mode until a QB is chosen", async () => {
    const { user } = await renderScreen();
    await user.click(screen.getByLabelText("Place your King now"));

    expect(screen.getByRole("button", { name: "Play this" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "(Play your own opening)" })).toBeDisabled();

    const select = await screen.findByLabelText("White's QB");
    const qbOption = Array.from(select.querySelectorAll("option")).find((o) => (o.textContent ?? "").startsWith("Joe Burrow"))!;
    await user.selectOptions(select, qbOption.value);

    expect(screen.getByRole("button", { name: "Play this" })).not.toBeDisabled();
  });

  it("Play this hands back the full chosen setup (preset, King mode, opening)", async () => {
    const { onChoose, user } = await renderScreen();
    await user.click(screen.getByRole("button", { name: "Play this" }));

    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: H2H,
        kingMode: KingMode.EMERGE,
        whiteKing: null,
        blackKing: null,
      }),
    );
  });
});
