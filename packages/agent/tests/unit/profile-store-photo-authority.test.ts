/** D487 — generic profile mutation must not be an Agent-photo writer. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("profile-store Agent-photo authority", () => {
  test("UpsertProfileInput and its conflict update cannot mutate avatarRef", () => {
    const source = readFileSync(
      new URL("../../src/store/profile-store.ts", import.meta.url),
      "utf8",
    );
    const input = source.slice(
      source.indexOf("export interface UpsertProfileInput"),
      source.indexOf("export async function getProfile"),
    );
    const upsert = source.slice(
      source.indexOf("export async function upsertProfile"),
      source.indexOf("function mapProfile"),
    );
    expect(input).not.toContain("avatar?:");
    expect(upsert).not.toContain("data.avatar");
    expect(upsert).not.toContain("avatarRef: data");
    expect(upsert).toContain("avatarRef: null");
  });
});
