import { expect, test } from "bun:test";

import {
  protectedTaskRunCancelledResultObjectId,
  protectedTaskRunCancelledResultOperationId,
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {
  withUnstagedTaskTerminalMessagePublication,
  type CryptoPostgresExecutor,
  type UnstagedTaskTerminalMessageAuthority,
} from "@nautilo/lattice-bridge/server";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import {
  readProtectedTaskTerminalMessageIntent,
  refreshUnstagedProtectedTaskTerminalMessagePolicy,
  type ProtectedTaskTerminalMessageIntent,
} from "../../src/routes/protected-task-terminal-message-product";

const TASK = "10000000-0000-4000-8000-000000000901";
const RUN = "20000000-0000-4000-8000-000000000902";
const USER = "30000000-0000-4000-8000-000000000903";
const OWNER = "40000000-0000-4000-8000-000000000904";
const AGENT = "50000000-0000-4000-8000-000000000905";
const ROOM = "60000000-0000-4000-8000-000000000906";
const SESSION = "70000000-0000-4000-8000-000000000907";
const CONTENT_NAMESPACE = "80000000-0000-4000-8000-000000000908";
const DESTINATION_NAMESPACE = "90000000-0000-4000-8000-000000000909";
const MESSAGE_ID = 71;
const EXPECTED_POLICY = 8;
const NEXT_POLICY = 9;
const CREATED_AT = 1_802_000_000_000;
const TERMINAL_AT = new Date(CREATED_AT - 3_000);
const ATTACHED_AT = new Date(CREATED_AT - 2_000);
const REQUEST_ID = `task-run-delivery-message-authorization:${RUN}`;
const OBJECT_ID = `message:v2:${"a".repeat(64)}`;
const OTHER_OBJECT_ID = `message:v2:${"b".repeat(64)}`;
const ALLOCATION_DIGEST = new Uint8Array(32).fill(0x31);

const intent: ProtectedTaskTerminalMessageIntent = Object.freeze({
  taskId: TASK,
  taskRunId: RUN,
  requesterUserId: USER,
  agentId: AGENT,
  contentNamespaceId: CONTENT_NAMESPACE,
  representation: "protected",
  bindingId: protectedTaskRunOutputBindingId(RUN),
  resultObjectId: protectedTaskRunCancelledResultObjectId(TASK, RUN),
  resultRevision: 2,
  acceptedPolicyRevision: 7,
  terminalAt: TERMINAL_AT,
  attachedAt: ATTACHED_AT,
  destinationRoomId: ROOM,
  destinationNamespaceId: DESTINATION_NAMESPACE,
  messageOperationId: protectedTaskRunMessageOperationId(RUN),
});

function taskRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: TASK,
    ownerId: USER,
    requesterUserId: USER,
    agentId: AGENT,
    contentNamespaceId: CONTENT_NAMESPACE,
    representation: "protected",
    status: "cancelled",
    cancelledAt: TERMINAL_AT,
    callingRoomId: ROOM,
    resultDelivery: "raw",
    ...overrides,
  };
}

function runRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: RUN,
    status: "cancelled",
    completedAt: TERMINAL_AT,
    revision: 2,
    objectId: protectedTaskRunCancelledResultObjectId(TASK, RUN),
    namespaceId: CONTENT_NAMESPACE,
    representation: "protected",
    mapping: "verified",
    siblingIsExact: true,
    ...overrides,
  };
}

function bindingRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    bindingId: protectedTaskRunOutputBindingId(RUN),
    taskRunId: RUN,
    resultRevision: 2,
    resultObjectId: protectedTaskRunCancelledResultObjectId(TASK, RUN),
    resultOperationId: protectedTaskRunCancelledResultOperationId(RUN),
    resultTerminalAt: TERMINAL_AT,
    resultAttachedAt: ATTACHED_AT,
    completedAt: null,
    deliveryMode: "raw",
    destinationRoomId: ROOM,
    destinationNamespaceId: DESTINATION_NAMESPACE,
    messageOperationId: protectedTaskRunMessageOperationId(RUN),
    acceptedPolicyRevision: 7,
    ...overrides,
  };
}

