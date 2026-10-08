import { createHash } from "node:crypto";

import { describe, expect, spyOn, test } from "bun:test";
import {
  canonicalProtectedTaskSemanticAuthorityRequirements,
  parseParkedProtectedTaskAdditionalAuthority,
  protectedTaskSemanticAuthorityRequirementsDigest,
  type ParkedProtectedTaskAdditionalAuthority,
  type ParkedProtectedTaskAdditionalAuthorityJobRow,
  type ParkedProtectedTaskAdditionalAuthorityRunRow,
  type ParkedProtectedTaskAdditionalAuthorityTaskRow,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeExecutor,
  type PostgresJsBridgeRow,
  type PostgresJsBridgeScalar,
  type ProtectedTaskExecutionContinuationProof,
} from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { inspectInitialTaskRuntimeNamespaceAuthority, inspectTaskContentNamespaceAuthority, withInitialTaskRuntimeRecipientAuthority, withParkedTaskRuntimeNamespaceAuthority, withParkedTaskRuntimeRecipientAuthority } from "../../src/server/task/initial-task-runtime-namespace-authority.ts";

import { PostgresDeviceAdmissionRepository, type CurrentDeviceAdmissionAuthority } from "../../src/server/device/postgres-device-admission-repository.ts";

const DEVICE = "initial-task-device";
const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "10000000-0000-4000-8000-000000000002";
const AGENT_ACTOR = "10000000-0000-4000-8000-000000000003";
const AGENT = "10000000-0000-4000-8000-000000000004";
const TASK = "10000000-0000-4000-8000-000000000005";
const PEER = "10000000-0000-4000-8000-000000000006";
const OTHER_HUMAN = "10000000-0000-4000-8000-000000000007";
const ROOMS = ["20000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002"] as const;
const NAMESPACES = ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002"] as const;
const DOMAINS = ["40000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000002"] as const;
const SCOPE = "50000000-0000-4000-8000-000000000001";
const MEMORY_ROOM = "50000000-0000-4000-8000-000000000002";
const RUN = "60000000-0000-4000-8000-000000000001";
const JOB = "60000000-0000-4000-8000-000000000002";
const REQUEST = "authority-request:1";
const STARTED = new Date("2026-10-07T12:00:00.000Z");
const PARKED = new Date("2026-10-07T12:34:56.000Z");
const OBJECT = `task-definition:v1:${"a".repeat(64)}`;

type Input = Parameters<typeof inspectInitialTaskRuntimeNamespaceAuthority>[0];
type Rows = readonly PostgresJsBridgeRow[];
type Adjust = (stage: string, rows: Rows) => Rows;

type ParkedRows = Readonly<{
  task: ParkedProtectedTaskAdditionalAuthorityTaskRow;
  run: ParkedProtectedTaskAdditionalAuthorityRunRow;
  job: ParkedProtectedTaskAdditionalAuthorityJobRow;
  proof: ProtectedTaskExecutionContinuationProof;
}>;

const digest = (seed: number): Uint8Array => new Uint8Array(32).fill(seed);

function resultObjectId(): string {
  const value = createHash("sha256").update(
    `nautilo/task-run-result-crypto-object/v1\n${TASK}\n${RUN}\n1`,
    "utf8",
  ).digest("hex");
  return `task-run-result:v1:${value}`;
}

function parkedRows(): ParkedRows {
  const requirements = canonicalProtectedTaskSemanticAuthorityRequirements([{
    namespaceId: NAMESPACES[1],
    operations: ["decrypt"],
  }]);
  return {
    task: {
      id: TASK, ownerId: USER, requestorId: USER, agentId: AGENT,
      callingRoomId: ROOMS[0], scheduleKind: "now", status: "awaiting",
      contentRepresentation: "protected", contentNamespaceId: NAMESPACES[0],
      contentRevision: 1, cryptoObjectId: OBJECT, cryptoAccessRevision: 2,
      cryptoRequiredNamespaceFingerprint: digest(1),
      cryptoMappingState: "verified", contentPristine: true,
    },
    run: {
      id: RUN, taskId: TASK, jobId: JOB,
      graphThreadId: `subagent:${TASK}:${RUN}`, status: "awaiting",
      startedAt: new Date(STARTED), pristine: true,
    },
    job: {
      id: JOB, ownerId: USER, requestorId: USER, laneKey: `task:${TASK}`,
      type: "foreground", status: "completed", startedAt: new Date(STARTED),
      completedAt: new Date(PARKED),
      reference: {
        kind: "protected_task_run_v1", taskId: TASK, taskRunId: RUN,
        inputObjectId: OBJECT, resultObjectId: resultObjectId(),
        authorizationRequestId: "prior-request:1", policyRevision: 7,
        executionSegment: 1,
      },
      parkReceipt: {
        version: 1, taskId: TASK, taskRunId: RUN, jobId: JOB,
        graphThreadId: `subagent:${TASK}:${RUN}`, generation: 3,
        executionSegment: 1,
        interrupts: [{ id: "interrupt:authority:1",
          kind: "additional_authority", requestId: REQUEST }],
        parkedAt: PARKED.toISOString(),
      },
      pristine: true,
    },
    proof: {
      segment: {
        taskRunId: RUN, executionSegment: 1, jobId: JOB,
        route: "native_langgraph_v1",
        transcriptContract: "protected_message_associations_v1",
        expectedTranscriptAssociationCount: 0,
        transcriptAssociationDigest: digest(2),
        checkpointContract: "encrypted_langgraph_v1",
        expectedCheckpointCount: 1, checkpointDigest: digest(3),
        expectedCheckpointBlobCount: 1, checkpointBlobDigest: digest(4),
        expectedPendingWriteCount: 0, pendingWriteDigest: digest(5),
        sealedAt: new Date(PARKED),
      },
      continuation: {
        taskRunId: RUN, executionSegment: 1, jobId: JOB,
        kind: "pre_effect_interrupt_v1", reason: "additional_authority",
        effectDisposition: "not_started_v1",
        interruptId: "interrupt:authority:1", operationId: "tool-call:1",
        requestDigest: digest(6),
        requiredAuthorityDigest:
          protectedTaskSemanticAuthorityRequirementsDigest(requirements),
        semanticAuthorityRequirements: requirements,
        stableRoutingDigest: digest(7),
        sealedAt: new Date(PARKED),
      },
    },
  };
}

function parkedDescriptor(value = parkedRows()): ParkedProtectedTaskAdditionalAuthority {
  const descriptor = parseParkedProtectedTaskAdditionalAuthority({
    ...value,
    authorizationRequestId: REQUEST,
  });
  if (descriptor === null) throw new Error("Parked fixture is invalid");
  return descriptor;
}

