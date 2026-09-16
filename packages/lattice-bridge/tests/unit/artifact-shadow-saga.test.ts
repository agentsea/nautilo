import { describe, expect, test } from "bun:test";

import {
  ARTIFACT_CONTROL_OBJECT_TYPE_V1,
  ARTIFACT_CONTROL_VERSION_V1,
  artifactPublicationRequestDigest,
  deriveArtifactControlObjectIdV1,
  fingerprintRequiredArtifactNamespaces,
  type ArtifactProductPublicationPort,
  type ArtifactPublicationLifecycle,
  type ArtifactPublicationPlanInput,
  type AtomicArtifactCryptoCompletionPort,
  type PreparedArtifactCryptoRevision,
} from "../../src/artifact/artifact-repository.ts";
import { createDormantArtifactShadowRepository } from "../../src/artifact/artifact-shadow-saga.ts";

const artifactId = "11111111-1111-4111-8111-111111111111";
const blobId = "22222222-2222-4222-8222-222222222222";
const rowId = "33333333-3333-4333-8333-333333333333";
const namespaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const hash = new Uint8Array(32).fill(0x16);

function prepared(): PreparedArtifactCryptoRevision {
  return Object.freeze({
    artifactId,
    artifactRevision: 1,
    blobGeneration: 1,
    objectId: deriveArtifactControlObjectIdV1({ artifactId, artifactRevision: 1 }),
    objectType: ARTIFACT_CONTROL_OBJECT_TYPE_V1,
    controlVersion: ARTIFACT_CONTROL_VERSION_V1,
    blobId,
    plaintextLength: 4,
    ciphertextLength: 180,
    ciphertextSha256: hash.slice(),
    chunkPlaintextBytes: 1_048_576,
    chunkCount: 1,
    requiredNamespaceIds: Object.freeze([namespaceId]),
  });
}

function plan(): Omit<
  ArtifactPublicationPlanInput,
  "requestDigest" | "allocationRequestDigest"
> {
  return Object.freeze({
    operationId: "artifact-create:test",
    artifactRowId: rowId,
    anchorNamespaceId: namespaceId,
    operationType: "create",
    expectedArtifactRevision: 0,
    expectedAccessRevision: 0,
    expectedBlobGeneration: 0,
    expectedBlobId: null,
    expectedRequiredNamespaceFingerprint: null,
    revision: prepared(),
    blob: Object.freeze({
      artifactId,
      blobId,
      blobGeneration: 1,
      storageRef: `${blobId}.artifact-blob-v1`,
      ciphertextLength: 180,
      ciphertextSha256: hash.slice(),
    }),
    mimeClass: "text",
    sizeBucket: "le_64_kib",
    requiredNamespaceFingerprint: fingerprintRequiredArtifactNamespaces([
      namespaceId,
    ]),
  });
}

