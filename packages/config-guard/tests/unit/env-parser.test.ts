import { describe, expect, test } from "bun:test";
import {
  parseEnvFile,
  serializeEnvFile,
  getValueFromEntries,
  setValueInEntries,
  removeKeyFromEntries,
} from "../../src/env-parser";

describe("env-parser", () => {
  test("round-trip preserves comments and blanks", () => {
    const src = "# hi\n\nFOO=bar\n";
    const entries = parseEnvFile(src);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(serializeEnvFile(entries)).toContain("# hi");
    expect(serializeEnvFile(entries)).toContain("FOO=bar");
  });

  test("set existing key updates in place", () => {
    const entries = parseEnvFile("A=1\n");
    const next = setValueInEntries(entries, "A", "2");
    expect(getValueFromEntries(next, "A")).toBe("2");
  });

  test("remove key", () => {
    const entries = parseEnvFile("A=1\nB=2\n");
    const next = removeKeyFromEntries(entries, "A");
    expect(getValueFromEntries(next, "A")).toBeUndefined();
    expect(getValueFromEntries(next, "B")).toBe("2");
  });

  test("quoted value", () => {
    const entries = parseEnvFile('X="a b"\n');
    expect(getValueFromEntries(entries, "X")).toBe("a b");
  });
});
