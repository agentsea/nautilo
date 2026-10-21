import { describe, expect, spyOn, test } from "bun:test";
import type {
  PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  decryptObjectThroughNamespace,
  domainNamespaceRetainedAuthoritySetDigest,
  humanId,
  namespaceGeneration,
  namespaceId,
  prepareAgentRuntimeInitialization,
  prepareDomainNamespaceBundle,
  verifyCommonObjectAccessManifest,
  type TaskRuntimeTerminalMessageEvidence,
} from "@nautilo/lattice-crypto";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
  DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  encodeAgentRuntimeSignerPublicationV1,
  encodeTaskRuntimeBackgroundAuthorizationResponseV2,
} from "@nautilo/lattice-crypto/wire";
import {
  withTaskRuntimeTerminalMessageEvidenceV1,
} from "../../../lattice-crypto/src/background/task-runtime-terminal-message-evidence-v1.ts";
import { deriveMessageCryptoObjectIdV2 } from
  "../../src/message/conversation-repository.ts";
import {
  decodeMessagePayloadV2,
  encodeMessagePayloadV2,
} from "../../src/message/message-payload-v2.ts";
import {
  prepareNativeTaskTerminalMessage,
  readPreparedNativeTaskTerminalMessage,
  type NativeTaskTerminalMessageAuthority,
  type PrepareNativeTaskTerminalMessageInput,
} from "../../src/server/task/native-task-terminal-message-preparation.ts";
import {
  assertVerifiedStagedTaskTerminalMessagePublication,
  inspectStagedTaskTerminalMessagePublication,
  stageNativeTaskTerminalMessagePublication,
  type NativeTaskTerminalMessageIntent,
} from "../../src/server/task/postgres-task-terminal-message-staging.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../../src/server/storage/postgres-record-codecs.ts";
import { withCertifiedTerminalPublicationSigner } from
  "../fixtures/task-publication-signer.ts";

const NOW = 1_930_000_000_000;
const TASK = "10000000-0000-4000-8000-000000000731";
const RUN = "20000000-0000-4000-8000-000000000731";
const ROOM = "30000000-0000-4000-8000-000000000731";
const SESSION = "40000000-0000-4000-8000-000000000731";
const NS = "terminal-message-namespace";
const DOMAIN = "terminal-message-domain";
const AGENT = "terminal-task-agent";
const REQUEST = `task-run-delivery-message-authorization:${RUN}`;
const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);

