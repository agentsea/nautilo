import { expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
  ARTIFACT_BLOB_FORMAT_VERSION_V1,
  decodeArtifactBlobHeaderV1,
  openArtifactBlobRangeV1,
  sealArtifactBlobV1,
} from "../../src/artifact/blob-v1.ts";
import {
  ARTIFACT_CONTROL_FORMAT_VERSION_V1,
  decodeArtifactControlV1,
  encodeArtifactControlV1,
  wipeArtifactControlV1,
} from "../../src/artifact/control-v1.ts";

test("Artifact v1 fuzz corpus rejects random wire and fails closed on blob mutation", () => {
  const rng = seededRng(0x261_f022);
  for (let index = 0; index < 256; index++) {
    const bytes = rng.bytes(index % 193);
    expect(() => decodeArtifactBlobHeaderV1(bytes)).toThrow();
    expect(() => decodeArtifactControlV1(bytes)).toThrow();
  }

  const crypto = new LatticeCrypto(seededRng(0x261_f023));
  const plaintext = Uint8Array.from({ length: 4_097 }, (_, index) => index % 251);
  const header = {
    formatVersion: ARTIFACT_BLOB_FORMAT_VERSION_V1,
    artifactId: "11111111-1111-4111-8111-111111111111",
    blobId: "22222222-2222-4222-8222-222222222222",
    blobGeneration: 1,
    plaintextLength: plaintext.length,
    chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
    chunkCount: 1,
  } as const;
  const blobDek = new Uint8Array(32).fill(0x33);
  const file = sealArtifactBlobV1(crypto, { header, blobDek, plaintext });
  for (let index = 0; index < 128; index++) {
    const mutated = file.slice();
    const byteIndex = index * 811 % mutated.length;
    mutated[byteIndex] = mutated[byteIndex]! ^ (1 << (index % 8));
    expect(() => openArtifactBlobRangeV1(crypto, {
      fileBytes: mutated,
      blobDek,
      expected: header,
      start: 0,
      endExclusive: plaintext.length,
    })).toThrow();
  }
});

test("ArtifactControlV1 fuzz mutation is either rejected or canonical", () => {
  const encoded = encodeArtifactControlV1({
    formatVersion: ARTIFACT_CONTROL_FORMAT_VERSION_V1,
    artifactId: "11111111-1111-4111-8111-111111111111",
    artifactRevision: 1,
    blobGeneration: 1,
    blobDek: new Uint8Array(32).fill(1),
    logicalPath: "file.txt",
    mimeType: "text/plain",
    plaintextLength: 1,
    plaintextSha256: new Uint8Array(32).fill(2),
    blobId: "22222222-2222-4222-8222-222222222222",
    ciphertextLength: 181,
    ciphertextSha256: new Uint8Array(32).fill(3),
    chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
    chunkCount: 1,
  });
  for (let index = 0; index < encoded.length; index += 3) {
    const mutated = encoded.slice();
    mutated[index] = mutated[index]! ^ 1;
    try {
      const decoded = decodeArtifactControlV1(mutated);
      expect(encodeArtifactControlV1(decoded)).toEqual(mutated);
      wipeArtifactControlV1(decoded);
    } catch (cause) {
      expect(cause).toBeInstanceOf(Error);
    }
  }
});
