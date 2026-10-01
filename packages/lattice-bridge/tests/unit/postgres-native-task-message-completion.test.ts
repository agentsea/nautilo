import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto, accessRevision, agentId, authorizationRevision, cryptoDeviceId, cryptoDomainId,
  domainNamespaceRetainedAuthoritySetDigest, humanId, namespaceGeneration, namespaceId,
  prepareAgentRuntimeInitialization, prepareDomainNamespaceBundle,
} from "@nautilo/lattice-crypto";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2, DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  encodeAgentRuntimeSignerPublicationV1,
} from "@nautilo/lattice-crypto/wire";
import {
  withTaskRuntimeExecutionEvidenceV1, type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";
import { deriveMessageCryptoObjectIdV2 } from "../../src/message/conversation-repository.ts";
import {
  prepareNativeTaskMessage, type NativeTaskMessageAuthority, type PrepareNativeTaskMessageInput,
} from "../../src/server/task/native-task-message-preparation.ts";
import {
  createPostgresNativeTaskMessageCryptoCompletion, NativeTaskMessageCryptoCompletionConflictError,
} from "../../src/server/task/postgres-native-task-message-completion.ts";
import {
  verifyCryptoPostgresHandle, type CryptoPostgresConnection, type CryptoPostgresExecutor, type CryptoPostgresHandle,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type { DatabaseRow, DatabaseScalar } from "../../src/server/storage/postgres-record-codecs.ts";

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
  return { crypto, base, evidenceInput, prepare, controller, checks, generationKey, managerPublicKey: manager.publicKey, expire: () => { time = NOW + 60_000; } };
}

type DurableState = { object: DatabaseRow | null; head: DatabaseRow | null; manifests: DatabaseRow[]; envelopes: DatabaseRow[] };
const empty = (): DurableState => ({ object: null, head: null, manifests: [], envelopes: [] });
function cloneRow(row: DatabaseRow): DatabaseRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? value.slice() : value])) as DatabaseRow;
}
function cloneState(state: DurableState): DurableState {
  return { object: state.object === null ? null : cloneRow(state.object), head: state.head === null ? null : cloneRow(state.head),
    manifests: state.manifests.map(cloneRow), envelopes: state.envelopes.map(cloneRow) };
}

type Adjust = (stage: string, rows: readonly DatabaseRow[]) => readonly DatabaseRow[];
class Connection implements CryptoPostgresConnection {
  state = empty();
  stages: string[] = [];
  adjust: Adjust = (_stage, rows) => rows;
  constructor(readonly signer: DatabaseRow | null) {}
  query<Row extends DatabaseRow>(statement: string): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) return Promise.resolve([
      { current_user: "nautilo_crypto", session_user: "nautilo_crypto" },
    ] as unknown as Row[]);
    throw new Error("Queries must run inside the owned crypto transaction");
  }
  async transaction<Result>(callback: (executor: CryptoPostgresExecutor) => Promise<Result>): Promise<Result> {
    const working = cloneState(this.state);
    const executor: CryptoPostgresExecutor = { query: async <Row extends DatabaseRow>(statement: string, parameters: readonly DatabaseScalar[] = []) => {
      const sql = statement.replaceAll('"', "").toLowerCase();
      const result = (stage: string, rows: readonly DatabaseRow[] = []): readonly Row[] => {
        this.stages.push(stage); return this.adjust(stage, rows.map(cloneRow)) as readonly Row[];
      };
      if (sql.includes("pg_advisory_xact_lock")) return result("lock");
      if (sql.includes("from crypto_objects")) return result("read-object", working.object === null ? [] : [working.object]);
      if (sql.includes("from object_crypto_access_heads")) return result("read-head", working.head === null ? [] : [working.head]);
      if (sql.includes("from object_crypto_access_manifests")) return result(
        sql.includes("access_revision >=") ? "verify-chain" : "read-manifest", working.manifests,
      );
      if (sql.includes("from object_crypto_namespace_envelopes")) return result("read-envelope", working.envelopes);
      if (sql.includes("from agent_crypto_runtime_signers")) return result("read-signer", this.signer === null ? [] : [this.signer]);
      if (sql.includes("insert into crypto_objects")) {
        working.object = cloneRow({ object_id: parameters[0]!, payload_hash: parameters[1]!, payload_bytes: parameters[2]! });
        return result("insert-object");
      }
      if (sql.includes("insert into object_crypto_access_manifests")) {
        working.manifests.push(cloneRow({ object_id: parameters[0]!, access_revision: parameters[1]!, manifest_hash: parameters[2]!,
          previous_manifest_hash: parameters[3]!, payload_hash: parameters[4]!, manifest_bytes: parameters[5]! }));
        return result("insert-manifest");
      }
      if (sql.includes("insert into object_crypto_namespace_envelopes")) {
        working.envelopes.push(cloneRow({ object_id: parameters[0]!, access_revision: parameters[1]!, namespace_id: parameters[2]!,
          ordinal: parameters[3]!, envelope_hash: parameters[4]!, envelope_bytes: parameters[5]! }));
        return result("insert-envelope");
      }
      if (sql.includes("insert into object_crypto_access_heads")) {
        working.head = cloneRow({ object_id: parameters[0]!, access_revision: parameters[1]!, manifest_hash: parameters[2]! });
        return result("insert-head");
      }
      throw new Error(`Unexpected Task Message crypto SQL: ${statement}`);
    } };
    const result = await callback(executor); this.state = working; return result;
  }
}

