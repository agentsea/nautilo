import { describe, expect, test } from "bun:test";
import { classifyProtectedTaskMetadataV1 } from "@nautilo/types";

import {
  PostgresTaskContentProductStore,
} from "../../src/server/task/postgres-task-content-product-store.ts";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresScalar,
} from "../../src/server/message/postgres-conversation-product-store.ts";
import {
  TASK_CONTENT_PAYLOAD_VERSION_V1,
  deriveTaskContentCryptoObjectIdV1,
  fingerprintTaskContentAuthorityV1,
  fingerprintTaskContentNamespaceV1,
  taskContentObjectTypeV1,
  type TaskContentCoordinateV1,
} from "../../src/task/task-content-repository.ts";
import type { TaskContentAuthorityV1 } from "../../src/task/task-content-authority-v1.ts";

const TASK_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "10000000-0000-4000-8000-000000000002";
const HUMAN_ID = "10000000-0000-4000-8000-000000000003";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000004";
const DOMAIN_ID = "10000000-0000-4000-8000-000000000005";
const LEASE_ID = "10000000-0000-4000-8000-000000000006";
const NOW = new Date("2026-09-22T12:00:00.000Z");

const authority = Object.freeze({
  authorityVersion: 1,
  kind: "requester_private_namespace",
  keyClass: "ai",
  requesterHumanId: HUMAN_ID,
  namespaceId: NAMESPACE_ID,
  domainId: DOMAIN_ID,
  expectedAccessRevision: 0,
  expectedPolicyRevision: 1,
} satisfies TaskContentAuthorityV1);

type Step = Readonly<{
  contains: string;
  rows: readonly ConversationProductDatabaseRow[];
  inspect?: (
    parameters: readonly ConversationProductPostgresScalar[],
    statement: string,
  ) => void;
}>;

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly steps: Step[];
  readonly isolations: string[] = [];

  constructor(steps: readonly Step[]) {
    this.steps = [...steps];
  }

  async query<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    if (statement.includes("SELECT current_user::text")) {
      return [{ current_user: "nautilo", session_user: "nautilo" }] as unknown as readonly Row[];
    }
    const step = this.steps.shift();
    if (step === undefined) throw new Error(`Unexpected query: ${statement}`);
    expect(statement).toContain(step.contains);
    step.inspect?.(parameters, statement);
    return step.rows as readonly Row[];
  }

  async transaction<Result>(
    callback: (transaction: ScriptedConnection) => Promise<Result>,
    options: Readonly<{ isolationLevel: "serializable" | "read committed" }>,
  ): Promise<Result> {
    this.isolations.push(options.isolationLevel);
    return callback(this);
  }
}

function definition(revision = 1): TaskContentCoordinateV1 {
  return Object.freeze({ kind: "definition", taskId: TASK_ID, contentRevision: revision });
}

function result(revision = 1): TaskContentCoordinateV1 {
  return Object.freeze({ kind: "run_result", taskId: TASK_ID, taskRunId: RUN_ID, contentRevision: revision });
}

function lifecycleRow(
  coordinate: TaskContentCoordinateV1,
  overrides: Record<string, unknown> = {},
): ConversationProductDatabaseRow {
  return {
    sequence: 1,
    task_id: coordinate.taskId,
    ...(coordinate.kind === "definition"
      ? { content_revision: coordinate.contentRevision }
      : { task_run_id: coordinate.taskRunId, result_revision: coordinate.contentRevision }),
    operation_id: `operation:${coordinate.kind}:${coordinate.contentRevision}`,
    request_digest: new Uint8Array(32).fill(7),
    authority_fingerprint: fingerprintTaskContentAuthorityV1(authority),
    requester_human_id: HUMAN_ID,
    content_namespace_id: NAMESPACE_ID,
    crypto_object_id: deriveTaskContentCryptoObjectIdV1(coordinate),
    payload_version: 1,
    representation: "protected",
    required_namespace_fingerprint: fingerprintTaskContentNamespaceV1(NAMESPACE_ID),
    ...(coordinate.kind === "definition"
      ? { operational_metadata: '{"mode":"update","publish":"branch"}' }
      : {}),
    completion: "pending",
    disposition: "active",
    attempt_count: 0,
    next_attempt_at: NOW,
    lease_token: null,
    lease_expires_at: null,
    failure_code: null,
    crypto_completed_at: null,
    ...overrides,
  } as ConversationProductDatabaseRow;
}

