/**
 * D392 — generic vendored-binary verify-once gate (tool-agnostic).
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resetVendoredBinaryVerifyCache,
  sha256HexOfFile,
  verifyVendoredBinaryOnce,
  type VendoredBinaryVerifyPolicy,
} from "../../src/vendored-binary";

function writeBinary(name: string, bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "vendored-bin-"));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  if (process.platform !== "win32") chmodSync(path, 0o755);
  return path;
}

async function shaOf(bytes: Buffer): Promise<string> {
  const path = writeBinary("hash-me", bytes);
  return sha256HexOfFile(path);
}

describe("verifyVendoredBinaryOnce", () => {
  test("UNAVAILABLE when binaryPath is null", async () => {
    const cache = new Map<string, boolean>();
    const out = await verifyVendoredBinaryOnce({ binaryPath: null, cache, label: "Tool" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("UNAVAILABLE");
  });

  test("ok + shaChecked when the pinned sha matches", async () => {
    const cache = new Map<string, boolean>();
    const bytes = Buffer.from("generic-match-bytes");
    const path = writeBinary("tool", bytes);
    const out = await verifyVendoredBinaryOnce({
      binaryPath: path,
      expectedSha256: await shaOf(bytes),
      cache,
    });
    expect(out).toMatchObject({ ok: true, binaryPath: path, shaChecked: true });
    if (out.ok) expect(out.note).toBeUndefined();
  });

  test("trusts without hashing when no sha is pinned (shaChecked=false)", async () => {
    const path = writeBinary("tool", Buffer.from("unpinned"));

    // Explicit null.
    const withNull = await verifyVendoredBinaryOnce({
      binaryPath: path,
      expectedSha256: null,
      cache: new Map(),
    });
    expect(withNull).toMatchObject({ ok: true, shaChecked: false });

    // Omitted key.
    const omitted = await verifyVendoredBinaryOnce({ binaryPath: path, cache: new Map() });
    expect(omitted).toMatchObject({ ok: true, shaChecked: false });
  });

  test("strict policy REFUSES a mismatch", async () => {
    const cache = new Map<string, boolean>();
    const path = writeBinary("tool", Buffer.from("actual-bytes"));
    const out = await verifyVendoredBinaryOnce({
      binaryPath: path,
      expectedSha256: "a".repeat(64),
      policy: "strict",
      cache,
      label: "Tool",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("CHECKSUM_MISMATCH");
      expect(out.error).toContain(path);
    }
  });

  test("tolerate-signed policy TOLERATES a mismatch with a note", async () => {
    const cache = new Map<string, boolean>();
    const path = writeBinary("tool", Buffer.from("codesigned-bytes"));
    const out = await verifyVendoredBinaryOnce({
      binaryPath: path,
      expectedSha256: "b".repeat(64),
      policy: "tolerate-signed",
      cache,
      label: "Tool",
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.shaChecked).toBe(true);
      expect(out.note).toContain("signed-at-package");
    }
  });

  test("caches by path: a post-verify byte change is not re-hashed until reset", async () => {
    const cache = new Map<string, boolean>();
    const bytesA = Buffer.from("cache-A");
    const path = writeBinary("tool", bytesA);
    const expected = await shaOf(bytesA);

    const first = await verifyVendoredBinaryOnce({ binaryPath: path, expectedSha256: expected, cache });
    expect(first.ok).toBe(true);

    // Tamper after first verify; cache hit must not re-hash → still ok.
    writeFileSync(path, Buffer.from("cache-B-tampered"));
    const second = await verifyVendoredBinaryOnce({ binaryPath: path, expectedSha256: expected, cache });
    expect(second.ok).toBe(true);

    // After reset, strict re-hash of the tampered bytes refuses.
    resetVendoredBinaryVerifyCache(cache);
    const third = await verifyVendoredBinaryOnce({
      binaryPath: path,
      expectedSha256: expected,
      policy: "strict" as VendoredBinaryVerifyPolicy,
      cache,
    });
    expect(third.ok).toBe(false);
  });
});