function fixture(
  adjust: Adjust = (_stage, rows) => rows,
  parked: ParkedRows | null = null,
) {
  const events: string[] = [];
  let productLocked = false;
  let restrictedLocked = false;
  const productMembers = [{ actor_id: HUMAN, kind: "user" }, { actor_id: AGENT_ACTOR, kind: "agent" }];
  const targetRows = NAMESPACES.map((namespace, index) => ({
    namespace_id: namespace, room_id: ROOMS[index]!, parent_room_id: null,
    namespace_access_revision: 9 + index, human_actor_ids: [HUMAN],
    effective_human_actor_ids: [HUMAN],
  }));
  const executor: PostgresJsBridgeExecutor = {
    query: async <Row extends PostgresJsBridgeRow>(statement: string, parameters: readonly PostgresJsBridgeScalar[] = []) => {
      expect(productLocked).toBe(true);
      expect(restrictedLocked).toBe(false);
      let stage: string;
      let rows: Rows;
      if (statement.includes('from "tasks"')) {
        stage = "task";
        rows = [{ id: TASK, owner_id: USER, requestor_id: USER,
          agent_id: AGENT, calling_room_id: ROOMS[0], schedule_kind: "now",
          preset: "task", target_user_ids: [],
          content_namespace_id: NAMESPACES[0], content_representation: "protected",
          content_revision: 1, crypto_object_id: OBJECT,
          crypto_access_revision: 2,
          crypto_required_namespace_fingerprint: digest(1),
          use_scope: false, scope_id: null, target_chat: "last_in_namespace",
          target_room_id: MEMORY_ROOM, wide_bring_back: true }];
      } else if (statement.includes("identity_probe")) {
        stage = "scope-identity";
        rows = [{ current_user: "nautilo", session_user: "nautilo",
          current_user_id: USER, current_agent_id: AGENT }];
      } else if (statement.includes('from "agent_scopes"')) {
        stage = "scope";
        rows = [{ id: SCOPE, parent_agent_id: AGENT, speaker_user_id: USER,
          lifecycle_state: "open", revision: 1 }];
      } else if (statement.includes('from "memory_scopes"')) {
        stage = "scope-bag";
        rows = [];
      } else if (statement.includes("m291_namespace_key_readable_set_target_candidates")) {
        stage = "candidates";
        rows = targetRows;
      } else if (statement.includes('order by "rooms"."parent_room_id" nulls first')) {
        stage = "room-locks";
        rows = ROOMS.map((id) => ({ id }));
      } else if (statement.includes("m291_namespace_key_readable_set_source_members")) {
        stage = "source-members";
        rows = productMembers;
      } else if (statement.includes("m291_namespace_key_readable_set_source")) {
        stage = "readable-source";
        rows = [{ source_room_id: ROOMS[0], kind: "private", parent_room_id: null,
          archived_at: null, human_actor_ids: [HUMAN], effective_human_actor_ids: [HUMAN] }];
      } else if (statement.includes("m291_namespace_key_readable_set_actor")) {
        stage = "subject";
        rows = [{ subject_user_id: USER }];
      } else if (statement.includes("m291_namespace_key_readable_set_targets")) {
        stage = "targets";
        rows = targetRows;
      } else if (statement.includes("m291_namespace_key_readable_set_target_members")) {
        stage = "target-members";
        rows = ROOMS.flatMap((roomId) => productMembers.map((member) => ({ ...member, room_id: roomId })));
      } else if (statement.includes('inner join "rooms" "namespace_source_room"')) {
        stage = "readable-policy";
        const requested = parameters.find((value): value is readonly string[] =>
          Array.isArray(value));
        rows = (requested ?? NAMESPACES).map((namespace_id) => ({ namespace_id }));
      } else if (statement.includes('from "room_members"')) {
        stage = "exact-members";
        rows = [{ id: HUMAN, kind: "user", owner_id: USER, agent_id: null },
          { id: AGENT_ACTOR, kind: "agent", owner_id: USER, agent_id: AGENT }];
      } else if (statement.includes('from "rooms"')) {
        const memoryRoom = parameters.includes(MEMORY_ROOM);
        stage = memoryRoom ? "memory-room" : "exact-source";
        rows = memoryRoom
          ? [{ id: MEMORY_ROOM, namespace_id: NAMESPACES[1],
            parent_room_id: null, archived_at: null }]
          : [{ id: ROOMS[0], namespace_id: NAMESPACES[0], type: "private", kind: "private",
            parent_room_id: null, archived_at: null, human_actor_ids: [HUMAN] }];
      } else throw new Error(`Unexpected product query: ${statement}`);
      events.push(stage);
      return adjust(stage, rows) as readonly Row[];
    },
  };
  let productSelectCall = 0;
  const tx = {
    execute: async () => { events.push("policy-lock"); return []; },
    select: () => {
      const current = productSelectCall++;
      const query: Record<string, unknown> = {};
      for (const name of ["from", "where"]) query[name] = () => query;
      query["limit"] = () => query;
      query["for"] = async () => {
        if (parked === null) throw new Error("Unexpected parked lock");
        const parkedStage = current - 1;
        const stage = ["parked-task", "parked-run", "parked-job"][parkedStage];
        const rows = [parked.task, parked.run, parked.job][parkedStage];
        if (stage === undefined || rows === undefined) {
          throw new Error("Unexpected parked lock order");
        }
        events.push(stage);
        return adjust(stage, [rows] as unknown as Rows);
      };
      query["then"] = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        if (current === 0) {
          events.push("policy");
          return Promise.resolve(adjust("policy", [{ mode: "encrypted_only", shadowBehavior: "strict", revision: 7 }])).then(resolve, reject);
        }
        if (parked === null) return Promise.reject(new Error("Unexpected parked proof")).then(resolve, reject);
        const proofStage = current - 4;
        const stage = ["proof-run", "proof-segment", "proof-continuation"][proofStage];
        const rows = [
          { id: RUN, taskId: TASK },
          parked.proof.segment,
          parked.proof.continuation,
        ][proofStage];
        if (stage === undefined || rows === undefined) {
          return Promise.reject(new Error("Unexpected parked proof order"))
            .then(resolve, reject);
        }
        events.push(stage);
        return Promise.resolve(adjust(stage, [rows] as unknown as Rows))
          .then(resolve, reject);
      };
      return query;
    },
  };
  const runner = {
    transaction: async (use: (transaction: unknown, product: PostgresJsBridgeExecutor) => Promise<unknown>) => {
      productSelectCall = 0;
      productLocked = true;
      try { return await use(tx, executor); }
      finally { productLocked = false; events.push("product-released"); }
    },
  };
  const restricted: PostgresJsBridgeConnection = {
    query: async <Row extends PostgresJsBridgeRow>(statement: string, parameters: readonly unknown[] = []) => {
      expect(productLocked).toBe(true);
      expect(restrictedLocked).toBe(true);
      let rows: Rows;
      let stage: string;
      if (statement.includes("SELECT current_user::text")) {
        stage = "role";
        rows = [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }];
      } else if (statement.includes('from "human_crypto_devices"')) {
        stage = "device-lock";
        rows = [{ device_id: DEVICE, device_generation: 2, revision: 4 }];
      } else if (statement.includes('from "domain_key_recipient_envelopes"')) {
        stage = "recipient";
        rows = DOMAINS.map((domain_id) => ({ domain_id }));
      } else if (statement.includes('from "namespace_domain_key_heads"') && statement.includes('order by')) {
        stage = "namespace-locks";
        rows = NAMESPACES.map((namespace_id, index) => ({ namespace_id, domain_id: DOMAINS[index]!,
          domain_key_generation: 2, domain_authorization_revision: 3,
          domain_head_digest: new Uint8Array(32).fill(4), binding_digest: new Uint8Array(32).fill(6) }));
      } else if (statement.includes('from "domain_key_heads"') && statement.includes('order by')) {
        stage = "domain-locks";
        rows = DOMAINS.map((domain_id) => ({ domain_id, domain_key_generation: 2,
          authorization_revision: 3, head_digest: new Uint8Array(32).fill(4),
          participant_count: 1, participant_digest: new Uint8Array(32).fill(5) }));
      } else if (statement.includes('from "namespace_domain_key_heads"')) {
        stage = "namespace";
        const index = (NAMESPACES as readonly string[]).indexOf(String(parameters[0]));
        expect(index).toBeGreaterThanOrEqual(0);
        expect(parameters[1]).toBe("ai");
        rows = [{ namespace_id: NAMESPACES[index]!, namespace_access_revision: 9 + index,
          namespace_current_generation: 1, domain_id: DOMAINS[index]!, domain_key_generation: 2,
          domain_authorization_revision: 3, domain_head_digest: new Uint8Array(32).fill(4),
          bundle_revision: 1, retained_generation_count: 2,
          retained_authority_set_digest: new Uint8Array(32).fill(5), binding_digest: new Uint8Array(32).fill(6) }];
      } else if (statement.includes('from "domain_key_heads"')) {
        stage = "domain";
        expect(parameters[1]).toBe("ai");
        rows = [{ domain_id: String(parameters[0]), domain_key_generation: 2,
          authorization_revision: 3, head_digest: new Uint8Array(32).fill(4) }];
      } else throw new Error(`Unexpected restricted query: ${statement}`);
      events.push(stage);
      return adjust(stage, rows) as readonly Row[];
    },
    transaction: async () => { throw new Error("Must not retry restricted transaction"); },
    transactionOnce: async (use) => {
      restrictedLocked = true;
      events.push("restricted");
      try { return await use(restricted); }
      finally { restrictedLocked = false; events.push("restricted-released"); }
    },
  };
  const input = { runner, restricted, crypto: new LatticeCrypto(), serverScope: "https://nautilo.example",
    taskId: TASK, requesterUserId: USER, requesterHumanId: HUMAN, agentId: AGENT,
    contentNamespaceId: NAMESPACES[0], sourceRoomId: ROOMS[0], targetRoomId: MEMORY_ROOM,
    namespaceIds: NAMESPACES,
    expectedPolicyRevision: 7 } as unknown as Input;
  return { input, events };
}

