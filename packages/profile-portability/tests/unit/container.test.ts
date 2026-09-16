import { describe, test, expect } from "bun:test";
import {
  validateContainerHeader,
  validateFrame,
  validateFrameSequence,
  validateTerminalManifest,
  verifySemanticRoot,
  validateArtifactChunkFrame,
  validateArtifactTerminalFrame,
  validateArtifactChunkSequence,
  validateArtifactStreamManifest,
} from "../../src/container/validate";
import { errorCodes } from "../../src/errors";
import { validContainerHeaderV1, buildValidFramesAndManifest } from "../fixtures/valid";
import {
  malformedHeaderUnknownContainerVersion,
  malformedHeaderUnknownSuite,
  malformedHeaderPlaintextDowngrade,
  malformedHeaderChunkSizeTooSmall,
  malformedHeaderNoSlots,
  malformedHeaderTooManySlots,
  malformedFramesGap,
  malformedFramesDuplicate,
  malformedFramesNoFinal,
  malformedFramesMultipleFinal,
  malformedFramesFinalNotHighest,
  malformedFrameCiphertextOversized,
} from "../fixtures/malformed";

describe("validateContainerHeader", () => {
  test("accepts the valid header", () => {
    const r = validateContainerHeader(validContainerHeaderV1);
    if (!r.ok) console.error(JSON.stringify(r.errors, null, 2));
    expect(r.ok).toBe(true);
  });

  test("accepts legacy semantic minor 0 and rejects unknown future minors", () => {
    expect(validateContainerHeader({
      ...validContainerHeaderV1,
      semanticVersion: { major: 1, minor: 0 },
    }).ok).toBe(true);
    const future = validateContainerHeader({
      ...validContainerHeaderV1,
      semanticVersion: { major: 1, minor: 2 },
    });
    expect(future.ok).toBe(false);
    if (!future.ok) {
      expect(errorCodes(future)).toContain("UNSUPPORTED_SEMANTIC_VERSION");
    }
  });

  test("rejects unknown container version", () => {
    const r = validateContainerHeader(malformedHeaderUnknownContainerVersion);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("UNKNOWN_CONTAINER_VERSION");
  });

  test("rejects unknown protection suite", () => {
    const r = validateContainerHeader(malformedHeaderUnknownSuite);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("UNKNOWN_PROTECTION_SUITE");
  });

  test("rejects plaintext downgrade", () => {
    const r = validateContainerHeader(malformedHeaderPlaintextDowngrade);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("PLAINTEXT_DOWNGRADE");
  });

  test("rejects chunk size below minimum", () => {
    const r = validateContainerHeader(malformedHeaderChunkSizeTooSmall);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("CHUNK_SIZE_OUT_OF_BOUNDS");
  });

  test("rejects zero key slots", () => {
    const r = validateContainerHeader(malformedHeaderNoSlots);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SLOT_COUNT_OUT_OF_BOUNDS");
  });

  test("rejects too many key slots", () => {
    const r = validateContainerHeader(malformedHeaderTooManySlots);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SLOT_COUNT_OUT_OF_BOUNDS");
  });
});