async function fixture() {
  const crypto = new LatticeCrypto();
  const issuer = crypto.generateSigningKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const domainKey = bytes(0x41);
  const generationKey = bytes(0x42);
  const retained = [{
    generation: namespaceGeneration(0),
    accessRevision: accessRevision(0),
    headDigest: bytes(0x43),
    generationKey,
  }];
  const retainedDigest = domainNamespaceRetainedAuthoritySetDigest(
    crypto, retained);
  const domain = Object.freeze({
    domainId: DOMAIN,
    sourceNamespaceId: NS,
    participantDigest: bytes(0x61),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 4,
    authorizationRevision: authorizationRevision(9),
    headDigest: bytes(0x62),
    activeNamespaceBindingSetDigest: bytes(0x63),
    activeNamespaceBindingCount: 1,
  });
  const current = {
    serverId: "https://nautilo.example",
    cryptoDomainId: cryptoDomainId(DOMAIN),
    participantDigest: domain.participantDigest,
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 4,
    domainAuthorizationRevision: authorizationRevision(9),
    domainHeadDigest: domain.headDigest,
    namespaceId: namespaceId(NS),
    namespaceAccessRevision: accessRevision(0),
    namespaceCurrentGeneration: namespaceGeneration(0),
    bundleRevision: 1,
    retainedAuthoritySetDigest: retainedDigest,
  };
  const native = prepareDomainNamespaceBundle(crypto, {
    operationId: "native-terminal-message-binding",
    previousBindingDigest: null,
    bundle: {
      ...current,
      formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
      retainedGenerationCount: 1,
      retainedGenerations: retained,
    },
    issuerHumanId: humanId("human"),
    issuerDeviceId: cryptoDeviceId("device"),
    issuerDeviceSigningGeneration: 1,
    issuerSigningPrivateKey: issuer.privateKey,
    issuerSigningPublicKey: issuer.publicKey,
    domainKey,
    issuedAt: NOW,
  });
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "native-terminal-message-initialization",
    agentId: agentId(AGENT),
    authorizationRevision: authorizationRevision(7),
    configObjects: [{
      objectId: "terminal-task-agent-config",
      configRevision: authorizationRevision(1),
      plaintextDek: bytes(0x21),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId("human"),
      managerAuthorizationRevision: authorizationRevision(2),
      managerDeviceId: cryptoDeviceId("device"),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const payload = Object.freeze({
    role: "assistant" as const,
    content: "The background task was cancelled. Nothing from this Task is still running.",
  });
  const encoded = encodeMessagePayloadV2(payload);
  const payloadDigest = crypto.hash(encoded);
  encoded.fill(0);
  const coordinate = { sessionId: SESSION, messageId: 17, revision: 0 };
  const message = Object.freeze({
    taskId: TASK,
    taskRunId: RUN,
    bindingId: `task-run-output:${RUN}`,
    messageOperationId: `task-run-delivery-message:${RUN}`,
    ...coordinate,
    objectId: deriveMessageCryptoObjectIdV2(coordinate),
    roomId: ROOM,
    namespaceId: NS,
    domainId: DOMAIN,
    mode: "encrypted_only" as const,
    acceptedPolicyRevision: 6,
    publicationPolicyRevision: 7,
    signerAgentId: AGENT,
    payloadDigest,
  });
  const evidenceInput = {
    purpose: "task.runtime.terminal_message" as const,
    workKind: "task.deliver_message" as const,
    requestId: REQUEST,
    workId: RUN,
    claimId: "terminal-message-claim",
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 1,
    recipientKeyId: "terminal-message-recipient",
    authorizationDigest: bytes(0x51),
    policyRevision: 7,
    episodeId: "terminal-message-episode",
    sourceRoomId: ROOM,
    hostAuthorizationRevision: 5,
    recipientAuthorizationRevision: 6,
    operations: ["encrypt"] as const,
    message,
    domainRequirements: [domain] as const,
    namespaceRequirements: [{
      ordinal: 0 as const,
      namespaceId: NS,
      domainId: DOMAIN,
      operations: ["encrypt"] as const,
      expectedAccessRevision: 0,
      expectedPolicyRevision: 7,
    }] as const,
  };
  const controller = new AbortController();
  let time = NOW;
  const checks: NativeTaskTerminalMessageAuthority[] = [];
  const base: Omit<PrepareNativeTaskTerminalMessageInput, "evidence"> = {
    crypto,
    payload,
    createdAt: NOW,
    namespace: {
      current,
      bindingBytes: native.bytes,
      expectedBindingDigest: native.bindingDigest,
      issuerSigningPublicKey: issuer.publicKey,
      domainKey,
    },
    runtime: initialized.runtime,
    signerPublication: initialized.signerPublication,
    agentAuthorizationRevision: 7,
    resolveHistoricalSignerPublicationManager: () => manager.publicKey,
    signal: controller.signal,
    resolveCurrentAuthority: authority => {
      checks.push(authority);
      return Promise.resolve({ ...authority });
    },
  };
  const prepare = (
    overrides: Partial<PrepareNativeTaskTerminalMessageInput> = {},
    evidenceOverride = evidenceInput,
  ) => withTaskRuntimeTerminalMessageEvidenceV1({
    evidence: evidenceOverride,
    signal: controller.signal,
    now: () => time,
    execute: evidence => prepareNativeTaskTerminalMessage({
      ...base,
      evidence: evidence as TaskRuntimeTerminalMessageEvidence,
      ...overrides,
    }),
  });
  return {
    crypto, base, prepare, message, evidenceInput, checks, generationKey,
    controller, managerPublicKey: manager.publicKey, issuer, domain,
    expire: () => { time = NOW + 60_000; },
  };
}

async function fails(operation: Promise<unknown>): Promise<void> {
  let failure: unknown = null;
  try {
    await operation;
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
}

describe("native terminal Task Message preparation", () => {
  test("uses a certified fresh signer and retains its historical proof", async () => {
    const value = await fixture();
    let expectedCertificate: Uint8Array | undefined;
    const prepared = await withCertifiedTerminalPublicationSigner({
      crypto: value.crypto,
      now: value.crypto.clock.now(),
      deviceSigner: value.issuer,
      requestId: REQUEST,
      sessionId: value.evidenceInput.episodeId,
      roomId: ROOM,
      requesterHumanId: "human",
      signerAgentId: AGENT,
      policyRevision: 7,
      domains: [{ ...value.domain, domainKey: value.base.namespace.domainKey }],
      namespaceRequirements: value.evidenceInput.namespaceRequirements,
      work: {
        kind: "task.deliver_message",
        taskId: TASK,
        taskRunId: RUN,
        contentRevision: 2,
        workIdentityHash: bytes(0xb1),
        messageObjectId: value.message.objectId,
      },
      message: value.message,
    }, async ({ evidence, signer, certificateBytes }) => {
      expectedCertificate = certificateBytes.slice();
      return prepareNativeTaskTerminalMessage({
        ...value.base,
        evidence,
        runtime: signer.runtime,
        signerPublication: null,
        temporarySigner: signer,
        agentAuthorizationRevision: 0,
        resolveHistoricalSignerPublicationManager: () => {
          throw new Error("permanent signer history must not be loaded");
        },
      });
    });
    const snapshot = readPreparedNativeTaskTerminalMessage(prepared);
    expect(snapshot.signerEvidenceBytes).toEqual(expectedCertificate);
    expect(prepared.authority.signerAuthorizationHash).toBeDefined();
    const verified = verifyCommonObjectAccessManifest(value.crypto, {
      manifestBytes: snapshot.manifestBytes,
      resolveHistoricalHumanDeviceSigningPublicKey: () => null,
      resolveAgentRuntimeSignerPublicKey: () => {
        throw new Error("permanent signer history must not be loaded");
      },
      resolveProcessorSignerAuthorizationBytes: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
      resolveTaskRuntimeSignerAuthorizationBytes: () =>
        snapshot.signerEvidenceBytes!,
      resolveHistoricalTaskRuntimeIssuer: () => value.issuer.publicKey,
    });
    expect(String(verified.manifest.objectId)).toBe(value.message.objectId);
    expectedCertificate?.fill(0);
  });

  test("prepares only the fixed assistant payload under exact terminal evidence", async () => {
    const value = await fixture();
    const prepared = await value.prepare();
    expect(prepared.authority).toMatchObject({
      taskId: TASK,
      taskRunId: RUN,
      bindingId: `task-run-output:${RUN}`,
      messageOperationId: `task-run-delivery-message:${RUN}`,
      roomId: ROOM,
      namespaceId: NS,
      mode: "encrypted_only",
      acceptedPolicyRevision: 6,
      publicationPolicyRevision: 7,
      role: "assistant",
    });
    expect(value.checks).toHaveLength(2);
    const snapshot = readPreparedNativeTaskTerminalMessage(prepared);
    expect(snapshot.signerEvidenceBytes).toBeUndefined();
    expect(prepared.authority.signerAuthorizationHash).toBeUndefined();
    const opened = decryptObjectThroughNamespace(
      value.crypto,
      value.generationKey,
      decodeNamespaceObjectEnvelopeV2(snapshot.envelopeBytes[0]),
      decodeEncryptedPayloadV2(snapshot.object.payloadBytes.ciphertext),
    );
    expect(opened).not.toBeNull();
    expect(decodeMessagePayloadV2(opened!)).toEqual(value.base.payload);
    opened?.fill(0);
    expect(() => readPreparedNativeTaskTerminalMessage({ ...prepared }))
      .toThrow("not prepared");
  });

  test("rejects payload, destination, current-authority, liveness and signer substitutions", async () => {
    const value = await fixture();
    await fails(value.prepare({
      payload: { role: "assistant", content: "Different cancellation text" },
    }));
    await fails(value.prepare({
      namespace: {
        ...value.base.namespace,
        current: {
          ...value.base.namespace.current,
          namespaceId: namespaceId("other-namespace"),
        },
      },
    }));
    await fails(value.prepare({
      resolveCurrentAuthority: expected => Promise.resolve({
        ...expected,
        roomId: "30000000-0000-4000-8000-000000000732",
      }),
    }));
    await fails(value.prepare({ agentAuthorizationRevision: 8 }));
    await fails(value.prepare({ signerPublication: null }));
    value.expire();
    await fails(value.prepare());
  });

  test("wipes owned plaintext, Runtime and Domain material without damaging borrowed inputs", async () => {
    const value = await fixture();
    const captured: Uint8Array[] = [];
    const sealOriginal = value.crypto.aeadSeal.bind(value.crypto);
    const openOriginal = value.crypto.aeadOpen.bind(value.crypto);
    const seal = spyOn(value.crypto, "aeadSeal").mockImplementation((...args) => {
      captured.push(args[0], args[1]);
      return sealOriginal(...args);
    });
    const open = spyOn(value.crypto, "aeadOpen").mockImplementation((...args) => {
      captured.push(args[0]);
      const result = openOriginal(...args);
      if (result !== null) captured.push(result);
      return result;
    });
    try {
      await value.prepare();
      expect(captured.length).toBeGreaterThan(0);
      for (const item of captured) {
        expect(item.every(byte => byte === 0)).toBe(true);
      }
      expect(value.base.runtime.key.some(byte => byte !== 0)).toBe(true);
      expect(value.base.namespace.domainKey.some(byte => byte !== 0)).toBe(true);
    } finally {
      seal.mockRestore();
      open.mockRestore();
    }
  });
});

type DurableState = Readonly<{
  object: DatabaseRow | null;
  head: DatabaseRow | null;
  manifests: readonly DatabaseRow[];
  envelopes: readonly DatabaseRow[];
  receipt: DatabaseRow | null;
}>;
const emptyState = (): DurableState => ({
  object: null, head: null, manifests: [], envelopes: [], receipt: null,
});
function cloneRow(row: DatabaseRow): DatabaseRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key, value instanceof Uint8Array ? value.slice() : value,
  ])) as DatabaseRow;
}
function cloneState(state: DurableState): DurableState {
  return {
    object: state.object === null ? null : cloneRow(state.object),
    head: state.head === null ? null : cloneRow(state.head),
    manifests: state.manifests.map(cloneRow),
    envelopes: state.envelopes.map(cloneRow),
    receipt: state.receipt === null ? null : cloneRow(state.receipt),
  };
}

