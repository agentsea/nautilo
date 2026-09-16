import { describe, expect, test } from "bun:test";
import type { ProtectedArtifactPreparedPublicationRequestV1 } from "@nautilo/api-client";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { seededRng } from "@nautilo/lattice-crypto/testing";

import {
  artifactBlobStorageRefV1,
  fingerprintRequiredArtifactNamespaces,
  type ArtifactPublicationLifecycle,
  type ArtifactPublicationReservationInput,
} from "../../src/artifact/artifact-repository.ts";
import {
  createHumanArtifactRoutePorts,
} from "../../src/server/artifact/human-artifact-route-ports.ts";

const NS = "11111111-1111-4111-8111-111111111111";
const ARTIFACT = "22222222-2222-4222-8222-222222222222";
const ROW = "33333333-3333-4333-8333-333333333333";
const BLOB = "44444444-4444-4444-8444-444444444444";
const OBJECT = `artifact:v1:${"a".repeat(64)}`;
const OPERATION = "artifact-publication:completed-replay";

const authority = Object.freeze({
  userId: "user-alice",
  subjectHumanId: "human-alice",
  actorId: "actor-alice",
  agentId: null,
  readableNamespaceIds: Object.freeze([NS]),
  mutableNamespaceIds: Object.freeze([NS]),
  writableNamespaceIds: Object.freeze([NS]),
});

function fixture() {
  const crypto = new LatticeCrypto(seededRng(0x262_17));
  const planDigest = new Uint8Array(32).fill(0x41);
  const ciphertextDigest = new Uint8Array(32).fill(0x42);
  const signedBytes = new TextEncoder().encode("expired-but-previously-authenticated");
  const fingerprint = fingerprintRequiredArtifactNamespaces([NS]);
  const prepared: ProtectedArtifactPreparedPublicationRequestV1 = {
    requestVersion: 1,
    operationId: OPERATION,
    planDigestBase64url: Buffer.from(planDigest).toString("base64url"),
    operation: "create",
    lifecycleAction: "activate",
    artifactRowId: ROW,
    artifactId: ARTIFACT,
    anchorNamespaceId: NS,
    cryptoObjectId: OBJECT,
    expectedArtifactRevision: 0,
    nextArtifactRevision: 1,
    expectedCryptoAccessRevision: 0,
    resultCryptoAccessRevision: 0,
    expectedBlobGeneration: 0,
    resultBlobGeneration: 1,
    expectedBlobId: null,
    resultBlobId: BLOB,
    requiredNamespaceIds: [NS],
    encryptedControlPayloadBytesBase64url: "Y29udHJvbA",
    accessManifestBytesBase64url: "bWFuaWZlc3Q",
    namespaceEnvelopes: [{
      namespaceId: NS,
      envelopeBytesBase64url: "ZW52ZWxvcGU",
    }],
    signedPublicationRequestBytesBase64url:
      Buffer.from(signedBytes).toString("base64url"),
    ciphertextLength: 123,
    ciphertextSha256Base64url:
      Buffer.from(ciphertextDigest).toString("base64url"),
    chunkPlaintextBytes: 1_048_576,
    chunkCount: 1,
    mimeClass: "document",
    sizeBucket: "le_64_kib",
  };
  const reservation: ArtifactPublicationReservationInput = Object.freeze({
    operationId: OPERATION,
    artifactRowId: ROW,
    artifactId: ARTIFACT,
    anchorNamespaceId: NS,
    operationType: "create",
    expectedArtifactRevision: 0,
    resultArtifactRevision: 1,
    expectedAccessRevision: 0,
    resultAccessRevision: 0,
    expectedBlobGeneration: 0,
    resultBlobGeneration: 1,
    expectedBlobId: null,
    resultBlobId: BLOB,
    expectedRequiredNamespaceFingerprint: null,
    targetRequiredNamespaceFingerprint: fingerprint.slice(),
    planDigest: planDigest.slice(),
  });
  const lifecycle: ArtifactPublicationLifecycle = Object.freeze({
    ...reservation,
    cryptoObjectId: OBJECT,
    blob: Object.freeze({
      artifactId: ARTIFACT,
      blobId: BLOB,
      blobGeneration: 1,
      storageRef: artifactBlobStorageRefV1(BLOB),
      ciphertextLength: 123,
      ciphertextSha256: ciphertextDigest.slice(),
    }),
    mimeClass: "document",
    sizeBucket: "le_64_kib",
    requestDigest: planDigest.slice(),
    allocationRequestDigest: crypto.hash(signedBytes),
    requiredNamespaceFingerprint: fingerprint.slice(),
    completion: "complete",
    disposition: "complete",
    attemptCount: 1,
    failureCode: null,
  });
  return { crypto, prepared, reservation, lifecycle };
}

