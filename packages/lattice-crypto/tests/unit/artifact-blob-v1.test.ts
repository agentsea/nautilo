import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
  ARTIFACT_BLOB_DEK_BYTES_V1,
  ARTIFACT_BLOB_FORMAT_VERSION_V1,
  ARTIFACT_BLOB_MAX_CHUNKS_V1,
  ARTIFACT_BLOB_MAX_FILE_BYTES_V1,
  ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES_V1,
  artifactBlobSealedChunkBytesV1,
  decodeArtifactBlobHeaderV1,
  deriveArtifactBlobChunkCountV1,
  encodeArtifactBlobChunkFrameV1,
  encodeArtifactBlobHeaderV1,
  generateArtifactBlobDekV1,
  openArtifactBlobChunkV1,
  openArtifactBlobRangeV1,
  sealArtifactBlobChunkV1,
  sealArtifactBlobV1,
} from "../../src/artifact/blob-v1.ts";

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

const header = Object.freeze({
  formatVersion: ARTIFACT_BLOB_FORMAT_VERSION_V1,
  artifactId: "11111111-1111-4111-8111-111111111111",
  blobId: "22222222-2222-4222-8222-222222222222",
  blobGeneration: 1,
  plaintextLength: 0,
  chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
  chunkCount: 1,
});

