import { acceptedForegroundSignerFixture } from "../fixtures/task-content-crypto-completion.ts";
import { describe, expect, spyOn, test } from "bun:test";
import type { PostgresJsBridgeConnection, PostgresJsBridgeRow, PostgresJsBridgeScalar } from "@nautilo/db";
import {
  LatticeCrypto, accessRevision, agentId, authorizationRevision, cryptoDeviceId, cryptoDomainId,
  createCommonHumanObjectAccessManifest, prepareAgentRuntimeInitialization,
  prepareDeviceWrappedAgentObjectAccessManifestGenesisSet,
  domainNamespaceRetainedAuthoritySetDigest, encryptObjectPayload, humanId,
  namespaceGeneration, namespaceId, objectId, prepareDomainNamespaceBundle,
  prepareHumanObjectAccessManifestGenesisSet, unixTimestamp, wrapObjectDekForNamespace,
  type DomainForegroundSecretEntry, type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2, DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  encodeEncryptedPayloadV2, encodeNamespaceObjectEnvelopeV2, encodeAgentRuntimeSignerPublicationV1,
} from "@nautilo/lattice-crypto/wire";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";
import { taskContentRevisionObjectIdV1, deriveTaskContentCryptoObjectIdV1, TASK_DEFINITION_OBJECT_TYPE_V1 } from "../../src/task/task-content-repository.ts";
import {
  encodeTaskDefinitionContentV2,
  encodeTaskPayloadV1,
} from "../../src/task/task-payload-v1.ts";
import {
  withNativeProtectedTaskDefinitionV1,
  type NativeProtectedTaskDefinitionOccurrenceV1,
} from "../../src/server/task/native-protected-task-definition-opener.ts";

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

