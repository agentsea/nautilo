import { describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { actors, agentScopes, rooms, type NewTask, type Task, type PostgresJsBridgeConnection } from "@nautilo/db";
import { bindEncryptionDataOperationOwner, readPreparedTaskContentCryptoRevisionSnapshotV1,
  type PreparedTaskContentCryptoRevisionV1, type TaskContentRepository } from "@nautilo/lattice-bridge";
import { prepareNativeTaskDefinitionCryptoRevision, TaskContentCryptoCompletionConflictError } from "@nautilo/lattice-bridge/server";
import { agentId, agentRuntimeGeneration, deriveAgentRuntimeObjectSignerPublic, LatticeCrypto } from "@nautilo/lattice-crypto";
import type { ProtectedTaskCreationPlanV1, ProtectedTaskCreateCandidate } from "@nautilo/runtime";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import { classifyProtectedTaskMetadataV1 } from "@nautilo/types";
import { createProtectedTaskForegroundCreationPublication,
  type ProtectedTaskForegroundCreationProductContext } from "../../src/routes/protected-task-foreground-creation-publication";

const TASK = "10000000-0000-4000-8000-000000000001";
const USER = "20000000-0000-4000-8000-000000000001";
const HUMAN = "30000000-0000-4000-8000-000000000001";
const NS = "40000000-0000-4000-8000-000000000001";
const DOMAIN = "50000000-0000-4000-8000-000000000001";
const AGENT = "60000000-0000-4000-8000-000000000001";
const PRIVATE_ROOM = "70000000-0000-4000-8000-000000000001";
const NOW = 1_820_000_000_000;

function fixture(mode: "encrypted_only" | "shadow_encryption" | "plaintext_only" = "encrypted_only") {
  const crypto = new LatticeCrypto();
  const abort = new AbortController();
  const runtime = { agentId: agentId(AGENT), keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(1), key: new Uint8Array(32).fill(31) };
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  const classified = classifyProtectedTaskMetadataV1({});
  if (classified.status !== "supported") throw new Error("Metadata unavailable");
  const plan: ProtectedTaskCreationPlanV1 = {
    canonicalTaskIdentity: { ownerId: USER, requestorId: USER, agentId: AGENT },
    authority: { authorityVersion: 1, kind: "requester_private_namespace", keyClass: "ai",
      requesterHumanId: HUMAN, namespaceId: NS, domainId: DOMAIN, expectedAccessRevision: 2, expectedPolicyRevision: 3 },
    shape: { conversation: "group", memory: "scope", executor: "native" },
    payload: { formatVersion: 1, prompt: "Private native prompt", expectedOutput: "Answer", protectedMetadata: {} },
    operationalMetadata: classified.operational,
  };
  const candidate: ProtectedTaskCreateCandidate = {
    id: TASK, ownerId: USER, requestorId: USER, agentId: AGENT, prompt: plan.payload.prompt,
    expectedOutput: plan.payload.expectedOutput, status: "pending", nextFireAt: new Date(NOW),
    fundingMode: "caller", localExecutionDelegation: null, metadata: {},
  };
  let held = false;
  let row: Task | null = null;
  let working: Task | null = null;
  let cryptoExists = false;
  let inspections = 0;
  let recoveries = 0;
  const scopeId = "90000000-0000-4000-8000-000000000001";
  let scope: { id: string; name: string; purpose: null } | null = null;
  let workingScope: { id: string; name: string; purpose: null } | null = null;
  let scopeCreates = 0;
  let failCommit = false;
  let cryptoConflict = false;
  let deny = false;
  let privateDenied = false;
  let privateRoomNamespace = NS;
  let prepares = 0;
  let writes = 0;
  let commits = 0;
  let gate: Promise<void> | null = null;
  let markEntered!: () => void;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  let captured: ProtectedTaskForegroundCreationProductContext | null = null;
  const objects: string[] = [];
  const preparedTokens: PreparedTaskContentCryptoRevisionV1[] = [];
  const check = () => { if (!held) throw new Error("Borrowed context escaped"); };
  const transaction = {
    select: () => {
      check();
      let table: unknown;
      const query = { from: (value: unknown) => { table = value; return query; }, innerJoin: () => query,
        where: () => query, groupBy: () => query, having: () => query, orderBy: () => query, for: () => query,
        limit: (count: number) => {
          void count; check();
          const values = table === agentScopes
            ? workingScope === null ? [] : [workingScope]
            : table === actors ? [{ id: HUMAN }]
              : table === rooms ? [{ roomId: PRIVATE_ROOM,
                  namespaceId: privateRoomNamespace, type: "private", kind: "private",
                  graphThreadId: "app:default", createdAt: new Date(0),
                  humanActorIds: [HUMAN], memberCount: 2, humanCount: 1, agentCount: 1 }]
                : working === null ? [] : [working];
          const result = Promise.resolve(values);
          return Object.assign(result, { for: () => result });
        } };
      return query;
    },
    insert: (table: unknown) => table === agentScopes ? { values: (values: { name: string; purpose: null }) => ({
      onConflictDoNothing: () => ({ returning: async () => {
        check(); expect(values.name).toBe(`task:${TASK}`); expect(values.purpose).toBeNull();
        if (workingScope !== null) return [];
        scopeCreates += 1; workingScope = { id: scopeId, name: values.name, purpose: null };
        return [workingScope];
      } }),
    }) } : ({ values: async (values: NewTask) => {
      check(); writes += 1;
      expect(values.status).toBe("paused"); expect(values.contentRevision).toBe(0);
      if (mode === "encrypted_only") { expect(values.prompt).toBe(""); expect(values.expectedOutput).toBeNull(); }
      working = { ...values } as Task;
    } }),
  } as unknown as CanonicalTranscriptTx;
  const connection = (role: string): PostgresJsBridgeConnection => {
    const result = {
      query: async (sql: string) => {
        check();
        if (sql.includes("current_user")) return [{ current_user: role, session_user: role }];
        if (sql.includes('"crypto_objects"')) return cryptoExists ? [{ objectId: "existing" }] : [];
        throw new Error(`Unexpected query ${sql}`);
      },
      transaction: async <T>(use: (tx: PostgresJsBridgeConnection) => Promise<T>) => { check(); return use(result as PostgresJsBridgeConnection); },
      transactionOnce: async <T>(use: (tx: PostgresJsBridgeConnection) => Promise<T>) => { check(); return use(result as PostgresJsBridgeConnection); },
    };
    return result as PostgresJsBridgeConnection;
  };
  const publisher = createProtectedTaskForegroundCreationPublication({
    crypto, now: () => NOW,
    owner: bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({ policy: { mode, shadowBehavior: "strict" }, revalidationToken: 19 }),
      revalidate: async () => {},
    } }),
    entities: { signal: abort.signal, use: async () => { throw new Error("Expected current set"); },
      useCurrentSet: async request => {
        check();
        if (privateDenied) return { status: "unavailable", reason: "content_unavailable" };
        expect(request.namespaceIds).toEqual([NS]); expect(request.operations).toEqual(["encrypt"]);
        const key = new Uint8Array(32).fill(41);
        try { return { status: "executed", value: await request.execute([{ namespaceKey: key,
          authority: { namespaceId: NS, domainId: DOMAIN, namespaceAccessRevision: 2, namespaceKeyGeneration: 4,
            domainKeyGeneration: 1, domainAuthorizationRevision: 2, domainHeadDigest: new Uint8Array(32).fill(1),
            namespaceHeadDigest: new Uint8Array(32).fill(2), namespacePublicationDigest: new Uint8Array(32).fill(3),
            namespacePublicationSetDigest: new Uint8Array(32).fill(4), namespaceAudienceFingerprint: new Uint8Array(32).fill(5) } }]) }; }
        finally { key.fill(0); }
      } },
    publication: { operationId: "foreground-turn", grantId: "foreground-grant", grantDigest: new Uint8Array(32).fill(8),
      recipientKeyId: "foreground-recipient", runtime, signerKeyId: signer.principal.signerKeyId,
      signerPublicKey: signer.publicKey, agentAuthorizationRevision: 4, policyRevision: 3 },
    withCurrentProduct: async input => {
      if (deny) return null;
      expect(held).toBe(false); held = true; working = structuredClone(row); workingScope = structuredClone(scope);
      const context: ProtectedTaskForegroundCreationProductContext = {
        transaction, product: connection("nautilo"), restricted: connection("nautilo_crypto"),
        authority: plan.authority, assertCurrent: async () => { check(); if (deny) throw new Error("Authority revoked"); },
        // The unit replaces the saga; real grant/storage authorization is covered by bridge completion tests.
        resolveCurrentForegroundDefinitionAuthorization: () => { throw new Error("Unexpected completion outside saga fixture"); },
      };
      captured = context;
      try {
        const value = await input.use(context);
        if (failCommit) throw new Error("Product commit rejected");
        row = working; scope = workingScope; commits += 1; return value;
      } finally { held = false; working = null; workingScope = null; }
    },
  }, {
    // This server test isolates orchestration; the bridge inspector suite uses
    // genuine signed durable bytes and exercises its unforgeable token boundary.
    inspect: async request => {
      check(); inspections += 1;
      if (!cryptoExists) return { status: "missing" };
      if (preparedTokens.length === 0 || privateDenied) return { status: "unavailable" };
      await request.assertCurrent();
      const value = await request.use({ kind: "verified_foreground_task_definition" });
      await request.assertCurrent();
      return { status: "verified", value };
    },
    publishVerified: async request => {
      check(); recoveries += 1;
      expect(request.operationId).toBe("task-create:stable-tool-effect");
      if (working === null) throw new Error("No product placeholder");
      if (working.cryptoMappingState !== "verified") working = { ...working, status: "pending", contentRevision: 1,
        cryptoMappingState: "verified", contentRepresentation: mode === "encrypted_only" ? "protected" : "dual",
        contentNamespaceId: NS, cryptoObjectId: preparedTokens[0]!.objectId };
      return "mapped";
    },
    prepare: async input => { check(); prepares += 1; return prepareNativeTaskDefinitionCryptoRevision(input); },
    repository: () => {
      check();
      const unused = async (): Promise<never> => { throw new Error("Unexpected saga method"); };
      return {
        reserveRevision: async request => {
          check();
          expect(working?.status === "paused" || working?.cryptoMappingState === "verified").toBe(true);
          preparedTokens.push(request.prepared);
          readPreparedTaskContentCryptoRevisionSnapshotV1(request.prepared);
          return { status: "reserved", coordinate: request.prepared.coordinate, cryptoObjectId: request.prepared.objectId };
        },
        completeRevision: async request => {
          check(); markEntered(); if (gate !== null) await gate; check();
          if (working === null) throw new Error("No product placeholder");
          if (cryptoConflict) throw new TaskContentCryptoCompletionConflictError("Existing orphan");
          cryptoExists = true; objects.push(request.prepared.objectId);
          working = { ...working, status: "pending", contentRevision: 1, cryptoMappingState: "verified",
            contentRepresentation: mode === "encrypted_only" ? "protected" : "dual",
            contentNamespaceId: NS, cryptoObjectId: request.prepared.objectId };
          return { status: "mapped", coordinate: request.coordinate, cryptoObjectId: request.prepared.objectId };
        },
        lookupPreparedReplay: unused, reconcilePending: unused, reconcileCoordinate: unused,
      } satisfies TaskContentRepository;
    },
  });
  return { publisher, request: { operationId: "task-create:stable-tool-effect", prepared: plan, candidate }, row: () => row, counts: () => ({ prepares, writes, commits }),
    tokens: preparedTokens, objects, recoveries: () => recoveries, inspections: () => inspections,
    setMappedStatus: (status: Task["status"]) => { if (row === null) throw new Error("No mapped row"); row = { ...row, status, nextFireAt: null }; }, entered, scope: () => scope, seedScope: () => { scope = { id: scopeId, name: `task:${TASK}`, purpose: null }; return scopeId; }, scopeCreates: () => scopeCreates, context: () => captured!,
    conflict: () => { cryptoConflict = true; }, setFailure: (value: boolean) => { failCommit = value; }, setDenied: () => { deny = true; },
    loseCrypto: () => { cryptoExists = false; },
    denyPrivate: () => { privateDenied = true; }, orphan: () => { cryptoExists = true; },
    mismatchPrivateRoomNamespace: () => {
      privateRoomNamespace = "80000000-0000-4000-8000-000000000001";
    },
    gate: (value: Promise<void>) => { gate = value; } };
}