describe("ArtifactBlobV1", () => {
  test("pins every public size calculation and rejects non-counters", () => {
    expect(ARTIFACT_BLOB_MAX_FILE_BYTES_V1).toBe(104_862_512);
    expect(deriveArtifactBlobChunkCountV1(0)).toBe(1);
    expect(deriveArtifactBlobChunkCountV1(1)).toBe(1);
    expect(deriveArtifactBlobChunkCountV1(
      ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
    )).toBe(1);
    expect(deriveArtifactBlobChunkCountV1(
      ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + 1,
    )).toBe(2);
    expect(deriveArtifactBlobChunkCountV1(
      ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES_V1,
    )).toBe(ARTIFACT_BLOB_MAX_CHUNKS_V1);
    expect(artifactBlobSealedChunkBytesV1(0)).toBe(40);
    expect(artifactBlobSealedChunkBytesV1(
      ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
    )).toBe(ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + 40);

    for (const invalid of [
      -1,
      ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES_V1 + 1,
      1.5,
      Number.NaN,
      "1",
    ]) {
      expect(() => deriveArtifactBlobChunkCountV1(invalid as number))
        .toThrow("Artifact blob plaintext length");
    }
    for (const invalid of [
      -1,
      ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + 1,
      1.5,
      Number.NaN,
      "1",
    ]) {
      expect(() => artifactBlobSealedChunkBytesV1(invalid as number))
        .toThrow("Artifact blob chunk plaintext length");
    }
  });

  test("validates every header field and exact object shape", () => {
    const invalidHeaders = [
      null,
      "header",
      { ...header, unexpected: true },
      {
        formatVersion: header.formatVersion,
        artifactId: header.artifactId,
        blobId: header.blobId,
        blobGeneration: header.blobGeneration,
        plaintextLength: header.plaintextLength,
        chunkPlaintextBytes: header.chunkPlaintextBytes,
      },
    ];
    for (const invalid of invalidHeaders) {
      expect(() => encodeArtifactBlobHeaderV1(
        invalid as unknown as typeof header,
      )).toThrow();
    }
    expect(() => encodeArtifactBlobHeaderV1({
      artifactId: header.artifactId,
      blobGeneration: header.blobGeneration,
      blobId: header.blobId,
      chunkPlaintextBytes: header.chunkPlaintextBytes,
      formatVersion: header.formatVersion,
      plaintextLength: header.plaintextLength,
      wrongField: header.chunkCount,
    } as unknown as typeof header)).toThrow(
      "Artifact blob header fields must be exact",
    );
    expect(() => encodeArtifactBlobHeaderV1(null as unknown as typeof header))
      .toThrow("Artifact blob header must be an object");

    const coercibleUuid = {
      toString: () => header.artifactId,
    } as unknown as string;
    expect(() => encodeArtifactBlobHeaderV1({
      ...header,
      artifactId: coercibleUuid,
    })).toThrow("Artifact id");

    const decoratedFunction = Object.assign(() => undefined, header);
    expect(() => encodeArtifactBlobHeaderV1(
      decoratedFunction as unknown as typeof header,
    )).toThrow("Artifact blob header must be an object");

    const validUuid = header.artifactId;
    for (const artifactId of [
      `x${validUuid}`,
      `${validUuid}x`,
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      "11111111-1111-0111-8111-111111111111",
      "11111111-1111-4111-7111-111111111111",
    ]) {
      expect(() => encodeArtifactBlobHeaderV1({ ...header, artifactId }))
        .toThrow("Artifact id");
    }
    for (const blobId of [`x${header.blobId}`, `${header.blobId}x`]) {
      expect(() => encodeArtifactBlobHeaderV1({ ...header, blobId }))
        .toThrow("Artifact blob id");
    }
    for (const blobGeneration of [
      0,
      Number.MAX_SAFE_INTEGER + 1,
      1.5,
      "1",
    ]) {
      expect(() => encodeArtifactBlobHeaderV1({
        ...header,
        blobGeneration: blobGeneration as number,
      })).toThrow("Artifact blob generation");
    }
    expect(() => encodeArtifactBlobHeaderV1({
      ...header,
      chunkCount: 0,
    })).toThrow("Artifact blob chunk count");
    expect(() => encodeArtifactBlobHeaderV1({
      ...header,
      chunkCount: ARTIFACT_BLOB_MAX_CHUNKS_V1 + 1,
    })).toThrow("Artifact blob chunk count");
  });

  test("validates chunk frames, keys, indexes, and provider output exactly", () => {
    const crypto = new LatticeCrypto(seededRng(0x260));
    const blobDek = new Uint8Array(ARTIFACT_BLOB_DEK_BYTES_V1).fill(0x41);
    const sealed = sealArtifactBlobChunkV1(crypto, {
      header,
      blobDek,
      chunkIndex: 0,
      plaintextChunk: new Uint8Array(0),
    });
    expect(sealed).toHaveLength(40);
    expect(openArtifactBlobChunkV1(crypto, {
      header,
      blobDek,
      chunkIndex: 0,
      sealedChunk: sealed,
    })).toEqual(new Uint8Array(0));
    expect(encodeArtifactBlobChunkFrameV1(sealed).slice(0, 4))
      .toEqual(Uint8Array.of(0, 0, 0, 40));

    for (const invalid of [
      new Uint8Array(39),
      new Uint8Array(ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + 41),
      "sealed",
    ]) {
      expect(() => encodeArtifactBlobChunkFrameV1(
        invalid as unknown as Uint8Array,
      )).toThrow("sealed chunk length");
    }
    for (const chunkIndex of [-1, 1, 1.5, "0"] as const) {
      expect(() => sealArtifactBlobChunkV1(crypto, {
        header,
        blobDek,
        chunkIndex: chunkIndex as number,
        plaintextChunk: new Uint8Array(0),
      })).toThrow("chunk index");
    }
    expect(() => sealArtifactBlobChunkV1(crypto, {
      header,
      blobDek: new Uint8Array(ARTIFACT_BLOB_DEK_BYTES_V1 - 1),
      chunkIndex: 0,
      plaintextChunk: new Uint8Array(0),
    })).toThrow("DEK");
    expect(() => sealArtifactBlobChunkV1(crypto, {
      header,
      blobDek,
      chunkIndex: 0,
      plaintextChunk: Uint8Array.of(1),
    })).toThrow("plaintext length");
    expect(() => openArtifactBlobChunkV1(crypto, {
      header,
      blobDek,
      chunkIndex: 0,
      sealedChunk: new Uint8Array(39),
    })).toThrow("sealed chunk length");

    const badSeal = new LatticeCrypto(seededRng(0x2601));
    const capturedSeal = new Uint8Array(39).fill(0x7a);
    badSeal.aeadSeal = () => capturedSeal;
    expect(() => sealArtifactBlobChunkV1(badSeal, {
      header,
      blobDek,
      chunkIndex: 0,
      plaintextChunk: new Uint8Array(0),
    })).toThrow("sealed chunk length is inexact");
    expect(capturedSeal).toEqual(new Uint8Array(39));

    const badOpen = new LatticeCrypto(seededRng(0x2602));
    badOpen.aeadOpen = () => null;
    expect(() => openArtifactBlobChunkV1(badOpen, {
      header,
      blobDek,
      chunkIndex: 0,
      sealedChunk: sealed,
    })).toThrow("authentication failed");
    const wrongPlaintext = Uint8Array.of(0x7b);
    badOpen.aeadOpen = () => wrongPlaintext;
    expect(() => openArtifactBlobChunkV1(badOpen, {
      header,
      blobDek,
      chunkIndex: 0,
      sealedChunk: sealed,
    })).toThrow("authentication failed");
    expect(wrongPlaintext).toEqual(Uint8Array.of(0));
  });

  test("rejects and wipes a provider-generated DEK of either wrong length", () => {
    for (const length of [ARTIFACT_BLOB_DEK_BYTES_V1 - 1, ARTIFACT_BLOB_DEK_BYTES_V1 + 1]) {
      const crypto = new LatticeCrypto(seededRng(length));
      const generated = new Uint8Array(length).fill(0x55);
      crypto.randomBytes = () => generated;
      expect(() => generateArtifactBlobDekV1(crypto)).toThrow(
        "Generated Artifact blob DEK has an invalid length",
      );
      expect(generated).toEqual(new Uint8Array(length));
    }
  });

  test("pins canonical empty bytes and authenticates its zero-length chunk", () => {
    const crypto = new LatticeCrypto(seededRng(0x261));
    const blobDek = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const encodedHeader = encodeArtifactBlobHeaderV1(header);
    const file = sealArtifactBlobV1(crypto, {
      header,
      blobDek,
      plaintext: new Uint8Array(0),
    });

    expect(decodeArtifactBlobHeaderV1(encodedHeader)).toEqual(header);
    expect(hex(encodedHeader)).toBe(
      "000000186e617574696c6f2f61727469666163742d626c6f622f7631"
        + "000000010000002431313131313131312d313131312d343131312d383131312d"
        + "3131313131313131313131310000002432323232323232322d323232322d3432"
        + "32322d383232322d323232323232323232323232000000000000000100000000"
        + "000000000010000000000001",
    );
    expect(hex(file)).toBe(
      hex(encodedHeader)
        + "00000028a7c97334360c2bbb2d7c8283aa16dc402c4fce91af22839d0c3d"
        + "b00b43509a9bc478464cecc7796d",
    );
    expect(openArtifactBlobRangeV1(crypto, {
      fileBytes: file,
      blobDek,
      expected: header,
      start: 0,
      endExclusive: 0,
    })).toEqual(new Uint8Array(0));
    expect(hex(sha256(file))).toBe(
      "0e82d4828dfd264b73e5c4101804b0a508dd105c138ce9daabad26fa5710cec6",
    );
    const tampered = file.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => openArtifactBlobRangeV1(crypto, {
      fileBytes: tampered,
      blobDek,
      expected: header,
      start: 0,
      endExclusive: 0,
    })).toThrow("authentication");
  });

  test("authenticates exact intersecting chunks before returning a range", () => {
    const crypto = new LatticeCrypto(seededRng(0x262));
    const blobDek = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    const plaintext = Uint8Array.from(
      { length: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + 1 },
      (_, index) => index % 251,
    );
    const rangedHeader = {
      ...header,
      plaintextLength: plaintext.length,
      chunkCount: 2,
    } as const;
    const file = sealArtifactBlobV1(crypto, {
      header: rangedHeader,
      blobDek,
      plaintext,
    });

    expect(openArtifactBlobRangeV1(crypto, {
      fileBytes: file,
      blobDek,
      expected: rangedHeader,
      start: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 - 2,
      endExclusive: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + 1,
    })).toEqual(plaintext.slice(-3));

    const tampered = file.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    expect(() => openArtifactBlobRangeV1(crypto, {
      fileBytes: tampered,
      blobDek,
      expected: rangedHeader,
      start: plaintext.length - 1,
      endExclusive: plaintext.length,
    })).toThrow("authentication");
  });

  test("rejects stable blob-coordinate substitution", () => {
    const crypto = new LatticeCrypto(seededRng(0x263));
    const blobDek = new Uint8Array(32).fill(7);
    const file = sealArtifactBlobV1(crypto, {
      header,
      blobDek,
      plaintext: new Uint8Array(0),
    });

    expect(() => openArtifactBlobRangeV1(crypto, {
      fileBytes: file,
      blobDek,
      expected: { ...header, blobGeneration: 2 },
      start: 0,
      endExclusive: 0,
    })).toThrow("coordinates");

    for (const expected of [
      { ...header, artifactId: "33333333-3333-4333-8333-333333333333" },
      { ...header, blobId: "44444444-4444-4444-8444-444444444444" },
      { ...header, plaintextLength: 1 },
    ]) {
      expect(() => openArtifactBlobRangeV1(crypto, {
        fileBytes: file,
        blobDek,
        expected,
        start: 0,
        endExclusive: 0,
      })).toThrow("coordinates");
    }
  });

  test("opens only intersecting chunks and computes offsets from the first opened chunk", () => {
    const crypto = new LatticeCrypto(seededRng(0x2632));
    const blobDek = new Uint8Array(32).fill(0x45);
    const plaintext = new Uint8Array(
      ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + 3,
    ).fill(0x21);
    plaintext.set(Uint8Array.of(0xa1, 0xa2, 0xa3),
      ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1);
    const twoChunkHeader = {
      ...header,
      plaintextLength: plaintext.length,
      chunkCount: 2,
    } as const;
    const file = sealArtifactBlobV1(crypto, {
      header: twoChunkHeader,
      blobDek,
      plaintext,
    });

    expect(openArtifactBlobRangeV1(crypto, {
      fileBytes: file,
      blobDek,
      expected: twoChunkHeader,
      start: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + 1,
      endExclusive: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + 3,
    })).toEqual(Uint8Array.of(0xa2, 0xa3));

    const encodedHeader = encodeArtifactBlobHeaderV1(twoChunkHeader);
    const firstFrameLength = 4 + ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + 40;
    const secondChunkTampered = file.slice();
    secondChunkTampered[encodedHeader.length + firstFrameLength + 5]! ^= 1;
    expect(openArtifactBlobRangeV1(crypto, {
      fileBytes: secondChunkTampered,
      blobDek,
      expected: twoChunkHeader,
      start: 0,
      endExclusive: 1,
    })).toEqual(Uint8Array.of(0x21));

    const shortenedUnrequestedChunk = file.slice(0, file.length - 1);
    const secondFrameOffset = encodedHeader.length + firstFrameLength;
    shortenedUnrequestedChunk.set(
      Uint8Array.of(0, 0, 0, 40),
      secondFrameOffset,
    );
    expect(() => openArtifactBlobRangeV1(crypto, {
      fileBytes: shortenedUnrequestedChunk,
      blobDek,
      expected: twoChunkHeader,
      start: 0,
      endExclusive: 1,
    })).toThrow("sealed chunk length is inexact");

    const firstChunkTampered = file.slice();
    firstChunkTampered[encodedHeader.length + 5]! ^= 1;
    expect(openArtifactBlobRangeV1(crypto, {
      fileBytes: firstChunkTampered,
      blobDek,
      expected: twoChunkHeader,
      start: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
      endExclusive: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + 1,
    })).toEqual(Uint8Array.of(0xa1));

    const allChunksTampered = file.slice();
    allChunksTampered[encodedHeader.length + 5]! ^= 1;
    allChunksTampered[encodedHeader.length + firstFrameLength + 5]! ^= 1;
    expect(openArtifactBlobRangeV1(crypto, {
      fileBytes: allChunksTampered,
      blobDek,
      expected: twoChunkHeader,
      start: 0,
      endExclusive: 0,
    })).toEqual(new Uint8Array(0));
  });

  test("rejects reordered, duplicated, and omitted chunk frames", () => {
    const crypto = new LatticeCrypto(seededRng(0x2631));
    const blobDek = new Uint8Array(32).fill(0x71);
    const plaintext = new Uint8Array(
      ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + 1,
    ).fill(0x39);
    const twoChunkHeader = {
      ...header,
      plaintextLength: plaintext.length,
      chunkCount: 2,
    } as const;
    const file = sealArtifactBlobV1(crypto, {
      header: twoChunkHeader,
      blobDek,
      plaintext,
    });
    const encodedHeader = encodeArtifactBlobHeaderV1(twoChunkHeader);
    const firstFrameLength = 4 + ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + 40;
    const prefix = file.slice(0, encodedHeader.length);
    const firstFrame = file.slice(
      encodedHeader.length,
      encodedHeader.length + firstFrameLength,
    );
    const secondFrame = file.slice(encodedHeader.length + firstFrameLength);
    const join = (...parts: readonly Uint8Array[]): Uint8Array => {
      const output = new Uint8Array(
        parts.reduce((length, part) => length + part.length, 0),
      );
      let offset = 0;
      for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
      }
      return output;
    };
    const open = (candidate: Uint8Array): Uint8Array =>
      openArtifactBlobRangeV1(crypto, {
        fileBytes: candidate,
        blobDek,
        expected: twoChunkHeader,
        start: 0,
        endExclusive: plaintext.length,
      });

    expect(() => open(join(prefix, secondFrame, firstFrame))).toThrow();
    expect(() => open(join(prefix, firstFrame, firstFrame))).toThrow();
    expect(() => open(join(prefix, firstFrame))).toThrow();
  });

  test("rejects malformed headers, impossible counts, ranges, and framing", () => {
    const crypto = new LatticeCrypto(seededRng(0x264));
    const blobDek = new Uint8Array(32).fill(9);
    const file = sealArtifactBlobV1(crypto, {
      header,
      blobDek,
      plaintext: new Uint8Array(0),
    });
    const malformedHeaders = [
      { ...header, formatVersion: 2 },
      { ...header, artifactId: "NOT-A-UUID" },
      { ...header, blobId: "AAAAAAAA-2222-4222-8222-222222222222" },
      { ...header, blobGeneration: 0 },
      { ...header, plaintextLength: -1 },
      { ...header, chunkPlaintextBytes: 1 },
      { ...header, chunkCount: 2 },
      { ...header, unexpected: true },
    ];
    for (const malformed of malformedHeaders) {
      expect(() => encodeArtifactBlobHeaderV1(
        malformed as typeof header,
      )).toThrow();
    }
    const encoded = encodeArtifactBlobHeaderV1(header);
    for (const malformed of [
      encoded.subarray(0, encoded.length - 1),
      Uint8Array.from([...encoded, 0]),
      Uint8Array.from(encoded, (byte, index) => index === 4 ? byte ^ 1 : byte),
    ]) {
      expect(() => decodeArtifactBlobHeaderV1(malformed)).toThrow();
    }
    const semanticallyInvalidHeader = encoded.slice();
    const artifactIdOffset = indexOfBytes(
      semanticallyInvalidHeader,
      new TextEncoder().encode(header.artifactId),
    );
    expect(artifactIdOffset).toBeGreaterThanOrEqual(0);
    semanticallyInvalidHeader[artifactIdOffset] = "x".charCodeAt(0);
    expect(() => decodeArtifactBlobHeaderV1(semanticallyInvalidHeader))
      .toThrow("Artifact id");
    const wrongChunkSize = encoded.slice();
    wrongChunkSize.set(Uint8Array.of(0, 0, 0, 1), wrongChunkSize.length - 8);
    expect(() => decodeArtifactBlobHeaderV1(wrongChunkSize))
      .toThrow("chunk plaintext size is unsupported");
    expect(() => openArtifactBlobRangeV1(crypto, {
      fileBytes: "not bytes" as unknown as Uint8Array,
      blobDek,
      expected: header,
      start: 0,
      endExclusive: 0,
    })).toThrow("file exceeds its supported bound");
    expect(() => openArtifactBlobRangeV1(crypto, {
      fileBytes: file,
      blobDek,
      expected: header,
      start: 1,
      endExclusive: 1,
    })).toThrow("range");
    expect(() => openArtifactBlobRangeV1(crypto, {
      fileBytes: file.subarray(0, file.length - 1),
      blobDek,
      expected: header,
      start: 0,
      endExclusive: 0,
    })).toThrow();
    expect(() => sealArtifactBlobV1(crypto, {
      header,
      blobDek,
      plaintext: Uint8Array.of(1),
    })).toThrow("length disagrees");
    expect(deriveArtifactBlobChunkCountV1(0)).toBe(1);
    expect(deriveArtifactBlobChunkCountV1(104_857_600)).toBe(100);
    expect(() => deriveArtifactBlobChunkCountV1(104_857_601)).toThrow();
  });

  test("wipes owned chunk keys, plaintext, ciphertext, and AAD copies", () => {
    const crypto = new LatticeCrypto(seededRng(0x265));
    const blobDek = new Uint8Array(32).fill(0x31);
    const capturedSeal: Uint8Array[] = [];
    const originalSeal = crypto.aeadSeal.bind(crypto);
    const capturedSealedOutputs: Uint8Array[] = [];
    crypto.aeadSeal = (key, plaintext, aad) => {
      capturedSeal.push(key, plaintext, aad!);
      const sealed = originalSeal(key, plaintext, aad);
      capturedSealedOutputs.push(sealed);
      return sealed;
    };
    const wipeHeader = {
      ...header,
      plaintextLength: 1,
    } as const;
    const file = sealArtifactBlobV1(crypto, {
      header: wipeHeader,
      blobDek,
      plaintext: Uint8Array.of(0x61),
    });
    expect(capturedSeal.every((bytes) => bytes.every((byte) => byte === 0)))
      .toBeTrue();
    expect(capturedSealedOutputs.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBeTrue();
    expect(blobDek).toEqual(new Uint8Array(32).fill(0x31));

    const capturedOpen: Uint8Array[] = [];
    const originalOpen = crypto.aeadOpen.bind(crypto);
    const capturedOpenedOutputs: Uint8Array[] = [];
    crypto.aeadOpen = (key, sealed, aad) => {
      capturedOpen.push(key, sealed, aad!);
      const opened = originalOpen(key, sealed, aad);
      if (opened !== null) capturedOpenedOutputs.push(opened);
      return opened;
    };
    openArtifactBlobRangeV1(crypto, {
      fileBytes: file,
      blobDek,
      expected: wipeHeader,
      start: 0,
      endExclusive: 1,
    });
    expect(capturedOpen.every((bytes) => bytes.every((byte) => byte === 0)))
      .toBeTrue();
    expect(capturedOpenedOutputs.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBeTrue();
    expect(file.some((byte) => byte !== 0)).toBeTrue();

    const generated = generateArtifactBlobDekV1(crypto);
    expect(generated).toHaveLength(32);
    expect(generated.some((byte) => byte !== 0)).toBeTrue();
    generated.fill(0);
  });
});
