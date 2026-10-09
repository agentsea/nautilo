import { describe, expect, spyOn, test } from "bun:test";
import { seededRng } from "../../src/crypto/index.ts";

import {
  LatticeCrypto,
  accessRevision,
  agentId,
  assertAuthenticPreparedTaskRuntimeResultObject,
  authorizationRevision,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  decryptObjectThroughNamespace,
  domainEpoch,
  domainNamespaceRetainedAuthoritySetDigest,
  humanId,
  namespaceBindingHash,
  namespaceGeneration,
  namespaceId,
  openNamespaceKeyring,
  prepareAgentRuntimeInitialization,
  prepareDomainNamespaceBundle,
  prepareNativeTaskRuntimeResultObject,
  prepareTaskRuntimeResultObject,
  sealNamespaceKeyring,
  verifyNamespaceBindingProof,
  type PrepareNativeTaskRuntimeResultObjectInput,
  type PrepareTaskRuntimeResultObjectInput,
  type PreparedTaskRuntimeResultObject,
  type DomainNamespaceRetainedGeneration,
} from "../../src/index.ts";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
  type TaskRuntimeExecutionEvidenceV1,
} from "../../src/background/task-runtime-execution-evidence-v1.ts";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
  DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "../../src/wire.ts";

const NOW = 1_930_000_000_000;
const TASK_ID = "10000000-0000-4000-8000-000000000801";
const RUN_ID = "20000000-0000-4000-8000-000000000801";
const HUMAN_ID = "30000000-0000-4000-8000-000000000801";
const NAMESPACE_ID = "40000000-0000-4000-8000-000000000801";
const DOMAIN_ID = "50000000-0000-4000-8000-000000000801";
const AGENT_ID = "60000000-0000-4000-8000-000000000801";
const ACCESS_REVISION = 0;
const POLICY_REVISION = 3;
const DOMAIN_GENERATION = 4;
const DOMAIN_AUTHORIZATION_REVISION = 9;