describe("foreground protected Task creation publication", () => {
  for (const mode of ["encrypted_only", "shadow_encryption"] as const) test(`commits ${mode} only after paused insertion and mapped definition`, async () => {
    const f = fixture(mode);
    const result = await f.publisher.publish(f.request);
    expect(result.taskId).toBe(TASK); expect(result.status).toBe("pending");
    expect(result.publicationDisposition).toBe("created");
    expect(f.row()?.prompt).toBe(mode === "encrypted_only" ? "" : f.request.candidate.prompt);
    expect(f.counts()).toEqual({ prepares: 1, writes: 1, commits: 1 });
    await rejects(f.context().assertCurrent(), /escaped/);
    expect((await f.publisher.publish(f.request)).publicationDisposition).toBe("replayed");
    expect(f.recoveries()).toBe(1); expect(f.counts().prepares).toBe(1);
    expect(f.row()?.prompt).toBe(mode === "encrypted_only" ? "" : f.request.candidate.prompt);
    f.publisher.dispose(); f.publisher.dispose();
  });
  test("creates the canonical content-free Scope in the same transaction and reuses it on replay", async () => {
    const f = fixture();
    const request = { ...f.request, candidate: { ...f.request.candidate, useScope: true, scopeId: null } };
    await f.publisher.publish(request);
    expect(f.scope()?.name).toBe(`task:${TASK}`); expect(f.scope()?.purpose).toBeNull();
    expect(f.row()?.scopeId).toBe(f.scope()?.id);
    await f.publisher.publish(request);
    expect(f.scopeCreates()).toBe(1); expect(f.counts().prepares).toBe(1);
  });
  test("a supplied Scope uses the canonical current Scope lookup", async () => {
    const f = fixture(); const scopeId = f.seedScope();
    await f.publisher.publish({ ...f.request, candidate: { ...f.request.candidate, useScope: true, scopeId } });
    expect(f.row()?.scopeId).toBe(scopeId); expect(f.scopeCreates()).toBe(0);
  });
  test("current authority loss during the sink rolls back its product mutation", async () => {
    const f = fixture(); let release!: () => void;
    f.gate(new Promise<void>(resolve => { release = resolve; }));
    const pending = f.publisher.publish(f.request);
    await f.entered; f.setDenied(); release();
    await rejects(pending, /revoked/);
    expect(f.row()).toBeNull(); expect(f.counts().commits).toBe(0);
    f.publisher.dispose();
  });
  test("concurrent same-candidate calls publish once and same-ID substitutions fail", async () => {
    const f = fixture(); let release!: () => void;
    f.gate(new Promise<void>(resolve => { release = resolve; }));
    const first = f.publisher.publish(f.request);
    const second = f.publisher.publish(f.request);
    expect(first).toBe(second);
    expect(() => f.publisher.publish({ ...f.request, candidate: { ...f.request.candidate, fundingMode: "legacy_server" } })).toThrow(/retry changed/);
    release(); await first;
    expect(f.counts()).toEqual({ prepares: 1, writes: 1, commits: 1 });
  });
  test("product rollback retries exact randomized bytes and exposes no runnable Full row", async () => {
    const f = fixture(); f.setFailure(true);
    await rejects(f.publisher.publish(f.request), /commit rejected/);
    expect(f.row()).toBeNull(); expect(f.counts().prepares).toBe(1);
    await rejects(f.publisher.publish(f.request), /commit rejected/);
    expect(f.row()).toBeNull(); expect(f.recoveries()).toBe(1);
    f.setFailure(false);
    expect((await f.publisher.publish(f.request)).publicationDisposition).toBe("created");
    expect(f.tokens).toHaveLength(1); expect(f.objects).toHaveLength(1);
    expect(f.inspections()).toBe(3); expect(f.recoveries()).toBe(2);
    expect(f.counts()).toEqual({ prepares: 1, writes: 3, commits: 1 });
  });
  test("a committed effect replay verifies bytes and preserves terminal state and scheduling", async () => {
    const f = fixture(); await f.publisher.publish(f.request);
    const original = structuredClone(readPreparedTaskContentCryptoRevisionSnapshotV1(f.tokens[0]!));
    f.setMappedStatus("completed");
    const result = await f.publisher.publish(f.request);
    expect(result.status).toBe("completed"); expect(result.nextFireAt).toBeUndefined();
    expect(result.publicationDisposition).toBe("replayed");
    expect(readPreparedTaskContentCryptoRevisionSnapshotV1(f.tokens[0]!)).toEqual(original);
    expect(f.counts().prepares).toBe(1); expect(f.objects).toHaveLength(1);
    expect(f.recoveries()).toBe(1); expect(f.row()?.nextFireAt).toBeNull();
    await rejects(async () => f.publisher.publish({ ...f.request, operationId: "another-effect" }), /changed its admitted candidate/);
  });
  test("a committed product with missing ciphertext waits instead of preparing replacement bytes", async () => {
    const f = fixture(); await f.publisher.publish(f.request);
    f.loseCrypto();
    await rejects(f.publisher.publish(f.request), /current-authority recovery/);
    expect(f.counts()).toEqual({ prepares: 1, writes: 1, commits: 1 });
    expect(f.objects).toHaveLength(1);
    expect(f.recoveries()).toBe(0);
  });
  test("an orphan without fresh recovery authority waits without reencryption", async () => {
    const f = fixture(); f.orphan();
    await rejects(f.publisher.publish(f.request), /current-authority recovery/);
    expect(f.counts()).toEqual({ prepares: 0, writes: 0, commits: 0 }); expect(f.row()).toBeNull();
  });
  test("a competing orphan appearing after absence inspection remains recoverable", async () => {
    const f = fixture(); f.conflict();
    await rejects(f.publisher.publish(f.request), error => error instanceof Error
      && "failureClass" in error && error.failureClass === "recoverable_availability");
    expect(f.row()).toBeNull(); expect(f.counts().commits).toBe(0);
  });
  test("Plain, absent current authority and absent private grant have no product writes", async () => {
    for (const kind of ["plain", "denied", "private"] as const) {
      const f = fixture(kind === "plain" ? "plaintext_only" : "encrypted_only");
      if (kind === "denied") f.setDenied(); if (kind === "private") f.denyPrivate();
      await rejects(f.publisher.publish(f.request));
      expect(f.row()).toBeNull(); expect(f.counts().writes).toBe(0);
    }
  });
  test("a private Room outside the admitted Namespace has no product writes", async () => {
    const f = fixture();
    f.mismatchPrivateRoomNamespace();
    await rejects(f.publisher.publish(f.request), /private Room is unavailable/);
    expect(f.row()).toBeNull();
    expect(f.counts()).toEqual({ prepares: 0, writes: 0, commits: 0 });
  });
  test("mismatched payload, owner and nested Task never enter the product owner", () => {
    for (const patch of [{ prompt: "substituted" }, { requestorId: HUMAN }, { parentTaskId: TASK }]) {
      const f = fixture();
      expect(() => f.publisher.publish({ ...f.request, candidate: { ...f.request.candidate, ...patch } })).toThrow(/admitted definition/);
      expect(f.counts()).toEqual({ prepares: 0, writes: 0, commits: 0 });
    }
  });
  test("disposal during a sink rolls back product state and wipes prepared bytes after drain", async () => {
    const f = fixture(); let release!: () => void;
    f.gate(new Promise<void>(resolve => { release = resolve; }));
    const pending = f.publisher.publish(f.request);
    await f.entered;
    expect(f.tokens).toHaveLength(1);
    const snapshot = readPreparedTaskContentCryptoRevisionSnapshotV1(f.tokens[0]!);
    f.publisher.dispose(); release(); await rejects(pending, /closed/);
    expect(f.row()).toBeNull();
    expect(snapshot.object.payloadBytes.ciphertext.every(value => value === 0)).toBe(true);
    expect(() => f.publisher.publish(f.request)).toThrow(/closed/);
  });
});

