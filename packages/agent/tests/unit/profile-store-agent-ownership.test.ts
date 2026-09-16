import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("profile-store Agent ownership", () => {
  test("fallback policy writes use the canonical Agent profile key", () => {
    const source = readFileSync(
      new URL("../../src/store/profile-store.ts", import.meta.url),
      "utf8",
    );
    const writer = source.slice(
      source.indexOf("export async function updateFallbackPolicy"),
      source.indexOf("export function assertValidVoiceLangKey"),
    );

    expect(writer).toContain("agentId: string");
    expect(writer).toContain("where(eq(profiles.agentId, agentId))");
    expect(writer).not.toContain("where(eq(profiles.userId");
  });
});