function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(seed = 801) {
  const crypto = new LatticeCrypto(seededRng(seed), { now: () => NOW });
  const namespaceCommitter = crypto.generateSigningKeyPair();
  const bundleIssuer = crypto.generateSigningKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const domainRoot = bytes(0x31);
  const domainKey = bytes(0x41);
  const ns = namespaceId(NAMESPACE_ID);
  const domain = cryptoDomainId(DOMAIN_ID);
  const epoch = domainEpoch(DOMAIN_GENERATION);
  const revision = accessRevision(ACCESS_REVISION);
  const device = cryptoDeviceId(`task-result-device-${seed}`);
  const rings = createInitialNamespaceKeyrings(crypto, ns);
  const metadata = {
    domainId: domain,
    domainEpoch: epoch,
    accessRevision: revision,
    previousBindingHash: null,
    committerDeviceId: device,
  };
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: bytes(0x32),
    keyring: { ...rings.human, accessRevision: revision },
    metadata,
    committerSigningPrivateKey: namespaceCommitter.privateKey,
    resolveCurrentCommitter: () => namespaceCommitter.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot,
    keyring: { ...rings.ai, accessRevision: revision },
    metadata,
    committerSigningPrivateKey: namespaceCommitter.privateKey,
    resolveCurrentCommitter: () => namespaceCommitter.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: namespaceCommitter.privateKey,
    resolveCurrentCommitter: () => namespaceCommitter.publicKey,
  });
  const trustedHead = verifyNamespaceBindingProof({
    crypto,
    anchor: {
      namespaceId: ns,
      accessRevision: revision,
      bindingHash: namespaceBindingHash(binding),
    },
    proof: [binding],
    resolveHistoricalCommitter: () => namespaceCommitter.publicKey,
  });
  const openedKeyring = openNamespaceKeyring({
    crypto,
    domainRoot,
    envelope: aiEnvelope,
    resolveHistoricalCommitter: () => namespaceCommitter.publicKey,
  });
  const currentKey = openedKeyring.generations.find((entry) =>
    entry.generation === openedKeyring.currentGeneration
  );
  if (currentKey === undefined) throw new Error("current test key is absent");
  const generationKey = currentKey.key.slice();
  const currentGeneration = namespaceGeneration(currentKey.generation);
  for (const entry of openedKeyring.generations) entry.key.fill(0);

  const participantDigest = bytes(0x61);
  const domainHeadDigest = bytes(0x62);
  const activeNamespaceBindingSetDigest = bytes(0x63);
  const retained = [{
    generation: currentGeneration,
    accessRevision: revision,
    headDigest: bytes(0x43),
    generationKey,
  }];
  const retainedAuthoritySetDigest =
    domainNamespaceRetainedAuthoritySetDigest(crypto, retained);
  const nativeCurrent = {
    serverId: "https://nautilo.example",
    cryptoDomainId: domain,
    participantDigest,
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: DOMAIN_GENERATION,
    domainAuthorizationRevision:
      authorizationRevision(DOMAIN_AUTHORIZATION_REVISION),
    domainHeadDigest,
    namespaceId: ns,
    namespaceAccessRevision: revision,
    namespaceCurrentGeneration: currentGeneration,
    bundleRevision: 1,
    retainedAuthoritySetDigest,
  };
  const nativeBundle = prepareDomainNamespaceBundle(crypto, {
    operationId: `task-result-native-binding-${seed}`,
    previousBindingDigest: null,
    bundle: {
      ...nativeCurrent,
      formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
      retainedGenerationCount: 1,
      retainedGenerations: retained,
    },
    issuerHumanId: humanId(HUMAN_ID),
    issuerDeviceId: device,
    issuerDeviceSigningGeneration: 1,
    issuerSigningPrivateKey: bundleIssuer.privateKey,
    issuerSigningPublicKey: bundleIssuer.publicKey,
    domainKey,
    issuedAt: NOW,
  });

  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: `task-result-runtime-initialization-${seed}`,
    agentId: agentId(AGENT_ID),
    authorizationRevision: authorizationRevision(7),
    configObjects: [{
      objectId: `task-result-agent-config-${seed}`,
      configRevision: authorizationRevision(1),
      plaintextDek: bytes(0x21),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId(HUMAN_ID),
      managerAuthorizationRevision: authorizationRevision(2),
      managerDeviceId: device,
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const domainRequirement = {
    domainId: DOMAIN_ID,
    sourceNamespaceId: NAMESPACE_ID,
    participantDigest,
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: DOMAIN_GENERATION,
    authorizationRevision:
      authorizationRevision(DOMAIN_AUTHORIZATION_REVISION),
    headDigest: domainHeadDigest,
    activeNamespaceBindingSetDigest,
    activeNamespaceBindingCount: 1,
  };
  const evidence = {
    requestId: `task-result-request-${seed}`,
    workId: RUN_ID,
    claimId: `task-result-claim-${seed}`,
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 1,
    recipientKeyId: `task-result-recipient-${seed}`,
    authorizationDigest: bytes(0x51),
    policyRevision: POLICY_REVISION,
    episodeId: `task-result-episode-${seed}`,
    sourceRoomId: `task-result-room-${seed}`,
    hostAuthorizationRevision: 5,
    recipientAuthorizationRevision: 6,
    result: {
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      contentRevision: 1,
      objectId: `task-result-object-${seed}`,
      signerAgentId: AGENT_ID,
      namespace: {
        namespaceId: NAMESPACE_ID,
        domainId: DOMAIN_ID,
        operations: ["encrypt"],
        expectedAccessRevision: ACCESS_REVISION,
        expectedPolicyRevision: POLICY_REVISION,
      },
    },
    domainRequirements: [domainRequirement],
    namespaceRequirements: [{
      ordinal: 0,
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      operations: ["decrypt", "encrypt"],
      expectedAccessRevision: ACCESS_REVISION,
      expectedPolicyRevision: POLICY_REVISION,
    }],
  } as const satisfies TaskRuntimeExecutionEvidenceInputV1;
  const legacyNamespace = {
    trustedHead,
    aiKeyringEnvelope: aiEnvelope,
    currentDomainRoot: domainRoot,
    resolveHistoricalCommitter: () => namespaceCommitter.publicKey,
  };
  const nativeNamespace: PrepareNativeTaskRuntimeResultObjectInput["namespace"] = {
    current: nativeCurrent,
    bindingBytes: nativeBundle.bytes,
    expectedBindingDigest: nativeBundle.bindingDigest,
    issuerSigningPublicKey: bundleIssuer.publicKey,
    domainKey,
  };
  return {
    crypto,
    namespaceCommitter,
    bundleIssuer,
    manager,
    initialized,
    evidence,
    legacyNamespace,
    nativeNamespace,
    generationKey,
    device,
  };
}

type NativeCurrent =
  PrepareNativeTaskRuntimeResultObjectInput["namespace"]["current"];

function signedNativeNamespace(
  value: Fixture,
  input: Readonly<{
    operation: string;
    current?: Partial<NativeCurrent>;
    retained?: readonly DomainNamespaceRetainedGeneration[];
  }>,
): PrepareNativeTaskRuntimeResultObjectInput["namespace"] {
  const provisionalCurrent = {
    ...value.nativeNamespace.current,
    ...input.current,
  };
  const retained = input.retained ?? [{
    generation: provisionalCurrent.namespaceCurrentGeneration,
    accessRevision: provisionalCurrent.namespaceAccessRevision,
    headDigest: bytes(0x43),
    generationKey: value.generationKey,
  }];
  const current = {
    ...provisionalCurrent,
    retainedAuthoritySetDigest:
      domainNamespaceRetainedAuthoritySetDigest(value.crypto, retained),
  };
  const prepared = prepareDomainNamespaceBundle(value.crypto, {
    operationId: `task-result-native-${input.operation}`,
    previousBindingDigest: null,
    bundle: {
      ...current,
      formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
      retainedGenerationCount: retained.length,
      retainedGenerations: retained,
    },
    issuerHumanId: humanId(HUMAN_ID),
    issuerDeviceId: value.device,
    issuerDeviceSigningGeneration: 1,
    issuerSigningPrivateKey: value.bundleIssuer.privateKey,
    issuerSigningPublicKey: value.bundleIssuer.publicKey,
    domainKey: value.nativeNamespace.domainKey,
    issuedAt: NOW,
  });
  return {
    current,
    bindingBytes: prepared.bytes,
    expectedBindingDigest: prepared.bindingDigest,
    issuerSigningPublicKey: value.bundleIssuer.publicKey,
    domainKey: value.nativeNamespace.domainKey,
  };
}

function withEvidence<Value>(
  value: Fixture,
  execute: (evidence: TaskRuntimeExecutionEvidenceV1) => Value | PromiseLike<Value>,
  evidence: TaskRuntimeExecutionEvidenceInputV1 = value.evidence,
): Promise<Value> {
  return withTaskRuntimeExecutionEvidenceV1({
    evidence,
    signal: new AbortController().signal,
    now: () => NOW,
    execute,
  });
}

function baseInput(
  value: Fixture,
  evidence: TaskRuntimeExecutionEvidenceV1,
  plaintext: Uint8Array,
) {
  return {
    evidence,
    plaintext,
    objectType: "nautilo-task-run-result-v1",
    createdAt: NOW,
    agentAuthorizationRevision: 7,
    runtime: value.initialized.runtime,
    signerPublication: value.initialized.signerPublication,
    resolveHistoricalSignerPublicationManager: () => value.manager.publicKey,
  };
}

function prepareLegacy(
  value: Fixture,
  plaintext: Uint8Array,
  alter: (
    input: PrepareTaskRuntimeResultObjectInput,
  ) => PrepareTaskRuntimeResultObjectInput = (input) => input,
  evidence: TaskRuntimeExecutionEvidenceInputV1 = value.evidence,
): Promise<PreparedTaskRuntimeResultObject> {
  return withEvidence(value, (activeEvidence) =>
    prepareTaskRuntimeResultObject(value.crypto, alter({
      ...baseInput(value, activeEvidence, plaintext),
      namespace: value.legacyNamespace,
    })), evidence);
}

function prepareNative(
  value: Fixture,
  plaintext: Uint8Array,
  alter: (
    input: PrepareNativeTaskRuntimeResultObjectInput,
  ) => PrepareNativeTaskRuntimeResultObjectInput = (input) => input,
  evidence: TaskRuntimeExecutionEvidenceInputV1 = value.evidence,
): Promise<PreparedTaskRuntimeResultObject> {
  return withEvidence(value, (activeEvidence) =>
    prepareNativeTaskRuntimeResultObject(value.crypto, alter({
      ...baseInput(value, activeEvidence, plaintext),
      namespace: value.nativeNamespace,
    })), evidence);
}

function assertExactPreparedAuthority(
  value: Fixture,
  prepared: PreparedTaskRuntimeResultObject,
  expectedBindingHash: Uint8Array,
): void {
  expect(prepared.access.authority).toMatchObject({
    purpose: "persist-task-runtime-result-genesis",
    requestId: value.evidence.requestId,
    workId: RUN_ID,
    claimId: value.evidence.claimId,
    objectId: value.evidence.result.objectId,
    taskId: TASK_ID,
    taskRunId: RUN_ID,
    namespace: {
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      expectedAccessRevision: ACCESS_REVISION,
      expectedPolicyRevision: POLICY_REVISION,
      keyGeneration: 0,
    },
    domain: value.evidence.domainRequirements[0],
    agentId: AGENT_ID,
    runtimeGeneration: value.initialized.runtime.generation,
    agentAuthorizationRevision: 7,
    signerKeyId: value.initialized.signerPublication.signerKeyId,
  });
  expect(prepared.access.authority.namespace.bindingHash)
    .toEqual(expectedBindingHash);
  expect(prepared.access.authority.payloadHash)
    .toEqual(value.crypto.hash(prepared.object.payloadBytes.ciphertext));
  const expectedEnvelopeHash = value.crypto.hash(
    prepared.access.envelopeBytes[0],
  );
  expect(prepared.access.manifest.envelopeHashes).toEqual([
    expectedEnvelopeHash,
  ]);
  expect(prepared.access.authority.namespace.envelopeHash)
    .toEqual(expectedEnvelopeHash);
  expectedEnvelopeHash.fill(0);
  expect(prepared.access.manifest).toMatchObject({
    objectId: value.evidence.result.objectId,
    accessRevision: 0,
    signer: {
      kind: "agent_runtime",
      agentId: AGENT_ID,
      runtimeGeneration: value.initialized.runtime.generation,
      signerKeyId: value.initialized.signerPublication.signerKeyId,
    },
    hostAuthorizationRevision: 7,
  });
  expect(() => assertAuthenticPreparedTaskRuntimeResultObject(prepared))
    .not.toThrow();
}

function openPrepared(
  value: Fixture,
  prepared: PreparedTaskRuntimeResultObject,
): Uint8Array | null {
  return decryptObjectThroughNamespace(
    value.crypto,
    value.generationKey,
    decodeNamespaceObjectEnvelopeV2(prepared.access.envelopeBytes[0]),
    decodeEncryptedPayloadV2(prepared.object.payloadBytes.ciphertext),
  );
}

function tamperedSignerPublication(value: Fixture) {
  const signature = value.initialized.signerPublication.signature.slice();
  signature[0] = signature[0]! ^ 1;
  return { ...value.initialized.signerPublication, signature };
}

function changedDigest(value: Uint8Array): Uint8Array {
  const result = value.slice();
  result[0] = result[0]! ^ 1;
  return result;
}

async function rejection(
  operation: Promise<unknown>,
  authority: string,
): Promise<void> {
  const result = await operation.then(
    () => null,
    (error: unknown) => error,
  );
  if (result === null) {
    throw new Error(`substituted ${authority} was accepted`);
  }
  expect(result).toBeInstanceOf(Error);
}

describe("Task Runtime result preparation", () => {
  test("legacy and native preparations bind the exact authority and decrypt", async () => {
    const value = await fixture();
    const plaintext = new TextEncoder().encode("protected Task result");
    const expectedPlaintext = plaintext.slice();
    const legacy = await prepareLegacy(value, plaintext);
    const native = await prepareNative(value, plaintext);

    assertExactPreparedAuthority(
      value,
      legacy,
      value.legacyNamespace.trustedHead.bindingHash,
    );
    assertExactPreparedAuthority(
      value,
      native,
      value.nativeNamespace.expectedBindingDigest,
    );
    for (const prepared of [legacy, native]) {
      const opened = openPrepared(value, prepared);
      expect(opened).toEqual(expectedPlaintext);
      opened?.fill(0);
    }
    expect(plaintext).toEqual(expectedPlaintext);
    plaintext.fill(0);
    expectedPlaintext.fill(0);
  });

  test("legacy preparation rejects substituted Namespace, Domain, runtime, and signer authority", async () => {
    const value = await fixture();
    const other = await fixture(802);
    const plaintext = new TextEncoder().encode("legacy rejection matrix");
    const alteredDomainEvidence: TaskRuntimeExecutionEvidenceInputV1 = {
      ...value.evidence,
      domainRequirements: [{
        ...value.evidence.domainRequirements[0],
        domainKeyGeneration: DOMAIN_GENERATION + 1,
      }],
    };
    const cases: readonly Readonly<{
      name: string;
      evidence?: TaskRuntimeExecutionEvidenceInputV1;
      alter(input: PrepareTaskRuntimeResultObjectInput):
        PrepareTaskRuntimeResultObjectInput;
    }>[] = [
      {
        name: "trusted Namespace head",
        alter: (input) => ({
          ...input,
          namespace: {
            ...input.namespace,
            trustedHead: other.legacyNamespace.trustedHead,
          },
        }),
      },
      {
        name: "Namespace keyring envelope",
        alter: (input) => ({
          ...input,
          namespace: {
            ...input.namespace,
            aiKeyringEnvelope: other.legacyNamespace.aiKeyringEnvelope,
          },
        }),
      },
      {
        name: "Domain root",
        alter: (input) => ({
          ...input,
          namespace: { ...input.namespace, currentDomainRoot: bytes(0x72) },
        }),
      },
      {
        name: "Domain generation",
        evidence: alteredDomainEvidence,
        alter: (input) => input,
      },
      {
        name: "Agent runtime",
        alter: (input) => ({ ...input, runtime: other.initialized.runtime }),
      },
      {
        name: "runtime signer publication",
        alter: (input) => ({
          ...input,
          signerPublication: tamperedSignerPublication(value),
        }),
      },
      {
        name: "historical signer manager",
        alter: (input) => ({
          ...input,
          resolveHistoricalSignerPublicationManager: () =>
            other.manager.publicKey,
        }),
      },
    ];
    for (const item of cases) {
      await rejection(
        prepareLegacy(
          value,
          plaintext,
          item.alter,
          item.evidence ?? value.evidence,
        ),
        item.name,
      );
    }
    plaintext.fill(0);
  });

  test("native preparation rejects every substituted current authority coordinate", async () => {
    const value = await fixture();
    const other = await fixture(803);
    const plaintext = new TextEncoder().encode("native rejection matrix");
    const currentCases: readonly Readonly<{
      name: string;
      current: PrepareNativeTaskRuntimeResultObjectInput["namespace"]["current"];
    }>[] = [
      {
        name: "Namespace",
        current: { ...value.nativeNamespace.current, namespaceId: namespaceId("other-namespace") },
      },
      {
        name: "Namespace access revision",
        current: {
          ...value.nativeNamespace.current,
          namespaceAccessRevision: accessRevision(ACCESS_REVISION + 1),
        },
      },
      {
        name: "Domain",
        current: { ...value.nativeNamespace.current, cryptoDomainId: cryptoDomainId("other-domain") },
      },
      {
        name: "key class",
        current: { ...value.nativeNamespace.current, keyClass: "human" },
      },
      {
        name: "Domain generation",
        current: {
          ...value.nativeNamespace.current,
          domainKeyGeneration: DOMAIN_GENERATION + 1,
        },
      },
      {
        name: "Domain authorization revision",
        current: {
          ...value.nativeNamespace.current,
          domainAuthorizationRevision:
            authorizationRevision(DOMAIN_AUTHORIZATION_REVISION + 1),
        },
      },
      {
        name: "Domain participant count",
        current: { ...value.nativeNamespace.current, participantCount: 2 },
      },
      {
        name: "Domain participant digest",
        current: {
          ...value.nativeNamespace.current,
          participantDigest: changedDigest(
            value.nativeNamespace.current.participantDigest,
          ),
        },
      },
      {
        name: "Domain head digest",
        current: {
          ...value.nativeNamespace.current,
          domainHeadDigest: changedDigest(
            value.nativeNamespace.current.domainHeadDigest,
          ),
        },
      },
      {
        name: "Namespace current generation",
        current: {
          ...value.nativeNamespace.current,
          namespaceCurrentGeneration: namespaceGeneration(1),
        },
      },
    ];
    for (const item of currentCases) {
      await rejection(
        prepareNative(value, plaintext, (input) => ({
          ...input,
          namespace: { ...input.namespace, current: item.current },
        })),
        item.name,
      );
    }
    const inputCases: readonly Readonly<{
      name: string;
      alter(input: PrepareNativeTaskRuntimeResultObjectInput):
        PrepareNativeTaskRuntimeResultObjectInput;
    }>[] = [
      {
        name: "signed bundle digest",
        alter: (input) => ({
          ...input,
          namespace: {
            ...input.namespace,
            expectedBindingDigest: changedDigest(
              input.namespace.expectedBindingDigest,
            ),
          },
        }),
      },
      {
        name: "bundle issuer",
        alter: (input) => ({
          ...input,
          namespace: {
            ...input.namespace,
            issuerSigningPublicKey: other.bundleIssuer.publicKey,
          },
        }),
      },
      {
        name: "Domain secret",
        alter: (input) => ({
          ...input,
          namespace: { ...input.namespace, domainKey: bytes(0x73) },
        }),
      },
      {
        name: "Agent runtime",
        alter: (input) => ({ ...input, runtime: other.initialized.runtime }),
      },
      {
        name: "runtime signer publication",
        alter: (input) => ({
          ...input,
          signerPublication: tamperedSignerPublication(value),
        }),
      },
      {
        name: "historical signer manager",
        alter: (input) => ({
          ...input,
          resolveHistoricalSignerPublicationManager: () =>
            other.manager.publicKey,
        }),
      },
    ];
    for (const item of inputCases) {
      await rejection(
        prepareNative(value, plaintext, item.alter),
        item.name,
      );
    }
    plaintext.fill(0);
  });

  test("native preparation rejects coherent signed bundles with substituted current authority", async () => {
    const value = await fixture(840);
    const plaintext = new TextEncoder().encode(
      "coherent native authority rejection matrix",
    );
    const current = value.nativeNamespace.current;
    const cases: readonly Readonly<{
      name: string;
      current: Partial<NativeCurrent>;
    }>[] = [
      {
        name: "Namespace",
        current: { namespaceId: namespaceId("coherent-other-namespace") },
      },
      {
        name: "Namespace access revision",
        current: {
          namespaceAccessRevision: accessRevision(ACCESS_REVISION + 1),
        },
      },
      {
        name: "Domain",
        current: { cryptoDomainId: cryptoDomainId("coherent-other-domain") },
      },
      { name: "key class", current: { keyClass: "human" } },
      {
        name: "Domain generation",
        current: { domainKeyGeneration: DOMAIN_GENERATION + 1 },
      },
      {
        name: "Domain authorization revision",
        current: {
          domainAuthorizationRevision:
            authorizationRevision(DOMAIN_AUTHORIZATION_REVISION + 1),
        },
      },
      { name: "Domain participant count", current: { participantCount: 2 } },
      {
        name: "Domain participant digest",
        current: { participantDigest: changedDigest(current.participantDigest) },
      },
      {
        name: "Domain head digest",
        current: { domainHeadDigest: changedDigest(current.domainHeadDigest) },
      },
    ];
    try {
      for (const [index, item] of cases.entries()) {
        const namespace = signedNativeNamespace(value, {
          operation: `coherent-current-${index}`,
          current: item.current,
        });
        await rejection(
          prepareNative(value, plaintext, (input) => ({
            ...input,
            namespace,
          })),
          `coherently signed ${item.name}`,
        );
      }
    } finally {
      plaintext.fill(0);
    }
  });

  test("native preparation selects the exact retained generation and access revision", async () => {
    const value = await fixture(850);
    const plaintext = new TextEncoder().encode("multigeneration native result");
    const expectedPlaintext = plaintext.slice();
    const oldKey = bytes(0x74);
    const currentKey = bytes(0x75);
    const retained: readonly [
      DomainNamespaceRetainedGeneration,
      DomainNamespaceRetainedGeneration,
    ] = [
      {
        generation: namespaceGeneration(0),
        accessRevision: accessRevision(0),
        headDigest: bytes(0x44),
        generationKey: oldKey,
      },
      {
        generation: namespaceGeneration(1),
        accessRevision: accessRevision(0),
        headDigest: bytes(0x45),
        generationKey: currentKey,
      },
    ];
    const namespace = signedNativeNamespace(value, {
      operation: "multigeneration-current",
      current: { namespaceCurrentGeneration: namespaceGeneration(1) },
      retained,
    });
    try {
      const prepared = await prepareNative(value, plaintext, (input) => ({
        ...input,
        namespace,
      }));
      expect(prepared.access.authority.namespace.keyGeneration).toBe(1);
      const opened = decryptObjectThroughNamespace(
        value.crypto,
        currentKey,
        decodeNamespaceObjectEnvelopeV2(prepared.access.envelopeBytes[0]),
        decodeEncryptedPayloadV2(prepared.object.payloadBytes.ciphertext),
      );
      expect(opened).toEqual(expectedPlaintext);
      opened?.fill(0);
      expect(decryptObjectThroughNamespace(
        value.crypto,
        oldKey,
        decodeNamespaceObjectEnvelopeV2(prepared.access.envelopeBytes[0]),
        decodeEncryptedPayloadV2(prepared.object.payloadBytes.ciphertext),
      )).toBeNull();

      const staleKey = bytes(0x76);
      const staleNamespace = signedNativeNamespace(value, {
        operation: "multigeneration-stale-access",
        current: { namespaceCurrentGeneration: namespaceGeneration(1) },
        retained: [
          retained[0],
          {
            ...retained[1],
            accessRevision: accessRevision(1),
            generationKey: staleKey,
          },
        ],
      });
      try {
        await rejection(
          prepareNative(value, plaintext, (input) => ({
            ...input,
            namespace: staleNamespace,
          })),
          "retained generation with a stale access revision",
        );
      } finally {
        staleKey.fill(0);
      }
    } finally {
      plaintext.fill(0);
      expectedPlaintext.fill(0);
      oldKey.fill(0);
      currentKey.fill(0);
    }
  });

  test("preparation rejects ambiguous Domain evidence and non-byte plaintext", async () => {
    const value = await fixture(860);
    const plaintext = new TextEncoder().encode("ambiguous Domain evidence");
    const domain = value.evidence.domainRequirements[0];
    const duplicateDomainEvidence: TaskRuntimeExecutionEvidenceInputV1 = {
      ...value.evidence,
      domainRequirements: [
        domain,
        {
          ...domain,
          participantDigest: domain.participantDigest.slice(),
          headDigest: domain.headDigest.slice(),
          activeNamespaceBindingSetDigest:
            domain.activeNamespaceBindingSetDigest.slice(),
        },
      ],
    };
    try {
      await rejection(
        prepareLegacy(
          value,
          plaintext,
          (input) => input,
          duplicateDomainEvidence,
        ),
        "duplicate legacy Domain authority",
      );
      await rejection(
        prepareNative(
          value,
          plaintext,
          (input) => input,
          duplicateDomainEvidence,
        ),
        "duplicate native Domain authority",
      );
      const invalidPlaintext = "not plaintext bytes" as unknown as Uint8Array;
      await rejection(
        prepareLegacy(value, invalidPlaintext),
        "legacy non-byte plaintext",
      );
      await rejection(
        prepareNative(value, invalidPlaintext),
        "native non-byte plaintext",
      );
    } finally {
      plaintext.fill(0);
    }
  });

  test("legacy and native preparation reject a substituted Agent authorization revision", async () => {
    const value = await fixture(870);
    const plaintext = new TextEncoder().encode("Agent authorization revision");
    try {
      await rejection(
        prepareLegacy(value, plaintext, (input) => ({
          ...input,
          agentAuthorizationRevision: input.agentAuthorizationRevision + 1,
        })),
        "legacy Agent authorization revision",
      );
      await rejection(
        prepareNative(value, plaintext, (input) => ({
          ...input,
          agentAuthorizationRevision: input.agentAuthorizationRevision + 1,
        })),
        "native Agent authorization revision",
      );
    } finally {
      plaintext.fill(0);
    }
  });

  test("authenticity rejects copied objects and mutation of every protected byte family", async () => {
    const selectors: readonly Readonly<{
      name: string;
      select(prepared: PreparedTaskRuntimeResultObject): Uint8Array;
    }>[] = [
      { name: "payload", select: (prepared) => prepared.object.payloadBytes.ciphertext },
      { name: "manifest bytes", select: (prepared) => prepared.access.manifestBytes },
      { name: "manifest hash", select: (prepared) => prepared.access.manifestHash },
      { name: "envelope", select: (prepared) => prepared.access.envelopeBytes[0] },
      { name: "authorization digest", select: (prepared) => prepared.access.authority.authorizationDigest },
      { name: "authority payload hash", select: (prepared) => prepared.access.authority.payloadHash },
      { name: "binding hash", select: (prepared) => prepared.access.authority.namespace.bindingHash },
      { name: "envelope hash", select: (prepared) => prepared.access.authority.namespace.envelopeHash },
      { name: "participant digest", select: (prepared) => prepared.access.authority.domain.participantDigest },
      { name: "Domain head digest", select: (prepared) => prepared.access.authority.domain.headDigest },
      {
        name: "binding-set digest",
        select: (prepared) =>
          prepared.access.authority.domain.activeNamespaceBindingSetDigest,
      },
    ];
    for (const [index, item] of selectors.entries()) {
      const value = await fixture(810 + index);
      const prepared = await prepareNative(
        value,
        new TextEncoder().encode(`authenticity-${item.name}`),
      );
      expect(() => assertAuthenticPreparedTaskRuntimeResultObject(prepared))
        .not.toThrow();
      if (index === 0) {
        expect(() => assertAuthenticPreparedTaskRuntimeResultObject({
          ...prepared,
        })).toThrow();
      }
      const selected = item.select(prepared);
      selected[0] = selected[0]! ^ 1;
      expect(() => assertAuthenticPreparedTaskRuntimeResultObject(prepared))
        .toThrow();
    }
  });

  for (const mode of ["legacy", "native"] as const) {
    test(`${mode} preparation erases owned plaintext, DEK, and opened key material`, async () => {
      const value = await fixture(mode === "legacy" ? 830 : 831);
      const plaintext = new TextEncoder().encode(`${mode} cleanup result`);
      const expectedPlaintext = plaintext.slice();
      const sealedKeys: Uint8Array[] = [];
      const sealedPlaintexts: Uint8Array[] = [];
      const openedPlaintexts: Uint8Array[] = [];
      const originalSeal = value.crypto.aeadSeal.bind(value.crypto);
      const originalOpen = value.crypto.aeadOpen.bind(value.crypto);
      const seal = spyOn(value.crypto, "aeadSeal").mockImplementation(
        (key, ownedPlaintext, aad) => {
          sealedKeys.push(key);
          sealedPlaintexts.push(ownedPlaintext);
          return originalSeal(key, ownedPlaintext, aad);
        },
      );
      const open = spyOn(value.crypto, "aeadOpen").mockImplementation(
        (key, ciphertext, aad) => {
          const opened = originalOpen(key, ciphertext, aad);
          if (opened !== null) openedPlaintexts.push(opened);
          return opened;
        },
      );
      try {
        const prepared = mode === "legacy"
          ? await prepareLegacy(value, plaintext)
          : await prepareNative(value, plaintext);
        expect(() => assertAuthenticPreparedTaskRuntimeResultObject(prepared))
          .not.toThrow();
        expect(plaintext).toEqual(expectedPlaintext);
        expect(sealedKeys).toHaveLength(2);
        expect(sealedPlaintexts).toHaveLength(2);
        expect(openedPlaintexts.length).toBeGreaterThan(0);
        for (const owned of [
          ...sealedKeys,
          ...sealedPlaintexts,
          ...openedPlaintexts,
        ]) {
          expect(owned.every((byte) => byte === 0)).toBe(true);
        }
      } finally {
        seal.mockRestore();
        open.mockRestore();
        plaintext.fill(0);
        expectedPlaintext.fill(0);
      }
    });
  }
});