const claudeCreationExecution = { version: 1, harnessId: "claude-code", source: "genie",
  profileRef: "profile", catalogModelId: "catalog", selectedModel: "model" };
function claudeCreationRequest(f: ReturnType<typeof fixture>, execution: unknown = claudeCreationExecution) {
  const metadata = { execution };
  const classification = classifyProtectedTaskMetadataV1(metadata);
  if (classification.status !== "supported") throw new Error("Invalid test metadata");
  return { ...f.request, candidate: { ...f.request.candidate, metadata }, prepared: { ...f.request.prepared,
    shape: { ...f.request.prepared.shape, executor: "external_harness" as const },
    operationalMetadata: classification.operational, payload: { ...f.request.prepared.payload, protectedMetadata: classification.protectedContent } } };
}
for (const mode of ["encrypted_only", "shadow_encryption"] as const) test(`closed Claude creation uses protected publication under ${mode}`, async () => {
  const f = fixture(mode);
  try {
    const request = claudeCreationRequest(f);
    expect((await f.publisher.publish(request)).publicationDisposition).toBe("created");
    expect(f.row()?.metadata).toEqual({ execution: claudeCreationExecution });
    expect(f.row()?.prompt).toBe(mode === "encrypted_only" ? "" : request.candidate.prompt);
    expect(f.counts()).toEqual({ prepares: 1, writes: 1, commits: 1 });
    expect((await f.publisher.publish(request)).publicationDisposition).toBe("replayed");
    expect(f.counts().prepares).toBe(1);
  } finally { f.publisher.dispose(); }
});
test("Claude publication refuses unsupported descriptors and mismatched executor shape before custody", async () => {
  for (const variant of ["provider", "unknown", "native-shape"] as const) {
    const f = fixture();
    try {
      const request = claudeCreationRequest(f);
      const changed = variant === "native-shape" ? { ...request, prepared: { ...request.prepared,
        shape: { ...request.prepared.shape, executor: "native" as const } } }
        : { ...request, candidate: { ...request.candidate, metadata: { execution: variant === "provider"
          ? { ...claudeCreationExecution, harnessId: "codex" }
          : { ...claudeCreationExecution, workingDirectory: "/private" } } } };
      await rejects(async () => f.publisher.publish(changed));
      expect(f.counts()).toEqual({ prepares: 0, writes: 0, commits: 0 });
      expect(f.row()).toBeNull();
    } finally { f.publisher.dispose(); }
  }
});

