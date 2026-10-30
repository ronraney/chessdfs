import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// vitest.config.ts doesn't enable `test.globals`, so RTL's own
// auto-cleanup (which looks for a global `afterEach`) never fires on its
// own -- without this, each test's render() stacks on top of the last
// test's DOM instead of starting fresh.
afterEach(cleanup);

// Rule change "Pick lists must keep the lineup completable": a pick
// list's own eligibility check now runs a real LP solve per distinct
// remaining-slots shape -- cheap on its own, but it adds up across a real
// interaction test's own many bare `waitFor(() => ...)` calls (the
// default 1000ms asyncUtilTimeout), under this project's own documented
// CPU/RAM-constrained worker cap (vite.config.ts). Same "extend to match
// real cost" precedent as that file's own testTimeout/hookTimeout bump,
// just for RTL's own internal polling instead of Vitest's per-test clock.
configure({ asyncUtilTimeout: 8000 });

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

// jsdom doesn't implement ResizeObserver at all -- BuildBoard (board-bounds
// re-measure bug fix) constructs one on every mount. A no-op default keeps
// every other test (which doesn't care about resize behavior) from
// throwing; the one test that does care replaces this global itself to
// capture the callback.
if (typeof window !== "undefined" && typeof window.ResizeObserver !== "function") {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver;
}