class TerminalMessageCryptoConnection implements CryptoPostgresConnection {
  state: DurableState = emptyState();
  claim: DatabaseRow | null = null;
  failReceipt = false;
  claimReads = 0;
  humanDevice: DatabaseRow | null = null;

  constructor(readonly signer: DatabaseRow) {}

  query<Row extends DatabaseRow = DatabaseRow>(
    statement: string,
    parameters: readonly DatabaseScalar[] = [],
  ): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }] as unknown as Row[]);
    }
    return this.transaction(transaction =>
      transaction.query<Row>(statement, parameters));
  }

  async transaction<Result>(
    callback: (transaction: CryptoPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    const working = cloneState(this.state);
    const executor: CryptoPostgresExecutor = {
      query: async <Row extends DatabaseRow = DatabaseRow>(
        statement: string,
        parameters: readonly DatabaseScalar[] = [],
      ): Promise<readonly Row[]> => {
        const normalized = statement.replaceAll('"', "").toLowerCase();
        if (normalized.includes("current_user::text")) {
          return [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }] as unknown as Row[];
        }
        if (normalized.includes("pg_advisory_xact_lock")) return [];
        if (normalized.includes("from background_crypto_authorization_requests")) {
          this.claimReads += 1;
          return (this.claim === null ? [] : [cloneRow(this.claim)]) as Row[];
        }
        if (normalized.includes("from task_terminal_message_crypto_staging_receipts")) {
          return (working.receipt === null ? [] : [cloneRow(working.receipt)]) as Row[];
        }
        if (normalized.includes("insert into task_terminal_message_crypto_staging_receipts")) {
          if (this.failReceipt) throw new Error("receipt write failed");
          const fields = [
            "request_id", "recipient_generation", "claim_id",
            "authorization_digest", "delivery_intent_hash",
            "accepted_policy_revision", "publication_policy_revision",
            "authority_fingerprint", "crypto_object_id",
            "genesis_manifest_hash",
          ];
          (working as { receipt: DatabaseRow | null }).receipt =
            Object.fromEntries(fields.map((field, index) => {
              const value = parameters[index]!;
              return [field, value instanceof Uint8Array ? value.slice() : value];
            })) as DatabaseRow;
          return [];
        }
        if (normalized.includes("from crypto_objects")) {
          return (working.object === null ? [] : [cloneRow(working.object)]) as Row[];
        }
        if (normalized.includes("from object_crypto_access_heads")) {
          return (working.head === null ? [] : [cloneRow(working.head)]) as Row[];
        }
        if (normalized.includes("from object_crypto_access_manifests")) {
          return working.manifests.map(cloneRow) as Row[];
        }
        if (normalized.includes("from object_crypto_namespace_envelopes")) {
          return working.envelopes.map(cloneRow) as Row[];
        }
        if (normalized.includes("from human_crypto_devices")) {
          return (this.humanDevice === null ? []
            : [cloneRow(this.humanDevice)]) as Row[];
        }
        if (normalized.includes("from agent_crypto_runtime_signers")) {
          return [cloneRow(this.signer)] as Row[];
        }
        if (normalized.includes("insert into crypto_objects")) {
          (working as { object: DatabaseRow | null }).object = {
            object_id: parameters[0] as string,
            payload_hash: (parameters[1] as Uint8Array).slice(),
            payload_bytes: (parameters[2] as Uint8Array).slice(),
          };
          return [];
        }
        if (normalized.includes("insert into object_crypto_access_manifests")) {
          (working.manifests as DatabaseRow[]).push({
            object_id: parameters[0] as string,
            access_revision: parameters[1] as number,
            manifest_hash: (parameters[2] as Uint8Array).slice(),
            previous_manifest_hash: parameters[3] as null,
            payload_hash: (parameters[4] as Uint8Array).slice(),
            manifest_bytes: (parameters[5] as Uint8Array).slice(),
            signer_evidence_bytes: parameters[6] === null ? null
              : (parameters[6] as Uint8Array).slice(),
          });
          return [];
        }
        if (normalized.includes("insert into object_crypto_namespace_envelopes")) {
          (working.envelopes as DatabaseRow[]).push({
            object_id: parameters[0] as string,
            access_revision: parameters[1] as number,
            namespace_id: parameters[2] as string,
            ordinal: parameters[3] as number,
            envelope_hash: (parameters[4] as Uint8Array).slice(),
            envelope_bytes: (parameters[5] as Uint8Array).slice(),
          });
          return [];
        }
        if (normalized.includes("insert into object_crypto_access_heads")) {
          (working as { head: DatabaseRow | null }).head = {
            object_id: parameters[0] as string,
            access_revision: parameters[1] as number,
            manifest_hash: (parameters[2] as Uint8Array).slice(),
          };
          return [];
        }
        throw new Error(`Unexpected terminal Message SQL: ${statement}`);
      },
    };
    const result = await callback(executor);
    this.state = working;
    return result;
  }
}

