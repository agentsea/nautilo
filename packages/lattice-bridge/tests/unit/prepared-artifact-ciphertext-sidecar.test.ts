import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProtectedArtifactPreparedPublicationRequestV1 } from "@nautilo/api-client/browser";

import { FilePreparedArtifactCiphertextSidecar } from "../../src/client/artifact/file-prepared-artifact-ciphertext-sidecar.ts";
import {
  createPreparedArtifactMutationJournal,
  type PreparedArtifactCiphertextStagingPort,
  type PreparedArtifactCiphertextSidecarReference,
  type PreparedArtifactMutationJournalPort,
} from "../../src/client/artifact/prepared-artifact-ciphertext-sidecar.ts";
import type {
  PreparedHumanArtifactMutation,
  PreparedHumanMutation,
  PreparedMutationJournalIndex,
} from "../../src/client/memory/prepared-mutation-journal.ts";

const ARTIFACT_ID = "82000000-0000-4000-8000-000000000001";
const ROW_ID = "82000000-0000-4000-8000-000000000002";
const BLOB_ID = "82000000-0000-4000-8000-000000000003";
const NAMESPACE_ID = "82000000-0000-4000-8000-000000000004";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

function request(bytes: Uint8Array): ProtectedArtifactPreparedPublicationRequestV1 {
  return {
    requestVersion: 1,
    operationId: "artifact-create:1",
    planDigestBase64url: "F".repeat(43),
    operation: "create",
    lifecycleAction: "activate",
    artifactRowId: ROW_ID,
    artifactId: ARTIFACT_ID,
    anchorNamespaceId: NAMESPACE_ID,
    cryptoObjectId: `artifact:v1:${"a".repeat(64)}`,
    expectedArtifactRevision: 0,
    nextArtifactRevision: 1,
    expectedCryptoAccessRevision: 0,
    resultCryptoAccessRevision: 0,
    expectedBlobGeneration: 0,
    resultBlobGeneration: 1,
    expectedBlobId: null,
    resultBlobId: BLOB_ID,
    requiredNamespaceIds: [NAMESPACE_ID],
    encryptedControlPayloadBytesBase64url: "Y29udHJvbA",
    accessManifestBytesBase64url: "bWFuaWZlc3Q",
    namespaceEnvelopes: [{
      namespaceId: NAMESPACE_ID,
      envelopeBytesBase64url: "ZW52ZWxvcGU",
    }],
    signedPublicationRequestBytesBase64url: "c2lnbmVk",
    ciphertextLength: bytes.length,
    ciphertextSha256Base64url: digest(bytes),
    chunkPlaintextBytes: 1_048_576,
    chunkCount: 1,
    mimeClass: "document",
    sizeBucket: "le_64_kib",
  };
}

function mutation(bytes: Uint8Array): PreparedHumanArtifactMutation {
  return {
    kind: "artifact_create",
    artifactId: ARTIFACT_ID,
    request: request(bytes),
  };
}

async function* chunks(...values: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield value;
}

class FakeJournal implements PreparedArtifactMutationJournalPort {
  readonly records = new Map<string, Readonly<{
    mutation: PreparedHumanArtifactMutation;
    index: PreparedMutationJournalIndex;
  }>>();
  failPut = false;

  putBeforeSend(mutation: PreparedHumanArtifactMutation) {
    if (this.failPut) throw new Error("journal failed");
    const existing = this.records.get(mutation.request.operationId);
    if (existing !== undefined) return Promise.resolve({
      status: "duplicate" as const,
      index: existing.index,
    });
    throw new Error("test must supply digest-aware index");
  }

  listStatus() {
    return Promise.resolve([...this.records.values()].map(({ index }) => index));
  }

  withPrepared<Result>(
    operationId: string,
    use: (mutation: PreparedHumanMutation) => Promise<Result> | Result,
  ): Promise<Result> {
    const record = this.records.get(operationId);
    if (record === undefined) throw new Error("missing");
    return Promise.resolve(use(record.mutation));
  }

  recordOutcome(): Promise<void> {
    return Promise.resolve();
  }
}

