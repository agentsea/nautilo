import { describe, test, expect } from "bun:test";
import { validateSemanticRecord, validateGenieLiveV1, validateArtifactMediaEntry, validateArtifactMediaManifest } from "../../src/semantic/validate";
import { MEMORY_RECORD_TYPE_MAX_UTF8_BYTES } from "../../src/semantic/types";
import { errorCodes } from "../../src/errors";
import { validGenieLiveV1, validArtifactRecord, validArtifactMediaManifest, v1AvatarOnlyBundle, v1LegacyMemoryBundle } from "../fixtures/valid";
import {
  malformedRecordUnknownKind,
  malformedRecordForbiddenIdField,
  malformedRecordForbiddenAgentId,
  malformedRecordSharedMemoryScope,
  malformedRecordBadField,
  malformedGenieLiveBadSemanticMajor,
  malformedGenieLiveBadBundleId,
  malformedGenieLiveUnknownScope,
  malformedGenieLiveEmptyRecords,
  malformedArtifactBadSha,
  malformedArtifactBadSize,
  malformedArtifactBadLogicalPath,
  malformedArtifactBytesEntryTraversal,
  malformedArtifactBytesEntryAbsolute,
  malformedArtifactBytesEntryBackslash,
  malformedArtifactBytesEntryNoPrefix,
  malformedArtifactBytesEntryShortOpaqueId,
  malformedArtifactBytesEntryMissingSuffix,
  malformedMediaEntryBadPath,
  malformedMediaEntryBadSha,
  malformedMediaEntryBadSize,
  malformedMediaEntryOversized,
  malformedArtifactMediaBadVersion,
  malformedArtifactMediaDuplicatePath,
  malformedArtifactMissingMediaEntry,
  malformedArtifactOrphanMediaEntry,
  malformedArtifactDuplicateBytesEntry,
  malformedArtifactMediaMismatch,
  malformedArtifactNoMediaManifest,
} from "../fixtures/malformed";

describe("validateSemanticRecord", () => {
  test("accepts every record in the valid fixture", () => {
    for (const rec of validGenieLiveV1.records) {
      const r = validateSemanticRecord(rec);
      if (!r.ok) {
        console.error(JSON.stringify(r.errors, null, 2));
      }
      expect(r.ok).toBe(true);
    }
  });

  test("rejects unknown recordKind", () => {
    const r = validateSemanticRecord(malformedRecordUnknownKind);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "SEMANTIC_RECORD_UNKNOWN_KIND")).toBe(true);
  });

  test("rejects forbidden id field", () => {
    const r = validateSemanticRecord(malformedRecordForbiddenIdField);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SEMANTIC_RECORD_FORBIDDEN_FIELD");
  });

  test("rejects forbidden agentId field on memory", () => {
    const r = validateSemanticRecord(malformedRecordForbiddenAgentId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SEMANTIC_RECORD_FORBIDDEN_FIELD");
  });

  test("rejects shared memory scope", () => {
    const r = validateSemanticRecord(malformedRecordSharedMemoryScope);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SEMANTIC_RECORD_FIELD_INVALID");
  });

  test("rejects bad field type", () => {
    const r = validateSemanticRecord(malformedRecordBadField);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SEMANTIC_RECORD_FIELD_INVALID");
  });

  test("rejects non-object", () => {
    expect(validateSemanticRecord(42).ok).toBe(false);
    expect(validateSemanticRecord(null).ok).toBe(false);
    expect(validateSemanticRecord("identity").ok).toBe(false);
  });

  test("requires one bounded confidential Memory type for current v1.1 records", () => {
    const memory = {
      recordKind: "memory",
      scope: "private",
      type: "general",
      content: "Portable confidential content",
      createdAt: null,
    } as const;
    expect(validateSemanticRecord(memory).ok).toBe(true);
    expect(validateSemanticRecord({
      ...memory,
      type: "🧠".repeat(MEMORY_RECORD_TYPE_MAX_UTF8_BYTES / 4),
    }).ok).toBe(true);
    for (const type of [
      undefined,
      null,
      1,
      "",
      "x".repeat(MEMORY_RECORD_TYPE_MAX_UTF8_BYTES + 1),
      "🧠".repeat(MEMORY_RECORD_TYPE_MAX_UTF8_BYTES / 4 + 1),
    ]) {
      const candidate = { ...memory, type };
      if (type === undefined) delete (candidate as { type?: unknown }).type;
      expect(validateSemanticRecord(candidate).ok).toBe(false);
    }
    expect(validateSemanticRecord({ ...memory, extra: true }).ok).toBe(false);
  });
});

