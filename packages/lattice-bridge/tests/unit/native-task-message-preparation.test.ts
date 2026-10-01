import { describe, expect, spyOn, test } from "bun:test";
import {
  LatticeCrypto, accessRevision, agentId, authorizationRevision, cryptoDeviceId, cryptoDomainId,
  decryptObjectThroughNamespace, domainNamespaceRetainedAuthoritySetDigest, humanId,
  namespaceGeneration, namespaceId, prepareAgentRuntimeInitialization, prepareDomainNamespaceBundle, verifyCommonObjectAccessManifest,
} from "@nautilo/lattice-crypto";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2, DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2, decodeObjectAccessManifestV5,
} from "@nautilo/lattice-crypto/wire";
import {
  withTaskRuntimeExecutionEvidenceV1, type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";
import { deriveMessageCryptoObjectIdV2 } from "../../src/message/conversation-repository.ts";
import { readPreparedConversationCryptoRevisionSnapshot } from "../../src/message/conversation-prepared-revision.ts";
import { decodeMessagePayloadV2 } from "../../src/message/message-payload-v2.ts";
import {
  prepareNativeTaskMessage, readPreparedNativeTaskMessage,
  type NativeTaskMessageAuthority, type PrepareNativeTaskMessageInput,
} from "../../src/server/task/native-task-message-preparation.ts";

const NOW = 1_920_000_000_000;
const SESSION = "10000000-0000-4000-8000-000000000721";
const NS = "message-namespace";
const DOMAIN = "message-domain";
const AGENT = "task-agent";
const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);

async function fixture() {
  const crypto = new LatticeCrypto();
  const issuer = crypto.generateSigningKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const domainKey = bytes(0x41);
  const generationKey = bytes(0x42);
  const retained = [{ generation: namespaceGeneration(0), accessRevision: accessRevision(0), headDigest: bytes(0x43), generationKey }];
  const retainedDigest = domainNamespaceRetainedAuthoritySetDigest(crypto, retained);
  const domain = { domainId: DOMAIN, sourceNamespaceId: NS, participantDigest: bytes(0x61), participantCount: 1,
    keyClass: "ai" as const, domainKeyGeneration: 4, authorizationRevision: authorizationRevision(9), headDigest: bytes(0x62),
    activeNamespaceBindingSetDigest: bytes(0x63), activeNamespaceBindingCount: 1 };
  const current = { serverId: "https://nautilo.example", cryptoDomainId: cryptoDomainId(DOMAIN), participantDigest: domain.participantDigest,
    participantCount: 1, keyClass: "ai" as const, domainKeyGeneration: 4,
    domainAuthorizationRevision: authorizationRevision(9), domainHeadDigest: domain.headDigest,
    namespaceId: namespaceId(NS), namespaceAccessRevision: accessRevision(0), namespaceCurrentGeneration: namespaceGeneration(0),
    bundleRevision: 1, retainedAuthoritySetDigest: retainedDigest };
  const native = prepareDomainNamespaceBundle(crypto, {
    operationId: "native-task-message-binding", previousBindingDigest: null,
    bundle: { ...current, formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2, retainedGenerationCount: 1, retainedGenerations: retained },
    issuerHumanId: humanId("human"), issuerDeviceId: cryptoDeviceId("device"), issuerDeviceSigningGeneration: 1,
    issuerSigningPrivateKey: issuer.privateKey, issuerSigningPublicKey: issuer.publicKey, domainKey, issuedAt: NOW,
  });
  const initialized = await prepareAgentRuntimeInitialization({ crypto, operationId: "native-message-initialization", agentId: agentId(AGENT),
    authorizationRevision: authorizationRevision(7),
    configObjects: [{ objectId: "task-agent-config", configRevision: authorizationRevision(1), plaintextDek: bytes(0x21) }],
    domains: [], resolveCurrentDomainCommitterAuthority: () => null,
    manager: { managerHumanId: humanId("human"), managerAuthorizationRevision: authorizationRevision(2), managerDeviceId: cryptoDeviceId("device") },
    managerSigningPrivateKey: manager.privateKey, resolveCurrentManagerAuthority: () => manager.publicKey });
  const evidenceInput: TaskRuntimeExecutionEvidenceInputV1 = {
    requestId: "message-request", workId: "run", claimId: "message-claim", claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000, expiresAt: NOW + 60_000, recipientGeneration: 1,
    recipientKeyId: "message-recipient", authorizationDigest: bytes(0x51), policyRevision: 3,
    episodeId: "message-episode", sourceRoomId: "calling-room", hostAuthorizationRevision: 5, recipientAuthorizationRevision: 6,
    result: { taskId: "task", taskRunId: "run", contentRevision: 1, objectId: "task-result", signerAgentId: AGENT,
      namespace: { namespaceId: "requester-private", domainId: "private-domain", operations: ["encrypt"], expectedAccessRevision: 0, expectedPolicyRevision: 3 } },
    domainRequirements: [domain, { ...domain, domainId: "private-domain", sourceNamespaceId: "requester-private" }],
    namespaceRequirements: [
      { ordinal: 0, namespaceId: NS, domainId: DOMAIN, operations: ["encrypt"], expectedAccessRevision: 0, expectedPolicyRevision: 3 },
      { ordinal: 1, namespaceId: "requester-private", domainId: "private-domain", operations: ["encrypt"], expectedAccessRevision: 0, expectedPolicyRevision: 3 },
    ],
  };
  const revision = { sessionId: SESSION, messageId: 1, revision: 0 };
  const controller = new AbortController();
  let time = NOW;
  const checks: NativeTaskMessageAuthority[] = [];
  const base: Omit<PrepareNativeTaskMessageInput, "evidence"> = {
    crypto, coordinates: { ...revision, taskId: "task", taskRunId: "run", roomId: "transcript-room",
      graphThreadId: "task:task", humanTurnId: "run", agentId: AGENT, objectId: deriveMessageCryptoObjectIdV2(revision), role: "assistant" },
    mode: "encrypted_only", payload: { role: "assistant", content: "Protected native Task transcript" }, createdAt: NOW,
    namespace: { current, bindingBytes: native.bytes, expectedBindingDigest: native.bindingDigest, issuerSigningPublicKey: issuer.publicKey, domainKey },
    runtime: initialized.runtime, signerPublication: initialized.signerPublication, agentAuthorizationRevision: 7,
    resolveHistoricalSignerPublicationManager: () => manager.publicKey, signal: controller.signal,
    resolveCurrentAuthority: (authority) => { checks.push(authority); return Promise.resolve({ ...authority }); },
  };
  const prepare = (overrides: Partial<PrepareNativeTaskMessageInput> = {}, evidence = evidenceInput) => withTaskRuntimeExecutionEvidenceV1({
    evidence, signal: controller.signal, now: () => time,
    execute: (opened) => prepareNativeTaskMessage({ ...base, evidence: opened, ...overrides }),
  });
  return { crypto, base, evidenceInput, prepare, controller, checks, generationKey, expire: () => { time = NOW + 60_000; } };
}

