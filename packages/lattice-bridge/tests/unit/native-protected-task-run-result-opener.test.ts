import { createAgentObjectAccessManifestV5, createHumanObjectAccessManifestV5 } from "../../../lattice-crypto/src/format/object-access-manifest-v5.ts";
import { describe, expect, spyOn, test } from "bun:test";
import type { PostgresJsBridgeConnection, PostgresJsBridgeRow, PostgresJsBridgeScalar } from "@nautilo/db";
import {
  LatticeCrypto, accessRevision, authorizationRevision, cryptoDeviceId, cryptoDomainId,
  domainNamespaceRetainedAuthoritySetDigest, encryptObjectPayload, humanId,
  namespaceGeneration, namespaceId, objectId, prepareDomainNamespaceBundle,
  prepareAgentRuntimeInitialization, agentId, unixTimestamp, wrapObjectDekForNamespace,
  type DomainForegroundSecretEntry, type TaskRuntimeRunResultReadEvidence,
} from "@nautilo/lattice-crypto";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2, DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  encodeEncryptedPayloadV2, encodeNamespaceObjectEnvelopeV2, encodeAgentRuntimeSignerPublicationV1,
} from "@nautilo/lattice-crypto/wire";
import {
  withTaskRuntimeRunResultReadEvidenceV1,
  type TaskRuntimeRunResultReadEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-run-result-read-evidence-v1.ts";
import { deriveTaskContentCryptoObjectIdV1, TASK_RUN_RESULT_OBJECT_TYPE_V1 } from "../../src/task/task-content-repository.ts";
import { encodeTaskRunResultPayloadV1, type TaskRunResultPayloadV1 } from "../../src/task/task-payload-v1.ts";
import {
  assertAuthenticNativeProtectedTaskRunResultMessageSourceV1,
  withNativeProtectedTaskRunResultV1,
  withNativeProtectedTaskRunResultMessageSourceV1,
  type NativeProtectedTaskRunResultOccurrenceV1,
  type NativeProtectedTaskRunResultMessageSourceV1,
} from "../../src/server/task/native-protected-task-run-result-opener.ts";
import { encodeMessagePayloadV2 } from "../../src/message/message-payload-v2.ts";

const NOW = 1_920_000_000_000;
const TASK = "10000000-0000-4000-8000-000000000711";
const RUN = "20000000-0000-4000-8000-000000000711";
const HUMAN = "30000000-0000-4000-8000-000000000711";
const NAMESPACE = "40000000-0000-4000-8000-000000000711";
const DOMAIN = "50000000-0000-4000-8000-000000000711";
const AGENT = "60000000-0000-4000-8000-000000000711";
const DEVICE = "task-native-definition-device";
const ROOM = "70000000-0000-4000-8000-000000000711";
const SERVER = "https://nautilo.example";
const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);
type Adjust = (stage: string, rows: readonly PostgresJsBridgeRow[]) => readonly PostgresJsBridgeRow[];