type ProductState = {
  message: Record<string, unknown>;
  revision: Record<string, unknown> & {
    publicationPolicyRevision: number;
    updatedAt: Date;
  };
};

function productState(): ProductState {
  return {
    message: {
      id: MESSAGE_ID,
      sessionId: SESSION,
      editRevision: 0,
      role: "assistant",
      createdAt: new Date(CREATED_AT),
      cryptoObjectId: null,
      content: null,
      toolCalls: null,
      toolName: null,
    },
    revision: {
      sessionId: SESSION,
      messageId: MESSAGE_ID,
      editRevision: 0,
      cryptoObjectId: OBJECT_ID,
      objectIdScheme: "message_v2",
      payloadVersion: 2,
      roomId: ROOM,
      namespaceIdAtAllocation: DESTINATION_NAMESPACE,
      appendIdempotencyKey: protectedTaskRunMessageOperationId(RUN),
      authorRole: "assistant",
      keyClass: "ai",
      representationMode: "full_encryption",
      publicationPolicyRevision: EXPECTED_POLICY,
      completion: "pending",
      disposition: "active",
      cryptoCompletedAt: null,
      leaseToken: null,
      repairIdentityDigest: null,
      shadowOperationId: null,
      humanPeerShadowOperationId: null,
      sharedAgentShadowOperationId: null,
      sharedAgentShadowExecutionId: null,
      allocationRequestDigest: ALLOCATION_DIGEST.slice(),
      updatedAt: new Date(CREATED_AT),
    },
  };
}

type Selection = Readonly<{ name: string; rows: readonly unknown[] }>;

function productTransaction(
  state: ProductState,
  options: Readonly<{
    task?: Record<string, unknown>;
    run?: Record<string, unknown>;
    binding?: Record<string, unknown> | null;
    policyMode?: string;
    policyRevision?: number;
  }> = {},
) {
  const events: string[] = [];
  const projections: (readonly string[] | null)[] = [];
  const updates: Record<string, unknown>[] = [];
  const graphThreadId = `room:${ROOM}:bot:${AGENT}`;
  const selections: Selection[] = [
    { name: "task", rows: [options.task ?? taskRow()] },
    { name: "run", rows: [options.run ?? runRow()] },
    { name: "binding", rows: options.binding === null
      ? [] : [options.binding ?? bindingRow()] },
    { name: "policy", rows: [{ mode: options.policyMode ?? "encrypted_only",
      shadowBehavior: "strict", revision: options.policyRevision ?? NEXT_POLICY }] },
    { name: "room", rows: [{ id: ROOM, ownerId: OWNER,
      namespaceId: DESTINATION_NAMESPACE, graphThreadId: "room-thread",
      archivedAt: null }] },
    { name: "members", rows: [
      { actorKind: "user", actorAgentId: null, actorOwnerId: USER },
      { actorKind: "user", actorAgentId: null, actorOwnerId: OWNER },
      { actorKind: "agent", actorAgentId: AGENT, actorOwnerId: OWNER },
    ] },
    { name: "session", rows: [{ id: SESSION, ownerId: OWNER,
      agentId: AGENT, roomId: ROOM, threadId: graphThreadId,
      endedAt: new Date(CREATED_AT), personaId: "owner" }] },
    { name: "message", rows: [state.message] },
    { name: "lifecycle", rows: [state.revision] },
  ];
  let selection = 0;
  const tx = {
    execute: async () => { events.push("policy_lock"); return []; },
    select(projection?: Record<string, unknown>) {
      projections.push(projection === undefined ? null : Object.keys(projection));
      const current = selections[selection++];
      if (current === undefined) throw new Error("Unexpected product select");
      const resolve = () => {
        events.push(`${current.name}_read`);
        return Promise.resolve(current.rows);
      };
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: () => chain,
        for: () => resolve(),
        then: (
          fulfilled: (rows: readonly unknown[]) => unknown,
          rejected?: (reason: unknown) => unknown,
        ) => resolve().then(fulfilled, rejected),
      };
      return chain;
    },
    insert() {
      throw new Error("Unexpected Session insert");
    },
    update() {
      const chain = {
        set(values: Record<string, unknown>) {
          events.push("lifecycle_update");
          updates.push(values);
          state.revision.publicationPolicyRevision =
            values["publicationPolicyRevision"] as number;
          state.revision.updatedAt = new Date(CREATED_AT + 1);
          return chain;
        },
        where: () => chain,
        returning: () => Promise.resolve([{ id: MESSAGE_ID }]),
      };
      return chain;
    },
  } as unknown as CanonicalTranscriptTx;
  return { tx, events, projections, updates };
}

