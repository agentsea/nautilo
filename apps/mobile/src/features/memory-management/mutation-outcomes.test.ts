/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { formatMakeMemoryPrivateOutcome, formatRevokeMemoryOutcome } from "./mutation-outcomes";

describe("memory access mutation outcomes", () => {
  test("formats a complete revoke as access removed", () => {
    expect(formatRevokeMemoryOutcome({ reHomed: 0, skipped: [] })).toBe("Access removed.");
  });

  test("formats a partial revoke without claiming every path changed", () => {
    expect(formatRevokeMemoryOutcome({ reHomed: 1, skipped: ["ns-family"] })).toBe(
      "1 access path re-homed. Not changed: ns-family.",
    );
  });

  test("formats a complete make-private result", () => {
    expect(formatMakeMemoryPrivateOutcome({ skipped: [] })).toBe("This memory is now private.");
  });

  test("formats a partial make-private result without an absolute claim", () => {
    const outcome = formatMakeMemoryPrivateOutcome({ skipped: ["ns-family"] });
    expect(outcome).toBe("Private access was added. Other access was not changed for: ns-family.");
    expect(outcome).not.toContain("now private");
  });
});