async function fixture(
  adjust: Adjust = (_stage, rows) => rows,
  revision: 1 | 2 = 1,
  currentAccess = 0,
  resultPayload: TaskRunResultPayloadV1 = {
    formatVersion: 1, resultText: "A protected result", lastError: null,
  },
  bufferBacked = false,
  mappedAccess = 0,
) {
  const crypto = new LatticeCrypto();
  const issuer = crypto.generateSigningKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const initialized = await prepareAgentRuntimeInitialization({ crypto,
    operationId: "result-read-historical-runtime", agentId: agentId(AGENT),
    authorizationRevision: authorizationRevision(7),
    configObjects: [{ objectId: "read-agent-config", configRevision: authorizationRevision(1), plaintextDek: bytes(0x21) }],
    domains: [], resolveCurrentDomainCommitterAuthority: () => null,
    manager: { managerHumanId: humanId(HUMAN), managerAuthorizationRevision: authorizationRevision(2), managerDeviceId: cryptoDeviceId(DEVICE) },
    managerSigningPrivateKey: manager.privateKey, resolveCurrentManagerAuthority: () => manager.publicKey });
  const signerPublication = initialized.signerPublication;
  const domainKey = bytes(0x41);
  const generationKey = bytes(0x42);
  const retained = [{ generation: namespaceGeneration(0), accessRevision: accessRevision(0),
    headDigest: bytes(0x43), generationKey }];
  const retainedDigest = domainNamespaceRetainedAuthoritySetDigest(crypto, retained);
  const digest = (value: number): Uint8Array => bufferBacked
    ? Buffer.from(bytes(value)) : bytes(value);
  const domainRequirement = { domainId: DOMAIN, sourceNamespaceId: NAMESPACE,
    participantDigest: digest(0x61), participantCount: 1, keyClass: "ai" as const,
    domainKeyGeneration: 4, authorizationRevision: authorizationRevision(9), headDigest: digest(0x62),
    activeNamespaceBindingSetDigest: digest(0x63), activeNamespaceBindingCount: 1 };
  const domain: DomainForegroundSecretEntry = { ...domainRequirement, domainKey };
  const native = prepareDomainNamespaceBundle(crypto, {
    operationId: "native-task-binding", previousBindingDigest: null,
    bundle: { formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2, serverId: SERVER,
      cryptoDomainId: cryptoDomainId(DOMAIN), participantDigest: domain.participantDigest,
      participantCount: domain.participantCount, keyClass: "ai", domainKeyGeneration: domain.domainKeyGeneration,
      domainAuthorizationRevision: domain.authorizationRevision, domainHeadDigest: domain.headDigest,
      namespaceId: namespaceId(NAMESPACE), namespaceAccessRevision: accessRevision(currentAccess),
      namespaceCurrentGeneration: namespaceGeneration(0), bundleRevision: 1, retainedGenerationCount: 1,
      retainedAuthoritySetDigest: retainedDigest, retainedGenerations: retained },
    issuerHumanId: humanId(HUMAN), issuerDeviceId: cryptoDeviceId(DEVICE), issuerDeviceSigningGeneration: 1,
    issuerSigningPrivateKey: issuer.privateKey, issuerSigningPublicKey: issuer.publicKey,
    domainKey, issuedAt: NOW,
  });
  const result = {
    taskId: TASK, taskRunId: RUN, terminalStatus: revision === 2 ? "cancelled" as const : "completed" as const,
    signerAgentId: AGENT, contentRevision: revision, cryptoAccessRevision: mappedAccess,
    objectId: deriveTaskContentCryptoObjectIdV1({ kind: "run_result", taskId: TASK, taskRunId: RUN, contentRevision: revision }),
    genesisManifestHash: bytes(0), namespace: { namespaceId: NAMESPACE, domainId: DOMAIN,
      operations: ["decrypt"] as const, expectedAccessRevision: currentAccess, expectedPolicyRevision: 3 },
  };
  const invocation = { kind: "raw" as const, bindingId: `task-run-output:${RUN}`,
    operationId: `task-run-delivery-message:${RUN}`, roomId: ROOM, sessionId: "result-read-session" };
  const occurrence: NativeProtectedTaskRunResultOccurrenceV1 = { requesterHumanId: HUMAN, result, invocation };
  const plaintext = encodeTaskRunResultPayloadV1(resultPayload);
  const encrypted = encryptObjectPayload(crypto, { objectId: objectId(result.objectId),
    keyClass: "ai", objectType: TASK_RUN_RESULT_OBJECT_TYPE_V1, createdAt: unixTimestamp(NOW) }, plaintext);
  plaintext.fill(0);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelope = wrapObjectDekForNamespace(crypto, generationKey, {
    objectId: objectId(result.objectId), namespaceId: namespaceId(NAMESPACE), keyClass: "ai",
    keyGeneration: namespaceGeneration(0), bindingRevisionAtWrap: accessRevision(0),
  }, encrypted.dek);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
  encrypted.dek.fill(0); encrypted.payload.ciphertext.fill(0); envelope.wrappedDek.fill(0); generationKey.fill(0);
  const prepared = createAgentObjectAccessManifestV5(crypto, {
    objectId: objectId(result.objectId), payloadHash: crypto.hash(payloadBytes), accessRevision: accessRevision(0),
    previousManifestHash: null, envelopeHashes: [crypto.hash(envelopeBytes)],
    signer: { kind: "agent_runtime", agentId: initialized.runtime.agentId,
      runtimeGeneration: initialized.runtime.generation, signerKeyId: signerPublication.signerKeyId },
    signerAuthorizationHash: null, hostAuthorizationRevision: authorizationRevision(7),
  }, initialized.runtime);
  const successor = mappedAccess === 0 ? prepared : createHumanObjectAccessManifestV5(crypto, {
    objectId: objectId(result.objectId), payloadHash: crypto.hash(payloadBytes), accessRevision: accessRevision(1),
    previousManifestHash: prepared.hash, envelopeHashes: [crypto.hash(envelopeBytes)],
    signer: { kind: "human_device", subjectHumanId: humanId(HUMAN), committerDeviceId: cryptoDeviceId(DEVICE) },
    signerAuthorizationHash: null, hostAuthorizationRevision: authorizationRevision(1),
  }, issuer.privateKey);
  result.genesisManifestHash = bufferBacked
    ? Buffer.from(prepared.hash) : prepared.hash.slice();
  const evidenceInput: TaskRuntimeRunResultReadEvidenceInputV1 = {
    purpose: "task.runtime.run_result_read", workKind: "task.deliver_result",
    requestId: `task-run-delivery-result-authorization:${RUN}`, workId: RUN,
    claimId: "result-read-claim", claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000, authorizationExpiresAt: NOW + 60_000, expiresAt: NOW + 60_000, recipientGeneration: 1,
    recipientKeyId: "result-read-recipient", authorizationDigest: digest(0x51), policyRevision: 3,
    requesterHumanId: HUMAN, episodeId: invocation.sessionId, sourceRoomId: ROOM,
    hostAuthorizationRevision: 5, recipientAuthorizationRevision: 6,
    operations: ["decrypt"], result, invocation, resultDomain: domainRequirement,
    messageWrite: revision === 1 ? {
      taskId: TASK,
      taskRunId: RUN,
      bindingId: invocation.bindingId,
      messageOperationId: invocation.operationId,
      roomId: invocation.roomId,
      sessionId: invocation.sessionId,
      signerAgentId: AGENT,
      namespace: { namespaceId: NAMESPACE, domainId: DOMAIN,
        operations: ["encrypt"], expectedAccessRevision: currentAccess,
        expectedPolicyRevision: 3 },
      domain: domainRequirement,
    } : null,
  };
  const manifest = { object_id: result.objectId, access_revision: 0, manifest_hash: prepared.hash,
    previous_manifest_hash: null, payload_hash: crypto.hash(payloadBytes), manifest_bytes: prepared.bytes };
  const stages: string[] = [];
  const restricted: PostgresJsBridgeConnection = {
    query: async <Row extends PostgresJsBridgeRow>(statement: string) => {
      let stage: string;
      let rows: readonly PostgresJsBridgeRow[];
      if (statement.includes("SELECT current_user::text")) {
        stage = "role"; rows = [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }];
      } else if (statement.includes('from "namespace_domain_key_heads"') && statement.includes('inner join')) {
        stage = "native-binding"; rows = [{ binding_bytes: native.bytes, binding_digest: native.bindingDigest, signing_public_key: issuer.publicKey }];
      } else if (statement.includes('from "namespace_domain_key_heads"')) {
        stage = "namespace"; rows = [{ namespace_id: NAMESPACE, namespace_access_revision: currentAccess,
          namespace_current_generation: 0, domain_id: DOMAIN, domain_key_generation: 4,
          domain_authorization_revision: 9, domain_head_digest: domain.headDigest, bundle_revision: 1,
          retained_generation_count: 1, retained_authority_set_digest: retainedDigest, binding_digest: native.bindingDigest }];
      } else if (statement.includes('from "domain_key_heads"')) {
        stage = "domain"; rows = [{ domain_id: DOMAIN, domain_key_generation: "4",
          authorization_revision: "9", head_digest: domain.headDigest,
          participant_digest: domain.participantDigest, participant_count: "1" }];
      } else if (statement.includes('from "crypto_objects"')) {
        stage = "object"; rows = [{ object_id: result.objectId, payload_bytes: payloadBytes, payload_hash: crypto.hash(payloadBytes) }];
      } else if (statement.includes('from "object_crypto_access_heads"')) {
        stage = "access-head"; rows = [{ ...manifest, access_revision: mappedAccess, previous_manifest_hash: mappedAccess === 0 ? null : prepared.hash, manifest_hash: successor.hash, manifest_bytes: successor.bytes }];
      } else if (statement.includes('from "object_crypto_namespace_envelopes"')) {
        stage = "envelope"; rows = [{ namespace_id: NAMESPACE, envelope_hash: crypto.hash(envelopeBytes), envelope_bytes: envelopeBytes }];
      } else if (statement.includes('from "object_crypto_access_manifests"')) {
        stage = "manifest"; rows = mappedAccess !== 0 && statement.includes("order by")
          ? [manifest, { ...manifest, access_revision: 1, previous_manifest_hash: prepared.hash,
            manifest_hash: successor.hash, manifest_bytes: successor.bytes }] : [manifest];
      } else if (statement.includes('from "human_crypto_devices"')) {
        stage = "human-signer"; rows = [{ device_id: DEVICE, human_id: HUMAN, signing_public_key: issuer.publicKey, state: "active", revision: 1 }];
      } else if (statement.includes('from "agent_crypto_runtime_signers"')) {
        stage = "historical-signer"; rows = [{ agent_id: AGENT, runtime_generation: initialized.runtime.generation,
          authorization_revision: signerPublication.authorizationRevision, transition_kind: signerPublication.transitionKind,
          operation_id: signerPublication.operationId, signer_key_id: signerPublication.signerKeyId,
          signer_public_key: signerPublication.signerPublicKey, publication_bytes: encodeAgentRuntimeSignerPublicationV1(signerPublication) }];
      } else throw new Error(`Unexpected native Task query: ${statement}`);
      stages.push(stage);
      return adjust(stage, rows) as readonly Row[];
    },
    transaction: async (use) => use(restricted),
    transactionOnce: async (use) => use(restricted),
  };
  const signal = new AbortController().signal;
  const open = <Value>(execute: Parameters<typeof withNativeProtectedTaskRunResultV1<Value>>[0]["execute"],
    loadCurrentResult: () => Promise<NativeProtectedTaskRunResultOccurrenceV1 | null> = async () => occurrence,
    domains = [domain]) => withTaskRuntimeRunResultReadEvidenceV1({
    evidence: evidenceInput, signal, now: () => NOW,
    execute: (evidence) => withNativeProtectedTaskRunResultV1({ restricted, crypto, serverScope: SERVER,
      evidence, domains, signal, loadCurrentResult,
      resolveHistoricalAgentSignerAuthority: context => ({ ...context, managerSigningPublicKey: manager.publicKey }), execute }),
  });
  const openMessageSource = <Value>(execute: Parameters<typeof withNativeProtectedTaskRunResultMessageSourceV1<Value>>[0]["execute"],
    loadCurrentResult: () => Promise<NativeProtectedTaskRunResultOccurrenceV1 | null> = async () => occurrence,
  ) => withTaskRuntimeRunResultReadEvidenceV1({ evidence: evidenceInput, signal, now: () => NOW,
    execute: evidence => withNativeProtectedTaskRunResultMessageSourceV1({
      restricted, crypto, serverScope: SERVER, evidence, domains: [domain], signal,
      loadCurrentResult, resolveHistoricalAgentSignerAuthority: context => ({
        ...context, managerSigningPublicKey: manager.publicKey,
      }), execute,
    }),
  });
  return { crypto, occurrence, domain, evidenceInput, restricted, signal,
    stages, open, openMessageSource, manager };
}