function substitute(stage: string, field: string, value: PostgresJsBridgeScalar): Adjust {
  return (current, rows) => current === stage ? rows.map((row) => ({ ...row, [field]: value })) : rows;
}

describe("initial Task Runtime Namespace authority", () => {
  test("returns only detached scalar facts for multiple AI Domains after releasing locks", async () => {
    const { input, events } = fixture();
    const result = await inspectInitialTaskRuntimeNamespaceAuthority(input);
    expect(result).toEqual({ sourceRoomId: ROOMS[0], sourceNamespaceId: NAMESPACES[0],
      facts: NAMESPACES.map((namespaceId, index) => ({ namespaceId, domainId: DOMAINS[index]!,
        expectedAccessRevision: 9 + index, expectedPolicyRevision: 7,
        expectedDomainEpoch: 2, expectedAuthorizationRevision: 3 })) });
    expect(events.slice(0, 2)).toEqual(["policy-lock", "policy"]);
    expect(events.indexOf("restricted")).toBeGreaterThan(events.indexOf("exact-members"));
    expect(events.lastIndexOf("namespace")).toBeLessThan(events.indexOf("domain"));
    expect(events.slice(-2)).toEqual(["restricted-released", "product-released"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.facts)).toBe(true);
  });

  test("checks a shared Domain once and binds both Namespace revisions", async () => {
    const { input, events } = fixture(substitute("namespace", "domain_id", DOMAINS[0]));
    const result = await inspectInitialTaskRuntimeNamespaceAuthority(input);
    expect(result?.facts.map((fact) => fact.domainId)).toEqual([DOMAINS[0], DOMAINS[0]]);
    expect(events.filter((event) => event === "domain")).toHaveLength(1);
  });

  test("normalizes PostgreSQL bigint Domain heads without accepting malformed revisions", async () => {
    const { input } = fixture((stage, rows) => stage === "domain"
      ? rows.map(row => ({ ...row, domain_key_generation: "2", authorization_revision: "3" }))
      : rows);
    expect((await inspectInitialTaskRuntimeNamespaceAuthority(input))?.facts)
      .toHaveLength(2);

    const malformed = fixture(substitute("domain", "authorization_revision", "3x"));
    const error = await inspectInitialTaskRuntimeNamespaceAuthority(malformed.input)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({
      message: "Crypto storage column authorization_revision must be a safe integer",
    });
    expect(malformed.events.slice(-2))
      .toEqual(["restricted-released", "product-released"]);
  });

  test("rejects an additional Agent in the purported private pair", async () => {
    const { input, events } = fixture((stage, rows) => stage === "exact-members"
      ? [...rows, { id: TASK, kind: "agent", agent_id: TASK, owner_id: USER }] : rows);
    expect(await inspectInitialTaskRuntimeNamespaceAuthority(input)).toBeNull();
    expect(events).not.toContain("restricted");
  });

  test("accepts a dual Task under Shadow consumption authority", async () => {
    const { input } = fixture((stage, rows) => stage === "policy"
      ? [{ mode: "shadow_encryption", shadowBehavior: "fallback", revision: 7 }]
      : stage === "task" ? rows.map((row) => ({ ...row, content_representation: "dual" })) : rows);
    expect(await inspectInitialTaskRuntimeNamespaceAuthority(input)).not.toBeNull();
  });

  test("holds and revalidates one exact fixed Scope inventory before Domain work", async () => {
    const { input, events } = fixture((stage, rows) => stage === "task"
      ? rows.map((row) => ({ ...row, use_scope: true, scope_id: SCOPE }))
      : rows);
    const result = await inspectInitialTaskRuntimeNamespaceAuthority({
      ...input,
      scopeMemory: {
        scopeId: SCOPE,
        memoryRoomId: MEMORY_ROOM,
        originWritableNamespaceId: NAMESPACES[1],
        readableNamespaceIds: [NAMESPACES[1]],
      },
    });

    expect(result).not.toBeNull();
    expect(events.filter((event) => event === "task")).toHaveLength(2);
    expect(events.indexOf("scope")).toBeGreaterThan(
      events.indexOf("exact-source"),
    );
    expect(events.indexOf("restricted")).toBeGreaterThan(
      events.indexOf("scope-bag"),
    );
  });

  test("requires the exact fixed binding only for a locked Scope Task", async () => {
    const binding = {
      scopeId: SCOPE,
      memoryRoomId: MEMORY_ROOM,
      originWritableNamespaceId: NAMESPACES[1],
      readableNamespaceIds: [NAMESPACES[1]],
    } as const;
    const missing = fixture((stage, rows) => stage === "task"
      ? rows.map((row) => ({ ...row, use_scope: true, scope_id: SCOPE }))
      : rows);
    expect(await inspectInitialTaskRuntimeNamespaceAuthority(missing.input))
      .toBeNull();

    const unexpected = fixture();
    expect(await inspectInitialTaskRuntimeNamespaceAuthority({
      ...unexpected.input,
      scopeMemory: binding,
    })).toBeNull();

    const substituted = fixture((stage, rows) => stage === "task"
      ? rows.map((row) => ({ ...row, use_scope: true, scope_id: TASK }))
      : rows);
    expect(await inspectInitialTaskRuntimeNamespaceAuthority({
      ...substituted.input,
      scopeMemory: binding,
    })).toBeNull();

    const retained = fixture((stage, rows) => stage === "task"
      ? rows.map((row) => ({ ...row, use_scope: false, scope_id: SCOPE }))
      : rows);
    expect(await inspectInitialTaskRuntimeNamespaceAuthority(retained.input))
      .not.toBeNull();
  });

  test("keeps requester-private content authority independent of Scope and routing", async () => {
    const scoped = fixture((stage, rows) => {
      if (stage === "task") return rows.map((row) => ({ ...row,
        use_scope: true, scope_id: SCOPE, target_chat: "orphan",
        target_room_id: ROOMS[1] }));
      if (["candidates", "room-locks", "targets"].includes(stage)) {
        return rows.slice(0, 1);
      }
      if (stage === "target-members") {
        return rows.filter((row) => row["room_id"] === ROOMS[0]);
      }
      return rows;
    });
    const { targetRoomId: _targetRoomId, namespaceIds: _namespaceIds,
      ...contentInput } = scoped.input;

    expect(await inspectTaskContentNamespaceAuthority(contentInput)).toEqual({
      sourceRoomId: ROOMS[0],
      sourceNamespaceId: NAMESPACES[0],
      facts: [{
        namespaceId: NAMESPACES[0],
        domainId: DOMAINS[0],
        expectedAccessRevision: 9,
        expectedPolicyRevision: 7,
        expectedDomainEpoch: 2,
        expectedAuthorizationRevision: 3,
      }],
    });
    expect(await inspectInitialTaskRuntimeNamespaceAuthority(scoped.input))
      .toBeNull();
  });

  test("rejects an archived exact Scope origin Room before restricted work", async () => {
    const { input, events } = fixture((stage, rows) => stage === "task"
      ? rows.map((row) => ({ ...row, use_scope: true, scope_id: SCOPE }))
      : stage === "memory-room"
        ? rows.map((row) => ({ ...row, archived_at: new Date() }))
        : rows);
    expect(await inspectInitialTaskRuntimeNamespaceAuthority({
      ...input,
      scopeMemory: {
        scopeId: SCOPE,
        memoryRoomId: MEMORY_ROOM,
        originWritableNamespaceId: NAMESPACES[1],
        readableNamespaceIds: [NAMESPACES[1]],
      },
    })).toBeNull();
    expect(events).not.toContain("restricted");
  });

  test("pins the current Task target and derives the Scope origin by target mode", async () => {
    const binding = {
      scopeId: SCOPE,
      memoryRoomId: MEMORY_ROOM,
      originWritableNamespaceId: NAMESPACES[1],
      readableNamespaceIds: [NAMESPACES[1]],
    } as const;
    const staleTarget = fixture((stage, rows) => stage === "task"
      ? rows.map((row) => ({ ...row, use_scope: true, scope_id: SCOPE,
        target_room_id: ROOMS[1] }))
      : rows);
    expect(await inspectInitialTaskRuntimeNamespaceAuthority({
      ...staleTarget.input,
      scopeMemory: binding,
    })).toBeNull();

    const substitutedOrigin = fixture((stage, rows) => stage === "task"
      ? rows.map((row) => ({ ...row, use_scope: true, scope_id: SCOPE }))
      : rows);
    expect(await inspectInitialTaskRuntimeNamespaceAuthority({
      ...substitutedOrigin.input,
      scopeMemory: { ...binding, memoryRoomId: ROOMS[1] },
    })).toBeNull();

    const orphan = fixture((stage, rows) => stage === "task"
      ? rows.map((row) => ({ ...row, use_scope: true, scope_id: SCOPE,
        target_chat: "orphan" }))
      : rows);
    expect(await inspectInitialTaskRuntimeNamespaceAuthority({
      ...orphan.input,
      scopeMemory: {
        scopeId: SCOPE,
        memoryRoomId: ROOMS[0],
        originWritableNamespaceId: NAMESPACES[0],
        readableNamespaceIds: [NAMESPACES[0]],
      },
    })).not.toBeNull();
  });

  for (const [stage, field, value] of [
    ["policy", "mode", "plaintext_only"], ["policy", "revision", 8],
    ["task", "id", AGENT], ["task", "requestor_id", HUMAN], ["task", "agent_id", HUMAN],
    ["task", "content_namespace_id", NAMESPACES[1]], ["task", "content_representation", "ordinary"],
    ["task", "target_chat", "unknown"], ["task", "target_room_id", ROOMS[1]],
    ["subject", "subject_user_id", HUMAN],
    ["exact-source", "id", ROOMS[1]], ["exact-source", "namespace_id", NAMESPACES[1]],
    ["exact-source", "type", "shared"], ["exact-source", "kind", "group"],
    ["exact-source", "parent_room_id", ROOMS[1]], ["exact-source", "archived_at", new Date()],
    ["exact-source", "human_actor_ids", [HUMAN, AGENT]],
    ["exact-members", "agent_id", TASK], ["exact-members", "owner_id", AGENT],
    ["exact-members", "id", TASK],
    ["targets", "effective_human_actor_ids", []],
    ["namespace", "namespace_access_revision", 88], ["namespace", "namespace_id", TASK],
    ["domain", "domain_key_generation", 4], ["domain", "authorization_revision", 4],
    ["domain", "head_digest", new Uint8Array(32).fill(8)], ["domain", "domain_id", TASK],
  ] as const) {
    test(`rejects substituted ${stage}.${field}`, async () => {
      const { input } = fixture(substitute(stage, field, value));
      expect(await inspectInitialTaskRuntimeNamespaceAuthority(input)).toBeNull();
    });
  }

  for (const stage of ["readable-policy", "exact-members", "namespace", "domain"]) {
    test(`rejects missing ${stage} evidence`, async () => {
      const { input } = fixture((current, rows) => current === stage ? [] : rows);
      expect(await inspectInitialTaskRuntimeNamespaceAuthority(input)).toBeNull();
    });
  }

  test("rejects noncanonical Namespace sets before taking locks", async () => {
    for (const namespaceIds of [[], [NAMESPACES[1]], [...NAMESPACES].reverse(), [NAMESPACES[0], NAMESPACES[0]]]) {
      const { input, events } = fixture();
      const error = await inspectInitialTaskRuntimeNamespaceAuthority({ ...input, namespaceIds }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TypeError);
      expect(events).toEqual([]);
    }
  });
});

