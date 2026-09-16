/**
 * D275 — the tool-result cap is overridable via NAUTILO_TOOL_RESULT_MAX_BYTES.
 *
 * `TOOL_RESULT_MAX_BYTES` is resolved ONCE at module load, so it can't be
 * re-tested by mutating env after import. We test the pure resolver instead
 * (it takes the raw value as an arg), which is what runs at load time.
 */
import { describe, expect, test } from "bun:test";

import { resolveToolResultMaxBytes, TOOL_RESULT_MAX_BYTES } from "../../src/realtime";

describe("resolveToolResultMaxBytes", () => {
  test("uses a positive integer override", () => {
    expect(resolveToolResultMaxBytes("5000")).toBe(5_000);
  });

  test("falls back to default (10_000) when unset / empty", () => {
    expect(resolveToolResultMaxBytes(undefined)).toBe(10_000);
    expect(resolveToolResultMaxBytes("")).toBe(10_000);
  });

  test("falls back to default for non-positive / non-numeric values", () => {
    expect(resolveToolResultMaxBytes("0")).toBe(10_000);
    expect(resolveToolResultMaxBytes("-5")).toBe(10_000);
    expect(resolveToolResultMaxBytes("abc")).toBe(10_000);
  });

  test("the exported const is a positive number resolved at load", () => {
    expect(TOOL_RESULT_MAX_BYTES).toBeGreaterThan(0);
  });
});