describe("validateGenieLiveV1", () => {
  test("accepts the valid fixture", () => {
    expect(validateGenieLiveV1(validGenieLiveV1).ok).toBe(true);
  });

  test("rejects unsupported semantic major", () => {
    const r = validateGenieLiveV1(malformedGenieLiveBadSemanticMajor);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("UNSUPPORTED_SEMANTIC_VERSION");
  });

  test("rejects malformed bundleId", () => {
    const r = validateGenieLiveV1(malformedGenieLiveBadBundleId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("BUNDLE_ID_INVALID");
  });

  test("rejects unknown scope", () => {
    const r = validateGenieLiveV1(malformedGenieLiveUnknownScope);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("UNSUPPORTED_SCOPE");
  });

  test("rejects empty records", () => {
    const r = validateGenieLiveV1(malformedGenieLiveEmptyRecords);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SEMANTIC_RECORD_EMPTY");
  });

  test("validates Memory fields against the exact semantic minor", () => {
    const common = {
      bundleId: "memory-bundle-001",
      scopes: ["privateMemories"],
    } as const;
    const legacyMemory = {
      recordKind: "memory",
      scope: "private",
      content: "Legacy private content",
      createdAt: null,
    } as const;
    const currentMemory = { ...legacyMemory, type: "general" } as const;

    expect(validateGenieLiveV1({
      ...common,
      semanticVersion: { major: 1, minor: 0 },
      records: [legacyMemory],
    }).ok).toBe(true);
    expect(validateGenieLiveV1({
      ...common,
      semanticVersion: { major: 1, minor: 0 },
      records: [currentMemory],
    }).ok).toBe(false);
    expect(validateGenieLiveV1({
      ...common,
      semanticVersion: { major: 1, minor: 1 },
      records: [currentMemory],
    }).ok).toBe(true);
    expect(validateGenieLiveV1({
      ...common,
      semanticVersion: { major: 1, minor: 1 },
      records: [legacyMemory],
    }).ok).toBe(false);
    expect(validateGenieLiveV1({
      ...common,
      semanticVersion: { major: 1, minor: 2 },
      records: [currentMemory],
    }).ok).toBe(false);
  });
});

describe("v1 read compatibility (format v2 reader MUST accept v1 bundles)", () => {
  test("accepts a v1 avatar-only bundle with no artifactMedia", () => {
    expect(validateGenieLiveV1(v1AvatarOnlyBundle).ok).toBe(true);
  });

  test("accepts an explicitly typed legacy v1.0 Memory bundle", () => {
    expect(validateGenieLiveV1(v1LegacyMemoryBundle).ok).toBe(true);
  });

  test("accepts the v2 valid fixture (artifact + media manifest, 1:1)", () => {
    expect(validateGenieLiveV1(validGenieLiveV1).ok).toBe(true);
  });
});

describe("validateSemanticRecord — artifact record (format v2)", () => {
  test("accepts the valid artifact record", () => {
    expect(validateSemanticRecord(validArtifactRecord).ok).toBe(true);
  });

  test("rejects bad sha256", () => {
    const r = validateSemanticRecord(malformedArtifactBadSha);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SEMANTIC_RECORD_FIELD_INVALID");
  });

  test("rejects negative size", () => {
    const r = validateSemanticRecord(malformedArtifactBadSize);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SEMANTIC_RECORD_FIELD_INVALID");
  });

  test("rejects unsafe logical path", () => {
    const r = validateSemanticRecord(malformedArtifactBadLogicalPath);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_PATH_INVALID");
  });

  test("rejects traversal bytesEntry", () => {
    const r = validateSemanticRecord(malformedArtifactBytesEntryTraversal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_PATH_INVALID");
  });

  test("rejects absolute bytesEntry", () => {
    const r = validateSemanticRecord(malformedArtifactBytesEntryAbsolute);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_PATH_INVALID");
  });

  test("rejects backslash bytesEntry", () => {
    const r = validateSemanticRecord(malformedArtifactBytesEntryBackslash);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_PATH_INVALID");
  });

  test("rejects bytesEntry without media/artifacts/ prefix", () => {
    const r = validateSemanticRecord(malformedArtifactBytesEntryNoPrefix);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_PATH_INVALID");
  });

  test("rejects bytesEntry with short opaque-id", () => {
    const r = validateSemanticRecord(malformedArtifactBytesEntryShortOpaqueId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_PATH_INVALID");
  });

  test("rejects bytesEntry missing .bin suffix", () => {
    const r = validateSemanticRecord(malformedArtifactBytesEntryMissingSuffix);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_PATH_INVALID");
  });
});

describe("validateArtifactMediaEntry", () => {
  test("accepts the valid media entry", () => {
    expect(validateArtifactMediaEntry(validArtifactMediaManifest.entries[0]).ok).toBe(true);
  });

  test("rejects bad path", () => {
    const r = validateArtifactMediaEntry(malformedMediaEntryBadPath);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_PATH_INVALID");
  });

  test("rejects bad sha256", () => {
    const r = validateArtifactMediaEntry(malformedMediaEntryBadSha);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_SHA_INVALID");
  });

  test("rejects negative size", () => {
    const r = validateArtifactMediaEntry(malformedMediaEntryBadSize);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_SIZE_INVALID");
  });

  test("rejects oversized entry", () => {
    const r = validateArtifactMediaEntry(malformedMediaEntryOversized);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_SIZE_INVALID");
  });
});

describe("validateArtifactMediaManifest — 1:1 binding", () => {
  test("accepts the valid manifest against the valid artifact set", () => {
    const r = validateArtifactMediaManifest(validArtifactMediaManifest, [validArtifactRecord]);
    expect(r.ok).toBe(true);
  });

  test("rejects unsupported mediaVersion", () => {
    const r = validateArtifactMediaManifest(malformedArtifactMediaBadVersion, [validArtifactRecord]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_VERSION_UNSUPPORTED");
  });

  test("rejects duplicate media entry paths", () => {
    const r = validateArtifactMediaManifest(malformedArtifactMediaDuplicatePath, [validArtifactRecord]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_DUPLICATE");
  });

  test("rejects missing media entry for an artifact", () => {
    const r = validateArtifactMediaManifest({ mediaVersion: 2, entries: [] }, [validArtifactRecord]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_MISSING");
  });

  test("rejects orphan media entry with no artifact", () => {
    const r = validateArtifactMediaManifest(
      {
        mediaVersion: 2,
        entries: [
          { ...validArtifactMediaManifest.entries[0] },
          { path: "media/artifacts/orphan-001.bin", size: 10, sha256: "0".repeat(64) },
        ],
      },
      [validArtifactRecord],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_ORPHAN");
  });

  test("rejects duplicate bytesEntry across artifacts", () => {
    const r = validateArtifactMediaManifest(validArtifactMediaManifest, [validArtifactRecord, validArtifactRecord]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_BYTES_ENTRY_DUPLICATE");
  });

  test("rejects size/sha256 mismatch between artifact and media entry", () => {
    const r = validateArtifactMediaManifest(
      { mediaVersion: 2, entries: [{ path: "media/artifacts/artifact-001.bin", size: 999, sha256: "f".repeat(64) }] },
      [validArtifactRecord],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_MISMATCH");
  });
});

describe("validateGenieLiveV1 — artifact media binding integration", () => {
  test("rejects missing media entry (artifact present, empty manifest)", () => {
    const r = validateGenieLiveV1(malformedArtifactMissingMediaEntry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_MISSING");
  });

  test("rejects orphan media entry", () => {
    const r = validateGenieLiveV1(malformedArtifactOrphanMediaEntry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_ORPHAN");
  });

  test("rejects duplicate bytesEntry across artifact records", () => {
    const r = validateGenieLiveV1(malformedArtifactDuplicateBytesEntry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_BYTES_ENTRY_DUPLICATE");
  });

  test("rejects size/sha256 mismatch", () => {
    const r = validateGenieLiveV1(malformedArtifactMediaMismatch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_MISMATCH");
  });

  test("rejects artifact records with no artifactMedia manifest at all", () => {
    const r = validateGenieLiveV1(malformedArtifactNoMediaManifest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_MISSING");
  });

  test("rejects duplicate media entry paths in a full payload", () => {
    const r = validateGenieLiveV1({
      ...validGenieLiveV1,
      artifactMedia: malformedArtifactMediaDuplicatePath,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_DUPLICATE");
  });
});