class CryptoConnection {
  role = "nautilo_crypto";
  sessionRole = "nautilo_crypto";

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
  ): Promise<readonly Row[]> {
    if (!statement.includes("current_user::text")) {
      throw new Error("Unscoped crypto query");
    }
    return Promise.resolve([{
      current_user: this.role,
      session_user: this.sessionRole,
    }] as unknown as Row[]);
  }

  transaction<Value>(
    use: (executor: CryptoPostgresExecutor) => Promise<Value>,
  ): Promise<Value> {
    const executor = {
      query: (
        statement: string,
        parameters: readonly unknown[] = [],
      ): Promise<readonly Record<string, unknown>[]> => {
        const sql = statement.replaceAll('"', "").toLowerCase();
        const rows = (value: Record<string, unknown>[]) =>
          Promise.resolve(value);
        if (sql.includes("from background_crypto_authorization_requests")) {
          expect(sql).toContain("for update");
          return rows(parameters.length === 1 ? [{ request_id: parameters[0] }] : []);
        }
        if (sql.includes("pg_advisory_xact_lock")) return rows([]);
        if (sql.includes("from task_terminal_message_crypto_staging_receipts")
          || sql.includes("from crypto_objects")) return rows([]);
        throw new Error(`Unexpected crypto query: ${sql}`);
      },
    } as unknown as CryptoPostgresExecutor;
    return use(executor);
  }
}

async function rejection(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected rejection");
}

async function withAuthority<Value>(
  objectId: string,
  use: (authority: UnstagedTaskTerminalMessageAuthority) => Promise<Value>,
): Promise<Value> {
  const result = await withUnstagedTaskTerminalMessagePublication({
    requestId: REQUEST_ID,
    objectId,
    restricted: new CryptoConnection() as unknown as PostgresJsBridgeConnection,
    use: async (_handle, authority) => use(authority),
  });
  if (result.status !== "unstaged") throw new Error("Expected unstaged proof");
  return result.value;
}

function refreshInput(
  transaction: CanonicalTranscriptTx,
  unstagedAuthority: UnstagedTaskTerminalMessageAuthority,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    transaction,
    intent,
    sessionId: SESSION,
    messageId: MESSAGE_ID,
    objectId: OBJECT_ID,
    createdAt: CREATED_AT,
    allocationRequestDigest: ALLOCATION_DIGEST.slice(),
    expectedPolicyRevision: EXPECTED_POLICY,
    nextPolicyRevision: NEXT_POLICY,
    unstagedAuthority,
    ...overrides,
  };
}

test("refreshes only policy metadata while preserving the allocated Message", async () => {
  const state = productState();
  const beforeMessage = structuredClone(state.message);
  const beforeRevision = structuredClone(state.revision);
  const first = productTransaction(state);
  expect(await withAuthority(OBJECT_ID, authority =>
    refreshUnstagedProtectedTaskTerminalMessagePolicy(
      refreshInput(first.tx, authority),
    ))).toBe("refreshed");
  expect(first.events).toEqual([
    "task_read", "run_read", "binding_read", "policy_lock", "policy_read",
    "room_read", "members_read", "session_read", "message_read",
    "lifecycle_read", "lifecycle_update",
  ]);
  expect(first.events.indexOf("message_read"))
    .toBeLessThan(first.events.indexOf("lifecycle_read"));
  expect(first.updates).toHaveLength(1);
  expect(Object.keys(first.updates[0]!).sort())
    .toEqual(["publicationPolicyRevision", "updatedAt"]);
  expect(state.message).toEqual(beforeMessage);
  const { publicationPolicyRevision: _oldPolicy, updatedAt: _oldUpdatedAt,
    ...beforeImmutable } = beforeRevision;
  const { publicationPolicyRevision, updatedAt: _newUpdatedAt,
    ...afterImmutable } = state.revision;
  expect(publicationPolicyRevision).toBe(NEXT_POLICY);
  expect(afterImmutable).toEqual(beforeImmutable);

  const replay = productTransaction(state);
  expect(await withAuthority(OBJECT_ID, authority =>
    refreshUnstagedProtectedTaskTerminalMessagePolicy(
      refreshInput(replay.tx, authority),
    ))).toBe("exact_replay");
  expect(replay.updates).toEqual([]);
});