function reservation(coordinate: TaskContentCoordinateV1) {
  const metadata = classifyProtectedTaskMetadataV1({
    target: "task-repository",
    mode: "update",
    publish: "branch",
  });
  if (metadata.status !== "supported") {
    throw new Error("Expected supported Task metadata fixture");
  }
  return Object.freeze({
    operationId: `operation:${coordinate.kind}:${coordinate.contentRevision}`,
    coordinate,
    requesterHumanId: HUMAN_ID,
    namespaceId: NAMESPACE_ID,
    authorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
    requiredNamespaceFingerprint: fingerprintTaskContentNamespaceV1(NAMESPACE_ID),
    representation: "protected" as const,
    requestDigest: new Uint8Array(32).fill(7),
    cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
    objectType: taskContentObjectTypeV1(coordinate),
    payloadVersion: TASK_CONTENT_PAYLOAD_VERSION_V1,
    operationalMetadata: coordinate.kind === "definition"
      ? metadata.operational
      : null,
  });
}

async function setup(steps: readonly Step[], current: TaskContentAuthorityV1 | null = authority) {
  const connection = new ScriptedConnection(steps);
  const handle = await verifyConversationProductPostgresHandle(connection);
  return {
    connection,
    store: new PostgresTaskContentProductStore(handle, () => current),
  };
}

const emptyOperations: readonly Step[] = [
  { contains: 'from "task_definition_crypto_revisions"', rows: [] },
  { contains: 'from "task_run_result_crypto_revisions"', rows: [] },
];

