import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("Profile Soul revision writer", () => {
  const source = readFileSync(
    new URL("../../src/store/profile-store.ts", import.meta.url),
    "utf8",
  );
  const conflictUpdate = source.slice(
    source.indexOf(".onConflictDoUpdate({"),
    source.indexOf(".returning();", source.indexOf(".onConflictDoUpdate({")),
  );

  test("increments atomically only when supplied Soul content is distinct", () => {
    expect(conflictUpdate).toContain("data.soulFile !== undefined");
    expect(conflictUpdate).toContain("profiles.soulFile} IS DISTINCT FROM ${data.soulFile}");
    expect(conflictUpdate).toContain("profiles.soulRevision} + 1");
    expect(conflictUpdate).toContain("ELSE ${profiles.soulRevision} END");
  });

  test("unrelated Profile writers do not advance Soul revision", () => {
    for (const writer of ["updateFallbackPolicy", "upsertVoiceAssignment", "removeVoiceAssignment"]) {
      const start = source.indexOf(`export async function ${writer}`);
      const end = source.indexOf("\n}\n", start);
      expect(start).toBeGreaterThan(-1);
      expect(source.slice(start, end)).not.toContain("soulRevision");
    }
  });
});