describe("parked Task Runtime Namespace authority", () => {
  test("lends exact current facts after locking the parked proof and before release", async () => {
    const current = parkedRows();
    const { input, events } = fixture((_stage, rows) => rows, current);
    let retained: PostgresJsBridgeConnection | undefined;
    const result = await withParkedTaskRuntimeNamespaceAuthority({
      ...input,
      expected: parkedDescriptor(current),
      authorizationRequestId: REQUEST,
      validateCurrentRouting: facts => {
        expect(facts).toEqual({
          taskId: TASK,
          taskRunId: RUN,
          ownerId: USER,
          requestorId: USER,
          agentId: AGENT,
          callingRoomId: ROOMS[0],
          scheduleKind: "now",
          graphThreadId: `subagent:${TASK}:${RUN}`,
          startedAt: STARTED,
          sourceRoomId: ROOMS[0],
          targetRoomId: MEMORY_ROOM,
          targetUserIds: [USER],
          memoryMode: "namespace",
          wideBringBack: true,
          scopeId: null,
          contentRepresentation: "protected",
          contentNamespaceId: NAMESPACES[0],
          contentRevision: 1,
          contentObjectId: OBJECT,
          contentAccessRevision: 2,
          requiredNamespaceFingerprint: digest(1),
        });
        expect(Object.isFrozen(facts)).toBe(true);
        expect(Object.isFrozen(facts.targetUserIds)).toBe(true);
        return true;
      },
      use: async (authority, restricted) => {
        retained = restricted;
        expect(authority).toEqual({
          sourceRoomId: ROOMS[0],
          sourceNamespaceId: NAMESPACES[0],
          facts: NAMESPACES.map((namespaceId, index) => ({
            namespaceId,
            domainId: DOMAINS[index]!,
            expectedAccessRevision: 9 + index,
            expectedPolicyRevision: 7,
            expectedDomainEpoch: 2,
            expectedAuthorizationRevision: 3,
          })),
        });
        expect(Object.isFrozen(authority)).toBe(true);
        expect(Object.isFrozen(authority.facts)).toBe(true);
        const role = await restricted.query("SELECT current_user::text");
        return role[0]?.["current_user"];
      },
    });

    expect(result).toBe("nautilo_crypto");
    expect(events.slice(events.indexOf("parked-task"), events.indexOf("proof-continuation") + 1))
      .toEqual(["parked-task", "parked-run", "parked-job",
        "proof-run", "proof-segment", "proof-continuation"]);
    expect(events.indexOf("proof-continuation"))
      .toBeLessThan(events.indexOf("candidates"));
    expect(events.lastIndexOf("namespace"))
      .toBeLessThan(events.indexOf("domain"));
    expect(events.slice(-2)).toEqual(["restricted-released", "product-released"]);
    expect(() => retained?.query("SELECT current_user::text"))
      .toThrow("Parked Task Runtime authority is not active");
  });

  test("fails closed on substituted proof or missing crypto authority", async () => {
    for (const denied of ["proof-continuation", "namespace"] as const) {
      const current = parkedRows();
      const { input, events } = fixture((stage, rows) => {
        if (stage === "proof-continuation") {
          return denied === stage
            ? rows.map(row => ({ ...row, requestDigest: digest(9) }))
            : rows;
        }
        return denied === stage ? [] : rows;
      }, current);
      let used = false;
      expect(await withParkedTaskRuntimeNamespaceAuthority({
        ...input,
        expected: parkedDescriptor(current),
        authorizationRequestId: REQUEST,
        validateCurrentRouting: () => true,
        use: () => { used = true; },
      }), denied).toBeNull();
      expect(used, denied).toBe(false);
      if (denied === "proof-continuation") {
        expect(events).not.toContain("restricted");
      }
    }
  });

  test("reports only an unavailable Namespace bundle as readiness work", async () => {
    const cases = [
      {
        name: "missing bundle",
        adjust: ((stage, rows) => stage === "namespace" ? [] : rows) as Adjust,
        expected: [NAMESPACES[0]],
      },
      {
        name: "inconsistent bundle",
        adjust: substitute("namespace", "bundle_revision", 0),
        expected: [],
      },
      {
        name: "stale access revision",
        adjust: substitute("namespace", "namespace_access_revision", 99),
        expected: [],
      },
    ];
    for (const value of cases) {
      const current = parkedRows();
      const { input } = fixture(value.adjust, current);
      const unavailable: string[] = [];
      let used = false;
      expect(await withParkedTaskRuntimeNamespaceAuthority({
        ...input,
        expected: parkedDescriptor(current),
        authorizationRequestId: REQUEST,
        validateCurrentRouting: () => true,
        onNamespaceReadinessUnavailable: namespaceId => {
          unavailable.push(namespaceId);
        },
        use: () => { used = true; },
      }), value.name).toBeNull();
      expect(unavailable, value.name).toEqual(value.expected);
      expect(used, value.name).toBe(false);
    }
  });

  test("snapshots the Namespace readiness callback before awaiting", async () => {
    const current = parkedRows();
    const { input } = fixture((stage, rows) =>
      stage === "namespace" ? [] : rows, current);
    const original: string[] = [];
    const substituted: string[] = [];
    const request = {
      ...input,
      expected: parkedDescriptor(current),
      authorizationRequestId: REQUEST,
      validateCurrentRouting: () => true,
      onNamespaceReadinessUnavailable: (namespaceId: string) => {
        original.push(namespaceId);
      },
      use: () => "unused",
    };
    const operation = withParkedTaskRuntimeNamespaceAuthority(request);
    request.onNamespaceReadinessUnavailable = namespaceId => {
      substituted.push(namespaceId);
    };

    expect(await operation).toBeNull();
    expect(original).toEqual([NAMESPACES[0]]);
    expect(substituted).toEqual([]);
  });

  test("requires the selected Namespace participant set to match locked authority", async () => {
    const adjustedAudience: Adjust = (stage, rows) => {
      if (stage === "targets") {
        return rows.map(row => row["namespace_id"] === NAMESPACES[1]
          ? { ...row, human_actor_ids: [HUMAN, PEER],
              effective_human_actor_ids: [HUMAN, PEER] }
          : row);
      }
      if (stage === "target-members") {
        return [...rows, { room_id: ROOMS[1], actor_id: PEER, kind: "user" }];
      }
      return rows;
    };
    for (const value of [
      { participantHumanIds: [HUMAN, PEER], expected: "used" },
      { participantHumanIds: [HUMAN], expected: null },
    ] as const) {
      const current = parkedRows();
      const { input, events } = fixture(adjustedAudience, current);
      expect(await withParkedTaskRuntimeNamespaceAuthority({
        ...input,
        expected: parkedDescriptor(current),
        authorizationRequestId: REQUEST,
        expectedNamespaceParticipants: [{
          namespaceId: NAMESPACES[1],
          match: "exact",
          participantHumanIds: value.participantHumanIds,
        }],
        validateCurrentRouting: () => true,
        use: () => "used",
      })).toBe(value.expected);
      if (value.expected === null) expect(events).not.toContain("restricted");
    }
  });

  test("snapshots selected Namespace participants and rejects noncanonical inputs", async () => {
    const current = parkedRows();
    const exact = fixture((_stage, rows) => rows, current);
    const participantHumanIds = [HUMAN];
    const expectedNamespaceParticipants: Array<{
      namespaceId: string;
      match: "exact" | "includes";
      participantHumanIds: string[];
    }> = [{
      namespaceId: NAMESPACES[1],
      match: "exact",
      participantHumanIds,
    }];
    const operation = withParkedTaskRuntimeNamespaceAuthority({
      ...exact.input,
      expected: parkedDescriptor(current),
      authorizationRequestId: REQUEST,
      expectedNamespaceParticipants,
      validateCurrentRouting: () => true,
      use: () => "used",
    });
    participantHumanIds[0] = PEER;
    expectedNamespaceParticipants[0]!.namespaceId = NAMESPACES[0];
    expect(await operation).toBe("used");

    for (const supplied of [
      [{ namespaceId: SCOPE, match: "exact" as const,
        participantHumanIds: [HUMAN] }],
      [{ namespaceId: NAMESPACES[1], match: "exact" as const,
        participantHumanIds: [HUMAN, HUMAN] }],
      [{ namespaceId: NAMESPACES[1], match: "subset" as unknown as "exact",
        participantHumanIds: [HUMAN] }],
      [
        { namespaceId: NAMESPACES[1], match: "exact" as const,
          participantHumanIds: [HUMAN] },
        { namespaceId: NAMESPACES[1], match: "exact" as const,
          participantHumanIds: [HUMAN] },
      ],
    ]) {
      const invalid = fixture((_stage, rows) => rows, current);
      expect(await withParkedTaskRuntimeNamespaceAuthority({
        ...invalid.input,
        expected: parkedDescriptor(current),
        authorizationRequestId: REQUEST,
        expectedNamespaceParticipants: supplied,
        validateCurrentRouting: () => true,
        use: () => "unexpected",
      })).toBeNull();
      expect(invalid.events).toEqual([]);
    }
  });

  test("requires every pinned target Human in other base Namespace audiences", async () => {
    const audience = (participantHumanIds: readonly string[]): Adjust =>
      (stage, rows) => {
        if (stage === "targets") {
          return rows.map(row => row["namespace_id"] === NAMESPACES[1]
            ? { ...row, human_actor_ids: participantHumanIds,
                effective_human_actor_ids: participantHumanIds }
            : row);
        }
        if (stage === "target-members") {
          return [
            ...rows,
            ...participantHumanIds.filter(id => id !== HUMAN).map(actor_id => ({
              room_id: ROOMS[1], actor_id, kind: "user",
            })),
          ];
        }
        return rows;
      };
    for (const value of [
      { actual: [HUMAN, PEER, OTHER_HUMAN], expected: "used" },
      { actual: [HUMAN, OTHER_HUMAN], expected: null },
    ] as const) {
      const current = parkedRows();
      const { input, events } = fixture(audience(value.actual), current);
      expect(await withParkedTaskRuntimeNamespaceAuthority({
        ...input,
        expected: parkedDescriptor(current),
        authorizationRequestId: REQUEST,
        expectedNamespaceParticipants: [{
          namespaceId: NAMESPACES[1],
          match: "includes",
          participantHumanIds: [HUMAN, PEER],
        }],
        validateCurrentRouting: () => true,
        use: () => "used",
      })).toBe(value.expected);
      if (value.expected === null) expect(events).not.toContain("restricted");
    }
  });

  test("snapshots proof, coordinates and callback before awaiting", async () => {
    const current = parkedRows();
    const expected = parkedDescriptor(current);
    const { input } = fixture((_stage, rows) => rows, current);
    const namespaceIds = [...input.namespaceIds];
    let originalCalls = 0;
    let originalValidations = 0;
    let substitutedValidations = 0;
    let substitutedCalls = 0;
    const request = {
      ...input,
      namespaceIds,
      expected,
      authorizationRequestId: REQUEST,
      validateCurrentRouting: () => {
        originalValidations += 1;
        return true;
      },
      use: () => {
        originalCalls += 1;
        return "original";
      },
    };
    const operation = withParkedTaskRuntimeNamespaceAuthority(request);
    namespaceIds[0] = TASK;
    expected.proof.continuation.requestDigest!.fill(0);
    request.validateCurrentRouting = () => {
      substitutedValidations += 1;
      return false;
    };
    request.use = () => {
      substitutedCalls += 1;
      return "substituted";
    };

    expect(await operation).toBe("original");
    expect(originalValidations).toBe(1);
    expect(substitutedValidations).toBe(0);
    expect(originalCalls).toBe(1);
    expect(substitutedCalls).toBe(0);
  });

  test("requires current routing validation before Namespace authority", async () => {
    const current = parkedRows();
    const denied = fixture((_stage, rows) => rows, current);
    let used = false;
    expect(await withParkedTaskRuntimeNamespaceAuthority({
      ...denied.input,
      expected: parkedDescriptor(current),
      authorizationRequestId: REQUEST,
      validateCurrentRouting: () => false,
      use: () => { used = true; },
    })).toBeNull();
    expect(used).toBe(false);
    expect(denied.events).toContain("proof-continuation");
    expect(denied.events).not.toContain("candidates");
    expect(denied.events).not.toContain("restricted");

    const missing = fixture((_stage, rows) => rows, current);
    expect(await withParkedTaskRuntimeNamespaceAuthority({
      ...missing.input,
      expected: parkedDescriptor(current),
      authorizationRequestId: REQUEST,
      use: () => { used = true; },
    } as never)).toBeNull();
    expect(missing.events).toEqual([]);
  });

  test("derives canonical audience, Memory mode and wide return intent from the locked Task", async () => {
    for (const wideBringBack of [true, false]) {
      const current = parkedRows();
      const { input } = fixture((stage, rows) => stage === "task"
        ? rows.map(row => ({ ...row,
            preset: "in_private_namespace",
            target_user_ids: [PEER],
            wide_bring_back: wideBringBack,
          }))
        : rows, current);
      let routing: Parameters<Parameters<
        typeof withParkedTaskRuntimeNamespaceAuthority
      >[0]["validateCurrentRouting"]>[0] | undefined;
      expect(await withParkedTaskRuntimeNamespaceAuthority({
        ...input,
        expected: parkedDescriptor(current),
        authorizationRequestId: REQUEST,
        validateCurrentRouting: facts => {
          routing = facts;
          return true;
        },
        use: () => "used",
      })).toBe("used");
      expect(routing?.targetUserIds).toEqual([USER, PEER]);
      expect(routing?.memoryMode).toBe("wide");
      expect(routing?.wideBringBack).toBe(wideBringBack);
      expect(routing?.scopeId).toBeNull();
    }
  });

  test("rejects missing or malformed projected wide return intent", async () => {
    {
      const current = parkedRows();
      const { input } = fixture((stage, rows) => stage === "task"
        ? rows.map(row => {
            const { wide_bring_back: _wideBringBack, ...replacement } = row;
            return replacement;
          })
        : rows, current);
      let used = false;
      expect(await withParkedTaskRuntimeNamespaceAuthority({
        ...input,
        expected: parkedDescriptor(current),
        authorizationRequestId: REQUEST,
        validateCurrentRouting: () => true,
        use: () => { used = true; },
      }), "missing").toBeNull();
      expect(used, "missing").toBe(false);
    }
    for (const wideBringBack of ["false", 0, null] as const) {
      const current = parkedRows();
      const { input } = fixture((stage, rows) => stage === "task"
        ? rows.map(row => ({ ...row, wide_bring_back: wideBringBack }))
        : rows, current);
      let used = false;
      expect(await withParkedTaskRuntimeNamespaceAuthority({
        ...input,
        expected: parkedDescriptor(current),
        authorizationRequestId: REQUEST,
        validateCurrentRouting: () => true,
        use: () => { used = true; },
      }), String(wideBringBack)).toBeNull();
      expect(used, String(wideBringBack)).toBe(false);
    }
  });

  test("unwinds both held transactions when the callback rejects", async () => {
    const current = parkedRows();
    const { input, events } = fixture((_stage, rows) => rows, current);
    const failure = new Error("parked preparation failed");
    expect(await withParkedTaskRuntimeNamespaceAuthority({
      ...input,
      expected: parkedDescriptor(current),
      authorizationRequestId: REQUEST,
      validateCurrentRouting: () => true,
      use: async () => { throw failure; },
    }).catch((error: unknown) => error)).toBe(failure);
    expect(events.slice(-2)).toEqual(["restricted-released", "product-released"]);
  });

  test("rejects cross-spliced parked coordinates before taking locks", async () => {
    const current = parkedRows();
    const { input, events } = fixture((_stage, rows) => rows, current);
    let used = false;
    expect(await withParkedTaskRuntimeNamespaceAuthority({
      ...input,
      taskId: USER,
      expected: parkedDescriptor(current),
      authorizationRequestId: REQUEST,
      validateCurrentRouting: () => true,
      use: () => { used = true; },
    })).toBeNull();
    expect(used).toBe(false);
    expect(events).toEqual([]);
  });
});

