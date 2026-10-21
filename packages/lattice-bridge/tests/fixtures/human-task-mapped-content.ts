import { taskRuntimeStableIdempotencyKey, type TaskRuntimeGrantStableIdentity } from "../../../runtime/src/protected-execution/background-authorization/task-runtime-grant-claim";
import { createBackgroundAuthorizationTaskRuntimeRequestV3 } from "../../../runtime/src/protected-execution/background-authorization/lifecycle";
import { type BackgroundAuthorizationTaskRuntimeRecordV3 } from "../../../runtime/src/protected-execution/background-authorization/repository";
import { preparedTaskHistoricalRepairProvenanceV1 } from "../../src/task/task-historical-repair-provenance.ts";
import { expect, spyOn } from "bun:test";
import { getTableName } from "drizzle-orm";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import type { PostgresJsBridgeConnection, PostgresJsBridgeRow } from "@nautilo/db";
import { fixture, authority, coordinate as definitionCoordinate } from "./task-content-crypto-completion.ts";
import { fingerprintTaskContentAuthorityV1, fingerprintTaskContentNamespaceV1 } from "../../src/task/task-content-repository.ts";
import { refreshHumanMappedTaskContentAccessHead } from "../../src/server/task/postgres-foreground-task-definition-inspector.ts";
import { bindConversationProductCanonicalTransactionRunner, verifyConversationProductPostgresHandle } from "../../src/server/message/postgres-conversation-product-store.ts";
import { PostgresDeviceAdmissionRepository } from "../../src/server/device/postgres-device-admission-repository.ts";
import { PostgresDomainKeyAuthorityRepository } from "../../src/server/delivery/postgres-domain-key-authority.ts";
import { inspectNamespaceProductAuthoritySnapshot } from "../../src/server/delivery/postgres-namespace-product-authority.ts";
import { humanId, cryptoDeviceId, namespaceId, accessRevision, namespaceGeneration } from "@nautilo/lattice-crypto";

const USER = "10000000-0000-4000-8000-000000000011";
const ROOM = "10000000-0000-4000-8000-000000000012";
const AGENT = "10000000-0000-4000-8000-000000000013";
const RUN = "10000000-0000-4000-8000-000000000014";
const JOB = "10000000-0000-4000-8000-000000000015";
const OTHER_SOURCE_AGENT = "10000000-0000-4000-8000-000000000016";
const EXTRA_SOURCE_AGENT = "10000000-0000-4000-8000-000000000017";
const DEVICE = "mapped-reader";
const hash = () => new Uint8Array(32).fill(9);