function change(stage: string, field: string, value: PostgresJsBridgeScalar): Adjust {
  return (current, rows) => current === stage ? rows.map((row) => ({ ...row, [field]: value })) : rows;
}

async function fails(operation: Promise<unknown>): Promise<void> {
  expect(await operation.then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
}


describe("native protected Task run result opener", () => {
  test.each([1, 2] as const)("reads exact mapped result revision %s with retained Agent signer history", async revision => {
    const value = await fixture(undefined, revision);
    const result = await value.open(async (payload, assertCurrent) => {
      await assertCurrent(); return payload.resultText;
    });
    expect(result).toBe("A protected result");
    expect(value.stages).toContain("historical-signer");
    expect(await value.open(() => null)).toBeNull();
  });

  test("opens an older retained Namespace envelope under a newer current access revision", async () => {
    const value = await fixture(undefined, 1, 2);
    expect(await value.open(payload => payload.resultText)).toBe("A protected result");
  });

  test("lends a callback-live assistant Message source tied to the raw revision-one write proof", async () => {
    const value = await fixture();
    let escaped: NativeProtectedTaskRunResultMessageSourceV1 | undefined;
    const outcome = await value.openMessageSource(async (source, assertCurrent) => {
      escaped = source;
      assertAuthenticNativeProtectedTaskRunResultMessageSourceV1(source);
      await assertCurrent();
      expect(source.payload).toEqual({ role: "assistant", content: "A protected result" });
      const encoded = encodeMessagePayloadV2(source.payload);
      try { expect(source.payloadDigest).toEqual(value.crypto.hash(encoded)); }
      finally { encoded.fill(0); }
      expect(source.result).toEqual(value.occurrence.result);
      if (value.occurrence.invocation.kind !== "raw"
        || value.evidenceInput.messageWrite === null) {
        throw new Error("raw Message source fixture missing");
      }
      expect(source.invocation).toEqual(value.occurrence.invocation);
      expect(source.messageWrite).toEqual(value.evidenceInput.messageWrite);
      expect(() => assertAuthenticNativeProtectedTaskRunResultMessageSourceV1(
        { ...source } as NativeProtectedTaskRunResultMessageSourceV1,
      )).toThrow();
      return "publishable";
    });
    expect(outcome).toEqual({ status: "available", value: "publishable" });
    expect(escaped).toBeDefined();
    expect(() => assertAuthenticNativeProtectedTaskRunResultMessageSourceV1(escaped!)).toThrow();
    expect(escaped!.payloadDigest).toEqual(new Uint8Array(32));
    expect(escaped!.result.genesisManifestHash).toEqual(new Uint8Array(32));
  });

  test("wipes Buffer-backed source copies without revoking or overwriting the parent proof", async () => {
    const value = await fixture(undefined, 1, 0, undefined, true);
    const parentDigests = [value.occurrence.result.genesisManifestHash,
      value.evidenceInput.authorizationDigest,
      value.evidenceInput.resultDomain.participantDigest,
      value.evidenceInput.resultDomain.headDigest,
      value.evidenceInput.resultDomain.activeNamespaceBindingSetDigest,
      value.evidenceInput.messageWrite!.domain.participantDigest,
      value.evidenceInput.messageWrite!.domain.headDigest,
      value.evidenceInput.messageWrite!.domain.activeNamespaceBindingSetDigest];
    expect(parentDigests.every(digest => Buffer.isBuffer(digest))).toBe(true);
    const expected = parentDigests.map(digest => Uint8Array.from(digest));
    let escaped: NativeProtectedTaskRunResultMessageSourceV1 | undefined;
    expect(await value.openMessageSource(async (source, assertCurrent) => {
      escaped = source;
      expect(Buffer.isBuffer(source.result.genesisManifestHash)).toBe(false);
      expect(Buffer.isBuffer(source.messageWrite.domain.participantDigest))
        .toBe(false);
      await assertCurrent();
      return "published";
    })).toEqual({ status: "available", value: "published" });
    expect(parentDigests).toEqual(expected);
    expect(escaped!.result.genesisManifestHash).toEqual(new Uint8Array(32));
    expect(escaped!.messageWrite.domain.participantDigest)
      .toEqual(new Uint8Array(32));
  });

  test("does not expose lastError or cancellation results as Message sources", async () => {
    const errorOnly = await fixture(undefined, 1, 0, {
      formatVersion: 1, resultText: null, lastError: "private execution failure",
    });
    let called = false;
    expect(await errorOnly.openMessageSource(() => { called = true; }))
      .toEqual({ status: "unavailable", reason: "result_text_unavailable" });
    expect(called).toBe(false);

    const cancelled = await fixture(undefined, 2);
    await fails(cancelled.openMessageSource(() => { called = true; }));
    expect(called).toBe(false);
  });

  test("detects Message source mutation before callback completion", async () => {
    const value = await fixture();
    const failure = value.openMessageSource(source => {
      source.payloadDigest[0] = source.payloadDigest[0]! ^ 1;
      return "must-not-escape";
    });
    await fails(failure);
  });

  test("wipes decrypted buffers after callback success and failure", async () => {
    for (const reject of [false, true]) {
      const value = await fixture();
      const plaintext: Uint8Array[] = [];
      const open = value.crypto.aeadOpen.bind(value.crypto);
      const spy = spyOn(value.crypto, "aeadOpen").mockImplementation((...args) => {
        const bytes = open(...args); if (bytes !== null) plaintext.push(bytes); return bytes;
      });
      try {
        const result = value.open(payload => {
          expect(payload.resultText).toBe("A protected result");
          if (reject) throw new Error("callback failed");
          return true;
        });
        if (reject) await fails(result); else expect(await result).toBe(true);
        expect(plaintext.length).toBeGreaterThan(0);
        expect(plaintext.every(buffer => buffer.every(byte => byte === 0))).toBe(true);
      } finally { spy.mockRestore(); }
    }
  });

  test("rejects substituted immutable result, signer, Domain and revoked delivery before any plaintext callback", async () => {
    const adjustments = [
      change("access-head", "manifest_hash", bytes(4)),
      change("historical-signer", "agent_id", TASK),
      change("historical-signer", "signer_public_key", bytes(2)),
      change("namespace", "namespace_access_revision", 1),
      change("domain", "authorization_revision", 10),
    ];
    for (const adjustment of adjustments) {
      const value = await fixture(adjustment); let called = false;
      await fails(value.open(() => { called = true; })); expect(called).toBe(false);
    }
    const value = await fixture(); let called = false;
    await fails(value.open(() => { called = true; }, async () => null));
    await fails(value.open(() => { called = true; }, async () => ({ ...value.occurrence,
      result: { ...value.occurrence.result, genesisManifestHash: bytes(9) } })));
    await fails(value.open(() => { called = true; }, async () => ({ ...value.occurrence,
      invocation: { ...value.occurrence.invocation, roomId: TASK } })));
    expect(called).toBe(false);
  });

  test("reproves product and current Domain authority before and after callback", async () => {
    for (const loseAt of [2, 3, 4]) {
      const value = await fixture(); let reads = 0; let called = false;
      await fails(value.open(() => { called = true; }, async () => ++reads >= loseAt ? null : value.occurrence));
      expect(called).toBe(loseAt === 4);
    }
    let domainReads = 0;
    const value = await fixture((stage, rows) => stage === "domain" && ++domainReads === 4
      ? rows.map(row => ({ ...row, authorization_revision: 10 })) : rows);
    await fails(value.open(() => true));
  });

  test("forged, expired and other-purpose evidence cannot reach storage", async () => {
    const value = await fixture();
    const invoke = (evidence: TaskRuntimeRunResultReadEvidence) => withNativeProtectedTaskRunResultV1({
      restricted: value.restricted, crypto: value.crypto, serverScope: SERVER, evidence,
      domains: [value.domain], signal: value.signal, loadCurrentResult: async () => value.occurrence,
      resolveHistoricalAgentSignerAuthority: () => null, execute: () => "never",
    });
    await fails(invoke(value.evidenceInput as unknown as TaskRuntimeRunResultReadEvidence));
    const expired = await withTaskRuntimeRunResultReadEvidenceV1({ evidence: value.evidenceInput,
      signal: value.signal, now: () => NOW, execute: async evidence => {
        await fails(invoke({ ...evidence })); return evidence;
      } });
    await fails(invoke(expired));
    expect(value.stages).toEqual([]);
  });
});

test("matching caller metadata cannot substitute mapped genesis or expected Agent identity", async () => {
  for (const field of ["genesis", "signer"] as const) {
    const value = await fixture();
    if (field === "genesis") value.occurrence.result.genesisManifestHash.fill(33);
    const proof = field === "signer" ? { ...value.occurrence.result, signerAgentId: TASK } : value.occurrence.result;
    let called = false;
    await fails(withTaskRuntimeRunResultReadEvidenceV1({
      evidence: { ...value.evidenceInput, result: proof }, signal: value.signal, now: () => NOW,
      execute: evidence => withNativeProtectedTaskRunResultV1({
        restricted: value.restricted, crypto: value.crypto, serverScope: SERVER, evidence,
        domains: [value.domain], signal: value.signal,
        loadCurrentResult: async () => ({ ...value.occurrence, result: proof }),
        resolveHistoricalAgentSignerAuthority: context => ({ ...context, managerSigningPublicKey: value.manager.publicKey }),
        execute: () => { called = true; },
      }),
    }));
    expect(called).toBe(false);
  }
});


test.each([1, 2] as const)("opens mapped result revision %s through an authenticated Human rewrap", async revision => {
  const value = await fixture(undefined, revision, 2, undefined, false, 1);
  expect(await value.open(payload => payload.resultText)).toBe("A protected result");
  expect(value.stages).toContain("human-signer");
  expect(value.occurrence.result.cryptoAccessRevision).toBe(1);
});

test("denies substituted mapped head, missing chain, and changed genesis before disclosure", async () => {
  for (const adjust of [change("access-head", "access_revision", 2),
    (stage: string, rows: readonly PostgresJsBridgeRow[]) => stage === "manifest" ? rows.slice(1) : rows,
    change("manifest", "manifest_hash", bytes(0xaa))]) {
    const value = await fixture(adjust, 1, 2, undefined, false, 1);
    let disclosed = false;
    await fails(value.open(() => { disclosed = true; }));
    expect(disclosed).toBe(false);
  }
});
