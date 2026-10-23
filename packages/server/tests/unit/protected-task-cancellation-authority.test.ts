import { expect, test } from "bun:test";
import type { PostgresJsBridgeConnection, PostgresJsBridgeRow,
  ProtectedTaskCancellationOutputIntent } from "@nautilo/db";
import type { AcceptedTaskRuntimeAuthorizationV3, CurrentTaskRuntimeAuthority,
  InitialTaskRuntimeRecipientAuthority } from "@nautilo/lattice-bridge/server";
import {
  createProtectedTaskCancellationAuthorityPort,
  validateCurrentProtectedTaskCancellationIntent,
  type ProtectedTaskCancellationAuthorityDependencies,
} from "../../src/routes/protected-task-cancellation-authority";

const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "10000000-0000-4000-8000-000000000002";
const TASK = "10000000-0000-4000-8000-000000000003";
const RUN = "10000000-0000-4000-8000-000000000004";
const AGENT = "10000000-0000-4000-8000-000000000005";
const NS = "10000000-0000-4000-8000-000000000006";
const ROOM = "10000000-0000-4000-8000-000000000007";
const DOMAIN = "10000000-0000-4000-8000-000000000008";
const DEVICE = "device";
const terminalAt = new Date("2026-10-12T10:00:00Z");
const intent: ProtectedTaskCancellationOutputIntent = {
  taskId: TASK, taskRunId: RUN, requesterUserId: USER, agentId: AGENT,
  contentNamespaceId: NS, representation: "protected", resultRevision: 2,
  resultOperationId: `task-run-cancelled-result:${RUN}`,
  resultObjectId: `task-run-result:v1:${"a".repeat(64)}`, policyRevision: 7,
  taskStatus: "cancelled", runStatus: "cancelled", terminalAt,
};
const subject = { userId: USER, humanActorId: HUMAN, deviceId: DEVICE };

