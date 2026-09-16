import { describe, expect, test } from "bun:test";
import { parseOfficeRunReadArgv } from "../../src/tools/office/local-office-read-spec";

describe("parseOfficeRunReadArgv", () => {
  test("parses get /body with depth and json", () => {
    const parsed = parseOfficeRunReadArgv(["get", "/body", "--depth", "6", "--json"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.spec).toEqual({
        verb: "get",
        target: "/body",
        depth: 6,
        json: true,
      });
    }
  });

  test("rejects unsupported flags", () => {
    const parsed = parseOfficeRunReadArgv(["get", "/body", "--evil"]);
    expect(parsed.ok).toBe(false);
  });
});