describe("terminal Task Message crypto staging", () => {
  test.each([
    "valid", "wrapper_hash", "inner_grant", "certificate", "expired",
  ] as const)("binds a certified V3 response for %s", async mutation => {
    const value = await fixture();
    const publication = value.base.signerPublication!;
    const connection = new TerminalMessageCryptoConnection({
      agent_id: publication.agentId,
      runtime_generation: publication.runtimeGeneration,
      authorization_revision: publication.authorizationRevision,
      transition_kind: publication.transitionKind,
      operation_id: publication.operationId,
      signer_key_id: publication.signerKeyId,
      signer_public_key: publication.signerPublicKey,
      publication_bytes: encodeAgentRuntimeSignerPublicationV1(publication),
    });
    connection.humanDevice = {
      device_id: "device:task-publication-signer-fixture",
      human_id: "human", device_generation: 1,
      signing_public_key: value.issuer.publicKey, state: "active",
    };
    const intent: NativeTaskTerminalMessageIntent = {
      ...value.message,
      payloadDigest: Array.from(value.message.payloadDigest, byte =>
        byte.toString(16).padStart(2, "0")).join(""),
      role: "assistant", createdAt: NOW, requestId: REQUEST,
    };
    const current = {
      taskId: intent.taskId, taskRunId: intent.taskRunId,
      bindingId: intent.bindingId,
      messageOperationId: intent.messageOperationId,
      sessionId: intent.sessionId, messageId: intent.messageId,
      revision: intent.revision, objectId: intent.objectId,
      roomId: intent.roomId, namespaceId: intent.namespaceId,
      domainId: intent.domainId, mode: intent.mode,
      acceptedPolicyRevision: intent.acceptedPolicyRevision,
      currentPolicyRevision: intent.publicationPolicyRevision,
      namespaceAccessRevision: 0,
    };
    await withCertifiedTerminalPublicationSigner({
      crypto: value.crypto,
      now: value.crypto.clock.now(),
      deviceSigner: value.issuer,
      requestId: REQUEST,
      sessionId: value.evidenceInput.episodeId,
      roomId: ROOM,
      requesterHumanId: "human",
      signerAgentId: AGENT,
      policyRevision: 7,
      domains: [{ ...value.domain,
        domainKey: value.base.namespace.domainKey }],
      namespaceRequirements: value.evidenceInput.namespaceRequirements,
      work: {
        kind: "task.deliver_message",
        taskId: TASK,
        taskRunId: RUN,
        contentRevision: 2,
        workIdentityHash: bytes(0xb1),
        messageObjectId: value.message.objectId,
      },
      message: value.message,
    }, async ({ evidence, signer, authorizationBytes, certificateBytes }) => {
      const inner = mutation === "inner_grant"
        ? new Uint8Array([0x71]) : authorizationBytes;
      const certificate = certificateBytes.slice();
      if (mutation === "certificate") {
        certificate[0] = certificate[0]! ^ 0xff;
      }
      const responseBytes = encodeTaskRuntimeBackgroundAuthorizationResponseV2({
        authorizationBytes: inner,
        certificateBytes: certificate,
      });
      certificate.fill(0);
      connection.claim = {
        request_id: REQUEST, work_id: RUN,
        work_kind: "task.deliver_message", purpose: "task.deliver_message",
        state: "running", format_version: 3,
        credential_subject_kind: "runtime", runtime_kind: "task",
        runtime_version: 1, claim_id: evidence.claimId,
        recipient_generation: evidence.recipientGeneration,
        recipient_key_id: evidence.recipientKeyId,
        accepted_response_kind: "runtime",
        accepted_response_hash: mutation === "wrapper_hash"
          ? bytes(0xee) : value.crypto.hash(responseBytes),
        accepted_response_bytes: responseBytes,
        expected_policy_revision: 7, namespace_id: NS, domain_id: DOMAIN,
        expected_namespace_access_revision: 0, expected_domain_epoch: 4,
        live: mutation !== "expired",
      };
      const operation = stageNativeTaskTerminalMessagePublication({
        restricted: connection as unknown as PostgresJsBridgeConnection,
        preparation: { ...value.base, evidence,
          runtime: signer.runtime, signerPublication: null,
          temporarySigner: signer, agentAuthorizationRevision: 0 },
        resolveHistoricalAgentSignerAuthority: context => ({ ...context,
          managerSigningPublicKey: value.managerPublicKey.slice() }),
        assertCurrentClaim: () => undefined,
        resolveCurrentDeliveryAuthority: () => Promise.resolve(current),
      });
      if (mutation === "valid") expect(await operation).toBe("staged");
      else await fails(operation);
    });
    expect(connection.state.object === null).toBe(mutation !== "valid");
    expect(connection.state.receipt === null).toBe(mutation !== "valid");
  });

  test.each([
    { policyAdvance: 0, behavior: "atomically stages immutable provenance and inspects replay without decryption" },
    { policyAdvance: 1, behavior: "rejects newer current policy before preparation or crypto writes" },
  ])("$behavior", async ({ policyAdvance }) => {
    const value = await fixture();
    const authorizationBytes = new Uint8Array([1, 2, 3, 4]);
    const evidenceInput = {
      ...value.evidenceInput,
      authorizationDigest: value.crypto.hash(authorizationBytes),
    };
      const publication = value.base.signerPublication!;
    const connection = new TerminalMessageCryptoConnection({
      agent_id: publication.agentId,
      runtime_generation: publication.runtimeGeneration,
      authorization_revision: publication.authorizationRevision,
      transition_kind: publication.transitionKind,
      operation_id: publication.operationId,
      signer_key_id: publication.signerKeyId,
      signer_public_key: publication.signerPublicKey,
      publication_bytes: encodeAgentRuntimeSignerPublicationV1(publication),
    });
    const historical = (context: Parameters<Parameters<
      typeof inspectStagedTaskTerminalMessagePublication
    >[0]["resolveHistoricalAgentSignerAuthority"]>[0]) => ({
      ...context,
      managerSigningPublicKey: value.managerPublicKey.slice(),
    });
    const intent: NativeTaskTerminalMessageIntent = {
      ...value.message,
      payloadDigest: Array.from(value.message.payloadDigest, byte =>
        byte.toString(16).padStart(2, "0")).join(""),
      role: "assistant",
      createdAt: NOW,
      requestId: REQUEST,
    };
    const current = {
      taskId: intent.taskId,
      taskRunId: intent.taskRunId,
      bindingId: intent.bindingId,
      messageOperationId: intent.messageOperationId,
      sessionId: intent.sessionId,
      messageId: intent.messageId,
      revision: intent.revision,
      objectId: intent.objectId,
      roomId: intent.roomId,
      namespaceId: intent.namespaceId,
      domainId: intent.domainId,
      mode: intent.mode,
      acceptedPolicyRevision: intent.acceptedPolicyRevision,
      currentPolicyRevision: intent.publicationPolicyRevision + policyAdvance,
      namespaceAccessRevision: 0,
    };
    await withTaskRuntimeTerminalMessageEvidenceV1({
      evidence: evidenceInput,
      signal: value.controller.signal,
      now: () => NOW,
      execute: async evidence => {
        const preparation = {
          ...value.base,
          evidence: evidence as TaskRuntimeTerminalMessageEvidence,
        };
        connection.claim = {
          request_id: REQUEST,
          work_id: RUN,
          work_kind: "task.deliver_message",
          purpose: "task.deliver_message",
          state: "running",
          format_version: 3,
          credential_subject_kind: "runtime",
          runtime_kind: "task",
          runtime_version: 1,
          claim_id: evidence.claimId,
          recipient_generation: evidence.recipientGeneration,
          recipient_key_id: evidence.recipientKeyId,
          accepted_response_kind: "runtime",
          accepted_response_hash: evidence.authorizationDigest.slice(),
          accepted_response_bytes: authorizationBytes.slice(),
          expected_policy_revision: 7,
          namespace_id: NS,
          domain_id: DOMAIN,
          expected_namespace_access_revision: 0,
          expected_domain_epoch: 4,
          live: true,
        };
        const stage = () => stageNativeTaskTerminalMessagePublication({
          restricted: connection as unknown as PostgresJsBridgeConnection,
          preparation,
          resolveHistoricalAgentSignerAuthority: historical,
          assertCurrentClaim: () => undefined,
          resolveCurrentDeliveryAuthority: () => Promise.resolve(current),
        });
        if (policyAdvance !== 0) {
          let rejected: unknown;
          try { await stage(); } catch (error: unknown) { rejected = error; }
          expect(rejected).toBeInstanceOf(Error);
          expect((rejected as Error).message).toBe("Terminal Message delivery authority is not current");
          expect(value.checks).toHaveLength(0);
          expect(connection.state).toEqual(emptyState());
          return;
        }
        expect(await stage()).toBe("staged");
        const preparationChecks = value.checks.length;
        expect(preparationChecks).toBeGreaterThan(0);
        expect(await stage()).toBe("already_staged");
        expect(value.checks).toHaveLength(preparationChecks);
      },
    });
    if (policyAdvance !== 0) return;
    expect(connection.state.object).not.toBeNull();
    expect(connection.state.receipt).not.toBeNull();
    const handle = await verifyCryptoPostgresHandle(connection);
    const advancedCurrent = {
      ...current,
      currentPolicyRevision: intent.publicationPolicyRevision + 1,
    };
    const staged = await inspectStagedTaskTerminalMessagePublication({
      handle,
      crypto: value.crypto,
      intent,
      currentAuthority: advancedCurrent,
      resolveHistoricalAgentSignerAuthority: historical,
    });
    expect(staged).not.toBeNull();
    expect(() => assertVerifiedStagedTaskTerminalMessagePublication(
      staged!, advancedCurrent)).not.toThrow();
    expect(() => assertVerifiedStagedTaskTerminalMessagePublication(
      staged!, { ...advancedCurrent, namespaceAccessRevision: 1 })).toThrow();
  });

  test("rolls back opaque bytes when the staging receipt cannot commit", async () => {
    const value = await fixture();
    const authorizationBytes = new Uint8Array([5, 6, 7, 8]);
    const evidenceInput = {
      ...value.evidenceInput,
      authorizationDigest: value.crypto.hash(authorizationBytes),
    };
      const publication = value.base.signerPublication!;
    const connection = new TerminalMessageCryptoConnection({
      agent_id: publication.agentId,
      runtime_generation: publication.runtimeGeneration,
      authorization_revision: publication.authorizationRevision,
      transition_kind: publication.transitionKind,
      operation_id: publication.operationId,
      signer_key_id: publication.signerKeyId,
      signer_public_key: publication.signerPublicKey,
      publication_bytes: encodeAgentRuntimeSignerPublicationV1(publication),
    });
    connection.failReceipt = true;
    let failure: unknown = null;
    try {
      await withTaskRuntimeTerminalMessageEvidenceV1({
        evidence: evidenceInput,
        signal: value.controller.signal,
        now: () => NOW,
        execute: async evidence => {
          const preparation = {
            ...value.base,
            evidence: evidence as TaskRuntimeTerminalMessageEvidence,
          };
          const intent: NativeTaskTerminalMessageIntent = {
            ...value.message,
            payloadDigest: Array.from(value.message.payloadDigest, byte =>
              byte.toString(16).padStart(2, "0")).join(""),
            role: "assistant", createdAt: NOW, requestId: REQUEST,
          };
          const current = {
            taskId: intent.taskId, taskRunId: intent.taskRunId,
            bindingId: intent.bindingId,
            messageOperationId: intent.messageOperationId,
            sessionId: intent.sessionId, messageId: intent.messageId,
            revision: intent.revision, objectId: intent.objectId,
            roomId: intent.roomId, namespaceId: intent.namespaceId,
            domainId: intent.domainId, mode: intent.mode,
            acceptedPolicyRevision: intent.acceptedPolicyRevision,
            currentPolicyRevision: intent.publicationPolicyRevision,
            namespaceAccessRevision: 0,
          };
          connection.claim = {
            request_id: REQUEST, work_id: RUN,
            work_kind: "task.deliver_message", purpose: "task.deliver_message",
            state: "running", format_version: 3,
            credential_subject_kind: "runtime", runtime_kind: "task",
            runtime_version: 1, claim_id: evidence.claimId,
            recipient_generation: evidence.recipientGeneration,
            recipient_key_id: evidence.recipientKeyId,
            accepted_response_kind: "runtime",
            accepted_response_hash: evidence.authorizationDigest.slice(),
            accepted_response_bytes: authorizationBytes.slice(),
            expected_policy_revision: 7, namespace_id: NS, domain_id: DOMAIN,
            expected_namespace_access_revision: 0, expected_domain_epoch: 4,
            live: true,
          };
          return stageNativeTaskTerminalMessagePublication({
            restricted: connection as unknown as PostgresJsBridgeConnection,
            preparation,
            resolveHistoricalAgentSignerAuthority: context => ({
              ...context,
              managerSigningPublicKey: value.managerPublicKey.slice(),
            }),
            assertCurrentClaim: () => undefined,
            resolveCurrentDeliveryAuthority: () => Promise.resolve(current),
          });
        },
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(connection.state).toEqual(emptyState());
  });
});