function fixture(change: (stage: string, row: PostgresJsBridgeRow) => PostgresJsBridgeRow = (_stage, row) => row) {
  const queries: string[] = [];
  const connection: PostgresJsBridgeConnection = {
    query: async <Row extends PostgresJsBridgeRow>(sql: string) => {
      queries.push(sql);
      let stage: string;
      let rows: PostgresJsBridgeRow[];
      if (sql.includes('from "tasks"')) {
        stage = "task";
        rows = [{ id: TASK, owner_id: USER, requestor_id: USER, agent_id: AGENT,
          status: "cancelled", cancelled_at: terminalAt, content_namespace_id: NS,
          content_representation: "protected" }];
      } else if (sql.includes('from "task_runs"')) {
        stage = "run";
        rows = [{ id: RUN, task_id: TASK, status: "cancelled", completed_at: terminalAt }];
      } else if (sql.includes('from "protected_task_run_output_bindings"')) {
        stage = "binding";
        rows = [{ task_run_id: RUN, result_revision: 2, result_operation_id: intent.resultOperationId,
          result_object_id: intent.resultObjectId, accepted_policy_revision: 7,
          result_terminal_at: terminalAt, result_attached_at: null }];
      } else if (sql.includes('from "rooms"')) {
        stage = "room";
        rows = [{ id: ROOM, namespace_id: NS, type: "private", kind: "private",
          parent_room_id: null, archived_at: null, human_actor_ids: [HUMAN] }];
      } else if (sql.includes('from "room_members"')) {
        stage = "members";
        rows = [{ id: HUMAN, kind: "user", owner_id: USER, agent_id: null },
          { id: "agent-actor", kind: "agent", owner_id: USER, agent_id: AGENT }];
      } else throw new Error(`Unexpected query: ${sql}`);
      return rows.map(row => change(stage, row)) as unknown as readonly Row[];
    },
    transaction: use => use(connection), transactionOnce: use => use(connection),
  };
  const namespaceRequirements = [{ ordinal: 0, namespaceId: NS, domainId: DOMAIN,
    operations: ["encrypt"] as const, expectedAccessRevision: 1, expectedPolicyRevision: 7 }];
  const domainRequirements = [{ ordinal: 0, domainId: DOMAIN,
    expectedEpoch: 2, expectedAuthorizationRevision: 3 }];
  const accepted: AcceptedTaskRuntimeAuthorizationV3 = {
    descriptorBytes: new Uint8Array([1]), descriptorDigest: "digest", requestId: "request",
    workId: RUN, workKind: "task.cancel_result", workPurpose: "task.cancel_result",
    recipientGeneration: 1, recipientKeyId: "recipient", recipientPublicKeyBase64url: "key",
    expectedPolicyRevision: 7, namespaceRequirements, domainRequirements,
    authorizationId: "authorization", authorizationBytes: new Uint8Array([2]),
    authorizationDigest: "digest", authorizationExpiresAt: Date.now() + 60_000,
    issuingHumanId: HUMAN, issuingDeviceId: DEVICE, issuingDeviceAuthorizationRevision: 4,
    issuerSigningPublicKeyHash: new Uint8Array(32).fill(3),
  };
  const dependencies: Partial<ProtectedTaskCancellationAuthorityDependencies> = {
    db: {} as ProtectedTaskCancellationAuthorityDependencies["db"],
    restricted: () => connection, resolveRequesterHuman: async () => ({ id: HUMAN }),
    resolveRequesterPrivateRoom: async () => ({ roomId: ROOM, namespaceId: NS }),
    createProductContext: async () => ({ canonicalRunner: {}, handle: {} }) as Awaited<ReturnType<ProtectedTaskCancellationAuthorityDependencies["createProductContext"]>>,
    inspectContentAuthority: async () => ({ sourceRoomId: ROOM, sourceNamespaceId: NS,
      facts: [{ namespaceId: NS, domainId: DOMAIN, expectedAccessRevision: 1,
        expectedPolicyRevision: 7, expectedDomainEpoch: 2, expectedAuthorizationRevision: 3 }] }),
    withRecipientAuthority: async input => {
      expect(input.namespaceRequirements[0]!.operations).toEqual(["encrypt"]);
      expect(input.domainRequirements).toHaveLength(1);
      if (!await input.validateCurrentTaskRun(connection, {} as never)) return null;
      const result = await input.use({ sourceRoomId: ROOM, sourceNamespaceId: NS,
        namespaceRequirements, domains: [], policyRevision: 7,
        device: subject } as unknown as InitialTaskRuntimeRecipientAuthority,
        connection, connection, {} as never);
      await input.validateBeforeCommit?.();
      return result;
    },
    withAcceptedAuthority: async input => {
      if (!await input.validateCurrentProduct(connection, {} as never)) return null;
      const result = await input.use({ plan: { roomId: ROOM } } as CurrentTaskRuntimeAuthority,
        connection, connection, {} as never);
      await input.validateBeforeCommit();
      return result;
    },
  };
  return { connection, queries, dependencies, accepted,
    port: createProtectedTaskCancellationAuthorityPort(dependencies) };
}

test("stopped intent proof reads only Task/Run/output metadata without a Job or definition", async () => {
  const value = fixture();
  expect(await validateCurrentProtectedTaskCancellationIntent({ product: value.connection, intent })).toBe(true);
  expect(value.queries).toHaveLength(3);
  expect(value.queries.every(sql => sql.endsWith('for update'))).toBe(true);
  expect(value.queries.join("\n")).not.toMatch(/prompt|expected_output|crypto_object_id|job_id|task_definition|"jobs"/u);
});