describe("validateFrame / validateFrameSequence", () => {
  test("accepts the valid frame sequence", () => {
    const { frames } = buildValidFramesAndManifest();
    expect(validateFrameSequence(frames).ok).toBe(true);
  });

  test("rejects a single oversized frame", () => {
    const r = validateFrame(malformedFrameCiphertextOversized);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("FRAME_CIPHERTEXT_OVERSIZED");
  });

  test("rejects ordinal gap", () => {
    const r = validateFrameSequence(malformedFramesGap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("FRAME_ORDINAL_GAP");
  });

  test("rejects duplicate ordinal", () => {
    const r = validateFrameSequence(malformedFramesDuplicate);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("FRAME_ORDINAL_DUPLICATE");
  });

  test("rejects missing FINAL", () => {
    const r = validateFrameSequence(malformedFramesNoFinal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("FRAME_MISSING_FINAL");
  });

  test("rejects multiple FINAL", () => {
    const r = validateFrameSequence(malformedFramesMultipleFinal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("FRAME_MULTIPLE_FINAL");
  });

  test("rejects FINAL not highest ordinal", () => {
    const r = validateFrameSequence(malformedFramesFinalNotHighest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("FRAME_MISSING_FINAL");
  });
});

describe("validateTerminalManifest / verifySemanticRoot", () => {
  test("accepts the valid manifest and verifies its semantic root", () => {
    const { manifest } = buildValidFramesAndManifest();
    expect(validateTerminalManifest(manifest).ok).toBe(true);
    expect(verifySemanticRoot(manifest).ok).toBe(true);
  });

  test("detects a tampered semantic root", () => {
    const { manifest } = buildValidFramesAndManifest();
    const tampered = { ...manifest, semanticRoot: "0".repeat(64) };
    const r = verifySemanticRoot(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SEMANTIC_ROOT_MISMATCH");
  });

  test("detects a tampered per-record hash", () => {
    const { manifest } = buildValidFramesAndManifest();
    const tampered = {
      ...manifest,
      records: manifest.records.map((r, i) => (i === 0 ? { ...r, sha256: "f".repeat(64) } : r)),
    };
    const r = verifySemanticRoot(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("SEMANTIC_ROOT_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// Wave 3 — format v2 artifact-byte chunk frame validators
// ---------------------------------------------------------------------------

const ENTRY = "media/artifacts/artifact-001.bin";

function validChunkFrame(overrides: Partial<{ ordinal: number; final: boolean; entryPath: string }> = {}): unknown {
  return {
    frameType: "artifact-chunk",
    mediaVersion: 2,
    entryPath: overrides.entryPath ?? ENTRY,
    ordinal: overrides.ordinal ?? 0,
    final: overrides.final ?? true,
    plaintextLength: 8,
    nonce: new Uint8Array(24),
    aad: new Uint8Array(64),
    ciphertext: new Uint8Array(24), // 8 plaintext + 16 tag
  };
}

function validTerminalFrame(): unknown {
  return {
    frameType: "artifact-manifest",
    mediaVersion: 2,
    ordinal: 0,
    final: true,
    plaintextLength: 64,
    nonce: new Uint8Array(24),
    aad: new Uint8Array(64),
    ciphertext: new Uint8Array(80), // 64 + 16
  };
}

describe("validateArtifactChunkFrame", () => {
  test("accepts a well-formed chunk frame", () => {
    expect(validateArtifactChunkFrame(validChunkFrame()).ok).toBe(true);
  });

  test("rejects a bad entry path", () => {
    const r = validateArtifactChunkFrame(validChunkFrame({ entryPath: "media/artifacts/bad!.bin" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_PATH_INVALID");
  });

  test("rejects a negative ordinal", () => {
    const r = validateArtifactChunkFrame(validChunkFrame({ ordinal: -1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("FRAME_ORDINAL_OUT_OF_RANGE");
  });

  test("rejects a ciphertext shorter than the tag", () => {
    const f = validChunkFrame() as Record<string, unknown>;
    f["ciphertext"] = new Uint8Array(8);
    const r = validateArtifactChunkFrame(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("FRAME_MALFORMED");
  });

  test("rejects a wrong-size nonce", () => {
    const f = validChunkFrame() as Record<string, unknown>;
    f["nonce"] = new Uint8Array(16);
    const r = validateArtifactChunkFrame(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("FRAME_MALFORMED");
  });
});

describe("validateArtifactTerminalFrame", () => {
  test("accepts a well-formed terminal frame", () => {
    expect(validateArtifactTerminalFrame(validTerminalFrame()).ok).toBe(true);
  });

  test("rejects a terminal frame with final=false", () => {
    const f = validTerminalFrame() as Record<string, unknown>;
    f["final"] = false;
    const r = validateArtifactTerminalFrame(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("FRAME_MISSING_FINAL");
  });
});

describe("validateArtifactChunkSequence", () => {
  test("accepts a contiguous 0..N-1 sequence with one final at the highest ordinal", () => {
    const frames = [
      validChunkFrame({ ordinal: 0, final: false }),
      validChunkFrame({ ordinal: 1, final: false }),
      validChunkFrame({ ordinal: 2, final: true }),
    ];
    expect(validateArtifactChunkSequence(frames).ok).toBe(true);
  });

  test("rejects an ordinal gap", () => {
    const frames = [
      validChunkFrame({ ordinal: 0, final: false }),
      validChunkFrame({ ordinal: 2, final: true }),
    ];
    const r = validateArtifactChunkSequence(frames);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("FRAME_ORDINAL_GAP");
  });

  test("rejects a duplicate ordinal", () => {
    const frames = [
      validChunkFrame({ ordinal: 0, final: false }),
      validChunkFrame({ ordinal: 0, final: true }),
    ];
    const r = validateArtifactChunkSequence(frames);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("FRAME_ORDINAL_DUPLICATE");
  });

  test("rejects a missing final chunk", () => {
    const frames = [
      validChunkFrame({ ordinal: 0, final: false }),
      validChunkFrame({ ordinal: 1, final: false }),
    ];
    const r = validateArtifactChunkSequence(frames);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("FRAME_MISSING_FINAL");
  });

  test("rejects multiple final chunks", () => {
    const frames = [
      validChunkFrame({ ordinal: 0, final: true }),
      validChunkFrame({ ordinal: 1, final: true }),
    ];
    const r = validateArtifactChunkSequence(frames);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("FRAME_MULTIPLE_FINAL");
  });

  test("rejects a final chunk that is not the highest ordinal", () => {
    const frames = [
      validChunkFrame({ ordinal: 0, final: true }),
      validChunkFrame({ ordinal: 1, final: false }),
    ];
    const r = validateArtifactChunkSequence(frames);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("FRAME_MISSING_FINAL");
  });
});

describe("validateArtifactStreamManifest", () => {
  test("accepts a well-formed manifest", () => {
    const manifest = {
      mediaVersion: 2,
      entries: [{ entryPath: ENTRY, size: 128, sha256: "0".repeat(64), chunkCount: 2 }],
    };
    expect(validateArtifactStreamManifest(manifest).ok).toBe(true);
  });

  test("rejects a duplicate entryPath", () => {
    const manifest = {
      mediaVersion: 2,
      entries: [
        { entryPath: ENTRY, size: 128, sha256: "0".repeat(64), chunkCount: 2 },
        { entryPath: ENTRY, size: 128, sha256: "0".repeat(64), chunkCount: 2 },
      ],
    };
    const r = validateArtifactStreamManifest(manifest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_DUPLICATE");
  });

  test("rejects a bad sha256", () => {
    const manifest = {
      mediaVersion: 2,
      entries: [{ entryPath: ENTRY, size: 128, sha256: "xyz", chunkCount: 2 }],
    };
    const r = validateArtifactStreamManifest(manifest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_SHA_INVALID");
  });

  test("rejects a bad mediaVersion", () => {
    const manifest = { mediaVersion: 0, entries: [] };
    const r = validateArtifactStreamManifest(manifest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorCodes(r)).toContain("ARTIFACT_MEDIA_VERSION_UNSUPPORTED");
  });
});
