import { describe, test, expect } from "bun:test";
import {
  shouldRecordCheckpoint,
  conflictReason,
  CHECKPOINT_COALESCE_MS,
} from "../../src/tools/file/user-save";

describe("shouldRecordCheckpoint (M180)", () => {
  const now = new Date("2026-06-19T12:00:00.000Z");

  test("returns false when checkpoint is false", () => {
    expect(shouldRecordCheckpoint(false, null, now)).toBe(false);
    expect(shouldRecordCheckpoint(false, now, now)).toBe(false);
  });

  test("returns true when checkpoint is true and no recent row", () => {
    expect(shouldRecordCheckpoint(true, null, now)).toBe(true);
  });

  test("returns false when last checkpoint is under five minutes ago", () => {
    const recent = new Date(now.getTime() - CHECKPOINT_COALESCE_MS + 1_000);
    expect(shouldRecordCheckpoint(true, recent, now)).toBe(false);
  });

  test("returns true when last checkpoint is at least five minutes ago", () => {
    const old = new Date(now.getTime() - CHECKPOINT_COALESCE_MS);
    expect(shouldRecordCheckpoint(true, old, now)).toBe(true);
  });
});

describe("conflictReason (M180)", () => {
  const currentSha = "a".repeat(64);

  test("returns null when no base tokens are set", () => {
    expect(
      conflictReason({
        baseRevision: null,
        rowRevision: 3,
        baseSha256: null,
        currentSha256: currentSha,
      }),
    ).toBeNull();
  });

  test("revision mismatch wins before sha mismatch", () => {
    expect(
      conflictReason({
        baseRevision: 1,
        rowRevision: 2,
        baseSha256: "deadbeef",
        currentSha256: currentSha,
      }),
    ).toBe("revision");
  });

  test("sha mismatch when revision guard is skipped", () => {
    expect(
      conflictReason({
        baseRevision: null,
        rowRevision: 2,
        baseSha256: "deadbeef",
        currentSha256: currentSha,
      }),
    ).toBe("sha");
  });

  test("null baseRevision skips revision guard even when row differs", () => {
    expect(
      conflictReason({
        baseRevision: null,
        rowRevision: 99,
        baseSha256: null,
        currentSha256: currentSha,
      }),
    ).toBeNull();
  });

  test("matching base tokens produce no conflict", () => {
    expect(
      conflictReason({
        baseRevision: 4,
        rowRevision: 4,
        baseSha256: currentSha,
        currentSha256: currentSha,
      }),
    ).toBeNull();
  });
});
