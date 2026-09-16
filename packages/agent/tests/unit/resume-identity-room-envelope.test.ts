/**
 * M065 Risk #3 — resume path must map checkpoint `thread_id` →
 * `requestedRoomId` before `resolveContext` so the envelope matches the
 * room thread (source contract; graph execution is integration-tested elsewhere).
 * M075: membership-based lookup via `findRoomIdByGraphThreadIdForUser`.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const RESUME_PATH = resolve(THIS_DIR, "../../src/graph/resume-identity.ts");

describe("resume-identity.ts M065 room-aware envelope", () => {
  const source = readFileSync(RESUME_PATH, "utf-8");

  test("calls findRoomIdByGraphThreadIdForUser before resolveContext with requestedRoomId", () => {
    const iFind = source.indexOf("findRoomIdByGraphThreadIdForUser");
    const iResolve = source.indexOf("resolveContext");
    expect(iFind).toBeGreaterThanOrEqual(0);
    expect(iResolve).toBeGreaterThan(iFind);
    expect(source).toMatch(/requestedRoomId[\s\S]{0,120}resolveContext\(/);
  });
});
