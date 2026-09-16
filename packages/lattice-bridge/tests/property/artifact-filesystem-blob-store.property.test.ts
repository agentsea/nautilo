import { expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { seededRng } from "@nautilo/lattice-crypto/testing";

import { createFilesystemEncryptedArtifactBlobStoreV1 } from "../../src/artifact/filesystem-blob-store.ts";

test("filesystem Artifact blobs preserve arbitrary fragmentation and authenticated ranges", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uint8Array({ minLength: 0, maxLength: 2_100_000 }),
    fc.array(fc.integer({ min: 1, max: 200_000 }), {
      minLength: 0,
      maxLength: 20,
    }),
    fc.integer({ min: 0, max: 2_100_000 }),
    fc.integer({ min: 0, max: 2_100_000 }),
    async (plaintext, fragmentSizes, first, second) => {
      const root = await mkdtemp(join(tmpdir(), "nautilo-artifact-property-"));
      try {
        const fragments: Uint8Array[] = [];
        let offset = 0;
        for (const size of fragmentSizes) {
          if (offset >= plaintext.length) break;
          fragments.push(plaintext.subarray(offset, Math.min(plaintext.length, offset + size)));
          offset += size;
        }
        if (offset < plaintext.length) fragments.push(plaintext.subarray(offset));
        const store = createFilesystemEncryptedArtifactBlobStoreV1({
          rootDirectory: root,
        });
        const published = await store.publish({
          crypto: new LatticeCrypto(seededRng(plaintext.length + 0x2617)),
          artifactId: "11111111-1111-4111-8111-111111111111",
          blobId: "22222222-2222-4222-8222-222222222222",
          blobGeneration: 1,
          plaintextLength: plaintext.length,
          blobDek: new Uint8Array(32).fill(7),
          plaintext: fragments,
        });
        if (published.status !== "published") throw new Error("publish failed");
        const start = Math.min(first, second, plaintext.length);
        const endExclusive = Math.min(
          Math.max(first, second),
          plaintext.length,
        );
        const opened = await store.openRange({
          crypto: new LatticeCrypto(seededRng(0)),
          blobDek: new Uint8Array(32).fill(7),
          reference: published.reference,
          start,
          endExclusive,
          consume: (bytes) => bytes.slice(),
        });
        expect(opened).toEqual({
          status: "opened",
          value: plaintext.slice(start, endExclusive),
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  ), { numRuns: 12 });
}, 60_000);
