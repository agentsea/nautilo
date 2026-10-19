import { describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { agentId, agentRuntimeGeneration, deriveAgentRuntimeObjectSignerPublic,
  LatticeCrypto } from "@nautilo/lattice-crypto";
import { prepareNativeTaskDefinitionCryptoRevision } from "../../src/server/task/native-task-definition-preparation.ts";
import { createPreparedForegroundTaskDefinitionCryptoRevisionV1,
  readPreparedTaskContentCryptoRevisionSnapshotV1 } from "../../src/task/task-content-prepared-revision.ts";
import { readPreparedDeviceWrappedAgentObjectSnapshot,
  type PreparedDeviceWrappedAgentObject } from "../../src/object/device-wrapped-agent-object-crypto.ts";
import type { ForegroundAgentEntityCryptoInvocation } from "../../src/object/foreground-agent-entity-crypto.ts";
import { deriveTaskContentCryptoObjectIdV1 } from "../../src/task/task-content-repository.ts";
import { encodeTaskDefinitionContent, encodeTaskPayloadV1 } from "../../src/task/task-payload-v1.ts";

const taskId = "10000000-0000-4000-8000-000000000001";
const namespaceId = "40000000-0000-4000-8000-000000000001";
const domainId = "50000000-0000-4000-8000-000000000001";
function fixture() {
  const crypto = new LatticeCrypto();
  const runtime = { agentId: agentId("native-task-agent"), keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(2), key: new Uint8Array(32).fill(31) };
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  const authority = { authorityVersion: 1 as const, kind: "requester_private_namespace" as const,
    keyClass: "ai" as const, requesterHumanId: "30000000-0000-4000-8000-000000000001",
    namespaceId, domainId, expectedAccessRevision: 2, expectedPolicyRevision: 3 };
  const current = { namespaceId, domainId, namespaceAccessRevision: 2, namespaceKeyGeneration: 4,
    domainKeyGeneration: 1, domainAuthorizationRevision: 2, domainHeadDigest: new Uint8Array(32).fill(1),
    namespaceHeadDigest: new Uint8Array(32).fill(2), namespacePublicationDigest: new Uint8Array(32).fill(3),
    namespacePublicationSetDigest: new Uint8Array(32).fill(4), namespaceAudienceFingerprint: new Uint8Array(32).fill(5) };
  const controller = new AbortController();
  let admitted = true;
  let loans = 0;
  const entities: ForegroundAgentEntityCryptoInvocation = {
    signal: controller.signal,
    use: async () => { throw new Error("Expected independently admitted current Namespace set"); },
    useCurrentSet: async request => {
      expect(request.namespaceIds).toEqual([namespaceId]);
      expect(request.operations).toEqual(["encrypt"]);
      if (!admitted) return { status: "unavailable", reason: "content_unavailable" };
      loans += 1;
      const key = new Uint8Array(32).fill(41);
      try { return { status: "executed", value: await request.execute([{ namespaceKey: key, authority: current }]) }; }
      finally { key.fill(0); }
    },
  };
  const input = { crypto, taskId, authority, entities, createdAt: 1_820_000_000_000,
    payload: { formatVersion: 1 as const, prompt: "Private Task prompt", expectedOutput: "Exact result", protectedMetadata: {} },
    publication: { operationId: "native-task-create", grantId: "foreground-grant", grantDigest: new Uint8Array(32).fill(9),
      recipientKeyId: "foreground-recipient", runtime, signerKeyId: signer.principal.signerKeyId,
      signerPublicKey: signer.publicKey, agentAuthorizationRevision: 4, policyRevision: 3 } };
  return { input, current, controller, loans: () => loans, deny: () => { admitted = false; } };
}

describe("native foreground Task definition preparation", () => {
  test("keeps V1 definition bytes identical and accepts retained V2 content", async () => {
    const v1 = fixture();
    expect(encodeTaskDefinitionContent(v1.input.payload))
      .toEqual(encodeTaskPayloadV1(v1.input.payload));
    const v2 = fixture();
    const prepared = await prepareNativeTaskDefinitionCryptoRevision({ ...v2.input,
      payload: { formatVersion: 2, prompt: v2.input.payload.prompt,
        expectedOutput: v2.input.payload.expectedOutput,
        protectedMetadata: v2.input.payload.protectedMetadata,
        retainedHistoricalError: "provider unavailable" } });
    expect(prepared).not.toBeNull();
    expect(prepared?.payloadVersion).toBe(1);
  });

  test("prepares one private definition with the real foreground signing family", async () => {
    const f = fixture();
    const prepared = await prepareNativeTaskDefinitionCryptoRevision(f.input);
    expect(prepared).not.toBeNull();
    const snapshot = readPreparedTaskContentCryptoRevisionSnapshotV1(prepared!);
    expect("publicationFamily" in snapshot && snapshot.publicationFamily).toBe("foreground_definition");
    expect(snapshot.coordinate).toEqual({ kind: "definition", taskId, contentRevision: 1 });
    expect(prepared!.objectId).toBe(deriveTaskContentCryptoObjectIdV1(snapshot.coordinate));
    expect(snapshot.access.envelopeBytes).toHaveLength(1);
    expect(new TextDecoder().decode(snapshot.object.payloadBytes.ciphertext)).not.toContain(f.input.payload.prompt);
    expect(f.loans()).toBe(1);
  });
  test("missing private foreground admission returns waiting without borrowing a key", async () => {
    const f = fixture(); f.deny();
    expect(await prepareNativeTaskDefinitionCryptoRevision(f.input)).toBeNull();
    expect(f.loans()).toBe(0);
  });
  test("prepares an explicitly coordinated later definition revision", async () => {
    const f = fixture();
    const prepared = await prepareNativeTaskDefinitionCryptoRevision({ ...f.input, contentRevision: 2 });
    const snapshot = readPreparedTaskContentCryptoRevisionSnapshotV1(prepared!);
    expect(snapshot.coordinate).toEqual({ kind: "definition", taskId, contentRevision: 2 });
    expect(prepared!.objectId).toBe(deriveTaskContentCryptoObjectIdV1(snapshot.coordinate));
  });
  test("policy, Namespace, Domain, access and expiry changes refuse preparation", async () => {
    const p = fixture();
    await rejects(prepareNativeTaskDefinitionCryptoRevision({ ...p.input,
      publication: { ...p.input.publication, policyRevision: 4 } }), /policy/);
    expect(p.loans()).toBe(0);
    for (const field of ["namespaceId", "domainId", "namespaceAccessRevision"] as const) {
      const f = fixture();
      if (field === "namespaceAccessRevision") f.current[field] += 1;
      else f.current[field] = "substituted";
      await rejects(prepareNativeTaskDefinitionCryptoRevision(f.input), /authority changed/);
    }
    const expired = fixture(); expired.controller.abort();
    await rejects(prepareNativeTaskDefinitionCryptoRevision(expired.input));
    expect(expired.loans()).toBe(0);
  });
  test("the opaque adapter refuses forged preparations, invalid revisions, rebound coordinates and mutable authority", async () => {
    const f = fixture();
    const coordinate = { kind: "definition" as const, taskId, contentRevision: 1 };
    expect(() => createPreparedForegroundTaskDefinitionCryptoRevisionV1({ coordinate,
      authority: f.input.authority, prepared: {} as PreparedDeviceWrappedAgentObject })).toThrow(/custody/);
    const prepared = await prepareNativeTaskDefinitionCryptoRevision(f.input);
    const snapshot = readPreparedTaskContentCryptoRevisionSnapshotV1(prepared!);
    if (!("foregroundPrepared" in snapshot)) throw new Error("Expected foreground preparation");
    expect(() => createPreparedForegroundTaskDefinitionCryptoRevisionV1({ coordinate: { ...coordinate, contentRevision: 2 },
      authority: f.input.authority, prepared: snapshot.foregroundPrepared })).toThrow(/coordinates|authority/);
    expect(() => createPreparedForegroundTaskDefinitionCryptoRevisionV1({ coordinate: { ...coordinate, contentRevision: 0 },
      authority: f.input.authority, prepared: snapshot.foregroundPrepared })).toThrow(/revision/);
    const original = readPreparedDeviceWrappedAgentObjectSnapshot(snapshot.foregroundPrepared);
    original.access.authority.grantHash[0] = original.access.authority.grantHash[0]! ^ 1;
    expect(() => readPreparedTaskContentCryptoRevisionSnapshotV1(prepared!)).toThrow(/authentic preparation/);
  });
});