test.each([
  { name: "backwards policy", input: { nextPolicyRevision: EXPECTED_POLICY - 1 } },
  { name: "dual representation", input: { intent: { ...intent, representation: "dual" } } },
  { name: "wrong current mode", tx: { policyMode: "shadow_encryption" } },
  { name: "wrong current policy", tx: { policyRevision: NEXT_POLICY + 1 } },
  { name: "Message content", state: { message: { content: "plaintext" } } },
  { name: "completed lifecycle", state: { revision: { completion: "complete" } } },
  { name: "mapped crypto", state: { revision: { cryptoCompletedAt: new Date(CREATED_AT) } } },
  { name: "leased lifecycle", state: { revision: { leaseToken: "lease" } } },
  { name: "repair-owned lifecycle", state: { revision: {
    repairIdentityDigest: new Uint8Array(32).fill(0x41) } } },
  { name: "Shadow lifecycle", state: { revision: {
    shadowOperationId: "shadow-operation" } } },
  { name: "changed allocation digest", state: { revision: {
    allocationRequestDigest: new Uint8Array(32).fill(0x32) } } },
])("rejects $name", async variant => {
  const state = productState();
  Object.assign(state.message, variant.state?.message);
  Object.assign(state.revision, variant.state?.revision);
  const value = productTransaction(state, variant.tx);
  expect(await withAuthority(OBJECT_ID, authority =>
    refreshUnstagedProtectedTaskTerminalMessagePolicy(refreshInput(
      value.tx,
      authority,
      variant.input,
    )))).toBe("conflict");
  expect(value.updates).toEqual([]);
});

test("denies wrong-coordinate and expired unstaged authority", async () => {
  const wrongState = productState();
  const wrong = productTransaction(wrongState);
  expect(await rejection(() => withAuthority(OTHER_OBJECT_ID, authority =>
    refreshUnstagedProtectedTaskTerminalMessagePolicy(
      refreshInput(wrong.tx, authority),
    )))).toBeInstanceOf(TypeError);
  expect(wrong.events).toEqual([]);

  let escaped: UnstagedTaskTerminalMessageAuthority | undefined;
  await withAuthority(OBJECT_ID, async authority => {
    escaped = authority;
  });
  const closed = productTransaction(productState());
  expect(await rejection(() =>
    refreshUnstagedProtectedTaskTerminalMessagePolicy(
      refreshInput(closed.tx, escaped!),
    ))).toBeInstanceOf(TypeError);
  expect(closed.events).toEqual([]);
});

test.each([
  { name: "foreign owner", task: taskRow({ ownerId: OWNER }) },
  { name: "non-exact result", run: runRow({ siblingIsExact: false }) },
  { name: "missing binding", binding: null },
  { name: "unattached result", binding: bindingRow({ resultAttachedAt: null }) },
])("closed intent rejects $name without materializing plaintext", async variant => {
  const state = productState();
  const value = productTransaction(state, variant);
  expect(await readProtectedTaskTerminalMessageIntent(value.tx, {
    taskId: TASK,
    taskRunId: RUN,
  })).toBeNull();
  expect(value.projections[0]).not.toContain("prompt");
  expect(value.projections[0]).not.toContain("result");
  if (value.projections[1] !== undefined) {
    expect(value.projections[1]).not.toContain("resultText");
    expect(value.projections[1]).not.toContain("lastError");
  }
});
