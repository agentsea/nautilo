import { describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { seededRng } from "@nautilo/lattice-crypto/testing";

import {
  createFilesystemEncryptedArtifactBlobStoreV1,
  type ArtifactBlobFilesystemV1,
  type EncryptedArtifactBlobReferenceV1,
} from "../../src/artifact/filesystem-blob-store.ts";

const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_ID_2 = "44444444-4444-4444-8444-444444444444";
const BLOB_ID = "22222222-2222-4222-8222-222222222222";
const BLOB_ID_2 = "33333333-3333-4333-8333-333333333333";
const DEK = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

async function withRoot<Value>(
  run: (root: string) => Promise<Value>,
): Promise<Value> {
  const root = await mkdtemp(join(tmpdir(), "nautilo-artifact-blob-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}

describe("filesystem encrypted Artifact blob store", () => {
  test("publishes an already-encrypted canonical stream without receiving its DEK", async () => {
    await withRoot(async (root) => {
      const sourceRoot = join(root, "source");
      const targetRoot = join(root, "target");
      const source = createFilesystemEncryptedArtifactBlobStoreV1({
        rootDirectory: sourceRoot,
      });
      const plaintext = new TextEncoder().encode("client-only plaintext canary");
      const prepared = await source.publish({
        crypto: new LatticeCrypto(seededRng(0x2617)),
        artifactId: ARTIFACT_ID,
        blobId: BLOB_ID,
        blobGeneration: 1,
        plaintextLength: plaintext.length,
        blobDek: DEK,
        plaintext: chunks(plaintext),
      });
      if (prepared.status !== "published") throw new Error("fixture publish failed");
      const ciphertext = await readFile(join(sourceRoot, `${BLOB_ID}.artifact-blob-v1`));
      const target = createFilesystemEncryptedArtifactBlobStoreV1({
        rootDirectory: targetRoot,
      });
      const published = await target.publishCiphertext({
        artifactId: ARTIFACT_ID,
        blobId: BLOB_ID,
        blobGeneration: 1,
        ciphertextLength: prepared.reference.ciphertextLength,
        ciphertextSha256: prepared.reference.ciphertextSha256,
        ciphertext: chunks(ciphertext.subarray(0, 5), ciphertext.subarray(5)),
      });
      expect(published).toEqual({ status: "published", reference: prepared.reference });
      expect((await readFile(join(targetRoot, `${BLOB_ID}.artifact-blob-v1`)))
        .includes(Buffer.from("client-only plaintext canary"))).toBeFalse();
      expect(await target.publishCiphertext({
        artifactId: ARTIFACT_ID,
        blobId: BLOB_ID,
        blobGeneration: 1,
        ciphertextLength: prepared.reference.ciphertextLength,
        ciphertextSha256: prepared.reference.ciphertextSha256,
        ciphertext: chunks(new Uint8Array([9])),
        expectedReplay: prepared.reference,
      })).toEqual({ status: "replayed", reference: prepared.reference });
    });
  });

  test("streams ciphertext into a private immutable file and opens only an authenticated range", async () => {
    await withRoot(async (root) => {
      const requestedReadLengths: number[] = [];
      const filesystem: ArtifactBlobFilesystemV1 = {
        mkdir,
        chmod,
        link,
        unlink,
        lstat,
        async listBounded(path, limit) {
          return (await readdir(path)).slice(0, limit);
        },
        async open(path, flags, mode) {
          const handle = await open(path, flags, mode);
          return {
            close: () => handle.close(),
            read: async (buffer, offset, length, position) => {
              requestedReadLengths.push(length);
              return handle.read(buffer, offset, length, position);
            },
            stat: () => handle.stat(),
            sync: () => handle.sync(),
            write: (buffer, offset, length, position) =>
              handle.write(buffer, offset, length, position),
          };
        },
      };
      const store = createFilesystemEncryptedArtifactBlobStoreV1({
        rootDirectory: root,
        filesystem,
      });
      const plaintext = new TextEncoder().encode(
        `canary-plaintext-${"x".repeat(1_048_576)}-tail`,
      );
      const published = await store.publish({
        crypto: new LatticeCrypto(seededRng(0x2611)),
        artifactId: ARTIFACT_ID,
        blobId: BLOB_ID,
        blobGeneration: 1,
        plaintextLength: plaintext.length,
        blobDek: DEK,
        plaintext: chunks(
          plaintext.subarray(0, 7),
          plaintext.subarray(7, 1_048_580),
          plaintext.subarray(1_048_580),
        ),
      });
      expect(published.status).toBe("published");
      if (published.status !== "published") throw new Error("publish failed");
      expect(await store.verify(published.reference)).toEqual({ status: "exact" });

      const names = await readdir(root);
      expect(names).toEqual([`${BLOB_ID}.artifact-blob-v1`]);
      const path = join(root, names[0]!);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const ciphertext = await readFile(path);
      expect(ciphertext.includes(Buffer.from("canary-plaintext"))).toBeFalse();

      let callbackBytes: Uint8Array | undefined;
      const opened = await store.openRange({
        crypto: new LatticeCrypto(seededRng(0x9999)),
        blobDek: DEK,
        reference: published.reference,
        start: 1_048_570,
        endExclusive: plaintext.length,
        consume: (value) => {
          callbackBytes = value;
          return value.slice();
        },
      });
      expect(opened).toEqual({
        status: "opened",
        value: plaintext.slice(1_048_570),
      });
      expect(Math.max(...requestedReadLengths)).toBeLessThanOrEqual(1_048_616);
      expect(requestedReadLengths).not.toContain(published.reference.ciphertextLength);
      expect(callbackBytes?.every((byte) => byte === 0)).toBeTrue();
    });
  });

  test("replays only an exact durable reference without consuming plaintext", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemEncryptedArtifactBlobStoreV1({ rootDirectory: root });
      const plaintext = new TextEncoder().encode("exact replay");
      const first = await store.publish({
        crypto: new LatticeCrypto(seededRng(0x2612)),
        artifactId: ARTIFACT_ID,
        blobId: BLOB_ID,
        blobGeneration: 1,
        plaintextLength: plaintext.length,
        blobDek: DEK,
        plaintext: chunks(plaintext),
      });
      if (first.status !== "published") throw new Error("publish failed");
      let consumed = false;
      const replay = await store.publish({
        crypto: new LatticeCrypto(seededRng(0xdead)),
        artifactId: ARTIFACT_ID,
        blobId: BLOB_ID,
        blobGeneration: 1,
        plaintextLength: plaintext.length,
        blobDek: DEK,
        plaintext: {
          async *[Symbol.asyncIterator]() {
            consumed = true;
            yield plaintext;
          },
        },
        expectedReplay: first.reference,
      });
      expect(replay).toEqual({ status: "replayed", reference: first.reference });
      expect(consumed).toBeFalse();

      const substituted: EncryptedArtifactBlobReferenceV1 = {
        ...first.reference,
        ciphertextSha256: new Uint8Array(32).fill(9),
      };
      expect(await store.publish({
        crypto: new LatticeCrypto(seededRng(0xbeef)),
        artifactId: ARTIFACT_ID,
        blobId: BLOB_ID,
        blobGeneration: 1,
        plaintextLength: plaintext.length,
        blobDek: DEK,
        plaintext: chunks(plaintext),
        expectedReplay: substituted,
      })).toEqual({ status: "quarantined", reason: "immutable_collision" });
    });
  });

  test("recovers authenticated public header facts from durable ciphertext coordinates", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemEncryptedArtifactBlobStoreV1({ rootDirectory: root });
      const plaintext = new Uint8Array(1_048_600).fill(23);
      const published = await store.publish({
        crypto: new LatticeCrypto(seededRng(0x2618)),
        artifactId: ARTIFACT_ID,
        blobId: BLOB_ID,
        blobGeneration: 7,
        plaintextLength: plaintext.length,
        blobDek: DEK,
        plaintext: chunks(plaintext),
      });
      if (published.status !== "published") throw new Error("publish failed");
      const stored = {
        artifactId: published.reference.artifactId,
        blobId: published.reference.blobId,
        blobGeneration: published.reference.blobGeneration,
        ciphertextLength: published.reference.ciphertextLength,
        ciphertextSha256: published.reference.ciphertextSha256,
      };
      expect(await store.inspectStored(stored)).toEqual({
        status: "exact",
        reference: published.reference,
      });
      expect(await store.inspectStored({
        ...stored,
        artifactId: ARTIFACT_ID_2,
      })).toEqual({ status: "mismatch", reason: "header" });
      expect(await store.inspectStored({
        ...stored,
        ciphertextLength: stored.ciphertextLength - 1,
      })).toEqual({ status: "mismatch", reason: "length" });
      expect(await store.inspectStored({
        ...stored,
        ciphertextSha256: new Uint8Array(32).fill(42),
      })).toEqual({ status: "mismatch", reason: "hash" });
    });
  });

  test("quarantines a no-replace collision and preserves the original immutable target", async () => {
    await withRoot(async (root) => {
      let token = 0;
      const store = createFilesystemEncryptedArtifactBlobStoreV1({
        rootDirectory: root,
        createToken: () => `token-${token++}`,
      });
      const original = new TextEncoder().encode("original bytes");
      const first = await store.publish({
        crypto: new LatticeCrypto(seededRng(0x2613)),
        artifactId: ARTIFACT_ID,
        blobId: BLOB_ID,
        blobGeneration: 1,
        plaintextLength: original.length,
        blobDek: DEK,
        plaintext: chunks(original),
      });
      if (first.status !== "published") throw new Error("publish failed");
      const target = join(root, `${BLOB_ID}.artifact-blob-v1`);
      const before = await readFile(target);

      const collision = await store.publish({
        crypto: new LatticeCrypto(seededRng(0x2614)),
        artifactId: ARTIFACT_ID,
        blobId: BLOB_ID,
        blobGeneration: 1,
        plaintextLength: original.length,
        blobDek: DEK,
        plaintext: chunks(new TextEncoder().encode("changed bytes!")),
      });
      expect(collision).toEqual({
        status: "quarantined",
        reason: "immutable_collision",
      });
      expect(await readFile(target)).toEqual(before);
      expect(await store.verify(first.reference)).toEqual({ status: "exact" });
      expect((await readdir(root)).some((name) =>
        name.endsWith(".artifact-blob-v1.quarantine"))).toBeTrue();
    });
  });

  test("cleans a failed partial stream and reports tamper without plaintext fallback", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemEncryptedArtifactBlobStoreV1({ rootDirectory: root });
      expect(store.publish({
        crypto: new LatticeCrypto(seededRng(0x2615)),
        artifactId: ARTIFACT_ID,
        blobId: BLOB_ID_2,
        blobGeneration: 1,
        plaintextLength: 10,
        blobDek: DEK,
        plaintext: {
          async *[Symbol.asyncIterator]() {
            yield new Uint8Array([1, 2, 3]);
            throw new Error("simulated input failure");
          },
        },
      })).rejects.toThrow("simulated input failure");
      expect((await readdir(root)).filter((name) => name.includes(BLOB_ID_2)))
        .toEqual([]);

      const plaintext = new TextEncoder().encode("tamper evidence");
      const published = await store.publish({
        crypto: new LatticeCrypto(seededRng(0x2616)),
        artifactId: ARTIFACT_ID,
        blobId: BLOB_ID,
        blobGeneration: 1,
        plaintextLength: plaintext.length,
        blobDek: DEK,
        plaintext: chunks(plaintext),
      });
      if (published.status !== "published") throw new Error("publish failed");
      const path = join(root, `${BLOB_ID}.artifact-blob-v1`);
      const bytes = await readFile(path);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      await writeFile(path, bytes);
      expect(await store.verify(published.reference)).toEqual({
        status: "mismatch",
        reason: "hash",
      });
      let opened = false;
      expect(await store.openRange({
        crypto: new LatticeCrypto(seededRng(1)),
        blobDek: DEK,
        reference: published.reference,
        start: 0,
        endExclusive: 1,
        consume: () => {
          opened = true;
        },
      })).toEqual({ status: "unavailable", reason: "mismatch" });
      expect(opened).toBeFalse();
    });
  });

  test("reconciles only bounded, old, unreferenced ciphertext files", async () => {
    await withRoot(async (root) => {
      let clock = Date.now();
      let token = 0;
      const store = createFilesystemEncryptedArtifactBlobStoreV1({
        rootDirectory: root,
        now: () => clock,
        orphanGraceMs: 1_000,
        createToken: () => `reconcile-${token++}`,
      });
      const plaintext = new Uint8Array([1]);
      for (const blobId of [BLOB_ID, BLOB_ID_2]) {
        expect((await store.publish({
          crypto: new LatticeCrypto(seededRng(token + 1)),
          artifactId: ARTIFACT_ID,
          blobId,
          blobGeneration: 1,
          plaintextLength: 1,
          blobDek: DEK,
          plaintext: chunks(plaintext),
        })).status).toBe("published");
      }
      clock += 10_000;
      const result = await store.reconcileOrphans({
        liveBlobIds: new Set([BLOB_ID]),
        limit: 1,
      });
      expect(result.cleaned).toBe(1);
      expect(await readdir(root)).toEqual([`${BLOB_ID}.artifact-blob-v1`]);
    });
  });
});
