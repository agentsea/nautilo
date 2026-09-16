import { describe, expect, test } from "bun:test";
import { shouldClearWorkSurfaceForAuth } from "../../src/layouts/work-surface-auth";

describe("work surface auth gating", () => {
  test("clears an open reader when auth becomes unverified", () => {
    expect(shouldClearWorkSurfaceForAuth("file", false)).toBe(true);
  });

  test("clears an open app when auth becomes unverified", () => {
    expect(shouldClearWorkSurfaceForAuth("app", false)).toBe(true);
  });

  test("keeps reader state for verified users and ignores empty state", () => {
    expect(shouldClearWorkSurfaceForAuth("file", true)).toBe(false);
    expect(shouldClearWorkSurfaceForAuth("none", false)).toBe(false);
  });
});
