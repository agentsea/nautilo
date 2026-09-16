import { describe, test, expect } from "bun:test";
import { validateArchiveEntry, validateArchiveManifest } from "../../src/container/manifest-allowlist";
import { errorCodes } from "../../src/errors";
import { validArchiveEntries } from "../fixtures/valid";
import {
  malformedArchiveUnknownPath,
  malformedArchiveTraversal,
  malformedArchiveAbsolute,
  malformedArchiveSymlink,
  malformedArchiveCompressed,
  malformedArchiveCompressionBomb,
  malformedArchiveEntryOversized,
  malformedArchiveDuplicate,
} from "../fixtures/malformed";

describe("validateArchiveEntry", () => {
  test("accepts every valid entry", () => {
    for (const e of validArchiveEntries) {
      expect(validateArchiveEntry(e).ok).toBe(true);
    }
  });

  test("rejects unknown path", () => {
    const r = validateArchiveEntry(malformedArchiveUnknownPath);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("MANIFEST_UNKNOWN_PATH");
  });

  test("rejects traversal", () => {
    const r = validateArchiveEntry(malformedArchiveTraversal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("MANIFEST_TRAVERSAL");
  });

  test("rejects absolute path", () => {
    const r = validateArchiveEntry(malformedArchiveAbsolute);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("MANIFEST_ABSOLUTE_PATH");
  });

  test("rejects symlink", () => {
    const r = validateArchiveEntry(malformedArchiveSymlink);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("MANIFEST_SYMLINK");
  });

  test("rejects compressed entry", () => {
    const r = validateArchiveEntry(malformedArchiveCompressed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("MANIFEST_COMPRESSION_NOT_ALLOWED");
  });

  test("rejects compression bomb", () => {
    const r = validateArchiveEntry(malformedArchiveCompressionBomb);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("MANIFEST_COMPRESSION_BOMB");
  });

  test("rejects oversized entry", () => {
    const r = validateArchiveEntry(malformedArchiveEntryOversized);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("MANIFEST_ENTRY_OVERSIZED");
  });
});

describe("validateArchiveManifest", () => {
  test("accepts the valid manifest", () => {
    expect(validateArchiveManifest(validArchiveEntries).ok).toBe(true);
  });

  test("rejects duplicate paths", () => {
    const r = validateArchiveManifest(malformedArchiveDuplicate);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("MANIFEST_DUPLICATE_PATH");
  });
});

describe("archive allowlist — format v2 artifact media paths", () => {
  test("accepts a media/artifacts/<opaque-id>.bin entry", () => {
    const r = validateArchiveEntry({
      path: "media/artifacts/artifact-001.bin",
      size: 128,
      compressedSize: 128,
      kind: "file",
      isCompressed: false,
    });
    expect(r.ok).toBe(true);
  });

  test("rejects a traversal path under media/artifacts/", () => {
    const r = validateArchiveEntry({
      path: "media/artifacts/../../etc/passwd.bin",
      size: 10,
      compressedSize: 10,
      kind: "file",
      isCompressed: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("MANIFEST_TRAVERSAL");
  });
});