describe("Human Artifact dormant route composition", () => {
  test("returns exact durable replay before deadline-sensitive authentication", async () => {
    const state = fixture();
    let openedBlob = false;
    let resolvedAuthority = false;
    const ports = createHumanArtifactRoutePorts({
      target: authority,
      crypto: state.crypto,
      now: () => Number.MAX_SAFE_INTEGER,
      productRoute: { plan: () => Promise.reject(new Error("unused")) },
      productRead: {
        list: () => Promise.reject(new Error("unused")),
        detail: () => Promise.reject(new Error("unused")),
        ciphertextRange: () => Promise.reject(new Error("unused")),
      },
      productPublication: {
        readPlan: () => Promise.resolve(state.reservation),
        read: () => Promise.resolve(state.lifecycle),
        reserve: () => Promise.reject(new Error("must not reserve replay")),
        publish: () => Promise.reject(new Error("must not republish replay")),
      },
      cryptoCompletion: {
        complete: () => Promise.reject(new Error("must not rerun crypto")),
      },
      blobs: {
        inspectStored: () => {
          openedBlob = true;
          return Promise.reject(new Error("must not reopen completed replay"));
        },
      } as never,
      resolvePublicationAuthority: () => {
        resolvedAuthority = true;
        return Promise.resolve(null);
      },
      exactAccess: {
        planAccess: () => Promise.reject(new Error("unused")),
        commitAccess: () => Promise.reject(new Error("unused")),
      },
    });
    expect(await ports.publish({ authority, prepared: state.prepared })).toEqual({
      dtoVersion: 1,
      status: "replayed",
      operationId: OPERATION,
      artifactId: ARTIFACT,
      artifactRevision: 1,
      cryptoAccessRevision: 0,
      blobId: BLOB,
      blobGeneration: 1,
      requiredNamespaceIds: [NS],
    });
    expect({ openedBlob, resolvedAuthority }).toEqual({
      openedBlob: false,
      resolvedAuthority: false,
    });
  });

  test("rejects a substituted completed-replay request digest", async () => {
    const state = fixture();
    const ports = createHumanArtifactRoutePorts({
      target: authority,
      crypto: state.crypto,
      now: () => Number.MAX_SAFE_INTEGER,
      productRoute: { plan: () => Promise.reject(new Error("unused")) },
      productRead: {
        list: () => Promise.reject(new Error("unused")),
        detail: () => Promise.reject(new Error("unused")),
        ciphertextRange: () => Promise.reject(new Error("unused")),
      },
      productPublication: {
        readPlan: () => Promise.resolve(state.reservation),
        read: () => Promise.resolve(state.lifecycle),
        reserve: () => Promise.reject(new Error("unused")),
        publish: () => Promise.reject(new Error("unused")),
      },
      cryptoCompletion: { complete: () => Promise.reject(new Error("unused")) },
      blobs: { inspectStored: () => Promise.reject(new Error("unused")) } as never,
      resolvePublicationAuthority: () => Promise.reject(new Error("unused")),
      exactAccess: {
        planAccess: () => Promise.reject(new Error("unused")),
        commitAccess: () => Promise.reject(new Error("unused")),
      },
    });
    const substituted = {
      ...state.prepared,
      signedPublicationRequestBytesBase64url:
        Buffer.from("different-request").toString("base64url"),
    };
    expect(await ports.publish({ authority, prepared: substituted })).toEqual({
      dtoVersion: 1,
      status: "unavailable",
      reason: "integrity_failure",
    });
  });
});
