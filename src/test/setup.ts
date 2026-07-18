import { afterEach } from "vitest";

// Component tests run under jsdom (opted into per file). Unmount between tests
// so effect cleanups actually run — several of our regression tests assert on
// exactly that.
if (typeof document !== "undefined") {
  const { cleanup } = await import("@testing-library/react");
  afterEach(cleanup);
}
