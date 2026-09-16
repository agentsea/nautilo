import { expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
  ARTIFACT_BLOB_FORMAT_VERSION_V1,
  deriveArtifactBlobChunkCountV1,
  openArtifactBlobRangeV1,
  sealArtifactBlobV1,
} from "../../src/artifact/blob-v1.ts";

test("ArtifactBlobV1 recorded property: arbitrary bounded ranges round-trip", () => {
  let state = 0x261_1601;
  const next = (maximum: number): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return maximum === 0 ? 0 : state % maximum;
  };
  const lengths = [
    0,
    1,
    ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 - 1,
    ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
    ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1 + 1,
    ...Array.from({ length: 24 }, () => next(65_537)),
  ];
  lengths.forEach((length, caseIndex) => {
    const crypto = new LatticeCrypto(seededRng(0x261_2000 + caseIndex));
    const plaintext = Uint8Array.from(
      { length },
      (_, index) => (index * 31 + caseIndex) % 251,
    );
    const header = {
      formatVersion: ARTIFACT_BLOB_FORMAT_VERSION_V1,
      artifactId: "11111111-1111-4111-8111-111111111111",
      blobId: "22222222-2222-4222-8222-222222222222",
      blobGeneration: caseIndex + 1,
      plaintextLength: length,
      chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES_V1,
      chunkCount: deriveArtifactBlobChunkCountV1(length),
    } as const;
    const blobDek = new Uint8Array(32).fill(caseIndex + 1);
    const fileBytes = sealArtifactBlobV1(crypto, {
      header,
      blobDek,
      plaintext,
    });
    for (let rangeIndex = 0; rangeIndex < 8; rangeIndex++) {
      const start = next(length + 1);
      const endExclusive = start + next(length - start + 1);
      expect(openArtifactBlobRangeV1(crypto, {
        fileBytes,
        blobDek,
        expected: header,
        start,
        endExclusive,
      })).toEqual(plaintext.slice(start, endExclusive));
    }
  });
});
