import { describe, test, expect } from "bun:test";
import { normalizeHandleForAgentRosterMatch } from "@nautilo/trust";

describe("normalizeHandleForAgentRosterMatch (M078)", () => {
  test("strips @ and lowercases", () => {
    expect(normalizeHandleForAgentRosterMatch("@Alice")).toBe("alice");
  });

  test("trims whitespace", () => {
    expect(normalizeHandleForAgentRosterMatch("  Bob  ")).toBe("bob");
  });
});
