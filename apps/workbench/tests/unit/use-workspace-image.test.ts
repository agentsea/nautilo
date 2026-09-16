/**
 * Pure helpers from `use-workspace-image.ts`. The hook is live-verified
 * in Electron; this file covers error strings and Blob URL cache reset.
 */

import { describe, expect, test } from "bun:test";
import {
  _resetWorkspaceImageCache,
  describeLoadError,
  getCachedImage,
} from "../../src/components/tool-card/renderers/use-workspace-image";

describe("describeLoadError", () => {
  test("Error uses message", () => {
    expect(describeLoadError(new Error("boom"))).toBe("boom");
  });

  test("string coerces via String()", () => {
    expect(describeLoadError("plain")).toBe("plain");
  });

  test("undefined becomes literal undefined", () => {
    expect(describeLoadError(undefined)).toBe("undefined");
  });
});

describe("workspace image cache", () => {
  test("after reset, lookup is empty", () => {
    _resetWorkspaceImageCache();
    expect(getCachedImage("/x")).toBeUndefined();
  });
});
