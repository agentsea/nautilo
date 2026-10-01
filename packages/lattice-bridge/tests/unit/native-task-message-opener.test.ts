import { describe, expect, spyOn, test } from "bun:test";
import type {
  PostgresJsBridgeConnection, PostgresJsBridgeRow,
  PostgresJsBridgeScalar,
} from "@nautilo/db";
import {
  LatticeCrypto, accessRevision, agentId, authorizationRevision,
  cryptoDeviceId, cryptoDomainId,
  domainNamespaceRetainedAuthoritySetDigest, humanId,
  namespaceGeneration, namespaceId, prepareAgentRuntimeInitialization,
  prepareDomainNamespaceBundle, type DomainForegroundSecretEntry,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
  DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  encodeAgentRuntimeSignerPublicationV1,
} from "@nautilo/lattice-crypto/wire";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";
import {
  deriveMessageCryptoObjectIdV2,
} from "../../src/message/conversation-repository.ts";
import {
  createNativeTaskMessageReadTargetV1, withNativeTaskMessageV1,
  type NativeTaskMessageReadAuthorityV1,
  type NativeTaskMessageReadTargetV1,
} from "../../src/server/task/native-task-message-opener.ts";
import {
  prepareNativeTaskMessage, readPreparedNativeTaskMessage,
  type PrepareNativeTaskMessageInput,
} from "../../src/server/task/native-task-message-preparation.ts";

const NOW = 1_920_000_000_000;
const TASK = "10000000-0000-4000-8000-000000000731";
const RUN = "20000000-0000-4000-8000-000000000731";
const HUMAN = "30000000-0000-4000-8000-000000000731";
const NAMESPACE = "40000000-0000-4000-8000-000000000731";
const DOMAIN = "50000000-0000-4000-8000-000000000731";
const AGENT = "60000000-0000-4000-8000-000000000731";
const DEVICE = "native-task-message-device";
const SOURCE_ROOM = "70000000-0000-4000-8000-000000000731";
const TRANSCRIPT_ROOM = "80000000-0000-4000-8000-000000000731";
const SESSION = "90000000-0000-4000-8000-000000000731";
const SERVER = "https://nautilo.example";
const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);

type Adjust = (
  stage: string,
  rows: readonly PostgresJsBridgeRow[],
) => readonly PostgresJsBridgeRow[];

