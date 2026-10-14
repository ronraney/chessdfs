// @vitest-environment jsdom
// Task 36: the Club/Slate toggle shown in the header of every screen.
// test-setup.ts gives every test a default window.matchMedia that reports
// "no preference" (Club); these tests override it per-case to cover the
// "default follows the device setting" requirement.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { getSavedTheme } from "./theme";
import ThemeToggle from "./ThemeToggle";

function mockDevicePrefersDark(matches: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  mockDevicePrefersDark(false);
});

describe("ThemeToggle", () => {
  it("defaults to Club when the device has no saved choice and prefers light", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Club" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Slate" })).toHaveAttribute("aria-pressed", "false");
  });

  it("defaults to Slate when the device prefers dark and no choice is saved", () => {
    mockDevicePrefersDark(true);
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Slate" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Club" })).toHaveAttribute("aria-pressed", "false");
  });

  it("switching to Slate updates the toggle and <html data-theme>", async () => {
    render(<ThemeToggle />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Slate" }));

    expect(screen.getByRole("button", { name: "Slate" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Club" })).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement.getAttribute("data-theme")).toBe("slate");
  });

  it("the choice survives a reload (persisted in storage, re-read on a fresh mount)", async () => {
    render(<ThemeToggle />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Slate" }));
    expect(getSavedTheme()).toBe("slate");

    // A reload re-runs main.tsx's bootstrap (applyTheme(getSavedTheme()))
    // and mounts a fresh component tree -- simulated here by clearing the
    // DOM-side effect of the old mount and mounting a brand new instance.
    document.documentElement.removeAttribute("data-theme");
    render(<ThemeToggle />);

    const slateButtons = screen.getAllByRole("button", { name: "Slate" });
    expect(slateButtons[slateButtons.length - 1]).toHaveAttribute("aria-pressed", "true");
  });

  it("switching back to Club clears the dark preference", async () => {
    mockDevicePrefersDark(true);
    render(<ThemeToggle />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Club" }));

    expect(screen.getByRole("button", { name: "Club" })).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.getAttribute("data-theme")).toBe("club");
    expect(getSavedTheme()).toBe("club");
  });
});