async function completionFixture() {
  const value = await fixture();
  const prepared = await value.prepare();
  const publication = value.base.signerPublication;
  const connection = new Connection({ agent_id: publication.agentId, runtime_generation: publication.runtimeGeneration,
    authorization_revision: publication.authorizationRevision, transition_kind: publication.transitionKind,
    operation_id: publication.operationId, signer_key_id: publication.signerKeyId, signer_public_key: publication.signerPublicKey,
    publication_bytes: encodeAgentRuntimeSignerPublicationV1(publication) });
  const dependencies = { handle: await verifyCryptoPostgresHandle(connection), crypto: value.crypto,
    resolveCurrentAuthority: (expected: NativeTaskMessageAuthority) => Promise.resolve({ ...expected }),
    resolveHistoricalAgentSignerAuthority: (context: Parameters<Parameters<typeof createPostgresNativeTaskMessageCryptoCompletion>[0]["resolveHistoricalAgentSignerAuthority"]>[0]) => ({
      ...context, managerSigningPublicKey: value.managerPublicKey.slice(),
    }),
  };
  const port = createPostgresNativeTaskMessageCryptoCompletion(dependencies);
  return { ...value, prepared, connection, dependencies, port };
}
async function fails(operation: Promise<unknown>, kind: new (...args: never[]) => Error = Error): Promise<void> {
  expect(await operation.then(() => null, (error: unknown) => error)).toBeInstanceOf(kind);
}

