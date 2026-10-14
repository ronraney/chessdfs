import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// vitest.config.ts doesn't enable `test.globals`, so RTL's own
// auto-cleanup (which looks for a global `afterEach`) never fires on its
// own -- without this, each test's render() stacks on top of the last
// test's DOM instead of starting fresh.
afterEach(cleanup);

// jsdom doesn't implement window.matchMedia at all -- ThemeToggle (Task
// 36) calls it on every render (every screen now renders one, via its
// header), so every test that renders a screen would throw without this.
// Defaults to "no preference" (Club); theme-specific tests override it
// per-test for "device prefers dark" scenarios. Guarded by `typeof window`
// since this setup file also runs for the engine tests' plain node
// environment (no jsdom, no window at all -- see each engine test file's
// own header comment on why jsdom isn't the default).
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}
