import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// vitest.config.ts doesn't enable `test.globals`, so RTL's own
// auto-cleanup (which looks for a global `afterEach`) never fires on its
// own -- without this, each test's render() stacks on top of the last
// test's DOM instead of starting fresh.
afterEach(cleanup);