async function fixture(adjust: Adjust = (_stage, rows) => rows, options: {
  agent?: string; rewrap?: boolean; ephemeral?: boolean; historical?: boolean;
  retainedHistoricalError?: string;
} = {}) {
  const crypto = new LatticeCrypto();
  const issuer = crypto.generateSigningKeyPair();
  const signer = crypto.generateSigningKeyPair();
  const domainKey = bytes(0x41);
  const generationKey = bytes(0x42);
  const retained = [{ generation: namespaceGeneration(0), accessRevision: accessRevision(0),
    headDigest: bytes(0x43), generationKey }];
  const retainedDigest = domainNamespaceRetainedAuthoritySetDigest(crypto, retained);
  const domainRequirement = { domainId: DOMAIN, sourceNamespaceId: NAMESPACE,
    participantDigest: bytes(0x61), participantCount: 1, keyClass: "ai" as const,
    domainKeyGeneration: 4, authorizationRevision: authorizationRevision(9), headDigest: bytes(0x62),
    activeNamespaceBindingSetDigest: bytes(0x63), activeNamespaceBindingCount: 1 };
  const domain: DomainForegroundSecretEntry = { ...domainRequirement, domainKey };
  const native = prepareDomainNamespaceBundle(crypto, {
    operationId: "native-task-binding", previousBindingDigest: null,
    bundle: { formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2, serverId: SERVER,
      cryptoDomainId: cryptoDomainId(DOMAIN), participantDigest: domain.participantDigest,
      participantCount: domain.participantCount, keyClass: "ai", domainKeyGeneration: domain.domainKeyGeneration,
      domainAuthorizationRevision: domain.authorizationRevision, domainHeadDigest: domain.headDigest,
      namespaceId: namespaceId(NAMESPACE), namespaceAccessRevision: accessRevision(0),
      namespaceCurrentGeneration: namespaceGeneration(0), bundleRevision: 1, retainedGenerationCount: 1,
      retainedAuthoritySetDigest: retainedDigest, retainedGenerations: retained },
    issuerHumanId: humanId(HUMAN), issuerDeviceId: cryptoDeviceId(DEVICE), issuerDeviceSigningGeneration: 1,
    issuerSigningPrivateKey: issuer.privateKey, issuerSigningPublicKey: issuer.publicKey,
    domainKey, issuedAt: NOW,
  });
  let occurrence: NativeProtectedTaskDefinitionOccurrenceV1 = {
    taskId: TASK, taskRunId: RUN, sourceRoomId: ROOM, agentId: AGENT, requesterHumanId: HUMAN,
    objectId: options.historical ? taskContentRevisionObjectIdV1({ coordinate: { kind: "definition", taskId: TASK, contentRevision: 1 },
      namespaceId: NAMESPACE, historicalRepair: { version: 2, claimId: RUN, publisherDeviceId: DEVICE,
        signedRequestDigest: "a".repeat(64), sourceDigest: "b".repeat(64), sourcePayloadHash: "c".repeat(64), sourceRevision: 0, genesisManifestHash: "d".repeat(64) } })
      : deriveTaskContentCryptoObjectIdV1({ kind: "definition", taskId: TASK, contentRevision: 2 }),
    contentRevision: options.historical ? 1 : 2, cryptoAccessRevision: options.rewrap ? 1 : 0, namespaceId: NAMESPACE, domainId: DOMAIN,
    expectedAccessRevision: 0, expectedPolicyRevision: 3,
  };
  const plaintext = options.retainedHistoricalError === undefined
    ? encodeTaskPayloadV1({ formatVersion: 1, prompt: "Open native protected Task", expectedOutput: "A result", protectedMetadata: {} })
    : encodeTaskDefinitionContentV2({ formatVersion: 2, prompt: "Open native protected Task", expectedOutput: "A result",
        protectedMetadata: {}, retainedHistoricalError: options.retainedHistoricalError });
  const encrypted = encryptObjectPayload(crypto, { objectId: objectId(occurrence.objectId),
    keyClass: "ai", objectType: TASK_DEFINITION_OBJECT_TYPE_V1, createdAt: unixTimestamp(NOW) }, plaintext);
  plaintext.fill(0);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelope = wrapObjectDekForNamespace(crypto, generationKey, {
    objectId: objectId(occurrence.objectId), namespaceId: namespaceId(NAMESPACE), keyClass: "ai",
    keyGeneration: namespaceGeneration(0), bindingRevisionAtWrap: accessRevision(0),
  }, encrypted.dek);
  let envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
  const objectDek = encrypted.dek.slice();
  encrypted.dek.fill(0); encrypted.payload.ciphertext.fill(0); envelope.wrappedDek.fill(0); generationKey.fill(0);
  let prepared = prepareHumanObjectAccessManifestGenesisSet(crypto, {
    objectId: objectId(occurrence.objectId), payloadHash: crypto.hash(payloadBytes), envelopeBytes: [envelopeBytes],
    sourceAuthorized: true, targetAuthorized: true, subjectHumanId: humanId(HUMAN),
    committerDeviceId: cryptoDeviceId(DEVICE), hostAuthorizationRevision: authorizationRevision(5),
    committerSigningPublicKey: signer.publicKey, committerSigningPrivateKey: signer.privateKey,
  });
  if (options.historical) occurrence = { ...occurrence, definitionHistoricalRepair: {
    version: 2, claimId: RUN, publisherDeviceId: DEVICE, signedRequestDigest: "a".repeat(64),
    sourceDigest: "b".repeat(64), sourcePayloadHash: "c".repeat(64), sourceRevision: 0,
    genesisManifestHash: Buffer.from(prepared.manifestHash).toString("hex"),
  } };
  let agentSignerRow: PostgresJsBridgeRow | null = null;
  let managerPublicKey: Uint8Array | null = null;
  if (options.agent !== undefined) {
    const manager = crypto.generateSigningKeyPair();
    managerPublicKey = manager.publicKey;
    const initialized = await prepareAgentRuntimeInitialization({
      crypto, operationId: "native-definition-runtime", agentId: agentId(options.agent),
      authorizationRevision: authorizationRevision(17),
      configObjects: [{ objectId: "native-definition-config", configRevision: authorizationRevision(1), plaintextDek: bytes(31) }],
      domains: [], resolveCurrentDomainCommitterAuthority: () => null,
      manager: { managerHumanId: humanId(HUMAN), managerAuthorizationRevision: authorizationRevision(8), managerDeviceId: cryptoDeviceId("manager-device") },
      managerSigningPrivateKey: manager.privateKey, resolveCurrentManagerAuthority: () => manager.publicKey,
    });
    const publication = initialized.signerPublication;
    prepared = prepareDeviceWrappedAgentObjectAccessManifestGenesisSet(crypto, {
      objectId: occurrence.objectId, payloadHash: crypto.hash(payloadBytes), envelopeBytes: [envelopeBytes],
      operationId: "native-definition-create", grant: { grantId: "foreground-grant", grantHash: bytes(21), recipientKeyId: "foreground-recipient" },
      runtime: initialized.runtime, signerKeyId: publication.signerKeyId, signerPublicKey: publication.signerPublicKey,
      agentAuthorizationRevision: publication.authorizationRevision,
      namespaces: [{ namespaceId: NAMESPACE, domainId: DOMAIN, accessRevision: 0, keyGeneration: 0,
        domainKeyGeneration: 4, domainAuthorizationRevision: 9, domainHeadDigest: domain.headDigest,
        headDigest: bytes(32), publicationDigest: bytes(32), publicationSetDigest: bytes(32), audienceFingerprint: bytes(32) }],
    });
    agentSignerRow = { agent_id: publication.agentId, runtime_generation: publication.runtimeGeneration,
      authorization_revision: publication.authorizationRevision, transition_kind: publication.transitionKind,
      operation_id: publication.operationId, signer_key_id: publication.signerKeyId, signer_public_key: publication.signerPublicKey,
      publication_bytes: encodeAgentRuntimeSignerPublicationV1(publication) };
  }
  const evidenceInput: TaskRuntimeExecutionEvidenceInputV1 = {
    requestId: "native-task-request", workId: RUN, claimId: "native-task-claim", claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000, expiresAt: NOW + 60_000, recipientGeneration: 1,
    recipientKeyId: "native-task-recipient", authorizationDigest: bytes(0x51), policyRevision: 3,
    episodeId: "native-task-episode", sourceRoomId: ROOM, hostAuthorizationRevision: 5,
    recipientAuthorizationRevision: 6,
    result: { taskId: TASK, taskRunId: RUN, contentRevision: 1, objectId: "native-task-result", signerAgentId: AGENT,
      namespace: { namespaceId: NAMESPACE, domainId: DOMAIN, operations: ["encrypt"], expectedAccessRevision: 0, expectedPolicyRevision: 3 } },
    domainRequirements: [domainRequirement], namespaceRequirements: [{ ordinal: 0,
      namespaceId: NAMESPACE, domainId: DOMAIN, operations: ["decrypt", "encrypt"], expectedAccessRevision: 0, expectedPolicyRevision: 3 }],
  };
  const manifest = { object_id: occurrence.objectId, access_revision: 0, manifest_hash: prepared.manifestHash,
    previous_manifest_hash: null as Uint8Array | null, payload_hash: crypto.hash(payloadBytes), manifest_bytes: prepared.manifestBytes };
  let head = manifest;
  if (options.rewrap) {
    envelopeBytes = encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(crypto, bytes(0x42), {
      objectId: objectId(occurrence.objectId), namespaceId: namespaceId(NAMESPACE), keyClass: "ai",
      keyGeneration: namespaceGeneration(0), bindingRevisionAtWrap: accessRevision(0),
    }, objectDek));
    const next = createCommonHumanObjectAccessManifest(crypto, {
      objectId: objectId(occurrence.objectId), payloadHash: crypto.hash(payloadBytes), accessRevision: accessRevision(1),
      previousManifestHash: prepared.manifestHash, envelopeHashes: [crypto.hash(envelopeBytes)],
      signer: { kind: "human_device", subjectHumanId: humanId(HUMAN), committerDeviceId: cryptoDeviceId(DEVICE) },
      signerAuthorizationHash: null, hostAuthorizationRevision: authorizationRevision(5),
    }, signer.privateKey);
    head = { ...manifest, access_revision: 1, previous_manifest_hash: prepared.manifestHash, manifest_bytes: next.bytes, manifest_hash: next.hash };
  }
  objectDek.fill(0);
  const stages: string[] = [];
  const restricted: PostgresJsBridgeConnection = {
    query: async <Row extends PostgresJsBridgeRow>(statement: string, parameters?: readonly PostgresJsBridgeScalar[]) => {
      let stage: string;
      let rows: readonly PostgresJsBridgeRow[];
      if (statement.includes("SELECT current_user::text")) {
        stage = "role"; rows = [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }];
      } else if (statement.includes('from "namespace_domain_key_heads"') && statement.includes('inner join')) {
        stage = "native-binding"; rows = [{ binding_bytes: native.bytes, binding_digest: native.bindingDigest, signing_public_key: issuer.publicKey }];
      } else if (statement.includes('from "namespace_domain_key_heads"')) {
        stage = "namespace"; rows = [{ namespace_id: NAMESPACE, namespace_access_revision: 0,
          namespace_current_generation: 0, domain_id: DOMAIN, domain_key_generation: 4,
          domain_authorization_revision: 9, domain_head_digest: domain.headDigest, bundle_revision: 1,
          retained_generation_count: 1, retained_authority_set_digest: retainedDigest, binding_digest: native.bindingDigest }];
      } else if (statement.includes('from "domain_key_heads"')) {
        stage = "domain"; rows = [{ domain_id: DOMAIN, domain_key_generation: "4",
          authorization_revision: "9", head_digest: domain.headDigest,
          participant_digest: domain.participantDigest, participant_count: "1" }];
      } else if (statement.includes('from "crypto_objects"')) {
        stage = "object"; rows = [{ object_id: occurrence.objectId, payload_bytes: payloadBytes, payload_hash: crypto.hash(payloadBytes) }];
      } else if (statement.includes('from "object_crypto_access_heads"')) {
        stage = "access-head"; rows = [head];
      } else if (statement.includes('from "object_crypto_namespace_envelopes"')) {
        stage = "envelope"; rows = [{ object_id: occurrence.objectId, access_revision: head.access_revision, ordinal: 0, namespace_id: NAMESPACE, envelope_hash: crypto.hash(envelopeBytes), envelope_bytes: envelopeBytes }];
      } else if (statement.includes('from "object_crypto_access_manifests"')) {
        if (statement.startsWith('select "manifest_bytes", "manifest_hash"')
          || statement.startsWith('select "object_id", "manifest_hash", "payload_hash"')) {
          stage = "genesis"; rows = [manifest];
        } else { stage = "manifest"; rows = options.rewrap ? [manifest, head] : [manifest]; }
      } else if (statement.includes('from "agent_crypto_runtime_signers"')) {
        stage = "agent-signer"; rows = agentSignerRow === null ? [] : [agentSignerRow];
      } else if (statement.includes('from "human_crypto_devices"') && parameters?.includes("manager-device")) {
        stage = "manager"; rows = [{ device_id: "manager-device", human_id: HUMAN, signing_public_key: managerPublicKey, state: "revoked", revision: 8 }];
      } else if (statement.includes('from "human_crypto_devices"')) {
        stage = "signer"; rows = [{ device_id: DEVICE, human_id: HUMAN, signing_public_key: signer.publicKey, state: "active", revision: 5 }];
      } else throw new Error(`Unexpected native Task query: ${statement}`);
      stages.push(stage);
      return adjust(stage, rows) as readonly Row[];
    },
    transaction: async (use) => use(restricted),
    transactionOnce: async (use) => use(restricted),
  };
  const accepted = options.ephemeral && agentSignerRow !== null
    ? await acceptedForegroundSignerFixture(crypto, agentSignerRow, {
        subjectHumanId: HUMAN,
        namespaceId: NAMESPACE,
        domainId: DOMAIN,
      })
    : undefined;
  if (options.ephemeral) agentSignerRow = null;
  const signal = new AbortController().signal;
  const open = <Value>(execute: Parameters<typeof withNativeProtectedTaskDefinitionV1<Value>>[0]["execute"],
    loadCurrentOccurrence: () => Promise<NativeProtectedTaskDefinitionOccurrenceV1 | null> = async () => occurrence,
    domains = [domain]) => withTaskRuntimeExecutionEvidenceV1({
    evidence: evidenceInput, signal, now: () => NOW,
    execute: (evidence) => withNativeProtectedTaskDefinitionV1({ restricted, crypto, serverScope: SERVER,
      evidence, domains, signal, loadCurrentOccurrence, execute,
      resolveForegroundAgentAcceptedExecutionEvidence: accepted?.resolve }),
  });
  return { accepted, crypto, occurrence, domain, evidenceInput, restricted, signal, stages, open, genesisHash: Uint8Array.from(manifest.manifest_hash) };
}