function device(): CurrentDeviceAdmissionAuthority {
  return { userId: USER, humanActorId: HUMAN, deviceId: DEVICE, deviceGeneration: 2,
    signingPublicKey: new Uint8Array(32).fill(6), serverInstanceId: "initial-server", lineageGeneration: 1,
    epoch: 2, securityRevision: 4, headDigest: new Uint8Array(32).fill(7) };
}
function recipientInput(input: Input) {
  return { ...input, deviceId: DEVICE,
    validateCurrentTaskRun: async () => true,
    namespaceRequirements: NAMESPACES.map((namespaceId, ordinal) => ({ ordinal, namespaceId,
      domainId: DOMAINS[ordinal]!, operations: ["decrypt", "encrypt"] as const,
      expectedAccessRevision: 9 + ordinal, expectedPolicyRevision: 7 })),
    domainRequirements: DOMAINS.map((domainId, ordinal) => ({ ordinal, domainId, expectedEpoch: 2, expectedAuthorizationRevision: 3 })),
  };
}

describe("initial Task Runtime recipient authority", () => {
  test("keeps exact awaiting TaskRun validation inside product locks before recipient construction", async () => {
    const { input, events } = fixture();
    const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
      .mockImplementation(async () => device());
    let used = false;
    try {
      const result = await withInitialTaskRuntimeRecipientAuthority({
        ...recipientInput(input),
        validateCurrentTaskRun: async () => {
          events.push("run-lock");
          expect(events).toContain("task");
          expect(events).not.toContain("restricted");
          return false;
        },
        use: () => { used = true; return true; },
      });
      expect(result).toBeNull();
      expect(used).toBe(false);
      expect(events.indexOf("task")).toBeLessThan(events.indexOf("run-lock"));
      expect(events).not.toContain("restricted");
    } finally { admission.mockRestore(); }
  });

  test("lends exact public authority inside product/device/Namespace/Domain locks", async () => {
    const { input, events } = fixture();
    const devices: CurrentDeviceAdmissionAuthority[] = [];
    const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
      .mockImplementation(async (subject) => {
        expect(subject).toEqual({ userId: USER, humanActorId: HUMAN, deviceId: DEVICE });
        expect(events).toContain("restricted"); expect(events).not.toContain("restricted-released");
        events.push("admission"); const current = device(); devices.push(current); return current;
      });
    let borrowed: Uint8Array[] = [];
    let borrowedRestricted: PostgresJsBridgeConnection | null = null;
    try {
      const result = await withInitialTaskRuntimeRecipientAuthority({ ...recipientInput(input), validateBeforeCommit: () => {
        events.push("commit-check");
      }, use: async (current, restricted) => {
        events.push("callback");
        borrowedRestricted = restricted;
        expect(restricted).not.toBe(input.restricted);
        expect(current.sourceRoomId).toBe(ROOMS[0]); expect(current.policyRevision).toBe(7);
        expect(current.namespaceRequirements).toEqual(recipientInput(input).namespaceRequirements);
        expect(current.domains.map((entry) => entry.domainId)).toEqual([...DOMAINS]);
        expect(current.domains.every((entry) => entry.activeNamespaceBindingCount === 1)).toBe(true);
        expect(Object.keys(current).sort()).toEqual(["device", "domains", "namespaceRequirements", "policyRevision", "sourceNamespaceId", "sourceRoomId"]);
        borrowed = current.domains.flatMap((entry) => [entry.headDigest, entry.participantDigest, entry.activeNamespaceBindingSetDigest]);
        expect(events).not.toContain("restricted-released");
        await Promise.resolve(); return current.device.deviceId;
      } });
      expect(result).toBe(DEVICE);
      expect(events.indexOf("device-lock")).toBeLessThan(events.indexOf("namespace-locks"));
      expect(events.indexOf("namespace-locks")).toBeLessThan(events.indexOf("domain-locks"));
      expect(events.lastIndexOf("admission")).toBeLessThan(events.indexOf("callback"));
      expect(events.indexOf("callback")).toBeLessThan(events.indexOf("commit-check"));
      expect(events.indexOf("commit-check")).toBeLessThan(events.indexOf("restricted-released"));
      expect(events.slice(-2)).toEqual(["restricted-released", "product-released"]);
      expect(borrowedRestricted).not.toBeNull();
      expect(() => borrowedRestricted!.query("select 1"))
        .toThrow("Parked Task Runtime authority is not active");
      for (const bytes of [...borrowed, ...devices.flatMap((entry) => [entry.signingPublicKey, entry.headDigest])]) {
        expect(bytes.every((byte) => byte === 0)).toBe(true);
      }
    } finally { admission.mockRestore(); }
  });

  test("snapshots callbacks before awaiting while retaining the frozen request receiver", async () => {
    const { input } = fixture();
    const exact = recipientInput(input);
    const originalRunner = exact.runner;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runnerEntered = new Promise<void>(resolve => { entered = resolve; });
    const runner = {
      transaction: async (
        use: Parameters<typeof originalRunner.transaction>[0],
        options: Parameters<typeof originalRunner.transaction>[1],
      ) => {
        entered();
        await gate;
        return originalRunner.transaction(use, options);
      },
    };
    let receiverAssertions = 0;
    let originalValidation = 0;
    let originalUse = 0;
    let substituted = 0;
    const request = {
      ...exact,
      runner,
      validateCurrentTaskRun: async () => {
        originalValidation += 1;
        return true;
      },
      use: function(this: unknown) {
        expect(this).not.toBe(request);
        expect(Object.isFrozen(this)).toBe(true);
        expect(Object.isFrozen(
          (this as { namespaceIds: readonly string[] }).namespaceIds,
        )).toBe(true);
        expect((this as { namespaceIds: readonly string[] }).namespaceIds)
          .not.toBe(request.namespaceIds);
        receiverAssertions += 1;
        originalUse += 1;
        return "original";
      },
    };
    const admission = spyOn(
      PostgresDeviceAdmissionRepository.prototype,
      "currentAuthorityForDelegation",
    ).mockImplementation(async () => device());
    try {
      const operation = withInitialTaskRuntimeRecipientAuthority(
        request as unknown as Parameters<
          typeof withInitialTaskRuntimeRecipientAuthority<string>
        >[0],
      );
      await runnerEntered;
      request.validateCurrentTaskRun = async () => {
        substituted += 1;
        return false;
      };
      request.use = function() {
        substituted += 1;
        return "substituted";
      };
      release();
      expect(await operation).toBe("original");
      expect(originalValidation).toBe(1);
      expect(originalUse).toBe(1);
      expect(substituted).toBe(0);
      expect(receiverAssertions).toBe(1);
    } finally {
      release();
      admission.mockRestore();
    }
  });

  test("accepts an independent locked device projection revision", async () => {
    const { input } = fixture(substitute("device-lock", "revision", 9));
    const admission = spyOn(
      PostgresDeviceAdmissionRepository.prototype,
      "currentAuthorityForDelegation",
    ).mockImplementation(async () => device());
    try {
      expect(await withInitialTaskRuntimeRecipientAuthority({
        ...recipientInput(input),
        use: (current) => current.device.securityRevision,
      })).toBe(4);
    } finally {
      admission.mockRestore();
    }
  });

  for (const [stage, field, value] of [
    ["task", "agent_id", HUMAN], ["exact-source", "namespace_id", NAMESPACES[1]],
    ["targets", "namespace_access_revision", 40], ["policy", "revision", 8], ["policy", "mode", "plaintext_only"],
    ["namespace", "namespace_access_revision", 80], ["namespace", "domain_id", DOMAINS[1]],
    ["namespace-locks", "domain_authorization_revision", 90], ["domain-locks", "authorization_revision", 90],
    ["domain-locks", "head_digest", new Uint8Array(32).fill(9)],
    ["device-lock", "device_generation", 8],
  ] as const) {
    test(`does not invoke callback for stale ${stage}.${field}`, async () => {
      const { input } = fixture(substitute(stage, field, value)); let used = false;
      const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
        .mockImplementation(async () => device());
      try {
        expect(await withInitialTaskRuntimeRecipientAuthority({ ...recipientInput(input), use: () => { used = true; } })).toBeNull();
        expect(used).toBe(false);
      } finally { admission.mockRestore(); }
    });
  }

  test("rejects revoked device, missing native recipient and device drift before callback", async () => {
    for (const denied of ["admission", "device-lock", "recipient", "changed"]) {
      const { input } = fixture((stage, rows) => stage === denied ? [] : rows); let used = false; let reads = 0;
      const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
        .mockImplementation(async () => denied === "admission" ? null
          : { ...device(), epoch: denied === "changed" && ++reads === 2 ? 3 : 2 });
      try {
        expect(await withInitialTaskRuntimeRecipientAuthority({ ...recipientInput(input), use: () => { used = true; } })).toBeNull();
        expect(used).toBe(false);
      } finally { admission.mockRestore(); }
    }
  });

  test("supports Shadow and wipes borrowed public bytes when its callback fails", async () => {
    const { input, events } = fixture((stage, rows) => stage === "policy"
      ? [{ mode: "shadow_encryption", shadowBehavior: "fallback", revision: 7 }]
      : stage === "task" ? rows.map((row) => ({ ...row, content_representation: "dual" })) : rows);
    const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
      .mockImplementation(async () => device());
    let borrowed: Uint8Array[] = [];
    try {
      const failure = new Error("request builder failed");
      expect(await withInitialTaskRuntimeRecipientAuthority({ ...recipientInput(input), use: (current) => {
        borrowed = [current.device.signingPublicKey, current.device.headDigest,
          ...current.domains.flatMap((entry) => [entry.headDigest, entry.participantDigest, entry.activeNamespaceBindingSetDigest])];
        throw failure;
      } }).catch((error: unknown) => error)).toBe(failure);
      expect(borrowed.length).toBeGreaterThan(0);
      expect(borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
      expect(events.slice(-2)).toEqual(["restricted-released", "product-released"]);
    } finally { admission.mockRestore(); }
  });

  test("rejects forged requirement inventory and aborts without invoking callback", async () => {
    const { input, events } = fixture(); const exact = recipientInput(input);
    expect(await withInitialTaskRuntimeRecipientAuthority({ ...exact,
      namespaceRequirements: [...exact.namespaceRequirements].reverse(), use: () => true }).catch((error: unknown) => error)).toBeInstanceOf(Error);
    const controller = new AbortController(); controller.abort();
    expect(await withInitialTaskRuntimeRecipientAuthority({ ...exact, signal: controller.signal, use: () => true }).catch((error: unknown) => error)).toBeInstanceOf(Error);
    expect(events).toEqual([]);
  });
});

describe("parked Task Runtime recipient authority", () => {
  test("revalidates locked routing and all pinned base Namespace audiences", async () => {
    const parked = parkedRows();
    const { input, events } = fixture((_stage, rows) => rows, parked);
    const admission = spyOn(
      PostgresDeviceAdmissionRepository.prototype,
      "currentAuthorityForDelegation",
    ).mockImplementation(async () => device());
    let validated = 0;
    let used = 0;
    try {
      const result = await withParkedTaskRuntimeRecipientAuthority({
        ...recipientInput(input),
        expected: parkedDescriptor(parked),
        authorizationRequestId: REQUEST,
        expectedNamespaceParticipants: [
          { namespaceId: NAMESPACES[0], match: "exact",
            participantHumanIds: [HUMAN] },
          { namespaceId: NAMESPACES[1], match: "includes",
            participantHumanIds: [HUMAN] },
        ],
        validateCurrentRouting: facts => {
          validated += 1;
          expect(facts.targetRoomId).toBe(MEMORY_ROOM);
          expect(facts.targetUserIds).toEqual([USER]);
          expect(facts.memoryMode).toBe("namespace");
          return true;
        },
        use: async (_authority, restricted) => {
          used += 1;
          await restricted.query("SELECT current_user::text");
          return "ready";
        },
      });
      expect(result).toBe("ready");
      expect(validated).toBe(1);
      expect(used).toBe(1);
      expect(events.indexOf("proof-continuation"))
        .toBeLessThan(events.indexOf("candidates"));
      expect(events.indexOf("target-members"))
        .toBeLessThan(events.indexOf("restricted"));
    } finally {
      admission.mockRestore();
    }
  });

  test("rejects routing and audience drift before restricted recipient work", async () => {
    const parked = parkedRows();
    for (const currentCase of ["routing", "audience"] as const) {
      const { input, events } = fixture(
        (stage, rows) => currentCase === "audience" && stage === "targets"
          ? rows.map((row, index) => index === 0
            ? { ...row, human_actor_ids: [HUMAN, OTHER_HUMAN],
              effective_human_actor_ids: [HUMAN, OTHER_HUMAN] }
            : row)
          : rows,
        parked,
      );
      const admission = spyOn(
        PostgresDeviceAdmissionRepository.prototype,
        "currentAuthorityForDelegation",
      ).mockImplementation(async () => device());
      let used = false;
      try {
        const result = await withParkedTaskRuntimeRecipientAuthority({
          ...recipientInput(input),
          expected: parkedDescriptor(parked),
          authorizationRequestId: REQUEST,
          expectedNamespaceParticipants: [{
            namespaceId: NAMESPACES[0],
            match: "exact",
            participantHumanIds: [HUMAN],
          }],
          validateCurrentRouting: () => currentCase !== "routing",
          use: () => { used = true; },
        });
        expect(result, currentCase).toBeNull();
        expect(used, currentCase).toBe(false);
        expect(events, currentCase).not.toContain("restricted");
      } finally {
        admission.mockRestore();
      }
    }
  });
});