describe("native Task Message crypto completion", () => {
  test("atomically stores and historically verifies the exact V5 set, then replays without writes", async () => {
    const value = await completionFixture();
    expect(await value.port.complete(value.prepared)).toBe("created");
    expect(value.connection.stages[0]).toBe("lock");
    expect(value.connection.stages).toContain("read-signer");
    const committed = cloneState(value.connection.state);
    value.connection.stages = [];
    expect(await value.port.complete(value.prepared)).toBe("duplicate");
    expect(value.connection.stages.some((stage) => stage.startsWith("insert-"))).toBe(false);
    expect(value.connection.state).toEqual(committed);
  });

  test("rejects forged preparation and unverified database handles", async () => {
    const value = await completionFixture();
    await fails(value.port.complete({ ...value.prepared }));
    expect(value.connection.stages).toEqual([]);
    expect(() => createPostgresNativeTaskMessageCryptoCompletion({ ...value.dependencies,
      handle: value.connection as unknown as CryptoPostgresHandle,
    })).toThrow();
  });

  for (const stage of ["insert-object", "insert-manifest", "insert-envelope", "insert-head", "verify-chain", "read-signer"] as const) {
    test(`rolls back all writes when ${stage} fails`, async () => {
      const value = await completionFixture();
      value.connection.adjust = (current, rows) => { if (current === stage) throw new Error("Injected failure"); return rows; };
      await fails(value.port.complete(value.prepared));
      expect(value.connection.state).toEqual(empty());
    });
  }

  test("rolls back a readback that loses the newly inserted object", async () => {
    const value = await completionFixture(); let reads = 0;
    value.connection.adjust = (stage, rows) => stage === "read-object" && ++reads === 2 ? [] : rows;
    await fails(value.port.complete(value.prepared), NativeTaskMessageCryptoCompletionConflictError);
    expect(value.connection.state).toEqual(empty());
  });

  for (const field of ["roomId", "sessionId", "messageId", "taskId", "taskRunId", "role", "namespaceId",
    "domainHeadDigest", "policyRevision", "mode", "runtimeGeneration", "signerKeyId"] as const) {
    test(`rejects current ${field} substitution before writes`, async () => {
      const value = await completionFixture();
      const port = createPostgresNativeTaskMessageCryptoCompletion({ ...value.dependencies,
        resolveCurrentAuthority: (expected) => Promise.resolve({ ...expected, [field]: "other" } as NativeTaskMessageAuthority),
      });
      await fails(port.complete(value.prepared), NativeTaskMessageCryptoCompletionConflictError);
      expect(value.connection.state).toEqual(empty());
    });
  }

  test("post-write loss of current authority rolls back, including on exact replay", async () => {
    const value = await completionFixture(); let checks = 0;
    const denied = createPostgresNativeTaskMessageCryptoCompletion({ ...value.dependencies,
      resolveCurrentAuthority: (expected) => Promise.resolve(++checks === 2 ? null : expected),
    });
    await fails(denied.complete(value.prepared), NativeTaskMessageCryptoCompletionConflictError);
    expect(checks).toBe(2); expect(value.connection.state).toEqual(empty());
    await value.port.complete(value.prepared);
    const committed = cloneState(value.connection.state); checks = 0;
    await fails(denied.complete(value.prepared));
    expect(value.connection.state).toEqual(committed);
  });

  for (const [stage, field, replacement] of [
    ["read-object", "payload_bytes", bytes(3)], ["read-manifest", "manifest_bytes", bytes(3)],
    ["read-envelope", "envelope_bytes", bytes(3)], ["read-envelope", "namespace_id", "other"],
    ["read-head", "access_revision", 1], ["read-signer", "agent_id", "other"],
    ["read-signer", "signer_public_key", bytes(3)], ["verify-chain", "manifest_bytes", bytes(3)],
  ] as const) {
    test(`rejects substituted durable ${stage}.${field}`, async () => {
      const value = await completionFixture();
      await value.port.complete(value.prepared); const committed = cloneState(value.connection.state);
      value.connection.adjust = (current, rows) => current === stage ? rows.map((row) => ({ ...row, [field]: replacement })) : rows;
      await fails(value.port.complete(value.prepared));
      expect(value.connection.state).toEqual(committed);
    });
  }

  test("rejects partial state and unexpected additional access revisions", async () => {
    const value = await completionFixture();
    await value.port.complete(value.prepared);
    value.connection.state.head = null;
    const partial = cloneState(value.connection.state);
    await fails(value.port.complete(value.prepared), NativeTaskMessageCryptoCompletionConflictError);
    expect(value.connection.state).toEqual(partial);
    const advanced = await completionFixture(); await advanced.port.complete(advanced.prepared);
    advanced.connection.state.manifests.push({ ...advanced.connection.state.manifests[0]!, access_revision: 1 });
    await fails(advanced.port.complete(advanced.prepared), NativeTaskMessageCryptoCompletionConflictError);
  });

  test("requires retained manager history even for an exact replay", async () => {
    const value = await completionFixture(); await value.port.complete(value.prepared);
    const denied = createPostgresNativeTaskMessageCryptoCompletion({ ...value.dependencies,
      resolveHistoricalAgentSignerAuthority: () => null,
    });
    await fails(denied.complete(value.prepared));
  });
});
