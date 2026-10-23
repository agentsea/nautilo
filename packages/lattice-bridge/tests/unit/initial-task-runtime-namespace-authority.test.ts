import { createHash } from "node:crypto";

import { describe, expect, spyOn, test } from "bun:test";
import {
  canonicalProtectedTaskSemanticAuthorityRequirements,
  parseParkedProtectedTaskAdditionalAuthority,
  protectedTaskSemanticAuthorityRequirementsDigest,
  protectedTaskRunWakeJobId,
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
import { authorizationRevision, createDomainForegroundAuthorizationPlan, cryptoDeviceId, humanId, LatticeCrypto, mintDomainForegroundAuthorization, type DomainForegroundAuthorityEntry } from "@nautilo/lattice-crypto";
import { inspectInitialTaskRuntimeNamespaceAuthority, inspectTaskContentNamespaceAuthority, inspectTaskDeliveryNamespaceAuthority, withInitialTaskRuntimeRecipientAuthority, withParkedTaskRuntimeNamespaceAuthority, withParkedTaskRuntimeRecipientAuthority, withTaskContentNamespaceAuthority, withTaskContentRecipientAuthority, withTaskDeliveryNamespaceAuthority, withTaskDeliveryRecipientAuthority } from "../../src/server/task/initial-task-runtime-namespace-authority.ts";

import { createTaskRuntimeBackgroundAuthorizationRequestV1, encodeTaskRuntimeBackgroundAuthorizationRequestV1 } from "@nautilo/lattice-crypto/background";
import { destroyDomainForegroundAuthorizationV2, serializeDomainForegroundAuthorizationV2 } from "@nautilo/lattice-crypto/wire";
import { assertTaskOutputProductAuthority, inspectTaskOutputNamespaceAuthority, withTaskOutputProductAuthority, withTaskOutputRecipientAuthority, type TaskOutputProductAuthority, type TaskOutputNamespaceAuthorityInput } from "../../src/server/task/initial-task-runtime-namespace-authority.ts";
import { withCurrentTaskOutputRuntimeAuthority, withCurrentAcceptedTaskOutputRuntimeClaimAuthority, withCurrentTaskRuntimeAuthority, type AcceptedTaskRuntimeAuthorizationV3 } from "../../src/server/task/current-task-runtime-authority.ts";

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
const DELIVERY_CHILD = "20000000-0000-4000-8000-000000000000";
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
      expect(restrictedLocked).toBe(statement.includes("recovery_use_probe") || statement.includes("SELECT current_user::text"));
      let stage: string;
      let rows: Rows;
      if (statement.includes("SELECT current_user::text")) {
        stage = "wake-product-role"; rows = [{ current_user: "nautilo", session_user: "nautilo" }];
      } else if (statement.includes("recovery_validate_probe")) {
        stage = "recovery-validate";
        rows = [{ current: true }];
      } else if (statement.includes("recovery_use_probe")) {
        stage = "recovery-use";
        rows = [{ current: true }];
      } else if (statement.includes('from "tasks"')) {
        if (statement.includes('as "wide_bring_back"')) {
          expect(statement).toContain("for no key update");
          expect(statement).not.toContain("for update");
        }
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
        rows = (parameters[0] as readonly string[]).map((id) => ({ id }));
      } else if (statement.includes("destination_access_allowed")) {
        stage = "delivery-room";
        const child = parameters.includes(DELIVERY_CHILD);
        const privateDestination = parameters.includes(ROOMS[0]);
        rows = [{ id: child ? DELIVERY_CHILD : privateDestination ? ROOMS[0] : ROOMS[1],
          namespace_id: privateDestination ? NAMESPACES[0] : NAMESPACES[1],
          kind: child ? "subthread" : privateDestination ? "private" : "group", parent_room_id: child ? ROOMS[1] : null,
          archived_at: null, destination_access_allowed: true,
          human_actor_ids: [HUMAN], effective_human_actor_ids: [HUMAN] }];
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
        const roomIds = parameters[0] as readonly string[];
        rows = roomIds.flatMap((roomId) => productMembers.map((member) => ({ ...member, room_id: roomId })));
      } else if (statement.includes('inner join "rooms" "namespace_source_room"')) {
        stage = "readable-policy";
        const requested = parameters.find((value): value is readonly string[] =>
          Array.isArray(value));
        rows = (requested ?? NAMESPACES).map((namespace_id) => ({ namespace_id }));
      } else if (statement.includes('from "room_members"')) {
        stage = parameters.includes(ROOMS[0]) ? "exact-members" : "delivery-members";
        rows = [{ id: HUMAN, kind: "user", owner_id: USER, agent_id: null },
          { id: AGENT_ACTOR, kind: "agent", owner_id: USER, agent_id: AGENT }];
      } else if (statement.includes('from "rooms"') && statement.includes("effective_human_actor_ids")) {
        stage = "output-roster";
        rows = [{ id: parameters.includes(DELIVERY_CHILD) ? DELIVERY_CHILD : parameters.includes(ROOMS[0]) ? ROOMS[0] : ROOMS[1], effective_human_actor_ids: [HUMAN] }];
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
    select: (projection?: Record<string, unknown>) => {
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
        if (current === 0 || projection !== undefined && "mode" in projection) {
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
  return { input, events, canonicalTransaction: tx };
}

function substitute(stage: string, field: string, value: PostgresJsBridgeScalar): Adjust {
  return (current, rows) => current === stage ? rows.map((row) => ({ ...row, [field]: value })) : rows;
}

function contentAuthorityFixture(
  adjust: Adjust = (_stage, rows) => rows,
) {
  return fixture((stage, rows) => {
    if (["candidates", "room-locks", "targets"].includes(stage)) {
      return rows.slice(0, 1);
    }
    if (stage === "target-members") {
      return rows.filter((row) => row["room_id"] === ROOMS[0]);
    }
    return adjust(stage, rows);
  });
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

  test("keeps Human-owned source custody when its private Room Agent differs from the Task executor", async () => {
    const { input } = fixture(substitute("exact-members", "agent_id", PEER));
    expect(await inspectInitialTaskRuntimeNamespaceAuthority(input)).not.toBeNull();
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

  test("keeps content custody with the Human when the source Room Agent differs from the Task executor", async () => {
    const { input } = contentAuthorityFixture(
      substitute("exact-members", "agent_id", PEER),
    );
    const { targetRoomId: _targetRoomId, namespaceIds: _namespaceIds,
      ...contentInput } = input;
    expect(await inspectTaskContentNamespaceAuthority(contentInput))
      .not.toBeNull();
  });

  test("lends the canonical product transaction under current content authority", async () => {
    const { input, events, canonicalTransaction } = contentAuthorityFixture();
    const { targetRoomId: _targetRoomId, namespaceIds: _namespaceIds,
      ...contentInput } = input;
    let validatedProduct: PostgresJsBridgeConnection | undefined;
    const result = await withTaskContentNamespaceAuthority({
      ...contentInput,
      validateCurrentTaskRun: async (product, transaction, task) => {
        expect(transaction as unknown).toBe(canonicalTransaction);
        expect(task.id).toBe(TASK);
        validatedProduct = product;
        const rows = await product.query("SELECT recovery_validate_probe");
        return rows[0]?.["current"] === true;
      },
      use: async (authority, product, transaction) => {
        expect(transaction as unknown).toBe(canonicalTransaction);
        if (validatedProduct === undefined) {
          throw new Error("Content authority use ran before product validation");
        }
        expect(product).toBe(validatedProduct);
        expect(authority.facts).toEqual([{
          namespaceId: NAMESPACES[0],
          domainId: DOMAINS[0],
          expectedAccessRevision: 9,
          expectedPolicyRevision: 7,
          expectedDomainEpoch: 2,
          expectedAuthorizationRevision: 3,
        }]);
        const rows = await product.query("SELECT recovery_use_probe");
        return rows[0]?.["current"] === true ? "used" : "stale";
      },
    });

    expect(result).toBe("used");
    expect(events.slice(0, 4)).toEqual([
      "policy-lock", "policy", "task", "recovery-validate",
    ]);
    expect(events.indexOf("recovery-use"))
      .toBeGreaterThan(events.lastIndexOf("domain"));
    expect(events.slice(-3)).toEqual([
      "recovery-use", "restricted-released", "product-released",
    ]);
  });

  test("denies content authority before Namespace locks when exact product proof fails", async () => {
    const { input, events } = contentAuthorityFixture();
    const { targetRoomId: _targetRoomId, namespaceIds: _namespaceIds,
      ...contentInput } = input;
    let used = false;
    expect(await withTaskContentNamespaceAuthority({
      ...contentInput,
      validateCurrentTaskRun: async () => false,
      use: () => {
        used = true;
      },
    })).toBeNull();

    expect(used).toBe(false);
    expect(events).toEqual([
      "policy-lock", "policy", "task", "product-released",
    ]);
  });

  test("unwinds both held transactions when content recovery throws", async () => {
    const { input, events } = contentAuthorityFixture();
    const { targetRoomId: _targetRoomId, namespaceIds: _namespaceIds,
      ...contentInput } = input;
    const sentinel = new Error("content recovery failed");
    const failure = await withTaskContentNamespaceAuthority({
      ...contentInput,
      validateCurrentTaskRun: async () => true,
      use: () => {
        throw sentinel;
      },
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBe(sentinel);
    expect(events.slice(-2)).toEqual([
      "restricted-released", "product-released",
    ]);
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
    ["exact-members", "owner_id", AGENT],
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


describe("cancellation content recipient authority", () => {
  for (const scenario of ["ready", "device_missing", "policy_changed", "domain_changed"] as const) {
    test(`holds encrypt-only content authority: ${scenario}`, async () => {
      const { input, events } = fixture((stage, rows) => {
        if (["candidates", "room-locks", "targets", "namespace-locks", "domain-locks", "recipient"].includes(stage)) rows = rows.slice(0, 1);
        if (stage === "target-members") rows = rows.filter(row => row["room_id"] === ROOMS[0]);
        if (stage === "task") rows = rows.map(row => ({ ...row,
          crypto_object_id: null, content_revision: 0, use_scope: true,
          scope_id: null, target_chat: "unavailable", target_room_id: null }));
        if (scenario === "policy_changed" && stage === "policy") rows = rows.map(row => ({ ...row, revision: 8 }));
        if (scenario === "domain_changed" && stage === "namespace") rows = rows.map(row => ({ ...row, domain_id: DOMAINS[1] }));
        return rows;
      });
      const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
        .mockImplementation(async () => {
          events.push("admission");
          return scenario === "device_missing" ? null : device();
        });
      try {
        const exact = recipientInput(input);
        const result = await withTaskContentRecipientAuthority({ ...input,
          deviceId: DEVICE,
          namespaceRequirements: [{ ...exact.namespaceRequirements[0]!, operations: ["encrypt"] }],
          domainRequirements: exact.domainRequirements.slice(0, 1),
          validateCurrentTaskRun: async () => { events.push("stopped-proof"); return true; },
          use: current => {
            expect(current.namespaceRequirements[0]!.operations).toEqual(["encrypt"]);
            expect(current.domains).toHaveLength(1);
            return "bound";
          },
        });
        expect(result).toBe(scenario === "ready" ? "bound" : null);
        if (scenario === "ready") {
          expect(events.indexOf("stopped-proof")).toBeLessThan(events.indexOf("admission"));
          expect(events.indexOf("admission")).toBeLessThan(events.indexOf("namespace-locks"));
          expect(events.indexOf("namespace-locks")).toBeLessThan(events.indexOf("domain-locks"));
        }
      } finally { admission.mockRestore(); }
    });
  }
});

function deliveryFixture(adjust: Adjust = (_stage, rows) => rows, child = false) {
  const state = fixture((stage, supplied) => {
    let rows = supplied;
    if (["candidates", "targets", "namespace-locks", "domain-locks", "recipient"].includes(stage)) {
      rows = rows.slice(1);
    }
    if (stage === "target-members") {
      rows = rows.filter(row => row["room_id"] === ROOMS[1]);
      if (child) rows = [...rows, ...rows.map(row => ({ ...row, room_id: DELIVERY_CHILD }))];
    }
    if (stage === "task") rows = rows.map(row => ({ ...row,
      crypto_object_id: null, content_revision: 0, use_scope: true,
      scope_id: null, target_chat: "unavailable", target_room_id: null }));
    return adjust(stage, rows);
  });
  return { ...state, delivery: { ...state.input,
    destinationRoomId: child ? DELIVERY_CHILD : ROOMS[1],
    destinationNamespaceId: NAMESPACES[1],
    validateCurrentTaskRun: async () => { state.events.push("terminal-proof"); return true; },
  } };
}

describe("terminal Task delivery Namespace authority", () => {
  for (const child of [false, true]) {
    test(`grants only the actual ${child ? "Subthread" : "Room"} destination and keeps private source proof`, async () => {
      const { delivery, events } = deliveryFixture(undefined, child);
      expect(await inspectTaskDeliveryNamespaceAuthority(delivery)).toEqual({
        sourceRoomId: child ? DELIVERY_CHILD : ROOMS[1], sourceNamespaceId: NAMESPACES[0],
        facts: [{ namespaceId: NAMESPACES[1], domainId: DOMAINS[1],
          expectedAccessRevision: 10, expectedPolicyRevision: 7,
          expectedDomainEpoch: 2, expectedAuthorizationRevision: 3 }],
      });
      expect(events.indexOf("terminal-proof")).toBeLessThan(events.indexOf("room-locks"));
      expect(events.indexOf("room-locks")).toBeLessThan(events.indexOf("delivery-room"));
      expect(events.indexOf("delivery-room")).toBeLessThan(events.indexOf("source-members"));
      expect(events.indexOf("delivery-members")).toBeLessThan(events.indexOf("restricted"));
      expect(events.filter(event => event === "namespace")).toHaveLength(1);
      expect(events).not.toContain("parked-job");
    });
  }

  test("lends both reentrant transactions only after the terminal proof and all current locks", async () => {
    const { delivery, events, canonicalTransaction } = deliveryFixture();
    const result = await withTaskDeliveryNamespaceAuthority({ ...delivery,
      use: async (authority, product, transaction, restricted) => {
        expect(transaction as unknown).toBe(canonicalTransaction);
        expect(authority.sourceRoomId).toBe(ROOMS[1]);
        await product.transaction(async tx => { await tx.query("SELECT recovery_use_probe"); });
        await restricted.transactionOnce(async tx => { await tx.query("SELECT current_user::text"); });
        return "held";
      },
    });
    expect(result).toBe("held");
    expect(events.indexOf("recovery-use")).toBeGreaterThan(events.indexOf("domain"));
    expect(events.slice(-2)).toEqual(["restricted-released", "product-released"]);
  });

  test("does not borrow parent membership when an actual Subthread has no roster", async () => {
    const { delivery, events } = deliveryFixture((stage, rows) => {
      if (stage === "target-members") return rows.filter(row => row["room_id"] !== DELIVERY_CHILD);
      return stage === "delivery-members" ? [] : rows;
    }, true);
    expect(await inspectTaskDeliveryNamespaceAuthority(delivery)).toBeNull();
    expect(events).toContain("target-members");
    expect(events).not.toContain("restricted");
  });

  test("keeps source custody Human-owned while delivery still binds the Task executor", async () => {
    const { delivery } = deliveryFixture(
      substitute("exact-members", "agent_id", PEER),
    );
    expect(await inspectTaskDeliveryNamespaceAuthority(delivery)).not.toBeNull();
  });

  for (const [stage, field, value] of [
    ["task", "content_namespace_id", NAMESPACES[1]],
    ["task", "agent_id", PEER],
    ["task", "requestor_id", PEER],
    ["task", "content_representation", "ordinary"],
    ["exact-source", "namespace_id", NAMESPACES[1]],
    ["exact-source", "kind", "group"],
    ["exact-source", "archived_at", new Date()],
    ["delivery-room", "namespace_id", NAMESPACES[0]],
    ["delivery-room", "archived_at", new Date()],
    ["delivery-room", "destination_access_allowed", false],
    ["delivery-room", "parent_room_id", ROOMS[0]],
    ["delivery-members", "agent_id", PEER],
    ["delivery-members", "owner_id", PEER],
    ["policy", "revision", 8],
    ["policy", "mode", "plaintext_only"],
  ] as const) {
    test(`refuses changed ${stage}.${field} before restricted authority`, async () => {
      const { delivery, events } = deliveryFixture(substitute(stage, field, value));
      expect(await inspectTaskDeliveryNamespaceAuthority(delivery)).toBeNull();
      expect(events).not.toContain("restricted");
    });
  }

  test("requires the exact terminal Task/Run/output binding proof for inspection and use", async () => {
    const { delivery, events } = deliveryFixture();
    expect(await inspectTaskDeliveryNamespaceAuthority({ ...delivery,
      validateCurrentTaskRun: async () => false })).toBeNull();
    const { validateCurrentTaskRun: _proof, ...missing } = delivery;
    expect(await inspectTaskDeliveryNamespaceAuthority(missing as typeof delivery)).toBeNull();
    expect(events).not.toContain("candidates");
  });

  test("does not let delivery omit the private Namespace from initial execution", async () => {
    const { input } = deliveryFixture();
    const failure = await inspectInitialTaskRuntimeNamespaceAuthority({ ...input,
      namespaceIds: [NAMESPACES[1]] }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
  });

  for (const scenario of ["ready", "missing_device", "device_changed", "domain_changed", "access_changed", "before_commit_rejected"] as const) {
    test(`holds exact encrypt-only destination recipient authority: ${scenario}`, async () => {
      const { delivery, input, events } = deliveryFixture((stage, rows) =>
        scenario === "domain_changed" && stage === "namespace"
          ? rows.map(row => ({ ...row, domain_id: DOMAINS[0] }))
          : scenario === "access_changed" && stage === "namespace"
            ? rows.map(row => ({ ...row, namespace_access_revision: 11 })) : rows);
      let admissionCalls = 0;
      const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
        .mockImplementation(async () => {
          admissionCalls++;
          if (scenario === "missing_device") return null;
          return { ...device(), securityRevision: scenario === "device_changed" && admissionCalls > 1 ? 99 : device().securityRevision };
        });
      try {
        const exact = recipientInput(input);
        let used = false;
        const result = await withTaskDeliveryRecipientAuthority({ ...delivery, deviceId: DEVICE,
          namespaceRequirements: [{ ...exact.namespaceRequirements[1]!, ordinal: 0, operations: ["encrypt"] }],
          domainRequirements: [{ ...exact.domainRequirements[1]!, ordinal: 0 }],
          use: async (authority, _restricted, product, transaction) => {
            used = true;
            expect(authority.sourceRoomId).toBe(ROOMS[1]);
            expect(authority.sourceNamespaceId).toBe(NAMESPACES[0]);
            expect(authority.namespaceRequirements.map(entry => [entry.namespaceId, entry.operations]))
              .toEqual([[NAMESPACES[1], ["encrypt"]]]);
            expect(transaction).toBeDefined();
            await product.query("SELECT recovery_use_probe");
            return "bound";
          },
          validateBeforeCommit: () => {
            events.push("before-commit");
            if (scenario === "before_commit_rejected") throw new Error("terminal binding changed");
          },
        }).catch((error: unknown) => error instanceof Error ? error.message : error);
        expect(result).toBe(scenario === "ready" ? "bound"
          : scenario === "before_commit_rejected" ? "terminal binding changed" : null);
        expect(used).toBe(scenario === "ready" || scenario === "before_commit_rejected");
        if (used) expect(events.indexOf("before-commit")).toBeLessThan(events.indexOf("restricted-released"));
      } finally { admission.mockRestore(); }
    });
  }

  for (const scenario of ["decrypt", "execution_operations", "private_namespace", "extra_namespace", "wrong_domain"] as const) {
    test(`refuses recipient requirements ${scenario}`, async () => {
      const { delivery, input, events } = deliveryFixture();
      const exact = recipientInput(input);
      const destination = { ...exact.namespaceRequirements[1]!, ordinal: 0,
        operations: ["encrypt"] as readonly ("decrypt" | "encrypt")[] };
      if (scenario === "decrypt") destination.operations = ["decrypt"];
      if (scenario === "execution_operations") destination.operations = ["decrypt", "encrypt"];
      if (scenario === "private_namespace") destination.namespaceId = NAMESPACES[0];
      if (scenario === "wrong_domain") destination.domainId = DOMAINS[0];
      const failure = await withTaskDeliveryRecipientAuthority({ ...delivery, deviceId: DEVICE,
        namespaceRequirements: scenario === "extra_namespace" ? exact.namespaceRequirements : [destination],
        domainRequirements: [{ ...exact.domainRequirements[1]!, ordinal: 0 }],
        use: () => "forbidden",
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect(events).toEqual([]);
    });
  }
});

function outputFixture(adjust: Adjust = (_stage, rows) => rows, wake = false) {
  const value = fixture(adjust);
  const workId = wake ? protectedTaskRunWakeJobId(RUN) : RUN;
  const output: TaskOutputNamespaceAuthorityInput = {
    ...value.input, destinationRoomId: DELIVERY_CHILD, destinationNamespaceId: NAMESPACES[1],
    taskRunId: RUN, episodeId: JOB, workId,
    requestId: wake ? `task-wake-authorization:${workId}` : `task-run-delivery-result-authorization:${RUN}`,
    workKind: wake ? "task.delivery_wake" : "task.deliver_result",
    foregroundNamespaceIds: [NAMESPACES[1]],
    validateCurrentTaskRun: async () => { value.events.push("closed-result"); return true; },
    validateCurrentForeground: async (_product, _tx, coordinates) => {
      value.events.push("foreground-proof");
      expect(coordinates.foregroundNamespaceIds).toEqual([NAMESPACES[1]]);
      return true;
    },
  };
  const recipient = recipientInput(value.input);
  const namespaceRequirements = recipient.namespaceRequirements.map((n, index) => ({ ...n,
    operations: index === 0 ? ["decrypt"] as const : wake ? ["decrypt", "encrypt"] as const : ["encrypt"] as const }));
  return { ...value, output, namespaceRequirements, domainRequirements: recipient.domainRequirements };
}

async function signedOutput(value: ReturnType<typeof outputFixture>) {
  const crypto = value.input.crypto;
  const signing = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const admissionSpy = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
    .mockImplementation(async () => ({ ...device(), signingPublicKey: signing.publicKey.slice() }));
  let domains: readonly DomainForegroundAuthorityEntry[] = [];
  try {
    await withTaskOutputRecipientAuthority({ ...value.output, deviceId: DEVICE,
      namespaceRequirements: value.namespaceRequirements, domainRequirements: value.domainRequirements,
      use: authority => { domains = structuredClone(authority.domains); },
    });
  } finally { admissionSpy.mockRestore(); }
  expect(domains).toHaveLength(2);
  const now = 1_800_000_000_000;
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: value.output.requestId, policyRevision: 7, sessionId: JOB, roomId: DELIVERY_CHILD,
    subjectHumanId: humanId(HUMAN), committerDeviceId: cryptoDeviceId(DEVICE), committerDeviceSigningGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(4), recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime", recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 1, recipientKeyId: "output-recipient", operations: ["decrypt", "encrypt"],
    issuedAt: now, deadlineAt: now + 60_000, maximumSecretBytes: 4_096, domains,
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: plan.authorizationId, workId: value.output.workId, workKind: value.output.workKind,
    workPurpose: value.output.workKind, recipientGeneration: 1, episodeId: JOB, sourceRoomId: DELIVERY_CHILD,
    recipientKeyId: plan.recipientKeyId, recipientPublicKey: recipient.publicKey, authorizationPlan: plan,
    issuedAt: now, deadlineAt: plan.deadlineAt,
  });
  const authorization = await mintDomainForegroundAuthorization(crypto, {
    plan, domains: domains.map(domain => ({ ...domain, domainKey: new Uint8Array(32).fill(10) })),
    committerDeviceSigningPrivateKey: signing.privateKey, recipientEncryptionPublicKey: recipient.publicKey,
  });
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(authorization);
  destroyDomainForegroundAuthorizationV2(authorization);
  const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(request);
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
  const currentDevice = { ...device(), signingPublicKey: signing.publicKey.slice() };
  const accepted: AcceptedTaskRuntimeAuthorizationV3 = {
    descriptorBytes, descriptorDigest: hex(crypto.hash(descriptorBytes)),
    requestId: request.requestId, workId: request.workId, workKind: request.workKind, workPurpose: request.workPurpose,
    recipientGeneration: 1, recipientKeyId: request.recipientKeyId,
    recipientPublicKeyBase64url: Buffer.from(recipient.publicKey).toString("base64url"), expectedPolicyRevision: 7,
    namespaceRequirements: value.namespaceRequirements, domainRequirements: value.domainRequirements,
    authorizationId: request.requestId, authorizationBytes, authorizationDigest: hex(crypto.hash(authorizationBytes)),
    authorizationExpiresAt: request.deadlineAt, issuingHumanId: HUMAN, issuingDeviceId: DEVICE,
    issuingDeviceAuthorizationRevision: 4, issuerSigningPublicKeyHash: crypto.hash(signing.publicKey),
  };
  signing.privateKey.fill(0); recipient.privateKey.fill(0);
  value.events.length = 0;
  return { request, accepted, currentDevice, now,
    admission: { ...currentDevice, expiresAt: plan.deadlineAt },
    subject: { userId: USER, humanActorId: HUMAN, deviceId: DEVICE } };
}

describe("closed Task output combined authority", () => {
  test("keeps private result facts outside the independent actual-child foreground set", async () => {
    const value = outputFixture();
    const authority = await inspectTaskOutputNamespaceAuthority(value.output);
    expect(authority?.sourceRoomId).toBe(DELIVERY_CHILD);
    expect(authority?.sourceNamespaceId).toBe(NAMESPACES[0]);
    expect(authority?.resultFact.namespaceId).toBe(NAMESPACES[0]);
    expect(authority?.foregroundFacts.map(f => f.namespaceId)).toEqual([NAMESPACES[1]]);
    expect(authority?.facts.map(f => f.namespaceId)).toEqual([...NAMESPACES]);
    expect(value.events.indexOf("foreground-proof")).toBeLessThan(value.events.indexOf("restricted"));
    expect(value.events.filter(e => e === "closed-result")).toHaveLength(2);
    expect(value.events.filter(e => e === "foreground-proof")).toHaveLength(2);
    expect(value.events.lastIndexOf("namespace")).toBeLessThan(value.events.indexOf("domain"));
  });

  for (const [stage, field, replacement] of [
    ["delivery-members", "agent_id", PEER], ["delivery-room", "archived_at", new Date()],
    ["output-roster", "effective_human_actor_ids", [OTHER_HUMAN]],
    ["policy", "mode", "plaintext_only"], ["policy", "revision", 8],
    ["task", "content_namespace_id", NAMESPACES[1]],
  ] as const) {
    test(`rejects ${stage}.${field} before crypto`, async () => {
      const value = outputFixture(substitute(stage, field, replacement));
      expect(await inspectTaskOutputNamespaceAuthority(value.output)).toBeNull();
      expect(value.events).not.toContain("restricted");
    });
  }

  test("deduplicates a shared Domain without merging private and foreground Namespace permissions", async () => {
    const value = outputFixture((stage, rows) => {
      if (stage === "namespace" || stage === "namespace-locks") return rows.map(row => ({ ...row, domain_id: DOMAINS[0] }));
      if (stage === "domain-locks" || stage === "recipient") return rows.slice(0, 1);
      return rows;
    });
    const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
      .mockImplementation(async () => device());
    try {
      expect(await withTaskOutputRecipientAuthority({ ...value.output, deviceId: DEVICE,
        namespaceRequirements: value.namespaceRequirements.map(n => ({ ...n, domainId: DOMAINS[0] })),
        domainRequirements: value.domainRequirements.slice(0, 1),
        use: authority => {
          expect(authority.domains).toHaveLength(1);
          expect(authority.domains[0]?.activeNamespaceBindingCount).toBe(2);
          expect(authority.resultNamespaceRequirement.operations).toEqual(["decrypt"]);
          expect(authority.foregroundNamespaceRequirements[0]?.operations).toEqual(["encrypt"]);
          return true;
        },
      })).toBe(true);
    } finally { admission.mockRestore(); }
  });

  test("requires canonical foreground policy independently of the private membership floor", async () => {
    let policyCalls = 0;
    const value = outputFixture((stage, rows) => stage === "readable-policy" && ++policyCalls === 2 ? [] : rows);
    expect(await inspectTaskOutputNamespaceAuthority(value.output)).toBeNull();
    expect(policyCalls).toBe(2);
    expect(value.events).not.toContain("foreground-proof");
    expect(value.events).not.toContain("restricted");
  });

  test("requires closed product and Scope/invocation proof callbacks", async () => {
    for (const key of ["validateCurrentTaskRun", "validateCurrentForeground"] as const) {
      const value = outputFixture();
      const missing = { ...value.output, [key]: undefined } as unknown as TaskOutputNamespaceAuthorityInput;
      expect(await inspectTaskOutputNamespaceAuthority(missing).catch((error: unknown) => error))
        .toMatchObject({ message: "Task output authority coordinates are invalid" });
      expect(value.events).toEqual([]);
      expect(await inspectTaskOutputNamespaceAuthority({ ...value.output, [key]: async () => false })).toBeNull();
      expect(value.events).not.toContain("restricted");
    }
  });

  for (const wake of [false, true]) {
    test(`projects result decrypt-only and ${wake ? "wake foreground read/write" : "raw destination encrypt-only"}`, async () => {
      const value = outputFixture(undefined, wake);
      const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
        .mockImplementation(async () => device());
      try {
        const result = await withTaskOutputRecipientAuthority({ ...value.output, deviceId: DEVICE,
          namespaceRequirements: value.namespaceRequirements, domainRequirements: value.domainRequirements,
          use: authority => {
            expect(authority.resultNamespaceRequirement.operations).toEqual(["decrypt"]);
            expect(authority.foregroundNamespaceRequirements.map(n => [n.namespaceId, n.operations]))
              .toEqual([[NAMESPACES[1], wake ? ["decrypt", "encrypt"] : ["encrypt"]]]);
            expect(value.events.indexOf("device-lock")).toBeLessThan(value.events.indexOf("namespace-locks"));
            expect(value.events.indexOf("namespace-locks")).toBeLessThan(value.events.indexOf("domain-locks"));
            return "held";
          },
        });
        expect(result).toBe("held");
      } finally { admission.mockRestore(); }
    });
  }

  test("merges an independently readable private Namespace while retaining a decrypt-only result partition", async () => {
    const value = outputFixture(undefined, true);
    const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
      .mockImplementation(async () => device());
    try {
      expect(await withTaskOutputRecipientAuthority({ ...value.output, foregroundNamespaceIds: NAMESPACES,
        validateCurrentForeground: async (_product, _tx, facts) => {
          expect(facts.foregroundNamespaceIds).toEqual([...NAMESPACES]); return true;
        }, ...recipientInput(value.input),
        use: authority => {
          expect(authority.namespaceRequirements.every(n => n.operations.join() === "decrypt,encrypt")).toBe(true);
          expect(authority.resultNamespaceRequirement.operations).toEqual(["decrypt"]);
          expect(authority.foregroundNamespaceRequirements).toHaveLength(2);
          return true;
        },
      })).toBe(true);
    } finally { admission.mockRestore(); }
  });

  test("rejects overbroad result operations and a noncanonical wake identity before locks", async () => {
    const value = outputFixture();
    expect(() => withTaskOutputRecipientAuthority({ ...value.output, ...recipientInput(value.input), use: () => true }))
      .toThrow("partitions");
    expect(value.events).toEqual([]);
    const wake = outputFixture(undefined, true);
    expect(await inspectTaskOutputNamespaceAuthority({ ...wake.output, workId: RUN }).catch((error: unknown) => error))
      .toMatchObject({ message: "Task output authority coordinates are invalid" });
    expect(wake.events).toEqual([]);
  });

  test("product proof is authentic, callback-live and bound to the exact request/partition/transaction", async () => {
    const value = outputFixture();
    let proof: TaskOutputProductAuthority | undefined;
    await withTaskOutputProductAuthority({ ...value.output, use: async (current, _product, transaction) => {
      proof = current;
      const expected = { transaction, subject: { userId: USER, humanActorId: HUMAN },
        request: { ...value.output, workPurpose: value.output.workKind, sourceRoomId: DELIVERY_CHILD },
        namespaces: value.namespaceRequirements, policyRevision: 7 };
      expect(() => assertTaskOutputProductAuthority(current, expected)).not.toThrow();
      expect(() => assertTaskOutputProductAuthority({ ...current }, expected)).toThrow();
      expect(() => assertTaskOutputProductAuthority(current, { ...expected,
        request: { ...expected.request, workPurpose: "task.execute" } })).toThrow();
      expect(() => assertTaskOutputProductAuthority(current, { ...expected,
        namespaces: recipientInput(value.input).namespaceRequirements })).toThrow();
      expect(value.events).not.toContain("device-lock");
      expect(value.events).not.toContain("namespace");
      return true;
    } });
    expect(proof).toBeDefined();
    expect(await withCurrentTaskOutputRuntimeAuthority({ productAuthority: proof! } as
      Parameters<typeof withCurrentTaskOutputRuntimeAuthority>[0]).catch((error: unknown) => error))
      .toMatchObject({ message: "Task output product authority is not active" });
  });

  for (const phase of ["product", "foreground"] as const) {
    test(`rolls back when ${phase} proof changes inside a callback`, async () => {
      const value = outputFixture(); let used = false;
      expect(await withTaskOutputProductAuthority({ ...value.output,
        ...(phase === "product" ? { validateCurrentTaskRun: async () => !used }
          : { validateCurrentForeground: async () => !used }),
        use: async () => { used = true; return true; },
      }).catch((error: unknown) => error)).toMatchObject({ message: "Task output product authority changed before commit" });
      expect(used).toBe(true);
      expect(value.events.slice(-2)).toEqual(["restricted-released", "product-released"]);
    });
  }

  for (const wake of [false, true]) {
    test(`bound ${wake ? "wake" : "raw"} verifier uses the held proof without recursive product locks`, async () => {
      const value = outputFixture(undefined, wake); const signed = await signedOutput(value);
      const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
        .mockImplementation(async () => structuredClone(signed.currentDevice));
      let escaped: PostgresJsBridgeConnection | undefined;
      try {
        const result = await withTaskOutputProductAuthority({ ...value.output, use: async productAuthority =>
          withCurrentTaskOutputRuntimeAuthority({ productAuthority, crypto: value.input.crypto,
            serverScope: value.input.serverScope, ...signed, now: () => signed.now,
            namespaceRequirements: value.namespaceRequirements, domainRequirements: value.domainRequirements,
            use: async (authority, _product, restricted) => {
              escaped = restricted;
              expect(authority.namespaceRequirements).toEqual(value.namespaceRequirements); return "verified";
            },
          }),
        });
        expect(result).toBe("verified");
        expect(escaped).toBeDefined();
        expect(() => escaped!.query("SELECT current_user::text"))
          .toThrow("Parked Task Runtime authority is not active");
        expect(value.events.filter(e => e === "product-released")).toHaveLength(1);
        expect(value.events.filter(e => e === "restricted-released")).toHaveLength(1);
        expect(value.events.indexOf("foreground-proof")).toBeLessThan(value.events.indexOf("device-lock"));
        expect(value.events.indexOf("namespace-locks")).toBeLessThan(value.events.indexOf("domain-locks"));
        value.events.length = 0;
        expect(await withCurrentTaskRuntimeAuthority({ ...value.input, ...signed, now: () => signed.now,
          namespaceRequirements: value.namespaceRequirements, domainRequirements: value.domainRequirements,
          use: async () => "forbidden",
        })).toBeNull();
        expect(value.events).not.toContain("restricted");
      } finally { admission.mockRestore(); }
    });
  }

  for (const scenario of ["ready", "revoked", "expired", "expires_inside", "claim_lost", "domain_substitution"] as const) {
    test(`accepted claim holds exact combined current authority: ${scenario}`, async () => {
      let substituteDomain = false;
      const value = outputFixture((stage, rows) => substituteDomain && stage === "namespace"
        ? rows.map(row => ({ ...row, domain_id: DOMAINS[0] })) : rows);
      const signed = await signedOutput(value); substituteDomain = scenario === "domain_substitution";
      const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
        .mockImplementation(async () => scenario === "revoked" ? null : structuredClone(signed.currentDevice));
      let used = false; let checked = false;
      try {
        const result = await withTaskOutputProductAuthority({ ...value.output, use: productAuthority =>
          withCurrentAcceptedTaskOutputRuntimeClaimAuthority({ productAuthority, crypto: value.input.crypto,
            serverScope: value.input.serverScope, subject: signed.subject, accepted: signed.accepted,
            now: () => scenario === "expired" || scenario === "expires_inside" && used ? signed.request.deadlineAt : signed.now,
            validateCurrentProduct: async () => true,
            validateBeforeCommit: () => { checked = true; if (scenario === "claim_lost") throw new Error("claim lost"); },
            use: async (_authority, _product, restricted, transaction) => {
              expect(transaction as unknown).toBe(value.canonicalTransaction);
              await restricted.query("SELECT current_user::text"); used = true; return "claimed";
            },
          }),
        }).catch((error: unknown) => error instanceof Error ? error.message : error);
        expect(result).toBe(scenario === "ready" ? "claimed" : scenario === "claim_lost" ? "claim lost"
          : scenario === "expires_inside" ? "Accepted Task Runtime authority expired before commit" : null);
        expect(used).toBe(scenario === "ready" || scenario === "claim_lost" || scenario === "expires_inside");
        expect(checked).toBe(used);
      } finally { admission.mockRestore(); }
    });
  }
});

// Exercise the wake writer through the same genuine signed combined-owner fixture.
import { agentId, cryptoDomainId, domainEpoch, prepareAgentRuntimeInitialization, persistAgentRuntimeInitialization, agentRuntimeGeneration,
  type TaskRuntimeWakeForegroundEvidence } from "@nautilo/lattice-crypto";
import { parseDomainForegroundAuthorizationPlanV2 } from "@nautilo/lattice-crypto/wire";
import { withTaskRuntimeRunResultReadEvidenceV1 } from "../../../lattice-crypto/src/background/task-runtime-run-result-read-evidence-v1.ts";
import { withTaskRuntimeWakeForegroundEvidenceV1 } from "../../../lattice-crypto/src/background/task-runtime-wake-foreground-evidence-v1.ts";
import { createFakeLatticeStorage } from "../../src/testing/fake-lattice-storage.ts";
import { PostgresLatticeStorage } from "../../src/server/storage/postgres-lattice-storage.ts";
import { PostgresDomainKeyAuthorityRepository } from "../../src/server/delivery/postgres-domain-key-authority.ts";
import { withPostgresTaskWakeLiveShadowAuthority, type TaskWakeLiveShadowCurrentWriter } from "../../src/server/message/postgres-task-wake-live-shadow-authority.ts";
import { deriveLiveShadowMessageCryptoObjectIdV1 } from "../../src/message/conversation-repository.ts";

async function wakeWriterFixture(scenario = "ready") {
  let entered = false; let ready = false;
  const value = outputFixture((stage, rows) => {
    if (ready && scenario === "archived" && stage === "delivery-room") return rows.map(row => ({ ...row, archived_at: new Date() }));
    if (ready && scenario === "agent_removed" && stage === "delivery-members") return rows.filter(row => row["kind"] !== "agent");
    return rows;
  }, true);
  const signed = await signedOutput(value); ready = true;
  const crypto = value.input.crypto;
  const plan = parseDomainForegroundAuthorizationPlanV2(signed.request.authorizationPlanBytes)!;
  const manager = crypto.generateSigningKeyPair();
  const committer = crypto.generateSigningKeyPair();
  const managerAuthority = { managerHumanId: humanId(HUMAN), managerAuthorizationRevision: authorizationRevision(1), managerDeviceId: cryptoDeviceId(DEVICE) };
  const init = await prepareAgentRuntimeInitialization({ crypto, operationId: "wake-runtime-initialization",
    agentId: agentId(AGENT), authorizationRevision: authorizationRevision(3),
    configObjects: [{ objectId: "wake-config", configRevision: authorizationRevision(1), plaintextDek: digest(41) }],
    domains: [{ domainId: cryptoDomainId(DOMAINS[1]), domainEpoch: domainEpoch(2), agentAuthorizationRevision: authorizationRevision(3),
      committerDeviceId: cryptoDeviceId(DEVICE), domainRoot: digest(42), committerSigningPrivateKey: committer.privateKey }],
    resolveCurrentDomainCommitterAuthority: () => committer.publicKey,
    manager: managerAuthority, managerSigningPrivateKey: manager.privateKey, resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const { storage } = createFakeLatticeStorage();
  expect(await persistAgentRuntimeInitialization({ crypto, storage, prepared: init,
    resolveCurrentAuthorization: () => ({ currentState: { agentId: agentId(AGENT), authorizationRevision: authorizationRevision(3), runtimeGeneration: agentRuntimeGeneration(0) },
      currentManager: managerAuthority, currentManagerSigningPublicKey: manager.publicKey,
      domains: [{ domainId: cryptoDomainId(DOMAINS[1]), domainEpoch: domainEpoch(2), agentAuthorizationRevision: authorizationRevision(3),
        committerDeviceId: cryptoDeviceId(DEVICE), committerSigningPublicKey: committer.publicKey }] }),
  })).toBe("inserted");
  init.runtime.key.fill(0); manager.privateKey.fill(0); committer.privateKey.fill(0);
  const publication = (await storage.getAgentRuntimeSignerPublication(AGENT, init.runtime.generation))!;
  const operationId = `task-run-delivery-wake:${RUN}`;
  const jobId = protectedTaskRunWakeJobId(RUN);
  const reference = { kind: "protected_task_delivery_v1" as const, taskId: TASK, taskRunId: RUN,
    bindingId: `task-run-output:${RUN}`, resultObjectId: resultObjectId(), wakeOperationId: operationId };
  const parent = {
    job: { id: jobId, ownerId: USER, requestorId: USER, roomId: DELIVERY_CHILD, laneKey: `room:${DELIVERY_CHILD}`,
      type: "foreground", status: scenario === "queued" ? "queued" : "running", input: scenario === "reference" ? { ...reference, taskId: PEER } : reference,
      result: null, message: null, metadata: {}, createdAt: new Date(signed.now), startedAt: new Date(signed.now), completedAt: null },
    binding: { taskRunId: RUN, bindingId: reference.bindingId, resultObjectId: reference.resultObjectId,
      wakeOperationId: scenario === "parent" ? "different-parent" : operationId, wakeJobId: jobId,
      wakeScheduledAt: new Date(signed.now), completedAt: new Date(signed.now), resultAttachedAt: new Date(signed.now - 1), acceptedPolicyRevision: 7,
      destinationRoomId: DELIVERY_CHILD, destinationNamespaceId: NAMESPACES[1] },
    taskId: TASK, taskOwnerId: USER, taskRequestorId: USER, agentId: AGENT, representation: "protected",
    roomNamespaceId: NAMESPACES[1], roomArchivedAt: null,
    // The receiving Room's Session may belong to a different Human than the Task.
    roomOwnerId: PEER, sessionOwnerId: PEER, sessionAgentId: AGENT, sessionRoomId: DELIVERY_CHILD,
  };
  const objectId = deriveLiveShadowMessageCryptoObjectIdV1({ operationId, sessionId: JOB, messageId: 11, revision: 0, transcriptOrdinal: 2, authorRole: "assistant" });
  const lifecycle = {
    sequence: 1, session_id: JOB, message_id: 11, edit_revision: 0, room_id: DELIVERY_CHILD,
    namespace_id_at_allocation: NAMESPACES[1], crypto_object_id: objectId,
    object_id_scheme: "live_shadow_v1", representation_mode: "full_encryption", publication_policy_revision: 7,
    shadow_operation_id: null, human_peer_shadow_operation_id: null, shared_agent_shadow_operation_id: null,
    shared_agent_shadow_execution_id: null, task_wake_operation_id: operationId, shadow_transcript_ordinal: 2,
    shadow_reserved_created_at: new Date(signed.now), shadow_stream_id: null, shadow_stream_start_digest: null,
    shadow_stream_terminal_digest: null, shadow_streamed_text_digest: null, shadow_durable_event_digest: null,
    payload_version: 2, key_class: "ai", author_role: "assistant", subthread_reply_classification: "counted",
    completion: "pending", disposition: "active", parity_status: "pending", attempt_count: 0, next_attempt_at: new Date(signed.now),
    failure_code: null, lease_token: null, lease_expires_at: null, append_idempotency_key: "wake-append",
    allocation_request_digest: digest(12), repair_identity_digest: null, repair_publisher_kind: null,
    repair_publisher_id: null, repair_publisher_human_id: null, repair_source_revision: null, repair_source_digest: null,
    repair_attestation_digest: null, terminal_operation_id: null, terminal_operation_type: null, terminal_expected_revision: null,
    terminal_request_digest: null, terminal_operation_group_id: null, quarantine_lease_token: null,
    delete_was_unread: null, delete_orphaned_turn_id: null, delete_root_parent_room_id: null,
    delete_root_anchor_message_id: null, delete_root_reply_count: null, delete_root_last_reply_at: null, delete_root_summary_revision: null,
  };
  const canonical = value.canonicalTransaction;
  const originalSelect = canonical.select;
  canonical.execute = () => Promise.resolve([{ current_user: "nautilo", session_user: "nautilo" }]) as ReturnType<typeof canonical.execute>;
  canonical.select = ((projection?: Record<string, unknown>) => {
    if (projection !== undefined && !('job' in projection) && !('sequence' in projection)) return originalSelect(projection);
    const rows = projection === undefined ? [{ taskWakeOperationId: operationId, sessionId: JOB, roomId: DELIVERY_CHILD,
      namespaceIdAtAllocation: NAMESPACES[1], objectIdScheme: "live_shadow_v1", representationMode: "full_encryption", publicationPolicyRevision: 7, shadowOperationId: null, humanPeerShadowOperationId: null,
      sharedAgentShadowOperationId: null, sharedAgentShadowExecutionId: null, editRevision: 0, shadowTranscriptOrdinal: 2,
      authorRole: "assistant", cryptoObjectId: objectId, messageId: 11 }]
      : 'job' in projection ? [parent] : [lifecycle];
    const query: Record<string, unknown> = {};
    for (const method of ['from', 'innerJoin', 'where', 'limit', 'for']) query[method] = () => query;
    query['then'] = (resolve: (rows: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return query;
  }) as typeof canonical.select;
  const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
    .mockImplementation(async () => scenario === "revoked" ? null : structuredClone(signed.currentDevice));
  const atomic = spyOn(PostgresLatticeStorage.prototype, "getAgentRuntimeAtomicState").mockImplementation(storage.getAgentRuntimeAtomicState.bind(storage));
  const signerPublication = spyOn(PostgresLatticeStorage.prototype, "getAgentRuntimeSignerPublication").mockImplementation(storage.getAgentRuntimeSignerPublication.bind(storage));
  const namespace = spyOn(PostgresDomainKeyAuthorityRepository.prototype, "inspectForegroundNamespaceAuthority")
    .mockImplementation(async ({ namespaceId }) => ({ status: "ready", namespaceId, namespaceAccessRevision: namespaceId === NAMESPACES[0] ? 9 : 10,
      namespaceKeyGeneration: 1, namespaceHeadDigest: digest(13), namespacePublicationDigest: digest(14), namespacePublicationSetDigest: digest(15),
      namespaceAudienceFingerprint: digest(16), domainId: namespaceId === NAMESPACES[0] ? DOMAINS[0] : DOMAINS[1], domainKeyGeneration: 2,
      domainAuthorizationRevision: 3, domainHeadDigest: digest(4), bundleRevision: 1, bundleDigest: digest(17) }));
  const run = <T>(use: (current: TaskWakeLiveShadowCurrentWriter, evidence: TaskRuntimeWakeForegroundEvidence) => Promise<T>,
    signerChange: Partial<Readonly<{ agentAuthorizationRevision: number; runtimeGeneration: number;
      signerKeyId: string; signerPublicKey: Uint8Array; signerAuthorizationHash: Uint8Array }>> = {}) =>
    withTaskRuntimeRunResultReadEvidenceV1({ now: () => signed.now, signal: new AbortController().signal,
      evidence: { purpose: "task.runtime.run_result_read", workKind: "task.delivery_wake", requestId: signed.request.requestId,
        workId: jobId, claimId: "wake-claim", claimExpiresAt: signed.now + 60_000, recipientExpiresAt: signed.now + 60_000,
        authorizationExpiresAt: signed.now + 60_000, expiresAt: signed.now + 60_000, recipientGeneration: 1,
        recipientKeyId: signed.request.recipientKeyId, authorizationDigest: crypto.hash(signed.accepted.authorizationBytes),
        requesterHumanId: HUMAN, policyRevision: 7, episodeId: JOB, sourceRoomId: DELIVERY_CHILD,
        hostAuthorizationRevision: 4, recipientAuthorizationRevision: 0, operations: ["decrypt"],
        result: { taskId: TASK, taskRunId: RUN, terminalStatus: "completed", contentRevision: 1, objectId: resultObjectId(),
          cryptoAccessRevision: 0, genesisManifestHash: digest(19), signerAgentId: AGENT,
          namespace: { namespaceId: NAMESPACES[0], domainId: DOMAINS[0], operations: ["decrypt"], expectedAccessRevision: 9, expectedPolicyRevision: 7 } },
        invocation: { kind: "wake", bindingId: reference.bindingId, operationId, roomId: DELIVERY_CHILD, sessionId: JOB, jobId, reference },
        resultDomain: plan.domains[0]!, messageWrite: null },
      execute: readEvidence => withTaskRuntimeWakeForegroundEvidenceV1({ readEvidence,
        committerDeviceId: DEVICE, committerDeviceSigningGeneration: 2, committerDeviceSigningPublicKeyHash: crypto.hash(signed.currentDevice.signingPublicKey),
        namespaceRequirements: [value.namespaceRequirements[1]!], domainRequirements: [plan.domains[1]!],
        execute: evidence => withTaskOutputProductAuthority({ ...value.output, use: productAuthority =>
          withPostgresTaskWakeLiveShadowAuthority({ productAuthority, crypto, serverScope: value.input.serverScope,
            subject: signed.subject, accepted: signed.accepted, now: () => signed.now,
            validateCurrentProduct: async () => true, validateBeforeCommit: () => {},
            evidence: scenario === "forged" ? { ...evidence } : evidence,
            signer: { agentAuthorizationRevision: 3, runtimeGeneration: publication.runtimeGeneration,
              signerKeyId: publication.signerKeyId, signerPublicKey: publication.signerPublicKey,
              ...signerChange },
            resolveHistoricalSignerPublicationManager: () => manager.publicKey,
            use: current => { entered = true; return use(current, evidence); },
          }),
        }),
      }),
    });
  return { ...value, signed, publication, operationId, objectId, lifecycle, parent, run, atomic,
    entered: () => entered,
    cleanup: () => { admission.mockRestore(); atomic.mockRestore(); signerPublication.mockRestore(); namespace.mockRestore(); } };
}

describe("held Task wake live transcript authority", () => {
  for (const scenario of ["ready", "archived", "agent_removed", "revoked", "queued", "reference", "parent", "forged"] as const) {
    test(`genuine running wake current authority: ${scenario}`, async () => {
      const f = await wakeWriterFixture(scenario);
      let escaped: TaskWakeLiveShadowCurrentWriter | undefined;
      try {
        const result = await f.run(async current => {
          escaped = current;
          expect(await current.productStore.reserveLiveShadowAgent({ sessionId: JOB, operationId: f.operationId, transcriptOrdinal: 2,
            authorRole: "assistant", createdAt: f.signed.now, requestDigest: digest(12), subthreadReplyClassification: "counted",
            publicationPolicy: { representation: "protected_only", expectedRevision: 7 } })).toMatchObject({ status: "replayed" });
          expect(current.productStore.reserveLiveShadowAgent({ sessionId: JOB, operationId: "wrong-parent", transcriptOrdinal: 2,
            authorRole: "assistant", createdAt: f.signed.now, requestDigest: digest(12), subthreadReplyClassification: "counted",
            publicationPolicy: { representation: "protected_only", expectedRevision: 7 } })).rejects.toThrow("does not match");
          return "published";
        }).catch((error: unknown) => error instanceof Error ? error.message : error);
        expect(result).toBe(scenario === "ready" ? "published" : scenario === "forged" ? "Task wake foreground evidence is not active" : null);
        expect(f.entered()).toBe(scenario === "ready");
        if (escaped !== undefined) {
          expect(escaped.productStore.reserveLiveShadowAgent({ sessionId: JOB, operationId: f.operationId, transcriptOrdinal: 2,
            authorRole: "assistant", createdAt: f.signed.now, requestDigest: digest(12), subthreadReplyClassification: "counted",
            publicationPolicy: { representation: "protected_only", expectedRevision: 7 } })).rejects.toThrow("not active");
        }
      } finally { f.cleanup(); }
    });
  }
});

test("legacy wake refuses an arbitrary certified signer hash before Runtime lookup", async () => {
  const f = await wakeWriterFixture();
  try {
    f.atomic.mockClear();
    const result = await f.run(async () => "must-not-enter", {
      signerAuthorizationHash: digest(30),
    });
    expect(result).toBeNull();
    expect(f.entered()).toBe(false);
    expect(f.atomic).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});

test("wake writer resolves only the current selected Room Message and independent foreground entity partitions", async () => {
  const f = await wakeWriterFixture();
  let escaped: TaskWakeLiveShadowCurrentWriter | undefined;
  try {
    await f.run(async (current, evidence) => {
      escaped = current;
      const context = { objectId: f.objectId, operationId: f.operationId, recipientKeyId: evidence.recipientKeyId,
        grantId: evidence.requestId, grantHash: evidence.authorizationDigest,
        namespaceId: NAMESPACES[1], namespaceAccessRevision: 10, namespaceHeadDigest: digest(13),
        namespacePublicationDigest: digest(14), namespacePublicationSetDigest: digest(15), namespaceAudienceFingerprint: digest(16),
        envelope: { namespaceId: NAMESPACES[1], keyClass: "ai", keyGeneration: 1, bindingRevisionAtWrap: 10 },
        agentId: AGENT, agentAuthorizationRevision: 3, runtimeGeneration: f.publication.runtimeGeneration, signerKeyId: f.publication.signerKeyId,
      } as unknown as Parameters<typeof current.resolveCurrentAgentObjectWrite>[0];
      expect(await current.resolveCurrentAgentObjectWrite(context)).toMatchObject({ namespaceAuthorized: true, agentAuthorized: true });
      for (const substitute of [{ operationId: "wrong" }, { namespaceId: NAMESPACES[0] }, { agentId: PEER }, { runtimeGeneration: 88 },
        { grantId: "wrong-grant" }, { grantHash: digest(29) },
        { signerAuthorizationHash: digest(30) }]) {
        expect(await current.resolveCurrentAgentObjectWrite({ ...context, ...substitute })).toBeNull();
      }
      const entity = { operationId: f.operationId, grantId: evidence.requestId, grantHash: evidence.authorizationDigest,
        recipientKeyId: evidence.recipientKeyId, agentId: AGENT, agentAuthorizationRevision: 3,
        runtimeGeneration: f.publication.runtimeGeneration, signerKeyId: f.publication.signerKeyId,
        namespaces: [{ namespaceId: NAMESPACES[1], accessRevision: 10, keyGeneration: 1,
          domainId: DOMAINS[1], domainKeyGeneration: 2, domainAuthorizationRevision: 3, domainHeadDigest: digest(4),
          headDigest: digest(13), publicationDigest: digest(14), publicationSetDigest: digest(15), audienceFingerprint: digest(16) }],
        envelopes: [{ namespaceId: NAMESPACES[1], keyClass: "ai", keyGeneration: 1, bindingRevisionAtWrap: 10 }],
      } as unknown as Parameters<typeof current.resolveCurrentForegroundEntityObjectWrite>[0];
      expect(await current.resolveCurrentForegroundEntityObjectWrite(entity)).toMatchObject({ namespacesAuthorized: true });
      expect(await current.resolveCurrentForegroundEntityObjectWrite({ ...entity,
        namespaces: [{ ...entity.namespaces[0]!, namespaceId: NAMESPACES[0] }] })).toBeNull();
      expect(await current.resolveCurrentForegroundEntityObjectWrite({ ...entity, grantHash: digest(29) })).toBeNull();
      expect(await current.resolveCurrentForegroundEntityObjectWrite({ ...entity,
        signerAuthorizationHash: digest(30) })).toBeNull();
      return true;
    });
    expect(escaped).toBeDefined();
    expect(escaped!.resolveCurrentAgentObjectWrite({} as Parameters<NonNullable<typeof escaped>["resolveCurrentAgentObjectWrite"]>[0]))
      .rejects.toThrow("not active");
  } finally { f.cleanup(); }
});

test("wake evidence replay does not complete the running Job or manufacture a Human turn", async () => {
  const f = await wakeWriterFixture();
  Object.assign(f.lifecycle, { completion: "complete", disposition: "mapped", parity_status: "server_authenticated", next_attempt_at: null, shadow_durable_event_digest: digest(22) });
  try {
    await f.run(async current => {
      expect(await current.productStore.recordLiveShadowAgentEvidence({ sessionId: JOB, operationId: f.operationId, messageId: 11,
        transcriptOrdinal: 2, durableEventDigest: digest(22), streamEvidence: null, finalTurnMessage: true, now: f.signed.now,
        publicationPolicy: { expectedRevision: 7, representation: "protected_only" } })).toBe("duplicate");
      expect(f.parent.job.status).toBe("running");
      return true;
    });
  } finally { f.cleanup(); }
});

test("wake Full publication rejects plaintext before product allocation", async () => {
  const f = await wakeWriterFixture();
  try {
    await f.run(async current => {
      expect(current.productStore.publishReservedLiveShadowAgent({ sessionId: JOB, operationId: f.operationId,
        transcriptOrdinal: 2, reservedMessageId: 11, reservedCreatedAt: f.signed.now, cryptoObjectId: f.objectId,
        reservationDigest: digest(12), idempotencyKey: "wake-append", content: "private plaintext",
        publicationPolicy: { expectedRevision: 7, representation: "protected_only" }, keyClass: "ai", authorRole: "assistant",
        toolCalls: null, toolName: null, fingerprint: null, humanTurnId: null, transcriptOrigin: "main", parentThreadId: null,
        scopeId: null, metadata: null, subthreadRoomId: null, replyToMessageId: null,
        notificationContext: { mentionedHumanUserIds: [], causalHumanUserId: USER, causalHumanTurnId: null },
        structuralProjection: { notificationEligibility: "eligible", subthreadReplyClassification: "counted" },
      })).rejects.toThrow("Protected-only publication contains an ordinary body");
      return true;
    });
  } finally { f.cleanup(); }
});

test("wake parent changed inside mutation rejects the entire scoped callback", async () => {
  const f = await wakeWriterFixture();
  try {
    expect(f.run(async () => { f.parent.job.status = "completed"; return true; }))
      .rejects.toThrow("parent changed before commit");
  } finally { f.cleanup(); }
});


describe("wake additional mutation partition", () => {
  function mutationFixture() {
    const readableSets: string[][] = [];
    const value = outputFixture((stage, rows) => {
      if (stage === "readable-policy") readableSets.push(rows.map(row => String(row["namespace_id"])));
      return rows;
    }, true);
    let validations = 0;
    const output: TaskOutputNamespaceAuthorityInput = { ...value.output,
      destinationRoomId: ROOMS[0], destinationNamespaceId: NAMESPACES[0], foregroundNamespaceIds: [NAMESPACES[0]],
      additionalMutationDestination: { roomId: ROOMS[1], namespaceId: NAMESPACES[1], semanticDigest: "a".repeat(64) },
      validateCurrentForeground: async (_product, _tx, current) => {
        expect(current.foregroundNamespaceIds).toEqual([NAMESPACES[0]]); return true;
      },
      validateCurrentAdditionalMutationDestination: async (_product, tx, current) => {
        expect(Object.is(tx, value.canonicalTransaction)).toBe(true);
        expect(current.namespaceId).toBe(NAMESPACES[1]); validations++; return true;
      },
    };
    return { ...value, output, readableSets, validations: () => validations };
  }
  test("holds the extra Room but never treats its Namespace as ordinary readable authority", async () => {
    const value = mutationFixture();
    const authority = await inspectTaskOutputNamespaceAuthority(value.output);
    expect(authority?.foregroundFacts.map(f => f.namespaceId)).toEqual([NAMESPACES[0]]);
    expect(authority?.additionalMutationFact?.namespace.namespaceId).toBe(NAMESPACES[1]);
    expect(authority?.additionalMutationFact?.destination.semanticDigest).toBe("a".repeat(64));
    expect(value.readableSets).toEqual([[NAMESPACES[0]], [NAMESPACES[0]]]);
    expect(value.validations()).toBe(2);
    const namespaces = value.namespaceRequirements.map((n, index) => ({ ...n,
      operations: index === 0 ? ["decrypt", "encrypt"] as const : ["encrypt"] as const }));
    const admission = spyOn(PostgresDeviceAdmissionRepository.prototype, "currentAuthorityForDelegation")
      .mockImplementation(async () => device());
    try {
      expect(await withTaskOutputRecipientAuthority({ ...value.output, deviceId: DEVICE,
        namespaceRequirements: namespaces, domainRequirements: value.domainRequirements,
        use: current => {
          expect(current.foregroundNamespaceRequirements.map(n => n.namespaceId)).toEqual([NAMESPACES[0]]);
          return "ready";
        },
      })).toBe("ready");
      expect(() => withTaskOutputRecipientAuthority({ ...value.output, deviceId: DEVICE,
        namespaceRequirements: namespaces.map(n => ({ ...n, operations: ["decrypt", "encrypt"] as const })),
        domainRequirements: value.domainRequirements, use: () => "forbidden",
      })).toThrow();
    } finally { admission.mockRestore(); }
  });
  test("requires sealed destination proof and rejects its revocation before commit", async () => {
    const value = mutationFixture();
    expect(await inspectTaskOutputNamespaceAuthority({ ...value.output,
      validateCurrentAdditionalMutationDestination: async () => false })).toBeNull();
    let calls = 0;
    await Promise.resolve(expect(inspectTaskOutputNamespaceAuthority({ ...value.output,
      validateCurrentAdditionalMutationDestination: async () => ++calls === 1 })).rejects.toThrow("before commit"));
    for (const changed of [{ namespaceId: NAMESPACES[0] }, { semanticDigest: "invalid" }]) {
      await Promise.resolve(expect(inspectTaskOutputNamespaceAuthority({ ...value.output,
        additionalMutationDestination: { ...value.output.additionalMutationDestination!, ...changed } })).rejects.toThrow());
    }
  });
});

test("wake destination planning locks independent Room metadata without granting its Namespace", async () => {
  const readable: string[][] = [];
  const f = outputFixture((stage, rows) => {
    if (stage === "readable-policy") readable.push(rows.map(row => String(row["namespace_id"])));
    return rows;
  }, true);
  let validated = 0;
  const output: TaskOutputNamespaceAuthorityInput = { ...f.output,
    destinationRoomId: ROOMS[0], destinationNamespaceId: NAMESPACES[0], foregroundNamespaceIds: [NAMESPACES[0]],
    projectionPlanningOnly: true, projectionDestination: { roomId: ROOMS[1], namespaceId: NAMESPACES[1] },
    validateCurrentForeground: async (_p, _tx, current) => {
      expect(current.foregroundNamespaceIds).toEqual([NAMESPACES[0]]); return true;
    },
    validateCurrentProjectionDestination: async (_p, tx) => { expect(Object.is(tx, f.canonicalTransaction)).toBe(true); validated++; return true; },
  };
  expect(await withTaskOutputProductAuthority({ ...output, use: async (proof, _product, transaction) => {
    const expected = { transaction, subject: { userId: USER, humanActorId: HUMAN },
      request: { ...output, workPurpose: output.workKind, sourceRoomId: ROOMS[0] },
      namespaces: f.namespaceRequirements.filter(n => n.namespaceId === NAMESPACES[0])
        .map(n => ({ ...n, operations: ["decrypt", "encrypt"] as const })), policyRevision: 7 };
    expect(() => assertTaskOutputProductAuthority(proof, expected)).not.toThrow();
    expect(() => assertTaskOutputProductAuthority(proof, { ...expected, namespaces: f.namespaceRequirements })).toThrow();
    expect(f.events).not.toContain("device-lock"); expect(f.events).not.toContain("namespace");
    return "planned";
  } })).toBe("planned");
  expect(validated).toBe(2);
  expect(readable).toEqual([[NAMESPACES[0]], [NAMESPACES[0]]]);
  expect(await withTaskOutputProductAuthority({ ...output,
    validateCurrentProjectionDestination: async () => false, use: async () => "forbidden" })).toBeNull();
});