describe("prepared Artifact ciphertext sidecar", () => {
  test("streams mode-0600 ciphertext, restarts, authenticates, and removes exactly", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-artifact-sidecar-"));
    const bytes = new TextEncoder().encode("sealed-artifact-ciphertext");
    const store = new FilePreparedArtifactCiphertextSidecar(root);
    const reference: PreparedArtifactCiphertextSidecarReference = {
      formatVersion: 1,
      operationId: "artifact-create:1",
      authenticatedRequestDigestBase64url: "B".repeat(43),
      artifactId: ARTIFACT_ID,
      blobId: BLOB_ID,
      blobGeneration: 1,
      ciphertextLength: bytes.length,
      ciphertextSha256Base64url: digest(bytes),
    };
    expect(await store.put({ reference, ciphertext: chunks(bytes.subarray(0, 8), bytes.subarray(8)) }))
      .toBe("inserted");

    const resumed = new FilePreparedArtifactCiphertextSidecar(root);
    let opened = new Uint8Array();
    await resumed.withOpened(reference, async (stream) => {
      const parts: Uint8Array[] = [];
      for await (const part of stream) parts.push(part.slice());
      opened = Uint8Array.from(parts.flatMap((part) => [...part]));
    });
    expect(opened).toEqual(bytes);
    expect(await resumed.put({ reference, ciphertext: chunks(bytes) })).toBe("exact_duplicate");

    const directory = join(root, "protected-artifact-ciphertext-sidecars");
    const blobName = (await readdir(directory)).find((name) => name.endsWith(".blob"))!;
    expect((await import("node:fs/promises")).stat(join(directory, blobName)).then((value) => value.mode & 0o777))
      .resolves.toBe(0o600);
    expect(await resumed.removeExact(reference)).toBeTrue();
    expect(await resumed.list()).toEqual([]);
  });

  test("rejects underrun, overrun, corruption, and coordinate collision", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-artifact-sidecar-"));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const store = new FilePreparedArtifactCiphertextSidecar(root);
    const reference: PreparedArtifactCiphertextSidecarReference = {
      formatVersion: 1,
      operationId: "artifact-create:1",
      authenticatedRequestDigestBase64url: "B".repeat(43),
      artifactId: ARTIFACT_ID,
      blobId: BLOB_ID,
      blobGeneration: 1,
      ciphertextLength: bytes.length,
      ciphertextSha256Base64url: digest(bytes),
    };
    expect(store.put({ reference, ciphertext: chunks(bytes.subarray(0, 3)) })).rejects.toThrow();
    expect(store.put({ reference, ciphertext: chunks(new Uint8Array([1, 2, 3, 4, 5])) }))
      .rejects.toThrow("overran");
    expect(await store.put({ reference, ciphertext: chunks(bytes) })).toBe("inserted");
    expect(await store.put({
      reference: { ...reference, blobGeneration: 2 },
      ciphertext: chunks(bytes),
    })).toBe("collision");

    const directory = join(root, "protected-artifact-ciphertext-sidecars");
    const blob = (await readdir(directory)).find((name) => name.endsWith(".blob"))!;
    await writeFile(join(directory, blob), new Uint8Array([9, 9, 9, 9]));
    expect(store.withOpened(reference, () => undefined)).rejects.toThrow("corrupt");
  });

  test("joint custody removes a newly inserted sidecar if record persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-artifact-sidecar-"));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sidecars = new FilePreparedArtifactCiphertextSidecar(root);
    const journal = new FakeJournal();
    journal.failPut = true;
    const composed = createPreparedArtifactMutationJournal({ journal, sidecars });
    expect(composed.putBeforeSend(mutation(bytes), chunks(bytes))).rejects.toThrow("journal failed");
    expect(await sidecars.list()).toEqual([]);
  });

  test("stages a single ciphertext pass before signed request binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-artifact-sidecar-"));
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const sidecars = new FilePreparedArtifactCiphertextSidecar(root);
    const staged = await (sidecars as PreparedArtifactCiphertextStagingPort).stage({
      operationId: "artifact-create:1",
      artifactId: ARTIFACT_ID,
      blobId: BLOB_ID,
      blobGeneration: 1,
      ciphertext: chunks(bytes),
    });
    expect(staged).toMatchObject({
      ciphertextLength: 4,
      ciphertextSha256Base64url: digest(bytes),
    });
    const journal = new FakeJournal();
    const prepared = mutation(bytes);
    const probe = (await import(
      "../../src/client/memory/prepared-mutation-journal.ts"
    )).inspectPreparedMutationCustodyFacts(prepared);
    journal.records.set(prepared.request.operationId, {
      mutation: prepared,
      index: {
        formatVersion: 1,
        operationId: prepared.request.operationId,
        kind: prepared.kind,
        artifactId: prepared.artifactId,
        authenticatedRequestDigestBase64url: probe.authenticatedRequestDigestBase64url,
        canonicalBytes: probe.canonicalBytes,
        sealedBytes: probe.canonicalBytes + 16,
        createdAt: 1,
        updatedAt: 1,
        attempts: 0,
        attemptWindowStartedAt: null,
        attemptsInWindow: 0,
        nextAttemptAt: 1,
        lastAttemptAt: null,
        state: "pending",
      },
    });
    const composed = createPreparedArtifactMutationJournal({ journal, sidecars });
    expect((await composed.putBeforeSend(prepared, staged)).status).toBe("duplicate");
    let reopened = new Uint8Array();
    await composed.withPrepared(prepared.request.operationId, async ({ ciphertext }) => {
      const parts: number[] = [];
      for await (const part of ciphertext!) parts.push(...part);
      reopened = Uint8Array.from(parts);
    });
    expect(reopened).toEqual(bytes);
  });
});