export async function setup(kind: "human" | "historical" | "agent" | "foreground" = "human", result = false, revision = 1) {
  const coordinate = result ? { kind: "run_result" as const, taskId: definitionCoordinate.taskId, taskRunId: RUN, contentRevision: revision } : { ...definitionCoordinate, contentRevision: revision };
  const foregroundAuthorizationBytes = new Uint8Array([1, 3, 3, 7]);
  const crypto = await fixture(kind, true, false, coordinate, undefined,
    kind === "foreground" ? foregroundAuthorizationBytes : undefined);
  const agent = kind === "agent" ? "task-agent" : AGENT;
  let sourceHumanId = authority.requesterHumanId;
  let sourceAgentActorId = AGENT;
  let sourceAgentId = agent;
  let extraSourceAgent = false;
  await crypto.adapter.complete(crypto.prepared);
  crypto.rewrapHuman(3);
  const head = crypto.connection.state.head!;
  let mappedAccess = 0;
  let now = 100;
  const taskStatus = "paused";
  let runStatus = result ? "completed" : "awaiting";
  let jobStatus = "completed";
  let backgroundActive = false;
  let archived = false;
  let deviceActive = true;
  let wrongDomain = false;
  let mode = kind === "historical" ? "shadow_encryption" : "encrypted_only";
  const representation = kind === "historical" ? "dual" : "protected";
  const historical = kind === "historical" ? preparedTaskHistoricalRepairProvenanceV1(crypto.prepared) : null;
  let substituteLedger = false;
  let ledgerReads = 0;
  let failCommit = false;
  const events: string[] = [];
  // Human publication and foreground Agent edits bind request identity separately
  // from the independently authenticated genesis manifest.
  const ledgerDigest = historical === null ? new Uint8Array(32).fill(17) : Uint8Array.from(historical.signedRequestDigest.match(/../gu)!, byte => Number.parseInt(byte, 16));
  const fp = fingerprintTaskContentNamespaceV1(authority.namespaceId);
  const ledger = { sequence: 1, task_id: coordinate.taskId, task_run_id: RUN, content_revision: revision, result_revision: revision,
    operation_id: "human-definition", request_digest: ledgerDigest,
    authority_fingerprint: fingerprintTaskContentAuthorityV1(authority), requester_human_id: authority.requesterHumanId,
    content_namespace_id: authority.namespaceId, result_content_namespace_id: authority.namespaceId, crypto_object_id: crypto.prepared.objectId, payload_version: 1,
    representation, required_namespace_fingerprint: fp, operational_metadata: "{}", historical_repair: historical === null ? null : JSON.stringify(historical),
    completion: "complete", disposition: "mapped", attempt_count: 0, next_attempt_at: null, lease_token: null,
    lease_expires_at: null, failure_code: null, crypto_completed_at: new Date(1), lease_is_live: true };
  const taskRow = () => ({ task_id: coordinate.taskId, owner_id: USER, requestor_id: USER, task_status: taskStatus,
    prompt: "", expected_output: null, last_error: null, metadata_json: "{}", content_revision: revision,
    content_namespace_id: authority.namespaceId, content_representation: representation, crypto_object_id: crypto.prepared.objectId,
    crypto_access_revision: mappedAccess, crypto_required_namespace_fingerprint: fp, crypto_mapping_state: "verified",
    task_run_id: RUN, run_status: runStatus, result_revision: revision, result_content_namespace_id: authority.namespaceId,
    result_representation: representation, namespace_id: authority.namespaceId });
  const query = async <Row extends PostgresJsBridgeRow>(sql: string, args: readonly unknown[] = []): Promise<readonly Row[]> => {
    await Promise.resolve();
    let rows: readonly object[];
    if (sql.includes("current_user")) rows = [{ current_user: "nautilo", session_user: "nautilo" }];
    else if (sql.includes("_namespace_key_product_room")) { events.push("room"); rows = [{ room_id: ROOM,
      namespace_id: authority.namespaceId, kind: "private", parent_room_id: null, archived_at: archived ? new Date() : null,
      namespace_access_revision: 3, human_actor_ids: [authority.requesterHumanId], effective_human_actor_ids: [authority.requesterHumanId], subject_user_id: USER }]; }
    else if (sql.includes("_namespace_key_product_members")) rows = [
      { actor_id: sourceHumanId, kind: "user" },
      { actor_id: sourceAgentActorId, kind: "agent", agent_id: sourceAgentId },
      ...(extraSourceAgent
        ? [{ actor_id: EXTRA_SOURCE_AGENT, kind: "agent", agent_id: "extra-source-agent" }]
        : []),
    ];
    else if (sql.includes('from "task_definition_crypto_revisions"') || sql.includes('from "task_run_result_crypto_revisions"')) { events.push("ledger"); if (substituteLedger && ledgerReads++ > 0) ledger.request_digest.fill(0); rows = [ledger]; }
    else if (sql.includes('from "encryption_transition_policy"')) { events.push("policy-map"); rows = [{ mode, revision: 4 }]; }
    else if (sql.includes('from "actors"')) rows = [{ owner_id: USER }];
    else if (sql.includes('update "tasks"') || sql.includes('update "task_runs"')) {
      expect(sql).toContain(result ? 'set "result_crypto_access_revision"' : 'set "crypto_access_revision"');
      expect(sql).not.toContain('"updated_at" =');
      events.push("map"); mappedAccess = Number(args[0]); rows = [{ task_id: coordinate.taskId, task_run_id: RUN }];
    } else if (sql.includes('from "tasks"') || sql.includes('from "task_runs"')) rows = [taskRow()];
    else if (sql.includes('conversation_shared_agent_shadow_executions') || sql.includes('conversation_shadow_turn_agent_signers')) rows = [];
    else throw new Error(`Unexpected product SQL ${sql}`);
    return rows as readonly Row[];
  };
  const tx = {
    execute: async () => { await Promise.resolve(); events.push("policy-lock"); return [{ current_user: "nautilo", session_user: "nautilo" }]; },
    select: () => {
      let table = "";
      const builder = {
        from(value: Parameters<typeof getTableName>[0]) { table = getTableName(value); return builder; },
        where() { return builder; }, orderBy() { return builder; }, for() { return builder; }, innerJoin() { return builder; },
        then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) {
          events.push(table);
          const rows = table === "encryption_transition_policy" ? [{ mode, revision: 4, shadowBehavior: "tolerant" }]
            : table === "tasks" ? [{ id: coordinate.taskId, ownerId: USER, requestorId: USER, agentId: agent,
              contentNamespaceId: authority.namespaceId, contentRepresentation: representation, cryptoMappingState: "verified", fireLockId: null, status: taskStatus }]
            : table === "task_runs" ? [{ id: RUN, jobId: JOB, status: runStatus }]
            : table === "jobs" ? [{ status: jobStatus }]
            : table === "room_members" ? [{ agentId: sourceAgentId }] : [];
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return builder;
    },
  } as unknown as CanonicalTranscriptTx;
  const product = await verifyConversationProductPostgresHandle({ query, transaction: use => use({ query }) });
  const runner = bindConversationProductCanonicalTransactionRunner(product, { transaction: async use => {
    const old = mappedAccess;
    try { const result = await use(tx, { query }); if (failCommit) throw new Error("Product commit rejected"); return result; }
    catch (error) { mappedAccess = old; throw error; }
  } });
  const restricted: PostgresJsBridgeConnection = {
    query: async () => { await Promise.resolve(); throw new Error("Unscoped restricted query"); },
    transaction: async use => restricted.transactionOnce(use),
    transactionOnce: async use => crypto.connection.transaction(async executor => {
      const wrapped = { query: async <Row extends PostgresJsBridgeRow>(sql: string, parameters: readonly unknown[] = []): Promise<readonly Row[]> => {
        if (sql.includes("current_user")) return [{current_user: "nautilo_crypto", session_user: "nautilo_crypto"}] as unknown as Row[];
        if (sql.includes('from "human_crypto_devices"')) {
          if (sql.includes('for share')) { events.push("device"); return (deviceActive ? [{device_id: DEVICE}] : []) as unknown as Row[]; }
          const key = crypto.historicalDevicePublicKey(String(parameters[0]));
          return [{device_id: parameters[0], human_id: authority.requesterHumanId, signing_public_key: key, state: "active", revision: 99}] as unknown as Row[];
        }
        if (sql.includes('from "background_crypto_authorization_requests"')) {
          events.push("grant"); return (backgroundActive ? [{ request_id: "active-request", state: "grant_ready" }] : []) as unknown as Row[];
        }
        return executor.query(sql, parameters as Parameters<typeof executor.query>[1]) as Promise<readonly Row[]>;
      } };
      return use(wrapped);
    }),
  };
  const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation").mockImplementation(() => Promise.resolve({
    userId: USER, humanActorId: authority.requesterHumanId, deviceId: DEVICE, deviceGeneration: 1, signingPublicKey: hash(),
    serverInstanceId: "test", lineageGeneration: 1, epoch: 1, securityRevision: 1, headDigest: hash(),
  }));
  const namespace = () => ({ status: "ready" as const, namespaceId: namespaceId(authority.namespaceId),
    domainId: wrongDomain ? "wrong" : authority.domainId, namespaceAccessRevision: 3, namespaceKeyGeneration: 5,
    namespaceHeadDigest: wrongDomain ? new Uint8Array(32) : hash(), namespacePublicationDigest: hash(), namespacePublicationSetDigest: hash(), namespaceAudienceFingerprint: hash(),
    domainKeyGeneration: 1, domainAuthorizationRevision: 1, domainHeadDigest: hash(), bundleDigest: hash(), bundleRevision: 1 });
  const inspect = spyOn(PostgresDomainKeyAuthorityRepository.prototype, "inspectForegroundNamespaceAuthority")
    .mockImplementation(async () => { await Promise.resolve(); events.push("namespace"); return namespace(); });
  const read = spyOn(PostgresDomainKeyAuthorityRepository.prototype, "inspectMessageReadAuthority").mockImplementation(async input => {
    await Promise.resolve();
    const snapshot = inspectNamespaceProductAuthoritySnapshot(input.authority);
    expect(snapshot.subjectHumanId).toBe(humanId(authority.requesterHumanId)); snapshot.audienceFingerprint.fill(0);
    events.push("domain");
    return { status: "ready", subjectHumanId: humanId(authority.requesterHumanId), committerDeviceId: cryptoDeviceId(DEVICE),
      committerDeviceSigningKeyGeneration: 1, committerDeviceRevision: 1, committerDeviceSigningPublicKey: hash(),
      namespaceId: namespaceId(authority.namespaceId), namespaceAccessRevision: accessRevision(3), namespaceKeyGeneration: namespaceGeneration(5),
      namespaceHeadDigest: hash(), namespacePublicationDigest: hash(), namespacePublicationSetDigest: hash(), namespaceAudienceFingerprint: hash(),
      participantHumanCount: 1, protectedParticipantHumanCount: 1, plaintextParticipantHumanCount: 0, protectedRecipientDeviceCount: 1 };
  });
  const input = { runner, restricted, crypto: crypto.crypto, serverScope: "https://nautilo.example", coordinate,
    sourceRoomId: ROOM, expectedPolicyRevision: 4, subject: { userId: USER, humanActorId: authority.requesterHumanId,
      admission: { status: "admitted" as const, deviceId: DEVICE, deviceGeneration: 1, serverInstanceId: "test",
        lineageGeneration: 1, epoch: 1, securityRevision: 1, headDigest: hash(), expiresAt: 200 } }, now: () => now };
  return { input, product, crypto, head, ledger, events, taskAgentId: agent,
    foregroundAuthorizationBytes,
    access: () => mappedAccess,
    running: () => { runStatus = "running"; }, queued: () => { jobStatus = "queued"; },
    grant: () => { backgroundActive = true; }, archive: () => { archived = true; }, revoke: () => { deviceActive = false; },
    plain: () => { mode = "plaintext_only"; }, expire: () => { now = 201; },
    sourceAgent: (value: string) => { sourceAgentActorId = OTHER_SOURCE_AGENT; sourceAgentId = value; },
    wrongSourceHuman: () => { sourceHumanId = USER; },
    addSourceAgent: () => { extraSourceAgent = true; },
    substituteLedger: () => { substituteLedger = true; }, failCommit: () => { failCommit = true; }, domain: () => { wrongDomain = true; },
    cleanup: () => { admission.mockRestore(); inspect.mockRestore(); read.mockRestore(); } };
}