function change(stage: string, field: string, value: PostgresJsBridgeScalar): Adjust {
  return (current, rows) => current === stage ? rows.map((row) => ({ ...row, [field]: value })) : rows;
}

async function fails(operation: Promise<unknown>): Promise<void> {
  expect(await operation.then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
}

describe("native protected Task definition opener", () => {
  test("normalizes retained V2 display content out of the native execution payload", async () => {
    const f = await fixture(undefined, {
      agent: AGENT,
      retainedHistoricalError: "provider unavailable",
    });
    const payload = await f.open(value => value);
    expect(payload).toEqual({
      formatVersion: 1,
      prompt: "Open native protected Task",
      expectedOutput: "A result",
      protectedMetadata: {},
    });
    expect(payload).not.toHaveProperty("retainedHistoricalError");
  });

  test("opens retained ephemeral Agent genesis after Human rewrap without persistent Runtime inventory", async () => {
    const f = await fixture(undefined, { agent: AGENT, rewrap: true, ephemeral: true });
    expect(await f.open(async payload => payload.prompt)).toBe("Open native protected Task");
    expect(f.stages).not.toContain("agent-signer");
    f.accepted!.invalidate();
    await fails(f.open(async () => { throw new Error("Invalid receipt must not decrypt"); }));
  });
  test("opens the client-produced object using a signed native Domain bundle", async () => {
    const value = await fixture();
    const result = await value.open(async (payload, assertCurrent) => {
      await assertCurrent();
      return payload.prompt;
    });
    expect(result).toBe("Open native protected Task");
    expect(value.stages).toContain("native-binding");
    expect(value.stages).toContain("signer");
    expect(await value.open(() => null)).toBeNull();
  });

  for (const rewrap of [false, true]) {
    test(`opens genuine Agent definition with mapped access head ${rewrap ? 1 : 0}`, async () => {
      const value = await fixture(undefined, { agent: AGENT, rewrap });
      expect(await value.open((payload) => payload.prompt)).toBe("Open native protected Task");
      expect(value.stages).toContain("agent-signer");
      expect(value.stages).toContain("manager");
      if (rewrap) expect(value.stages).toContain("signer");
    });
  }

  test("preserves Human genesis opening after an authenticated access update", async () => {
    const value = await fixture(undefined, { rewrap: true });
    expect(await value.open((payload) => payload.expectedOutput)).toBe("A result");
  });

  test("denies a valid genesis signed by a different Agent", async () => {
    const value = await fixture(undefined, { agent: TASK, rewrap: true });
    let called = false;
    await fails(value.open(() => { called = true; }));
    expect(called).toBe(false);
  });

  test("opens a different-Agent genesis only with retained same-Human Domain authority", async () => {
    const value = await fixture(undefined, {
      agent: TASK,
      rewrap: true,
      ephemeral: true,
    });
    expect(await value.open(payload => payload.prompt))
      .toBe("Open native protected Task");
    value.accepted!.invalidate();
    await fails(value.open(() => "must not open"));
  });

  for (const [stage, field, replacement] of [
    ["manager", "human_id", AGENT], ["manager", "revision", 7],
    ["manager", "state", "pending"], ["manager", "signing_public_key", bytes(7)],
    ["agent-signer", "signer_public_key", bytes(7)],
    ["genesis", "manifest_hash", bytes(7)], ["access-head", "access_revision", 0],
  ] as const) {
    test(`denies invalid retained Agent chain ${stage}.${field}`, async () => {
      const value = await fixture(change(stage, field, replacement), { agent: AGENT, rewrap: true });
      let called = false;
      await fails(value.open(() => { called = true; }));
      expect(called).toBe(false);
    });
  }

  test("requires the exact mapped access head before and after opening", async () => {
    const value = await fixture(undefined, { agent: AGENT, rewrap: true });
    for (const cryptoAccessRevision of [0, 2, -1, Number.MAX_SAFE_INTEGER + 1]) {
      await fails(value.open(() => "must not open", async () => ({ ...value.occurrence, cryptoAccessRevision })));
    }
    let reads = 0;
    await fails(value.open(() => "opened", async () => ++reads >= 3
      ? { ...value.occurrence, cryptoAccessRevision: 2 } : value.occurrence));
  });

  test("wipes decrypted buffers on callback success and failure", async () => {
    for (const fail of [false, true]) {
      const value = await fixture();
      const decrypted: Uint8Array[] = [];
      const original = value.crypto.aeadOpen.bind(value.crypto);
      const spy = spyOn(value.crypto, "aeadOpen").mockImplementation((...args) => {
        const result = original(...args);
        if (result !== null) decrypted.push(result);
        return result;
      });
      try {
        const operation = value.open(() => { if (fail) throw new Error("callback failed"); return "done"; });
        if (fail) await fails(operation); else expect(await operation).toBe("done");
        expect(decrypted.length).toBeGreaterThan(0);
        for (const bytes of decrypted) expect(bytes.every((byte) => byte === 0)).toBe(true);
      } finally { spy.mockRestore(); }
    }
  });

  for (const [field, replacement] of [
    ["taskId", RUN], ["taskRunId", TASK], ["sourceRoomId", TASK], ["agentId", HUMAN],
    ["requesterHumanId", AGENT], ["contentRevision", 3], ["namespaceId", TASK],
    ["domainId", TASK], ["expectedAccessRevision", 1], ["expectedPolicyRevision", 4],
  ] as const) {
    test(`rejects swapped occurrence ${field}`, async () => {
      const value = await fixture(); let called = false;
      await fails(value.open(() => { called = true; }, async () => ({ ...value.occurrence, [field]: replacement })));
      expect(called).toBe(false);
    });
  }

  for (const [stage, field, replacement] of [
    ["role", "current_user", "nautilo"],
    ["domain", "domain_key_generation", 5], ["domain", "authorization_revision", 10],
    ["domain", "head_digest", bytes(5)], ["domain", "participant_digest", bytes(6)],
    ["domain", "participant_count", 2],
    ["namespace", "namespace_access_revision", 1], ["namespace", "domain_key_generation", 5],
    ["namespace", "domain_authorization_revision", 10], ["native-binding", "signing_public_key", bytes(5)],
    ["signer", "human_id", AGENT], ["signer", "revision", 4], ["signer", "state", "pending"],
    ["signer", "signing_public_key", bytes(8)],
  ] as const) {
    test(`rejects stale/substituted ${stage}.${field}`, async () => {
      const value = await fixture(change(stage, field, replacement)); let called = false;
      await fails(value.open(() => { called = true; }));
      expect(called).toBe(false);
    });
  }

  test("accepts retained signing history after device revocation", async () => {
    const value = await fixture(change("signer", "state", "revoked"));
    expect(await value.open((payload) => payload.expectedOutput)).toBe("A result");
  });

  test("rejects Domain secret substitution", async () => {
    const value = await fixture();
    await fails(value.open(() => "must not open", undefined, [{ ...value.domain, domainKey: bytes(9) }]));
  });

  test("rejects stale occurrence before plaintext and after callback", async () => {
    for (const staleAt of [2, 3]) {
      const value = await fixture(); let reads = 0; let called = false;
      await fails(value.open(() => { called = true; }, async () => ++reads >= staleAt
        ? { ...value.occurrence, contentRevision: 3 } : value.occurrence));
      expect(called).toBe(staleAt === 3);
    }
  });

  test("rejects native binding drift before and after plaintext use", async () => {
    for (const staleAt of [2, 3]) {
      let reads = 0; let called = false;
      const value = await fixture((stage, rows) => stage === "namespace" && ++reads >= staleAt
        ? rows.map((row) => ({ ...row, binding_digest: bytes(7) })) : rows);
      await fails(value.open(() => { called = true; }));
      expect(called).toBe(staleAt === 3);
    }
  });

  test("rejects Domain revocation while the native Namespace head stays unchanged", async () => {
    for (const staleAt of [2, 3]) {
      let reads = 0; let called = false;
      const value = await fixture((stage, rows) => stage === "domain" && ++reads >= staleAt
        ? rows.map((row) => ({ ...row, authorization_revision: 10 })) : rows);
      await fails(value.open(() => { called = true; }));
      expect(called).toBe(staleAt === 3);
    }
  });

  test("rejects forged and expired process-local evidence", async () => {
    const value = await fixture();
    const invoke = (evidence: TaskRuntimeExecutionEvidence) => withNativeProtectedTaskDefinitionV1({
      restricted: value.restricted, crypto: value.crypto, serverScope: SERVER, evidence,
      domains: [value.domain], signal: value.signal, loadCurrentOccurrence: async () => value.occurrence,
      execute: () => "must not open",
    });
    await fails(invoke(value.evidenceInput as unknown as TaskRuntimeExecutionEvidence));
    await withTaskRuntimeExecutionEvidenceV1({ evidence: value.evidenceInput,
      signal: value.signal, now: () => NOW, execute: async (evidence) => {
        expect(evidence.purpose).toBe("task.runtime.execution");
        expect(Object.isFrozen(evidence)).toBe(true);
        await fails(invoke({ ...evidence, purpose: "other" } as unknown as TaskRuntimeExecutionEvidence));
      } });
    const expired = await withTaskRuntimeExecutionEvidenceV1({ evidence: value.evidenceInput,
      signal: value.signal, now: () => NOW, execute: (evidence) => evidence });
    await fails(invoke(expired));
    expect(value.stages).toEqual([]);
  });
});


test("opens source-versioned historical definition only with exact retained signed genesis", async () => {
  const f = await fixture(undefined, { historical: true, rewrap: true });
  expect(await f.open(async payload => payload.prompt)).toBe("Open native protected Task");
});

test("historical identity rejects source and retained genesis substitution before decryption", async () => {
  for (const field of ["sourceDigest", "genesisManifestHash"] as const) {
    const f = await fixture(undefined, { historical: true, rewrap: true });
    const proof = f.occurrence.definitionHistoricalRepair!;
    const bad = { ...f.occurrence, definitionHistoricalRepair: { ...proof, [field]: "e".repeat(64) } };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(f.open(async payload => payload.prompt, async () => bad)).rejects.toThrow();
  }
});