describe("PostgresTaskContentProductStore", () => {
  test("reserves definition creation before the product row exists", async () => {
    const coordinate = definition();
    const row = lifecycleRow(coordinate);
    const { store, connection } = await setup([
      ...emptyOperations,
      { contains: 'from "task_definition_crypto_revisions"', rows: [] },
      { contains: 'from "tasks"', rows: [] },
      {
        contains: 'insert into "task_definition_crypto_revisions"',
        rows: [row],
        inspect(parameters, statement) {
          expect(statement).toContain("convert_from");
          expect(statement).toContain("::jsonb");
          expect(parameters.some((parameter) => parameter instanceof Uint8Array
            && new TextDecoder().decode(parameter) === '{"mode":"update","publish":"branch"}')).toBe(true);
        },
      },
      { contains: 'from "tasks"', rows: [] },
    ]);
    const reserved = await store.reserveRevision(reservation(coordinate));
    expect(reserved.status).toBe("reserved");
    if (reserved.status === "reserved") {
      expect(reserved.state.product).toBeNull();
      expect(reserved.state.lifecycle.representation).toBe("protected");
    }
    expect(connection.steps).toHaveLength(0);
    expect(connection.isolations).toEqual(["serializable"]);
  });

  test("enforces exact update predecessor and TaskRun parent binding", async () => {
    const update = definition(2);
    const updateRow = lifecycleRow(update);
    const updateSetup = await setup([
      ...emptyOperations,
      { contains: 'from "task_definition_crypto_revisions"', rows: [] },
      { contains: 'from "tasks"', rows: [{
        owner_id: HUMAN_ID, task_status: "pending",
        content_namespace_id: NAMESPACE_ID,
        content_revision: 1, content_representation: "protected",
        crypto_object_id: deriveTaskContentCryptoObjectIdV1(definition()),
        crypto_required_namespace_fingerprint: fingerprintTaskContentNamespaceV1(NAMESPACE_ID),
        crypto_mapping_state: "verified",
      }] },
      { contains: 'insert into "task_definition_crypto_revisions"', rows: [updateRow] },
      { contains: 'from "tasks"', rows: [{
        task_id: TASK_ID, owner_id: HUMAN_ID, content_revision: 1,
        content_namespace_id: NAMESPACE_ID, content_representation: "protected",
        crypto_object_id: deriveTaskContentCryptoObjectIdV1(definition()),
        crypto_access_revision: 0,
        crypto_required_namespace_fingerprint: fingerprintTaskContentNamespaceV1(NAMESPACE_ID),
      }] },
    ]);
    expect((await updateSetup.store.reserveRevision(reservation(update))).status).toBe("reserved");

    const run = result();
    const runRow = lifecycleRow(run);
    const runSetup = await setup([
      ...emptyOperations,
      { contains: 'from "task_run_result_crypto_revisions"', rows: [] },
      { contains: 'inner join "tasks"', rows: [{
        task_id: TASK_ID, result_revision: 0, result_content_namespace_id: null,
        result_representation: "ordinary", result_crypto_object_id: null,
        result_crypto_required_namespace_fingerprint: null,
        result_crypto_mapping_state: "unmapped",
        run_status: "running", owner_id: HUMAN_ID,
        task_status: "running", parent_namespace_id: NAMESPACE_ID,
      }] },
      { contains: 'insert into "task_run_result_crypto_revisions"', rows: [runRow] },
      { contains: 'from "task_runs"', rows: [{
        task_id: TASK_ID, task_run_id: RUN_ID, result_revision: 0,
        result_content_namespace_id: null, result_representation: "ordinary",
        crypto_object_id: null, crypto_access_revision: 0,
        crypto_required_namespace_fingerprint: null,
      }] },
    ]);
    expect((await runSetup.store.reserveRevision(reservation(run))).status).toBe("reserved");
  });

  test("accepts only exact operation replay and rejects stale authority", async () => {
    const coordinate = definition();
    const row = lifecycleRow(coordinate, { kind: "definition" });
    const replaySetup = await setup([
      { contains: 'from "task_definition_crypto_revisions"', rows: [row] },
      { contains: 'from "task_run_result_crypto_revisions"', rows: [] },
      { contains: 'from "tasks"', rows: [] },
    ]);
    expect((await replaySetup.store.reserveRevision(reservation(coordinate))).status).toBe("replayed");

    const collisionSetup = await setup([
      { contains: 'from "task_definition_crypto_revisions"', rows: [row] },
      { contains: 'from "task_run_result_crypto_revisions"', rows: [] },
    ]);
    const collision = { ...reservation(coordinate), requestDigest: new Uint8Array(32).fill(8) };
    expect((await collisionSetup.store.reserveRevision(collision)).status).toBe("conflict");

    const stale = { ...authority, expectedPolicyRevision: 2 } satisfies TaskContentAuthorityV1;
    const staleSetup = await setup(emptyOperations, stale);
    expect((await staleSetup.store.reserveRevision(reservation(coordinate))).status).toBe("stale");
    expect(staleSetup.connection.isolations).toEqual(["serializable"]);
  });

  test("completes and maps a definition with exact authority and product CAS", async () => {
    const coordinate = definition();
    const pending = lifecycleRow(coordinate, { lease_is_live: true });
    const complete = lifecycleRow(coordinate, {
      completion: "complete", crypto_completed_at: NOW, lease_is_live: true,
    });
    const product = {
      task_id: TASK_ID, owner_id: HUMAN_ID, content_revision: 0,
      task_status: "pending",
      prompt: "plaintext-canary", expected_output: "expected-canary",
      last_error: "error-canary", metadata_json: '{"mode":"update","secret":"metadata-canary"}',
      content_namespace_id: null, content_representation: "ordinary",
      crypto_object_id: null, crypto_access_revision: 0,
      crypto_required_namespace_fingerprint: null,
      crypto_mapping_state: "unmapped",
    };
    const { store, connection } = await setup([
      { contains: 'for update', rows: [pending] },
      { contains: 'update "task_definition_crypto_revisions"', rows: [complete] },
      { contains: 'for update', rows: [complete] },
      { contains: 'from "tasks"', rows: [product] },
      {
        contains: 'update "tasks"',
        rows: [{ task_id: TASK_ID }],
        inspect(parameters, statement) {
          expect(statement).toContain('"prompt"');
          expect(statement).toContain('"expected_output"');
          expect(statement).toContain('"last_error"');
          expect(statement).toContain('"metadata"');
          expect(statement).toContain("convert_from");
          expect(statement).toContain("::jsonb");
          const encoded = JSON.stringify(parameters);
          expect(parameters.some((parameter) => parameter instanceof Uint8Array
            && new TextDecoder().decode(parameter) === '{"mode":"update","publish":"branch"}')).toBe(true);
          expect(encoded).not.toContain("plaintext-canary");
          expect(encoded).not.toContain("expected-canary");
          expect(encoded).not.toContain("error-canary");
          expect(encoded).not.toContain("metadata-canary");
        },
      },
      { contains: 'update "task_definition_crypto_revisions"', rows: [{ ...complete, disposition: "mapped" }] },
    ]);
    expect(await store.markCryptoComplete({
      coordinate, cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate), leaseToken: null,
    })).toBe("applied");
    expect(await store.compareAndSwapCryptoMapping({
      coordinate, cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
      expectedRepresentation: "protected", leaseToken: null,
    })).toBe("applied");
    expect(connection.steps).toHaveLength(0);
  });

  test("marks stale authority without mutating the product mapping", async () => {
    const coordinate = definition();
    const complete = lifecycleRow(coordinate, {
      completion: "complete", crypto_completed_at: NOW, lease_is_live: true,
    });
    const changed = {
      ...authority,
      requesterHumanId: "10000000-0000-4000-8000-000000000099",
    } satisfies TaskContentAuthorityV1;
    const { store, connection } = await setup([
      { contains: 'for update', rows: [complete] },
      { contains: 'update "task_definition_crypto_revisions"', rows: [{
        ...complete, disposition: "stale_mapping", failure_code: "authority_stale",
      }] },
    ], changed);
    expect(await store.compareAndSwapCryptoMapping({
      coordinate, cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
      expectedRepresentation: "protected", leaseToken: null,
    })).toBe("wrong_authority");
    expect(connection.steps).toHaveLength(0);
  });

  test("maps a protected TaskRun result and clears ordinary result content", async () => {
    const coordinate = result();
    const complete = lifecycleRow(coordinate, {
      completion: "complete", crypto_completed_at: NOW, lease_is_live: true,
    });
    const { store, connection } = await setup([
      { contains: 'for update', rows: [complete] },
      { contains: 'from "tasks"', rows: [{
        owner_id: HUMAN_ID, namespace_id: NAMESPACE_ID,
        task_status: "completed",
      }] },
      { contains: 'from "task_runs"', rows: [{
        task_id: TASK_ID, task_run_id: RUN_ID, result_revision: 0,
        run_status: "completed",
        result_content_namespace_id: null, result_representation: "ordinary",
        crypto_object_id: null, crypto_access_revision: 0,
        crypto_required_namespace_fingerprint: null,
        crypto_mapping_state: "unmapped",
      }] },
      {
        contains: 'update "task_runs"',
        rows: [{ task_run_id: RUN_ID }],
        inspect(parameters, statement) {
          expect(statement).toContain('"result_text"');
          expect(statement).toContain('"last_error"');
          expect(JSON.stringify(parameters)).not.toContain("result-canary");
        },
      },
      { contains: 'update "task_run_result_crypto_revisions"', rows: [{
        ...complete, disposition: "mapped",
      }] },
    ]);
    expect(await store.compareAndSwapCryptoMapping({
      coordinate,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
      expectedRepresentation: "protected",
      leaseToken: null,
    })).toBe("applied");
    expect(connection.steps).toHaveLength(0);
  });

  test("refuses definition mapping after the Task is cancelled", async () => {
    const coordinate = definition();
    const complete = lifecycleRow(coordinate, {
      completion: "complete", crypto_completed_at: NOW, lease_is_live: true,
    });
    const { store, connection } = await setup([
      { contains: 'for update', rows: [complete] },
      { contains: 'from "tasks"', rows: [{
        task_id: TASK_ID, owner_id: HUMAN_ID, task_status: "cancelled",
        content_revision: 0, prompt: "cancelled", expected_output: null,
        last_error: null, metadata_json: '{}', content_namespace_id: null,
        content_representation: "ordinary", crypto_object_id: null,
        crypto_access_revision: 0,
        crypto_required_namespace_fingerprint: null,
        crypto_mapping_state: "unmapped",
      }] },
      { contains: 'update "tasks"', rows: [], inspect(_parameters, statement) {
        expect(statement).toContain('"tasks"."status" in');
      } },
      { contains: 'update "task_definition_crypto_revisions"', rows: [{
        ...complete, disposition: "stale_mapping", failure_code: "mapping_conflict",
      }] },
    ]);
    expect(await store.compareAndSwapCryptoMapping({
      coordinate,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
      expectedRepresentation: "protected",
      leaseToken: null,
    })).toBe("stale");
    expect(connection.steps).toHaveLength(0);
  });

  test("refuses result mapping after the TaskRun is cancelled", async () => {
    const coordinate = result();
    const complete = lifecycleRow(coordinate, {
      completion: "complete", crypto_completed_at: NOW, lease_is_live: true,
    });
    const { store, connection } = await setup([
      { contains: 'for update', rows: [complete] },
      { contains: 'from "tasks"', rows: [{
        owner_id: HUMAN_ID, namespace_id: NAMESPACE_ID,
        task_status: "running",
      }] },
      { contains: 'from "task_runs"', rows: [{
        task_id: TASK_ID, task_run_id: RUN_ID, run_status: "cancelled",
        result_revision: 0, result_content_namespace_id: null,
        result_representation: "ordinary", crypto_object_id: null,
        crypto_access_revision: 0,
        crypto_required_namespace_fingerprint: null,
        crypto_mapping_state: "unmapped",
      }] },
      { contains: 'update "task_run_result_crypto_revisions"', rows: [{
        ...complete, disposition: "stale_mapping", failure_code: "mapping_conflict",
      }] },
    ]);
    expect(await store.compareAndSwapCryptoMapping({
      coordinate,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
      expectedRepresentation: "protected",
      leaseToken: null,
    })).toBe("stale");
    expect(connection.steps).toHaveLength(0);
  });

  test("claims in stable order and bounds retry into quarantine", async () => {
    const coordinate = definition();
    const due = lifecycleRow(coordinate, { kind: "definition" });
    const leased = lifecycleRow(coordinate, {
      lease_token: LEASE_ID,
      lease_expires_at: new Date("2026-09-22T12:01:00.000Z"),
    });
    const failed = lifecycleRow(coordinate, {
      attempt_count: 8, disposition: "quarantined", failure_code: "retry_exhausted",
      next_attempt_at: null, lease_token: null, lease_expires_at: null,
    });
    const { store, connection } = await setup([
      { contains: 'from "task_definition_crypto_revisions"', rows: [due] },
      { contains: 'from "task_run_result_crypto_revisions"', rows: [] },
      { contains: 'update "task_definition_crypto_revisions"', rows: [leased] },
      { contains: 'from "task_definition_crypto_revisions"', rows: [leased] },
      { contains: 'from "tasks"', rows: [] },
      { contains: 'update "task_definition_crypto_revisions"', rows: [failed] },
    ]);
    const claimed = await store.claimReconciliationCandidates({ leaseToken: LEASE_ID, limit: 1 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.lifecycle.leaseToken).toBe(LEASE_ID);
    const receipt = await store.failReconciliationClaim({
      coordinate, leaseToken: LEASE_ID, failureCode: "storage_transient",
    });
    expect(receipt?.attemptCount).toBe(8);
    expect(receipt?.disposition).toBe("quarantined");
    expect(receipt?.failureCode).toBe("retry_exhausted");
    expect(connection.isolations).toEqual(["read committed", "serializable"]);
  });
});