function harness(options: Readonly<{
  blob?: "exact" | "missing" | "mismatch";
  blobPlaintextLength?: number;
  verify?: "exact" | "missing" | "mismatch";
}> = {}) {
  let blob = options.blob;
  let lifecycle: ArtifactPublicationLifecycle | null = null;
  let completeCalls = 0;
  let publishCalls = 0;
  let failures = 0;
  const product: ArtifactProductPublicationPort = {
    reserve: (input) => {
      if (lifecycle !== null) {
        return Promise.resolve({ status: "replayed", lifecycle });
      }
      const allocated = Object.freeze({
        operationId: input.operationId,
        artifactRowId: input.artifactRowId,
        artifactId: input.revision.artifactId,
        anchorNamespaceId: input.anchorNamespaceId,
        operationType: input.operationType,
        expectedArtifactRevision: input.expectedArtifactRevision,
        resultArtifactRevision: input.revision.artifactRevision,
        expectedAccessRevision: input.expectedAccessRevision,
        resultAccessRevision: 0,
        expectedBlobGeneration: input.expectedBlobGeneration,
        resultBlobGeneration: input.revision.blobGeneration,
        expectedBlobId: input.expectedBlobId,
        resultBlobId: input.revision.blobId,
        expectedRequiredNamespaceFingerprint:
          input.expectedRequiredNamespaceFingerprint,
        cryptoObjectId: input.revision.objectId,
        blob: input.blob,
        mimeClass: input.mimeClass,
        sizeBucket: input.sizeBucket,
        requestDigest: input.requestDigest,
        allocationRequestDigest: input.allocationRequestDigest,
        requiredNamespaceFingerprint: input.requiredNamespaceFingerprint,
        completion: "pending",
        disposition: "active",
        attemptCount: 0,
        failureCode: null,
      });
      lifecycle = allocated;
      return Promise.resolve({ status: "allocated", lifecycle: allocated });
    },
    publish: ({ lifecycle: current }) => {
      publishCalls++;
      if (current.completion === "complete") return Promise.resolve("duplicate");
      lifecycle = Object.freeze({
        ...current,
        completion: "complete",
        disposition: "complete",
      });
      return Promise.resolve("applied");
    },
    read: () => Promise.resolve(lifecycle),
    recordFailure: ({ disposition, failureCode }) => {
      failures++;
      if (lifecycle !== null) lifecycle = Object.freeze({
        ...lifecycle,
        disposition,
        failureCode,
      });
      return Promise.resolve();
    },
  };
  const crypto: AtomicArtifactCryptoCompletionPort = {
    complete: () => {
      completeCalls++;
      return Promise.resolve(completeCalls === 1 ? "created" : "duplicate");
    },
    verify: () => Promise.resolve(
      options.verify === "missing"
        ? null
        : options.verify === "mismatch"
        ? {
          artifactId,
          artifactRevision: 1,
          objectId: prepared().objectId,
          accessRevision: 0,
          requiredNamespaceIds: [namespaceId],
          requiredNamespaceFingerprint: new Uint8Array(32).fill(0xff),
        }
        : {
          artifactId,
          artifactRevision: 1,
          objectId: prepared().objectId,
          accessRevision: 0,
          requiredNamespaceIds: [namespaceId],
          requiredNamespaceFingerprint:
            fingerprintRequiredArtifactNamespaces([namespaceId]),
        },
    ),
  };
  const repository = createDormantArtifactShadowRepository({
    product,
    crypto,
    blobs: {
      inspectStored: (facts) => {
        expect(Object.keys(facts).sort()).toEqual([
          "artifactId",
          "blobGeneration",
          "blobId",
          "ciphertextLength",
          "ciphertextSha256",
        ]);
        return Promise.resolve(blob === "missing"
          ? { status: "missing" as const }
          : blob === "mismatch"
          ? { status: "mismatch" as const }
          : {
            status: "exact" as const,
            reference: {
              plaintextLength: options.blobPlaintextLength ?? 4,
              chunkCount: 1,
            },
          });
      },
    },
  });
  return {
    repository,
    calls: () => ({ completeCalls, publishCalls, failures }),
    setBlob: (value: "exact" | "missing" | "mismatch") => {
      blob = value;
    },
  };
}

describe("dormant Artifact shadow saga", () => {
  test("publishes once and verifies exact replay without redoing crypto", async () => {
    const state = harness();
    expect(await state.repository.publish(plan())).toMatchObject({ status: "published" });
    expect(await state.repository.publish(plan())).toMatchObject({ status: "replayed" });
    expect(state.calls()).toEqual({ completeCalls: 1, publishCalls: 2, failures: 0 });
  });

  test("does not expose a mapping when the immutable blob is missing", async () => {
    const state = harness({ blob: "missing" });
    expect(await state.repository.publish(plan())).toEqual({
      status: "pending",
      reason: "blob_unavailable",
    });
    expect(state.calls()).toEqual({ completeCalls: 0, publishCalls: 0, failures: 1 });
  });

  test("quarantines a substituted durable crypto result", async () => {
    const state = harness({ verify: "mismatch" });
    expect(await state.repository.publish(plan())).toEqual({
      status: "quarantined",
      reason: "crypto_mismatch",
    });
    expect(state.calls()).toEqual({ completeCalls: 1, publishCalls: 0, failures: 1 });
  });

  test("quarantines a blob header outside the durable routing size bucket", async () => {
    const state = harness({ blobPlaintextLength: 70_000 });
    expect(await state.repository.publish(plan())).toEqual({
      status: "quarantined",
      reason: "blob_mismatch",
    });
    expect(state.calls()).toEqual({ completeCalls: 0, publishCalls: 0, failures: 1 });
  });

  test("quarantines rather than retries when a completed blob disappears", async () => {
    const state = harness();
    expect(await state.repository.publish(plan())).toMatchObject({ status: "published" });
    state.setBlob("missing");
    expect(await state.repository.reconcile("artifact-create:test")).toEqual({
      status: "quarantined",
      reason: "blob_unavailable",
    });
    expect(state.calls()).toEqual({ completeCalls: 1, publishCalls: 1, failures: 1 });
  });

  test("request digest binds blob routing and exact Namespace set", () => {
    const first = artifactPublicationRequestDigest(plan());
    expect(first).toHaveLength(32);
    expect(() => artifactPublicationRequestDigest({
      ...plan(),
      blob: { ...plan().blob, storageRef: `${blobId}.other` },
    })).toThrow("storage reference");
    expect(() => artifactPublicationRequestDigest({
      ...plan(),
      anchorNamespaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })).toThrow("anchor Namespace");
  });
});