test("recovery-only validation accepts exactly the terminal attachment timestamp", async () => {
  const attached = fixture((stage, row) => stage === "binding"
    ? { ...row, result_attached_at: new Date(terminalAt) } : row);
  expect(await validateCurrentProtectedTaskCancellationIntent({ product: attached.connection, intent,
    allowTerminalResultAttachment: true })).toBe(true);

  const mismatched = fixture((stage, row) => stage === "binding"
    ? { ...row, result_attached_at: new Date(terminalAt.getTime() + 1) } : row);
  expect(await validateCurrentProtectedTaskCancellationIntent({ product: mismatched.connection, intent,
    allowTerminalResultAttachment: true })).toBe(false);
});

for (const [stage, field, replacement] of [
  ["task", "status", "running"], ["task", "requestor_id", "other"],
  ["task", "agent_id", "other"], ["task", "content_namespace_id", "other"],
  ["run", "status", "completed"], ["run", "completed_at", new Date(0)],
  ["binding", "result_revision", 1], ["binding", "result_operation_id", "other"],
  ["binding", "result_object_id", "other"], ["binding", "accepted_policy_revision", 8],
  ["binding", "result_terminal_at", new Date(0)], ["binding", "result_attached_at", terminalAt],
] as const) {
  test(`denies changed cancellation ${stage}.${field}`, async () => {
    const value = fixture((current, row) => current === stage ? { ...row, [field]: replacement } : row);
    let used = false;
    expect(await value.port.withDiscovery({ intent, subject,
      use: () => { used = true; return "bound"; } })).toBeNull();
    expect(used).toBe(false);
  });
}

test("discovery binds only encrypt-only content authority and rechecks before commit", async () => {
  const value = fixture();
  const events: string[] = [];
  expect(await value.port.withDiscovery({ intent, subject,
    use: current => { events.push("use"); expect(current.restricted).toBe(value.connection); return "bound"; },
    validateBeforeCommit: () => { events.push("commit-check"); },
  })).toBe("bound");
  expect(events).toEqual(["use", "commit-check"]);
});

test("accepts Human-owned cancellation content when the source Room Agent differs", async () => {
  const value = fixture((stage, row) => stage === "members"
    && row["kind"] === "agent" ? { ...row, agent_id: "other-private-room-agent" } : row);
  expect(await value.port.withDiscovery({
    intent,
    subject,
    use: () => "bound",
  })).toBe("bound");
});

test("accepted cancellation checks the caller's claim lease before and after use", async () => {
  const value = fixture();
  const events: string[] = [];
  expect(await value.port.withAccepted({ intent, subject, accepted: value.accepted,
    validateBeforeCommit: () => { events.push("lease"); },
    use: () => { events.push("use"); return "settled"; },
  })).toBe("settled");
  expect(events).toEqual(["lease", "use", "lease"]);
  expect(value.accepted.descriptorBytes[0]).toBe(1);
  let used = false;
  expect(await value.port.withAccepted({ intent, subject, accepted: value.accepted,
    validateBeforeCommit: () => { throw new Error("Claim expired"); },
    use: () => { used = true; },
  }).catch((error: unknown) => error)).toEqual(new Error("Claim expired"));
  expect(used).toBe(false);
});

test("rejects execution, mismatched purpose, expanded operations and a different Domain", async () => {
  for (const patch of [
    { workKind: "task.execute" as const }, { workPurpose: "task.execute" as const },
    { namespaceRequirements: [{ ordinal: 0, namespaceId: NS, domainId: DOMAIN,
      operations: ["decrypt", "encrypt"] as const, expectedAccessRevision: 1, expectedPolicyRevision: 7 }] },
    { domainRequirements: [{ ordinal: 0, domainId: "other", expectedEpoch: 2, expectedAuthorizationRevision: 3 }] },
  ]) {
    const value = fixture();
    expect(await value.port.withAccepted({ intent, subject,
      accepted: { ...value.accepted, ...patch }, validateBeforeCommit: () => {},
      use: () => { throw new Error("Must not execute"); },
    })).toBeNull();
    expect(value.queries).toHaveLength(0);
  }
});