async function fails(operation: Promise<unknown>): Promise<void> {
  expect(await operation.then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
}

describe("native Task Message preparation", () => {
  test("seals canonical MessagePayloadV2 in the granted Message audience, separate from the Task result", async () => {
    const value = await fixture();
    const prepared = await value.prepare();
    const snapshot = readPreparedNativeTaskMessage(prepared);
    expect(prepared.authority.namespaceId).toBe(NS);
    expect(prepared.authority.roomId).toBe("transcript-room");
    expect(value.checks).toHaveLength(2);
    const payload = decodeEncryptedPayloadV2(snapshot.object.payloadBytes.ciphertext);
    const envelope = decodeNamespaceObjectEnvelopeV2(snapshot.envelopeBytes[0]);
    const manifest = decodeObjectAccessManifestV5(snapshot.manifestBytes);
    expect(payload.context.objectType).toBe("nautilo-message-v2");
    expect(manifest.signer).toMatchObject({ kind: "agent_runtime", agentId: AGENT, runtimeGeneration: 0 });
    expect(manifest.payloadHash).toEqual(value.crypto.hash(snapshot.object.payloadBytes.ciphertext));
    expect(() => verifyCommonObjectAccessManifest(value.crypto, { manifestBytes: snapshot.manifestBytes,
      resolveHistoricalHumanDeviceSigningPublicKey: () => null,
      resolveAgentRuntimeSignerPublicKey: () => value.base.signerPublication.signerPublicKey,
      resolveProcessorSignerAuthorizationBytes: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    })).not.toThrow();
    const plaintext = decryptObjectThroughNamespace(value.crypto, value.generationKey, envelope, payload);
    expect(plaintext).not.toBeNull();
    try { expect(decodeMessagePayloadV2(plaintext!)).toEqual(value.base.payload); }
    finally { plaintext?.fill(0); }
  });

  test("private brand is incompatible with Conversation completion and snapshots are detached", async () => {
    const value = await fixture(); const prepared = await value.prepare();
    expect(() => readPreparedNativeTaskMessage({ ...prepared })).toThrow();
    expect(() => readPreparedConversationCryptoRevisionSnapshot(
      prepared as unknown as Parameters<typeof readPreparedConversationCryptoRevisionSnapshot>[0],
    )).toThrow();
    const first = readPreparedNativeTaskMessage(prepared);
    first.manifestBytes.fill(0); first.envelopeBytes[0].fill(0); first.object.payloadBytes.ciphertext.fill(0);
    const second = readPreparedNativeTaskMessage(prepared);
    expect(second.manifestBytes.some((byte) => byte !== 0)).toBe(true);
    expect(second.envelopeBytes[0].some((byte) => byte !== 0)).toBe(true);
    expect(second.object.payloadBytes.ciphertext.some((byte) => byte !== 0)).toBe(true);
  });

  for (const field of ["taskId", "taskRunId", "agentId", "objectId"] as const) {
    test(`rejects substituted ${field} against evidence or canonical Message coordinate`, async () => {
      const value = await fixture(); await fails(value.prepare({ coordinates: { ...value.base.coordinates, [field]: "other" } }));
    });
  }
  for (const field of ["roomId", "sessionId", "messageId", "graphThreadId", "humanTurnId", "policyRevision",
    "namespaceId", "namespaceBindingDigest", "domainHeadDigest", "runtimeGeneration", "role", "mode"] as const) {
    test(`rejects current ${field} drift`, async () => {
      const value = await fixture();
      await fails(value.prepare({ resolveCurrentAuthority: (expected) => Promise.resolve({ ...expected, [field]: "changed" } as NativeTaskMessageAuthority) }));
    });
  }

  test("rejects Human authorship, mismatched role, and Plain policy", async () => {
    const value = await fixture();
    await fails(value.prepare({ payload: { role: "user", content: "human" } }));
    await fails(value.prepare({ coordinates: { ...value.base.coordinates, role: "tool" } }));
    await fails(value.prepare({ mode: "plaintext_only" as PrepareNativeTaskMessageInput["mode"] }));
  });

  test("rejects ungranted or decrypt-only Message Namespace", async () => {
    const value = await fixture();
    await fails(value.prepare({}, { ...value.evidenceInput, namespaceRequirements: [
      { ...value.evidenceInput.namespaceRequirements[1]!, ordinal: 0 },
    ] }));
    await fails(value.prepare({}, { ...value.evidenceInput, namespaceRequirements: [
      { ...value.evidenceInput.namespaceRequirements[0]!, operations: ["decrypt"] }, value.evidenceInput.namespaceRequirements[1]!,
    ] }));
  });

  test("rejects structurally forged Task evidence", async () => {
    const value = await fixture();
    await withTaskRuntimeExecutionEvidenceV1({ evidence: value.evidenceInput, signal: value.controller.signal, now: () => NOW,
      execute: async (evidence) => { await fails(prepareNativeTaskMessage({ ...value.base, evidence: { ...evidence } })); },
    });
  });

  test("rejects altered Domain generation, native binding, key and signer history", async () => {
    const value = await fixture(); const source = value.base.namespace;
    await fails(value.prepare({ namespace: { ...source, current: { ...source.current, domainKeyGeneration: 5 } } }));
    await fails(value.prepare({ namespace: { ...source, expectedBindingDigest: bytes(3) } }));
    await fails(value.prepare({ namespace: { ...source, domainKey: bytes(3) } }));
    await fails(value.prepare({ resolveHistoricalSignerPublicationManager: () => null }));
    await fails(value.prepare({ agentAuthorizationRevision: 8 }));
  });

  test("rechecks current authority after crypto and honors abort/expiry", async () => {
    const value = await fixture(); let checks = 0;
    await fails(value.prepare({ resolveCurrentAuthority: (expected) => Promise.resolve(++checks === 2 ? null : expected) }));
    expect(checks).toBe(2);
    const expired = await fixture();
    await fails(expired.prepare({ resolveCurrentAuthority: (expected) => { expired.expire(); return Promise.resolve(expected); } }));
    const aborted = await fixture();
    aborted.controller.abort(); await fails(aborted.prepare());
  });

  test("wipes owned plaintext, Runtime and Domain keys and opened bundle bytes without damaging borrowed inputs", async () => {
    const value = await fixture(); const captured: Uint8Array[] = [];
    const sealOriginal = value.crypto.aeadSeal.bind(value.crypto);
    const openOriginal = value.crypto.aeadOpen.bind(value.crypto);
    const seal = spyOn(value.crypto, "aeadSeal").mockImplementation((...args) => {
      captured.push(args[0], args[1]); return sealOriginal(...args);
    });
    const open = spyOn(value.crypto, "aeadOpen").mockImplementation((...args) => {
      captured.push(args[0]); const result = openOriginal(...args); if (result !== null) captured.push(result); return result;
    });
    try {
      await value.prepare();
      expect(captured.length).toBeGreaterThan(0);
      for (const bytes of captured) expect(bytes.every((byte) => byte === 0)).toBe(true);
      expect(value.base.runtime.key.some((byte) => byte !== 0)).toBe(true);
      expect(value.base.namespace.domainKey.some((byte) => byte !== 0)).toBe(true);
    } finally { seal.mockRestore(); open.mockRestore(); }
  });
});
