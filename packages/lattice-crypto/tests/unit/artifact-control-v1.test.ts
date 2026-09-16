import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";

import { ARTIFACT_BLOB_MAX_FILE_BYTES_V1 } from "../../src/artifact/blob-v1.ts";
import {
  ARTIFACT_CONTROL_MAX_LOGICAL_PATH_BYTES_V1,
  ARTIFACT_CONTROL_MAX_MIME_TYPE_BYTES_V1,
  ARTIFACT_CONTROL_FORMAT_VERSION_V1,
  decodeArtifactControlV1,
  encodeArtifactControlV1,
  wipeArtifactControlV1,
} from "../../src/artifact/control-v1.ts";

const control = Object.freeze({
  formatVersion: ARTIFACT_CONTROL_FORMAT_VERSION_V1,
  artifactId: "11111111-1111-4111-8111-111111111111",
  artifactRevision: 2,
  blobGeneration: 1,
  blobDek: Uint8Array.from({ length: 32 }, (_, index) => index),
  logicalPath: "Research/Ångström.md",
  mimeType: "text/markdown",
  plaintextLength: 17,
  plaintextSha256: new Uint8Array(32).fill(0x11),
  blobId: "22222222-2222-4222-8222-222222222222",
  ciphertextLength: 211,
  ciphertextSha256: new Uint8Array(32).fill(0x22),
  chunkPlaintextBytes: 1_048_576,
  chunkCount: 1,
});

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const indexOfBytes = (haystack: Uint8Array, needle: Uint8Array): number => {
  for (let offset = 0; offset <= haystack.length - needle.length; offset++) {
    if (needle.every((byte, index) => haystack[offset + index] === byte)) {
      return offset;
    }
  }
  return -1;
};

