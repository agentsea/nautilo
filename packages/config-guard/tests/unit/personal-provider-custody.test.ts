import { expect, test } from "bun:test";
import { getModeReport } from "../../src/index";
import { MODE_REGISTRY } from "../../src/mode-registry";

const value = JSON.stringify({ formatVersion: 1, keyId: "de977e5c-c81c-4e80-9b5b-ad25083ca542", keyHex: "ab".repeat(32) });
const resetValue = JSON.stringify({
  formatVersion: 1,
  keyId: "de977e5c-c81c-4e80-9b5b-ad25083ca542",
  keyHex: "ab".repeat(32),
  resetFromKeyId: "c58029f9-5fad-4ab4-93b1-d4f8e62b3f83",
});
test("custody diagnostics expose presence only, never a prefix or key identity", () => {
  const report = getModeReport({ NAUTILO_PERSONAL_PROVIDER_CUSTODY: value });
  const row = report.entries.find((entry) => entry.envVar === "NAUTILO_PERSONAL_PROVIDER_CUSTODY");
  expect(row?.value).toBe("[configured]");
  expect(row?.redacted).toBe(true);
  expect(JSON.stringify(report)).not.toContain("abababab");
  expect(JSON.stringify(report)).not.toContain("de977e5c");
});
test("custody mode validation rejects malformed structure without echoing input", () => {
  const def = MODE_REGISTRY.find((entry) => entry.envVar === "NAUTILO_PERSONAL_PROVIDER_CUSTODY")!;
  expect(def.validator(value)).toBeNull();
  expect(def.validator(resetValue)).toBeNull();
  expect(def.validator(JSON.stringify({
    formatVersion: 1,
    keyId: "de977e5c-c81c-4e80-9b5b-ad25083ca542",
    keyHex: "ab".repeat(32),
    resetFromKeyId: "de977e5c-c81c-4e80-9b5b-ad25083ca542",
  }))).not.toBeNull();
  expect(def.validator("private-sentinel")).toBe("invalid personal provider custody envelope");
  expect(def.validator(JSON.stringify({ formatVersion: 1, keyId: "wrong", keyHex: "ab".repeat(32) }))).not.toBeNull();
});
