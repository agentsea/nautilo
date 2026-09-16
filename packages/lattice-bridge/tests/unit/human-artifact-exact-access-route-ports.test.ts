import { describe, expect, mock, test } from "bun:test";
import type { ProtectedArtifactPreparedAccessRequestV1 } from "@nautilo/api-client";

import {
  createHumanArtifactExactAccessRoutePorts,
  type HumanArtifactExactAccessCryptoRoutePort,
  type HumanArtifactExactAccessProductRoutePort,
} from "../../src/server/artifact/human-artifact-exact-access-route-ports.ts";
import type { HumanArtifactExactAccessPlan } from
  "../../src/server/artifact/postgres-human-artifact-exact-access-product.ts";

const ARTIFACT = "10000000-0000-4000-8000-000000000001";
const BLOB = "10000000-0000-4000-8000-000000000002";
const ROW = "10000000-0000-4000-8000-000000000003";
const A = "20000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const OBJECT = `artifact:v1:${"a".repeat(64)}`;
const authority = { userId: "user-1", subjectHumanId: "human-1",
  actorId: "actor-1", agentId: null, readableNamespaceIds: [A],
  mutableNamespaceIds: [A], writableNamespaceIds: [A, B] } as const;

function plan(): HumanArtifactExactAccessPlan {
  const binding = (namespaceId: string) => ({ namespaceId, domainId: "domain-1",
    expectedAccessRevision: 2, expectedPolicyRevision: 1,
    bindingHash: new Uint8Array(32).fill(0x44) });
  return { status: "prepared", operationId: "access:1",
    subjectHumanId: "human-1", anchorNamespaceId: A, artifactRowId: ROW,
    artifactId: ARTIFACT, artifactRevision: 3, cryptoObjectId: OBJECT,
    expectedCryptoAccessRevision: 1, nextCryptoAccessRevision: 2,
    blobId: BLOB, blobGeneration: 2,
    currentRequiredNamespaceFingerprint: new Uint8Array(32).fill(0x11),
    targetRequiredNamespaceFingerprint: new Uint8Array(32).fill(0x22),
    currentNamespaceIds: [A], targetNamespaceIds: [A, B],
    addedNamespaceIds: [B], removedNamespaceIds: [],
    currentBindings: [binding(A)], targetBindings: [binding(A), binding(B)],
    sourceAuthorized: true, targetAuthorized: true };
}

function prepared(): ProtectedArtifactPreparedAccessRequestV1 {
  return { requestVersion: 1, operationId: "access:1", artifactId: ARTIFACT,
    artifactRevision: 3, expectedCryptoAccessRevision: 1,
    nextCryptoAccessRevision: 2, cryptoObjectId: OBJECT, blobId: BLOB,
    blobGeneration: 2, currentNamespaceIds: [A], targetNamespaceIds: [A, B],
    accessManifestBytesBase64url: "bWFuaWZlc3Q",
    signedAccessRequestBytesBase64url: "c2lnbmVk",
    namespaceEnvelopes: [
      { namespaceId: A, envelopeBytesBase64url: "ZW52LWE" },
      { namespaceId: B, envelopeBytesBase64url: "ZW52LWI" },
    ] };
}

function fixture() {
  const current = plan();
  let replay: Awaited<ReturnType<HumanArtifactExactAccessProductRoutePort["lookupReplay"]>>
    = { status: "absent" };
  const product: HumanArtifactExactAccessProductRoutePort = {
    resolveTarget: mock(async () => ({ kind: "replace_exact" as const,
      namespaceIds: [A, B] })),
    plan: mock(async () => current),
    lookupReplay: mock(async () => replay), reserve: mock(async () => "reserved" as const),
    commit: mock(async () => ({ status: "updated" as const, operationId: "access:1",
      artifactId: ARTIFACT, cryptoAccessRevision: 2,
      requiredNamespaceIds: [A, B] })),
    reconcile: mock(async () => ({ status: "quarantined" as const })),
  };
  const handle = Object.freeze({}) as never;
  const crypto: HumanArtifactExactAccessCryptoRoutePort = {
    digestSignedRequest: mock(() => new Uint8Array(32).fill(7)),
    authenticate: mock(async () => ({ handle,
      signedRequestDigest: new Uint8Array(32).fill(7) })),
    complete: mock(async () => ({ operationId: "access:1", artifactId: ARTIFACT,
      objectId: OBJECT, artifactRevision: 3, blobId: BLOB, blobGeneration: 2,
      expectedAccessRevision: 1, resultAccessRevision: 2,
      currentManifestHash: new Uint8Array(32),
      resultManifestHash: new Uint8Array(32),
      targetRequiredNamespaceFingerprint: new Uint8Array(32).fill(0x22),
      requestDigest: new Uint8Array(32).fill(7), currentNamespaceIds: [A],
      targetNamespaceIds: [A, B], status: "applied" as const })),
    observe: mock(async () => ({ status: "absent" as const })),
  };
  return { product, crypto, ports: createHumanArtifactExactAccessRoutePorts({
    target: authority, now: () => 1_000_010, deadlineAt: () => 1_030_000,
    createOperationId: () => "access:1", product, crypto,
  }), setReplay(value: typeof replay) { replay = value; } };
}

describe("Human Artifact exact access route ports", () => {
  test("plans and commits one exact no-copy access update", async () => {
    const state = fixture();
    expect(await state.ports.planAccess({ authority, artifactId: ARTIFACT,
      operation: { kind: "grant_room", roomId: B } })).toMatchObject({
      status: "planned", artifactId: ARTIFACT, blobId: BLOB,
      currentNamespaceIds: [A], targetNamespaceIds: [A, B],
    });
    expect(await state.ports.commitAccess({ authority, artifactId: ARTIFACT,
      prepared: prepared() })).toEqual({ dtoVersion: 1, status: "updated",
      operationId: "access:1", artifactId: ARTIFACT, cryptoAccessRevision: 2,
      requiredNamespaceIds: [A, B] });
    expect(state.product.reserve).toHaveBeenCalledTimes(1);
    expect(state.crypto.complete).toHaveBeenCalledTimes(1);
  });

  test("uses durable completed replay before deadline-sensitive authentication", async () => {
    const state = fixture();
    state.setReplay({ status: "completed", cryptoAccessRevision: 7,
      requiredNamespaceIds: [B] });
    expect(await state.ports.commitAccess({ authority, artifactId: ARTIFACT,
      prepared: { ...prepared(), nextCryptoAccessRevision: 99 } })).toMatchObject({
      status: "replayed", cryptoAccessRevision: 7, requiredNamespaceIds: [B],
    });
    expect(state.crypto.authenticate).not.toHaveBeenCalled();
  });

  test("fails closed on authority and route substitutions", async () => {
    const state = fixture();
    expect(await state.ports.commitAccess({ authority: {
      ...authority, writableNamespaceIds: [A] }, artifactId: ARTIFACT,
      prepared: prepared() })).toMatchObject({ status: "unavailable",
      reason: "authorization_required" });
    expect(await state.ports.commitAccess({ authority, artifactId: BLOB,
      prepared: prepared() })).toMatchObject({ status: "unavailable" });
  });
});