describe("ArtifactControlV1", () => {
  test("requires the exact object shape and owns every secret byte field", () => {
    for (const malformed of [
      null,
      "control",
      { ...control, unexpected: true },
      {
        ...control,
        ciphertextSha256: undefined,
      },
    ]) {
      expect(() => encodeArtifactControlV1(
        malformed as unknown as typeof control,
      )).toThrow();
    }
    expect(() => encodeArtifactControlV1(null as unknown as typeof control))
      .toThrow("Artifact control must be an object");
    const { ciphertextSha256: _, ...missingCiphertextHash } = control;
    expect(() => encodeArtifactControlV1({
      ...missingCiphertextHash,
      wrongField: control.ciphertextSha256,
    } as unknown as typeof control)).toThrow(
      "Artifact control fields must be exact",
    );
    expect(() => encodeArtifactControlV1({
      ...control,
      formatVersion: 2 as 1,
    })).toThrow("Artifact control format version is unsupported");

    const coercibleUuid = {
      toString: () => control.artifactId,
    } as unknown as string;
    expect(() => encodeArtifactControlV1({
      ...control,
      artifactId: coercibleUuid,
    })).toThrow("Artifact id");

    const decoratedFunction = Object.assign(() => undefined, control);
    expect(() => encodeArtifactControlV1(
      decoratedFunction as unknown as typeof control,
    )).toThrow("Artifact control must be an object");

    const blobDek = new Uint8Array(32).fill(0x31);
    const plaintextSha256 = new Uint8Array(32).fill(0x32);
    const ciphertextSha256 = new Uint8Array(32).fill(0x33);
    const encoded = encodeArtifactControlV1({
      ...control,
      blobDek,
      plaintextSha256,
      ciphertextSha256,
    });
    expect(blobDek).toEqual(new Uint8Array(32).fill(0x31));
    expect(plaintextSha256).toEqual(new Uint8Array(32).fill(0x32));
    expect(ciphertextSha256).toEqual(new Uint8Array(32).fill(0x33));
    const decoded = decodeArtifactControlV1(encoded);
    decoded.blobDek[0] = 0xff;
    decoded.plaintextSha256[0] = 0xfe;
    decoded.ciphertextSha256[0] = 0xfd;
    expect(blobDek[0]).toBe(0x31);
    expect(plaintextSha256[0]).toBe(0x32);
    expect(ciphertextSha256[0]).toBe(0x33);
    wipeArtifactControlV1(decoded);
    expect(decoded.blobDek).toEqual(new Uint8Array(32));
    expect(decoded.plaintextSha256).toEqual(new Uint8Array(32));
    expect(decoded.ciphertextSha256).toEqual(new Uint8Array(32));
  });

  test("validates identifiers, counters, fixed bytes, and chunk agreement exactly", () => {
    const uuidCases = [
      `x${control.artifactId}`,
      `${control.artifactId}x`,
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      "11111111-1111-0111-8111-111111111111",
      "11111111-1111-4111-7111-111111111111",
    ];
    for (const artifactId of uuidCases) {
      expect(() => encodeArtifactControlV1({ ...control, artifactId }))
        .toThrow("Artifact id");
    }
    for (const blobId of [`x${control.blobId}`, `${control.blobId}x`]) {
      expect(() => encodeArtifactControlV1({ ...control, blobId }))
        .toThrow("Artifact blob id");
    }

    for (const [field, values] of [
      ["artifactRevision", [0, Number.MAX_SAFE_INTEGER + 1, 1.5, "1"]],
      ["blobGeneration", [0, Number.MAX_SAFE_INTEGER + 1, 1.5, "1"]],
      ["plaintextLength", [-1, 104_857_601, 1.5, "17"]],
      ["ciphertextLength", [0, ARTIFACT_BLOB_MAX_FILE_BYTES_V1 + 1, 1.5, "211"]],
      ["chunkCount", [0, 101, 1.5, "1"]],
    ] as const) {
      for (const value of values) {
        expect(() => encodeArtifactControlV1({
          ...control,
          [field]: value,
        } as unknown as typeof control)).toThrow();
      }
    }
    for (const field of ["blobDek", "plaintextSha256", "ciphertextSha256"] as const) {
      for (const value of [new Uint8Array(31), new Uint8Array(33), "bytes"]) {
        expect(() => encodeArtifactControlV1({
          ...control,
          [field]: value,
        } as unknown as typeof control)).toThrow(field === "blobDek" ? "blob DEK" : "SHA-256");
      }
    }
    expect(() => encodeArtifactControlV1({
      ...control,
      chunkPlaintextBytes: 1,
    } as unknown as typeof control)).toThrow("chunk plaintext size");
    expect(() => encodeArtifactControlV1({
      ...control,
      plaintextLength: 1_048_577,
      chunkCount: 1,
    })).toThrow("chunk count disagrees");

    expect(decodeArtifactControlV1(encodeArtifactControlV1({
      ...control,
      artifactRevision: Number.MAX_SAFE_INTEGER,
      blobGeneration: Number.MAX_SAFE_INTEGER,
      plaintextLength: 104_857_600,
      ciphertextLength: ARTIFACT_BLOB_MAX_FILE_BYTES_V1,
      chunkCount: 100,
    }))).toMatchObject({
      artifactRevision: Number.MAX_SAFE_INTEGER,
      blobGeneration: Number.MAX_SAFE_INTEGER,
      plaintextLength: 104_857_600,
      ciphertextLength: ARTIFACT_BLOB_MAX_FILE_BYTES_V1,
      chunkCount: 100,
    });
  });

  test("normalizes and bounds every logical-path and MIME branch", () => {
    for (const logicalPath of [
      "",
      "/",
      "///",
      "/absolute",
      "back\\slash",
      "nul\0byte",
      ".",
      "..",
      "a/./b",
      "a/../b",
      42,
    ]) {
      expect(() => encodeArtifactControlV1({
        ...control,
        logicalPath: logicalPath as string,
      })).toThrow("Artifact logical path");
    }
    expect(decodeArtifactControlV1(encodeArtifactControlV1({
      ...control,
      logicalPath: "a///b",
    })).logicalPath).toBe("a/b");
    expect(decodeArtifactControlV1(encodeArtifactControlV1({
      ...control,
      logicalPath: "e\u0301.txt",
    })).logicalPath).toBe("é.txt");
    const maximumPath = "a".repeat(ARTIFACT_CONTROL_MAX_LOGICAL_PATH_BYTES_V1);
    expect(decodeArtifactControlV1(encodeArtifactControlV1({
      ...control,
      logicalPath: maximumPath,
    })).logicalPath).toBe(maximumPath);
    expect(() => encodeArtifactControlV1({
      ...control,
      logicalPath: "a".repeat(ARTIFACT_CONTROL_MAX_LOGICAL_PATH_BYTES_V1 + 1),
    })).toThrow("UTF-8 bytes bound");

    for (const mimeType of [
      "",
      "   ",
      "no-slash",
      "text/pla\u0000in",
      "text/pla\u001fin",
      "text/pla\u007fin",
      42,
    ]) {
      expect(() => encodeArtifactControlV1({
        ...control,
        mimeType: mimeType as string,
      })).toThrow("Artifact MIME type");
    }
    expect(decodeArtifactControlV1(encodeArtifactControlV1({
      ...control,
      mimeType: "  TEXT/MARKDOWN  ",
    })).mimeType).toBe("text/markdown");
    expect(decodeArtifactControlV1(encodeArtifactControlV1({
      ...control,
      mimeType: "/",
    })).mimeType).toBe("/");
    const maximumMime = `a/${"b".repeat(ARTIFACT_CONTROL_MAX_MIME_TYPE_BYTES_V1 - 2)}`;
    expect(decodeArtifactControlV1(encodeArtifactControlV1({
      ...control,
      mimeType: maximumMime,
    })).mimeType).toBe(maximumMime);
    expect(() => encodeArtifactControlV1({
      ...control,
      mimeType: `${maximumMime}b`,
    })).toThrow("UTF-8 bytes bound");
  });

  test("round-trips the confidential blob key and exact routing coordinates", () => {
    const encoded = encodeArtifactControlV1(control);
    const decoded = decodeArtifactControlV1(encoded);

    expect(decoded).toEqual(control);
    expect(encodeArtifactControlV1(decoded)).toEqual(encoded);
    expect(hex(sha256(encoded))).toBe(
      "9dd7708cbd0a9e22495c1ccc7d7f7b3301c27d9b2fa2aede7192f8976645d743",
    );
    expect(hex(encoded)).toBe(
      "0000001b6e617574696c6f2f61727469666163742d636f6e74726f6c2f7631"
        + "000000010000002431313131313131312d313131312d343131312d383131312d"
        + "3131313131313131313131310000000000000002000000000000000100000020"
        + "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
        + "0000001652657365617263682fc3856e67737472c3b66d2e6d640000000d7465"
        + "78742f6d61726b646f776e000000000000001100000020111111111111111111"
        + "1111111111111111111111111111111111111111111111000000243232323232"
        + "3232322d323232322d343232322d383232322d3232323232323232323232320000"
        + "0000000000d30000002022222222222222222222222222222222222222222222"
        + "222222222222222222220010000000000001",
    );
    wipeArtifactControlV1(decoded);
    expect(decoded.blobDek).toEqual(new Uint8Array(32));
  });

  test("normalizes paths and enforces UTF-8 byte bounds", () => {
    const encoded = encodeArtifactControlV1({
      ...control,
      logicalPath: "Research//Café.md",
    });
    expect(decodeArtifactControlV1(encoded).logicalPath).toBe(
      "Research/Café.md",
    );
    expect(() => encodeArtifactControlV1({
      ...control,
      logicalPath: "../secret.md",
    })).toThrow("relative path");
    expect(() => encodeArtifactControlV1({
      ...control,
      mimeType: "🫖".repeat(65),
    })).toThrow("UTF-8 bytes");
  });

  test("rejects key, hash, count, and canonical-byte substitutions", () => {
    expect(() => encodeArtifactControlV1({
      ...control,
      blobDek: new Uint8Array(31),
    })).toThrow("blob DEK");
    expect(() => encodeArtifactControlV1({
      ...control,
      plaintextSha256: new Uint8Array(31),
    })).toThrow("plaintext SHA-256");
    expect(() => encodeArtifactControlV1({
      ...control,
      chunkCount: 2,
    })).toThrow("chunk count");

    const trailing = new Uint8Array(encodeArtifactControlV1(control).length + 1);
    trailing.set(encodeArtifactControlV1(control));
    expect(() => decodeArtifactControlV1(trailing)).toThrow("trailing bytes");

    const encoded = encodeArtifactControlV1(control);

    const mimeBytes = new TextEncoder().encode(control.mimeType);
    const mimeOffset = indexOfBytes(encoded, mimeBytes);
    expect(mimeOffset).toBeGreaterThanOrEqual(0);
    const noncanonicalMime = encoded.slice();
    noncanonicalMime.set(new TextEncoder().encode("TEXT/MARKDOWN"), mimeOffset);
    expect(() => decodeArtifactControlV1(noncanonicalMime))
      .toThrow("bytes are noncanonical");

    const pathBytes = new TextEncoder().encode(control.logicalPath);
    const pathOffset = indexOfBytes(encoded, pathBytes);
    expect(pathOffset).toBeGreaterThanOrEqual(4);
    const duplicateSlashPath = new TextEncoder().encode(
      control.logicalPath.replace("/", "//"),
    );
    const noncanonicalPath = new Uint8Array(encoded.length + 1);
    noncanonicalPath.set(encoded.subarray(0, pathOffset), 0);
    new DataView(noncanonicalPath.buffer).setUint32(
      pathOffset - 4,
      duplicateSlashPath.length,
    );
    noncanonicalPath.set(duplicateSlashPath, pathOffset);
    noncanonicalPath.set(
      encoded.subarray(pathOffset + pathBytes.length),
      pathOffset + duplicateSlashPath.length,
    );
    expect(() => decodeArtifactControlV1(noncanonicalPath))
      .toThrow("bytes are noncanonical");

    const wrongDomain = encoded.slice();
    wrongDomain[4]! ^= 1;
    expect(() => decodeArtifactControlV1(wrongDomain))
      .toThrow("Artifact control domain is unsupported");
    const wrongChunkSize = encoded.slice();
    wrongChunkSize.set(Uint8Array.of(0, 0, 0, 1), wrongChunkSize.length - 8);
    expect(() => decodeArtifactControlV1(wrongChunkSize))
      .toThrow("Artifact control chunk plaintext size is unsupported");
    for (const malformed of [
      encoded.subarray(0, encoded.length - 1),
      Uint8Array.from(encoded, (byte, index) => index === 4 ? byte ^ 1 : byte),
      new Uint8Array(1_000_000),
    ]) {
      expect(() => decodeArtifactControlV1(malformed)).toThrow();
    }
    for (const malformed of [
      { ...control, artifactRevision: 0 },
      { ...control, blobGeneration: 0 },
      { ...control, plaintextLength: 104_857_601 },
      { ...control, ciphertextLength: 0 },
      { ...control, ciphertextLength: ARTIFACT_BLOB_MAX_FILE_BYTES_V1 + 1 },
      { ...control, logicalPath: "/absolute" },
      { ...control, logicalPath: "a/../b" },
      { ...control, mimeType: "no-slash" },
      { ...control, unexpected: true },
    ]) {
      expect(() => encodeArtifactControlV1(
        malformed as typeof control,
      )).toThrow();
    }
  });
});