export function replanFixture(input: Parameters<NonNullable<Parameters<typeof refreshHumanMappedTaskContentAccessHead>[0]["withMappedHead"]>>[0]) {
  const { lifecycle, context, currentAccessRevision, proof, lineage } = input;
  if (lineage === null) throw new Error("definition required");
  const stableIdentity: TaskRuntimeGrantStableIdentity = {
    taskId: lifecycle.coordinate.taskId, taskRunId: RUN, executionSegment: 1, resumeContinuationFingerprint: null,
    ownerId: USER, requestorId: USER, agentId: AGENT, callingRoomId: null, scheduleKind: "now",
    graphThreadId: "thread", startedAt: 1, sourceRoomId: ROOM, targetRoomId: ROOM, targetUserIds: [USER],
    outputRoomId: null, outputNamespaceId: null, memoryMode: "namespace", scopeId: null,
    contentRepresentation: lifecycle.representation, contentNamespaceId: lifecycle.namespaceId,
    contentRevision: lifecycle.coordinate.contentRevision, contentObjectId: lifecycle.cryptoObjectId,
    contentAccessRevision: currentAccessRevision,
    requiredNamespaceFingerprint: Buffer.from(lifecycle.requiredNamespaceFingerprint).toString("base64url"),
  };
  const a = context.currentAuthority;
  const replacement: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({ requestId: `task-run-authorization:${RUN}`,
      workId: RUN, namespaceId: a.namespaceId, now: 100 }),
    idempotencyKey: taskRuntimeStableIdempotencyKey(stableIdentity), workIdentityHash: new Uint8Array(32).fill(7),
    workKind: "task.execute", purpose: "task.execute", domainId: a.domainId, processorAuthorizationRevision: null,
    expectedDomainEpoch: 1, expectedNamespaceAccessRevision: a.expectedAccessRevision, expectedPolicyRevision: a.expectedPolicyRevision,
    descriptorBytes: null, acceptedMaterial: null, finishedAt: null,
    authoritySet: { namespaceRequirements: [{ ordinal: 0, namespaceId: a.namespaceId, domainId: a.domainId,
      operations: ["decrypt", "encrypt"], expectedAccessRevision: a.expectedAccessRevision, expectedPolicyRevision: a.expectedPolicyRevision }],
    domainRequirements: [{ ordinal: 0, domainId: a.domainId, expectedEpoch: 1, expectedAuthorizationRevision: 1 }] },
  };
  const expected = { ...replacement, idempotencyKey: taskRuntimeStableIdempotencyKey({ ...stableIdentity, contentAccessRevision: 0 }) };
  return { expected, replacement, now: 101, stableIdentity, proof, lineage, lifecycle, currentAuthority: a };
}