async function fixture(
  adjust: Adjust = (_stage, rows) => rows,
) {
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
    crypto,
    retained,
  );
  const domainRequirement = {
    domainId: DOMAIN,
    sourceNamespaceId: NAMESPACE,
    participantDigest: bytes(0x61),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 4,
    authorizationRevision: authorizationRevision(9),
    headDigest: bytes(0x62),
    activeNamespaceBindingSetDigest: bytes(0x63),
    activeNamespaceBindingCount: 1,
  };
  const domain: DomainForegroundSecretEntry = {
    ...domainRequirement,
    domainKey,
  };
  const current = {
    serverId: SERVER,
    cryptoDomainId: cryptoDomainId(DOMAIN),
    participantDigest: domain.participantDigest,
    participantCount: domain.participantCount,
    keyClass: "ai" as const,
    domainKeyGeneration: domain.domainKeyGeneration,
    domainAuthorizationRevision: domain.authorizationRevision,
    domainHeadDigest: domain.headDigest,
    namespaceId: namespaceId(NAMESPACE),
    namespaceAccessRevision: accessRevision(0),
    namespaceCurrentGeneration: namespaceGeneration(0),
    bundleRevision: 1,
    retainedAuthoritySetDigest: retainedDigest,
  };
  const bundle = prepareDomainNamespaceBundle(crypto, {
    operationId: "native-task-message-read-binding",
    previousBindingDigest: null,
    bundle: {
      ...current,
      formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
      retainedGenerationCount: 1,
      retainedGenerations: retained,
    },
    issuerHumanId: humanId(HUMAN),
    issuerDeviceId: cryptoDeviceId(DEVICE),
    issuerDeviceSigningGeneration: 1,
    issuerSigningPrivateKey: issuer.privateKey,
    issuerSigningPublicKey: issuer.publicKey,
    domainKey,
    issuedAt: NOW,
  });
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "native-task-message-read-runtime",
    agentId: agentId(AGENT),
    authorizationRevision: authorizationRevision(7),
    configObjects: [{
      objectId: "native-task-message-config",
      configRevision: authorizationRevision(1),
      plaintextDek: bytes(0x21),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId(HUMAN),
      managerAuthorizationRevision: authorizationRevision(2),
      managerDeviceId: cryptoDeviceId(DEVICE),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const evidenceInput: TaskRuntimeExecutionEvidenceInputV1 = {
    requestId: "native-task-message-read-request",
    workId: RUN,
    claimId: "native-task-message-read-claim",
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 1,
    recipientKeyId: "native-task-message-read-recipient",
    authorizationDigest: bytes(0x51),
    policyRevision: 3,
    episodeId: "native-task-message-read-episode",
    sourceRoomId: SOURCE_ROOM,
    hostAuthorizationRevision: 5,
    recipientAuthorizationRevision: 6,
    result: {
      taskId: TASK,
      taskRunId: RUN,
      contentRevision: 1,
      objectId: "native-task-message-result",
      signerAgentId: AGENT,
      namespace: {
        namespaceId: NAMESPACE,
        domainId: DOMAIN,
        operations: ["encrypt"],
        expectedAccessRevision: 0,
        expectedPolicyRevision: 3,
      },
    },
    domainRequirements: [domainRequirement],
    namespaceRequirements: [{
      ordinal: 0,
      namespaceId: NAMESPACE,
      domainId: DOMAIN,
      operations: ["decrypt", "encrypt"],
      expectedAccessRevision: 0,
      expectedPolicyRevision: 3,
    }],
  };
  const coordinate = { sessionId: SESSION, messageId: 1, revision: 0 };
  const controller = new AbortController();
  const prepareInput: Omit<PrepareNativeTaskMessageInput, "evidence"> = {
    crypto,
    coordinates: {
      ...coordinate,
      taskId: TASK,
      taskRunId: RUN,
      roomId: TRANSCRIPT_ROOM,
      graphThreadId: `task:${TASK}`,
      humanTurnId: RUN,
      agentId: AGENT,
      objectId: deriveMessageCryptoObjectIdV2(coordinate),
      role: "assistant",
    },
    mode: "encrypted_only",
    payload: {
      role: "assistant",
      content: "Verified native Task transcript",
    },
    createdAt: NOW,
    namespace: {
      current,
      bindingBytes: bundle.bytes,
      expectedBindingDigest: bundle.bindingDigest,
      issuerSigningPublicKey: issuer.publicKey,
      domainKey,
    },
    runtime: initialized.runtime,
    signerPublication: initialized.signerPublication,
    agentAuthorizationRevision: 7,
    resolveHistoricalSignerPublicationManager: () => manager.publicKey,
    signal: controller.signal,
    resolveCurrentAuthority: (expected) => Promise.resolve(expected),
  };
  const prepared = await withTaskRuntimeExecutionEvidenceV1({
    evidence: evidenceInput,
    signal: controller.signal,
    now: () => NOW,
    execute: (evidence) => prepareNativeTaskMessage({
      ...prepareInput,
      evidence,
    }),
  });
  const snapshot = readPreparedNativeTaskMessage(prepared);
  const created = snapshot.authority;
  const authority: NativeTaskMessageReadAuthorityV1 = {
    mode: created.mode,
    taskId: created.taskId,
    taskRunId: created.taskRunId,
    sourceRoomId: created.sourceRoomId,
    roomId: created.roomId,
    sessionId: created.sessionId,
    messageId: created.messageId,
    revision: created.revision,
    graphThreadId: created.graphThreadId,
    humanTurnId: created.humanTurnId,
    agentId: created.agentId,
    role: created.role,
    createdAt: created.createdAt,
    objectId: created.objectId,
    cryptoAccessRevision: 0,
    namespaceId: created.namespaceId,
    domainId: created.domainId,
    expectedAccessRevision: created.namespaceAccessRevision,
    expectedPolicyRevision: created.policyRevision,
  };
  const target = createNativeTaskMessageReadTargetV1(authority);
  const payloadHash = crypto.hash(snapshot.object.payloadBytes.ciphertext);
  const envelopeHash = crypto.hash(snapshot.envelopeBytes[0]);
  const signerPublication = initialized.signerPublication;
  const stages: string[] = [];
  let manifestReads = 0;
  const restricted: PostgresJsBridgeConnection = {
    query: async <Row extends PostgresJsBridgeRow>(statement: string) => {
      let stage: string;
      let rows: readonly PostgresJsBridgeRow[];
      if (statement.includes("SELECT current_user::text")) {
        stage = "role";
        rows = [{
          current_user: "nautilo_crypto",
          session_user: "nautilo_crypto",
        }];
      } else if (statement.includes('from "namespace_domain_key_heads"')
        && statement.includes("inner join")) {
        stage = "native-binding";
        rows = [{
          binding_bytes: bundle.bytes,
          binding_digest: bundle.bindingDigest,
          signing_public_key: issuer.publicKey,
        }];
      } else if (statement.includes('from "namespace_domain_key_heads"')) {
        stage = "namespace";
        rows = [{
          namespace_id: NAMESPACE,
          namespace_access_revision: 0,
          namespace_current_generation: 0,
          domain_id: DOMAIN,
          domain_key_generation: 4,
          domain_authorization_revision: 9,
          domain_head_digest: domain.headDigest,
          bundle_revision: 1,
          retained_generation_count: 1,
          retained_authority_set_digest: retainedDigest,
          binding_digest: bundle.bindingDigest,
        }];
      } else if (statement.includes('from "domain_key_heads"')) {
        stage = "domain";
        rows = [{
          domain_id: DOMAIN,
          domain_key_generation: 4,
          authorization_revision: 9,
          head_digest: domain.headDigest,
          participant_digest: domain.participantDigest,
          participant_count: 1,
        }];
      } else if (statement.includes('from "crypto_objects"')) {
        stage = "object";
        rows = [{
          object_id: authority.objectId,
          payload_hash: payloadHash,
          payload_bytes: snapshot.object.payloadBytes.ciphertext,
        }];
      } else if (statement.includes('from "object_crypto_access_heads"')) {
        stage = "access-head";
        rows = [{
          object_id: authority.objectId,
          access_revision: 0,
          manifest_hash: snapshot.manifestHash,
        }];
      } else if (statement.includes('from "object_crypto_namespace_envelopes"')) {
        stage = "envelope";
        rows = [{
          object_id: authority.objectId,
          access_revision: 0,
          namespace_id: NAMESPACE,
          ordinal: 0,
          envelope_hash: envelopeHash,
          envelope_bytes: snapshot.envelopeBytes[0],
        }];
      } else if (statement.includes('from "object_crypto_access_manifests"')) {
        manifestReads += 1;
        stage = manifestReads % 2 === 0 ? "verify-chain" : "manifest";
        rows = [{
          object_id: authority.objectId,
          access_revision: 0,
          manifest_hash: snapshot.manifestHash,
          previous_manifest_hash: null,
          payload_hash: payloadHash,
          manifest_bytes: snapshot.manifestBytes,
        }];
      } else if (statement.includes('from "agent_crypto_runtime_signers"')) {
        stage = "signer";
        rows = [{
          agent_id: signerPublication.agentId,
          runtime_generation: signerPublication.runtimeGeneration,
          authorization_revision: signerPublication.authorizationRevision,
          transition_kind: signerPublication.transitionKind,
          operation_id: signerPublication.operationId,
          signer_key_id: signerPublication.signerKeyId,
          signer_public_key: signerPublication.signerPublicKey,
          publication_bytes:
            encodeAgentRuntimeSignerPublicationV1(signerPublication),
        }];
      } else {
        throw new Error(`Unexpected native Task Message query: ${statement}`);
      }
      stages.push(stage);
      return adjust(stage, rows) as readonly Row[];
    },
    transaction: async (use) => use(restricted),
    transactionOnce: async (use) => use(restricted),
  };
  let authorityReads = 0;
  const open = <Value>(
    execute: Parameters<typeof withNativeTaskMessageV1<Value>>[0]["execute"],
    options: Readonly<{
      target?: NativeTaskMessageReadTargetV1;
      domains?: readonly DomainForegroundSecretEntry[];
      evidence?: TaskRuntimeExecutionEvidenceInputV1;
      resolveCurrentAuthority?: (
        expected: NativeTaskMessageReadAuthorityV1,
        read: number,
      ) => Promise<NativeTaskMessageReadAuthorityV1 | null>;
    }> = {},
  ) => withTaskRuntimeExecutionEvidenceV1({
    evidence: options.evidence ?? evidenceInput,
    signal: controller.signal,
    now: () => NOW,
    execute: (evidence) => withNativeTaskMessageV1({
      restricted,
      crypto,
      serverScope: SERVER,
      evidence,
      domains: options.domains ?? [domain],
      signal: controller.signal,
      target: options.target ?? target,
      resolveCurrentAuthority: (expected) => {
        authorityReads += 1;
        return options.resolveCurrentAuthority?.(expected, authorityReads)
          ?? Promise.resolve({ ...expected });
      },
      resolveHistoricalAgentSignerAuthority: (context) => ({
        ...context,
        managerSigningPublicKey: manager.publicKey.slice(),
      }),
      execute,
    }),
  });
  return {
    crypto, authority, target, domain, evidenceInput, controller, stages,
    snapshot, open, get authorityReads() { return authorityReads; },
  };
}

function change(
  stage: string,
  field: string,
  value: PostgresJsBridgeScalar,
): Adjust {
  return (current, rows) => current === stage
    ? rows.map((row) => ({ ...row, [field]: value }))
    : rows;
}

async function fails(operation: Promise<unknown>): Promise<void> {
  expect(await operation.then(
    () => null,
    (error: unknown) => error,
  )).toBeInstanceOf(Error);
}

describe("native Task Message opener", () => {
  test("opens a historically signed V5 Message under its exact Task audience", async () => {
    const value = await fixture();
    expect(await value.open(async (payload, assertCurrent) => {
      await assertCurrent();
      return payload.content;
    })).toBe("Verified native Task transcript");
    expect(value.stages).toContain("verify-chain");
    expect(value.stages).toContain("signer");
    expect(value.authorityReads).toBeGreaterThanOrEqual(4);
    expect(await value.open(() => null)).toBeNull();
  });

  test("rejects forged and spread read targets before database access", async () => {
    const value = await fixture();
    await fails(value.open(() => "must not open", {
      target: { ...value.target },
    }));
    expect(value.stages).toEqual([]);
  });

  test("does not admit Plain Message targets", async () => {
    const value = await fixture();
    expect(() => createNativeTaskMessageReadTargetV1({
      ...value.authority,
      mode: "plaintext_only",
    } as unknown as NativeTaskMessageReadAuthorityV1)).toThrow();
    expect(value.stages).toEqual([]);
  });

  test("rejects a missing decrypt grant before ciphertext access", async () => {
    const value = await fixture();
    await fails(value.open(() => "must not open", { domains: [] }));
    expect(value.stages).toEqual([]);
    const withoutDecrypt: TaskRuntimeExecutionEvidenceInputV1 = {
      ...value.evidenceInput,
      namespaceRequirements: value.evidenceInput.namespaceRequirements.map(
        (entry) => ({ ...entry, operations: ["encrypt"] }),
      ),
    };
    await fails(value.open(() => "must not open", {
      evidence: withoutDecrypt,
    }));
    expect(value.stages).toEqual([]);
  });

  test("rejects a grant for a different Runtime signer", async () => {
    const value = await fixture();
    await fails(value.open(() => "must not open", {
      evidence: {
        ...value.evidenceInput,
        result: { ...value.evidenceInput.result, signerAgentId: HUMAN },
      },
    }));
    expect(value.stages).toEqual([]);
  });

  for (const [field, replacement] of [
    ["taskId", RUN],
    ["taskRunId", TASK],
    ["sourceRoomId", TRANSCRIPT_ROOM],
    ["roomId", SOURCE_ROOM],
    ["sessionId", "a0000000-0000-4000-8000-000000000731"],
    ["namespaceId", TASK],
    ["domainId", TASK],
    ["expectedAccessRevision", 1],
    ["expectedPolicyRevision", 4],
  ] as const) {
    test(`rejects current ${field} substitution`, async () => {
      const value = await fixture();
      await fails(value.open(() => "must not open", {
        resolveCurrentAuthority: async (expected) => ({
          ...expected,
          [field]: replacement,
        } as NativeTaskMessageReadAuthorityV1),
      }));
    });
  }

  test("rejects product authority loss before plaintext and after callback", async () => {
    for (const staleAt of [1, 4]) {
      const value = await fixture();
      let called = false;
      await fails(value.open(() => {
        called = true;
        return "done";
      }, {
        resolveCurrentAuthority: async (expected, read) =>
          read >= staleAt ? null : expected,
      }));
      expect(called).toBe(staleAt === 4);
    }
  });

  for (const [stage, field, replacement] of [
    ["object", "payload_bytes", bytes(2)],
    ["manifest", "manifest_bytes", bytes(3)],
    ["envelope", "envelope_bytes", bytes(4)],
    ["envelope", "namespace_id", TASK],
    ["access-head", "access_revision", 1],
    ["signer", "agent_id", HUMAN],
    ["signer", "signer_public_key", bytes(5)],
    ["verify-chain", "manifest_bytes", bytes(6)],
  ] as const) {
    test(`rejects substituted ${stage}.${field}`, async () => {
      const value = await fixture(change(stage, field, replacement));
      await fails(value.open(() => "must not open"));
    });
  }

  for (const [stage, field, replacement] of [
    ["namespace", "namespace_access_revision", 1],
    ["namespace", "domain_key_generation", 5],
    ["domain", "authorization_revision", 10],
    ["domain", "head_digest", bytes(7)],
  ] as const) {
    test(`rejects stale ${stage}.${field}`, async () => {
      const value = await fixture(change(stage, field, replacement));
      await fails(value.open(() => "must not open"));
    });
  }

  test("rejects a substituted Domain secret", async () => {
    const value = await fixture();
    await fails(value.open(() => "must not open", {
      domains: [{ ...value.domain, domainKey: bytes(9) }],
    }));
  });

  test("wipes decrypted bytes on callback success and failure", async () => {
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
        const operation = value.open(() => {
          if (fail) throw new Error("callback failed");
          return "done";
        });
        if (fail) await fails(operation);
        else expect(await operation).toBe("done");
        expect(decrypted.length).toBeGreaterThan(0);
        for (const value of decrypted) {
          expect(value.every((byte) => byte === 0)).toBe(true);
        }
      } finally {
        spy.mockRestore();
      }
    }
  });

  test("rejects forged and expired execution evidence", async () => {
    const value = await fixture();
    const invoke = (evidence: TaskRuntimeExecutionEvidence) =>
      withNativeTaskMessageV1({
        restricted: {} as PostgresJsBridgeConnection,
        crypto: value.crypto,
        serverScope: SERVER,
        evidence,
        domains: [value.domain],
        signal: value.controller.signal,
        target: value.target,
        resolveCurrentAuthority: async () => value.authority,
        resolveHistoricalAgentSignerAuthority: () => null,
        execute: () => "must not open",
      });
    await fails(invoke(
      value.evidenceInput as unknown as TaskRuntimeExecutionEvidence,
    ));
    const expired = await withTaskRuntimeExecutionEvidenceV1({
      evidence: value.evidenceInput,
      signal: value.controller.signal,
      now: () => NOW,
      execute: (evidence) => evidence,
    });
    await fails(invoke(expired));
  });
});