const externalCreationExecutions = [
  { version: 1, harnessId: "codex", source: "genie", collaborationMode: "work", harnessModelId: "model",
    readiness: { relayId: "relay", pairingGenerationRef: "pairing", capabilityRevision: 4 }, workingDirectory: "/private/workspace" },
  { version: 1, harnessId: "hermes-acp", source: "genie", readiness: { relayId: "relay", relaySessionId: "socket",
    pairingGenerationRef: "pairing", desktopSessionId: "desktop", selectedProtocolVersion: 14, capabilityRevision: 4 } },
  { version: 1, harnessId: "opencode-acp", source: "genie", executionProfile: "autonomous", readiness: {
    relayId: "relay", relaySessionId: "socket", pairingGenerationRef: "pairing", desktopSessionId: "desktop",
    selectedProtocolVersion: 15, capabilityRevision: 4 } },
];
for (const execution of externalCreationExecutions) for (const mode of ["encrypted_only", "shadow_encryption"] as const) {
  test(`${execution.harnessId} definition creation uses protected bytes and exact replay under ${mode}`, async () => {
    const f = fixture(mode);
    try {
      const request = claudeCreationRequest(f, execution);
      const classified = classifyProtectedTaskMetadataV1({ execution });
      if (classified.status !== "supported") throw new Error("Fixture classification failed");
      expect((await f.publisher.publish(request)).publicationDisposition).toBe("created");
      expect(f.row()?.metadata).toEqual(mode === "encrypted_only" ? classified.operational : { execution });
      expect(f.row()?.prompt).toBe(mode === "encrypted_only" ? "" : request.candidate.prompt);
      if (execution.harnessId === "codex") {
        expect(JSON.stringify(request.prepared.operationalMetadata)).not.toContain("workingDirectory");
        expect(request.prepared.payload.protectedMetadata).toEqual({ execution: { workingDirectory: "/private/workspace" } });
      }
      expect((await f.publisher.publish(request)).publicationDisposition).toBe("replayed");
      expect(f.counts()).toEqual({ prepares: 1, writes: 1, commits: 2 });
    } finally { f.publisher.dispose(); }
  });
}
test("external publication rejects protected directory substitution and non-autonomous OpenCode before custody", async () => {
  for (const variant of ["directory", "opencode-profile"] as const) {
    const f = fixture();
    try {
      const changed = variant === "directory"
        ? (() => {
            const request = claudeCreationRequest(f, externalCreationExecutions[0]);
            return { ...request, candidate: { ...request.candidate, metadata: { execution: {
              ...externalCreationExecutions[0], workingDirectory: "/substituted",
            } } } };
          })()
        : claudeCreationRequest(f, { ...externalCreationExecutions[2], executionProfile: "plan" });
      await rejects(async () => f.publisher.publish(changed));
      expect(f.counts()).toEqual({ prepares: 0, writes: 0, commits: 0 }); expect(f.row()).toBeNull();
    } finally { f.publisher.dispose(); }
  }
});
