import { describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { TASK_LOCAL_EXECUTION_RECREATE_TEXT } from "@nautilo/db";
import { classifyProtectedTaskMetadataV1 } from "@nautilo/types";

import {
  PostgresTaskContentProductStore,
  type ResolveCurrentTaskContentAuthority,
} from "../../src/server/task/postgres-task-content-product-store.ts";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresScalar,
} from "../../src/server/message/postgres-conversation-product-store.ts";
import {
  TASK_CONTENT_PAYLOAD_VERSION_V1,
  TaskHistoricalRepairPublicationUnavailableError,
  deriveTaskContentCryptoObjectIdV1,
  fingerprintTaskContentAuthorityV1,
  fingerprintTaskContentNamespaceV1,
  prepareTaskOrdinaryFallbackRepairSourceProofV1,
  taskContentObjectTypeV1,
  type TaskContentCoordinateV1,
} from "../../src/task/task-content-repository.ts";
import type { TaskContentAuthorityV1 } from "../../src/task/task-content-authority-v1.ts";
import { deriveTaskHistoricalContentCryptoObjectIdV1 } from
  "../../src/task/task-historical-content-identity.ts";

const TASK_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "10000000-0000-4000-8000-000000000002";
const HUMAN_ID = "10000000-0000-4000-8000-000000000003";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000004";
const DOMAIN_ID = "10000000-0000-4000-8000-000000000005";
const LEASE_ID = "10000000-0000-4000-8000-000000000006";
const OWNER_ID = "10000000-0000-4000-8000-000000000007";
const FOREIGN_OWNER_ID = "10000000-0000-4000-8000-000000000008";
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
  readonly statements: string[] = [];
  transactionDepth = 0;
  productUpdateLocks = 0;

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
    this.statements.push(statement);
    const step = this.steps.shift();
    if (step === undefined) throw new Error(`Unexpected query: ${statement}`);
    if (statement.includes("for update")
      && (statement.includes('from "tasks"')
        || statement.includes('from "task_runs"'))) {
      this.productUpdateLocks += 1;
    }
    expect(statement).toContain(step.contains);
    step.inspect?.(parameters, statement);
    return step.rows as readonly Row[];
  }

  async transaction<Result>(
    callback: (transaction: ScriptedConnection) => Promise<Result>,
    options: Readonly<{ isolationLevel: "serializable" | "read committed" }>,
  ): Promise<Result> {
    this.isolations.push(options.isolationLevel);
    this.transactionDepth += 1;
    try {
      return await callback(this);
    } finally {
      this.transactionDepth -= 1;
    }
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

const FALLBACK_COMPLETED_AT = new Date("2026-09-22T11:55:00.000Z");
const FALLBACK_UPDATED_AT = new Date("2026-09-22T11:56:00.000Z");
const FALLBACK_OPERATION_ID = "fallback:task:update";
const FALLBACK_REQUEST_DIGEST = new Uint8Array(32).fill(0x51);

function fallbackRepairProof(overrides: Readonly<{
  sourceMutationVersion?: string;
}> = {}) {
  return prepareTaskOrdinaryFallbackRepairSourceProofV1({
    taskId: TASK_ID,
    sourceMutationVersion: overrides.sourceMutationVersion ?? "41",
    sourceUpdatedAt: FALLBACK_UPDATED_AT,
    sourceContentRevision: 1,
    sourceNamespaceId: NAMESPACE_ID,
    sourceCryptoObjectId: deriveTaskContentCryptoObjectIdV1(definition()),
    sourceCryptoAccessRevision: 0,
    sourceRequiredNamespaceFingerprint:
      fingerprintTaskContentNamespaceV1(NAMESPACE_ID),
    fallbackOperationId: FALLBACK_OPERATION_ID,
    fallbackRequestDigest: FALLBACK_REQUEST_DIGEST,
    fallbackReason: "target_encryption_not_ready",
    fallbackPolicyRevision: 1,
    fallbackCompletedAt: FALLBACK_COMPLETED_AT,
  });
}

function fallbackSourceRow(overrides: Record<string, unknown> = {}) {
  return {
    task_id: TASK_ID,
    owner_id: OWNER_ID,
    requestor_id: OWNER_ID,
    mutation_version: "41",
    task_status: "pending",
    fire_lock_id: null,
    content_namespace_id: NAMESPACE_ID,
    content_revision: 1,
    content_representation: "dual",
    crypto_object_id: deriveTaskContentCryptoObjectIdV1(definition()),
    crypto_access_revision: 0,
    crypto_required_namespace_fingerprint:
      fingerprintTaskContentNamespaceV1(NAMESPACE_ID),
    crypto_mapping_state: "stale",
    ordinary_fallback_operation_id: FALLBACK_OPERATION_ID,
    ordinary_fallback_request_digest: FALLBACK_REQUEST_DIGEST,
    ordinary_fallback_reason: "target_encryption_not_ready",
    ordinary_fallback_policy_revision: 1,
    ordinary_fallback_completed_at: FALLBACK_COMPLETED_AT,
    updated_at: FALLBACK_UPDATED_AT,
    prompt: "fallback sibling",
    expected_output: null,
    last_error: null,
    metadata_json: "{}",
    ...overrides,
  };
}

async function setup(
  steps: readonly Step[],
  current: TaskContentAuthorityV1 | null | ResolveCurrentTaskContentAuthority = authority,
) {
  const connection = new ScriptedConnection(steps);
  const handle = await verifyConversationProductPostgresHandle(connection);
  return {
    connection,
    store: new PostgresTaskContentProductStore(
      handle,
      typeof current === "function" ? current : () => current,
    ),
  };
}

const emptyOperations: readonly Step[] = [
  { contains: 'from "task_definition_crypto_revisions"', rows: [] },
  { contains: 'from "task_run_result_crypto_revisions"', rows: [] },
];

const requesterOwner: Step = {
  contains: 'from "actors"',
  rows: [{ owner_id: OWNER_ID }],
  inspect(_parameters, statement) {
    expect(statement).toContain('"actors"."kind"');
    expect(statement).toContain('"actors"."id"');
    expect(statement).toContain("for share");
  },
};

const protectedPublicationPolicy: Step = {
  contains: 'from "encryption_transition_policy"',
  rows: [{ mode: "encrypted_only", revision: 1 }],
  inspect(_parameters, statement) {
    expect(statement).toContain("for share");
  },
};

// Keep the expected definition protocol explicit while sharing the unchanged
// lifecycle and product fixtures with reservation/mapping regression cases.
function definitionReservationSteps(steps: readonly Step[]): Step[] {
  const product = steps.find(step => step.contains === 'from "tasks"');
  return [protectedPublicationPolicy, { contains: 'from "tasks"', rows: product?.rows ?? [] }, ...steps];
}

function definitionMappingSteps(steps: readonly Step[]): Step[] {
  const lockedIndex = steps.findIndex(step => step.contains === "for update");
  if (lockedIndex < 0) throw new Error("Definition mapping fixture needs its locked lifecycle");
  const locked = steps[lockedIndex]!;
  const prior = steps.slice(0, lockedIndex);
  const policy = steps.find(step => step.contains === 'from "encryption_transition_policy"') ?? protectedPublicationPolicy;
  const product = steps.find(step => step.contains === 'from "tasks"');
  return [
    ...prior.filter(step => step.contains !== 'from "encryption_transition_policy"' && step.contains !== 'from "tasks"'),
    { contains: 'from "task_definition_crypto_revisions"', rows: locked.rows },
    policy, { contains: 'from "tasks"', rows: product?.rows ?? [] },
    ...steps.slice(lockedIndex),
  ];
}

describe("PostgresTaskContentProductStore", () => {
  test("definition reservation locks policy then Task before either ledger", async () => {
    const coordinate = definition();
    const row = lifecycleRow(coordinate, { kind: "definition" });
    const { store, connection } = await setup([
      protectedPublicationPolicy,
      { contains: 'from "tasks"', rows: [], inspect(_parameters, statement) { expect(statement).toContain("for update"); } },
      { contains: 'from "task_definition_crypto_revisions"', rows: [row] },
      { contains: 'from "task_run_result_crypto_revisions"', rows: [] },
      { contains: 'from "tasks"', rows: [] },
    ]);
    expect((await store.reserveRevision(reservation(coordinate))).status).toBe("replayed");
    expect(connection.statements.slice(0, 3).map(statement => statement.match(/from "([^"]+)"/)?.[1]))
      .toEqual(["encryption_transition_policy", "tasks", "task_definition_crypto_revisions"]);
    expect(connection.steps).toHaveLength(0);
  });

  test("definition mapping resolves authority without locks then rejects changed immutable ledger", async () => {
    const coordinate = definition();
    const complete = lifecycleRow(coordinate, { completion: "complete", crypto_completed_at: NOW });
    const connection = new ScriptedConnection([
      { contains: 'from "task_definition_crypto_revisions"', rows: [complete], inspect(_parameters, statement) { expect(statement).not.toContain("for update"); } },
      protectedPublicationPolicy,
      { contains: 'from "tasks"', rows: [], inspect(_parameters, statement) { expect(statement).toContain("for update"); } },
      { contains: 'from "task_definition_crypto_revisions"', rows: [{ ...complete, request_digest: new Uint8Array(32).fill(99) }] },
    ]);
    let resolutions = 0;
    const store = new PostgresTaskContentProductStore(await verifyConversationProductPostgresHandle(connection), () => {
      expect(connection.transactionDepth).toBe(0);
      expect(connection.productUpdateLocks).toBe(0);
      resolutions += 1;
      return authority;
    });
    expect(await store.compareAndSwapCryptoMapping({ coordinate,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
      expectedRepresentation: "protected", leaseToken: null })).toBe("stale");
    expect(resolutions).toBe(1);
    expect(connection.statements.slice(1).map(statement => statement.match(/from "([^"]+)"/)?.[1]))
      .toEqual(["encryption_transition_policy", "tasks", "task_definition_crypto_revisions"]);
    expect(connection.steps).toHaveLength(0);
    expect(connection.statements.some(statement => statement.startsWith("update "))).toBe(false);
  });

  test.each([
    { mode: "encrypted_only", revision: 2 },
    { mode: "shadow_encryption", revision: 1 },
    { mode: "plaintext_only", revision: 1 },
  ])("definition reservation rejects changed policy before product or ledger locks %p", async policy => {
    const { store, connection } = await setup([
      { ...protectedPublicationPolicy, rows: [policy] },
    ]);
    expect(await store.reserveRevision(reservation(definition()))).toEqual({ status: "stale" });
    expect(connection.productUpdateLocks).toBe(0);
    expect(connection.steps).toHaveLength(0);
    expect(connection.statements).toHaveLength(1);
  });

  test("reserves definition creation before the product row exists", async () => {
    const coordinate = definition();
    const row = lifecycleRow(coordinate);
    const { store, connection } = await setup(definitionReservationSteps([
      ...emptyOperations,
      { contains: 'from "task_definition_crypto_revisions"', rows: [] },
      requesterOwner,
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
    ]));
    const reserved = await store.reserveRevision(reservation(coordinate));
    expect(reserved.status).toBe("reserved");
    if (reserved.status === "reserved") {
      expect(reserved.state.product).toBeNull();
      expect(reserved.state.lifecycle.representation).toBe("protected");
    }
    expect(connection.steps).toHaveLength(0);
    expect(connection.isolations).toEqual(["serializable"]);
  });

  test.each([
    "2026-10-02T09:08:07.123Z",
    "2026-10-02 12:08:07.123+03",
    "2026-10-02 09:08:07.123456+00",
  ])("decodes canonical storage timestamp %s", async (nextAttemptAt) => {
    const coordinate = definition();
    const row = lifecycleRow(coordinate, {
      next_attempt_at: nextAttemptAt,
    });
    const { store } = await setup(definitionReservationSteps([
      ...emptyOperations,
      { contains: 'from "task_definition_crypto_revisions"', rows: [] },
      requesterOwner,
      { contains: 'from "tasks"', rows: [] },
      { contains: 'insert into "task_definition_crypto_revisions"', rows: [row] },
      { contains: 'from "tasks"', rows: [] },
    ]));
    const reserved = await store.reserveRevision(reservation(coordinate));
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") return;
    expect(reserved.state.lifecycle.nextAttemptAt).toEqual(new Date(nextAttemptAt));
  });

  test.each([
    "",
    "not-a-timestamp",
    "0",
    "2026-10-02",
    "2026-02-30T09:08:07.123Z",
    "2026-02-30 09:08:07.123+00",
    "2026-10-02 09:08:07.123+99",
    1,
    {},
    new Date(Number.NaN),
  ])(
    "rejects malformed storage timestamp %p",
    async (stored) => {
      const coordinate = definition();
      const { store } = await setup(definitionReservationSteps([
        ...emptyOperations,
        { contains: 'from "task_definition_crypto_revisions"', rows: [] },
        requesterOwner,
        { contains: 'from "tasks"', rows: [] },
        {
          contains: 'insert into "task_definition_crypto_revisions"',
          rows: [lifecycleRow(coordinate, { next_attempt_at: stored })],
        },
      ]));
      const error = await store.reserveRevision(reservation(coordinate))
        .then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message)
        .toBe("next_attempt_at is not a timestamp");
    },
  );

  test("enforces exact update predecessor and TaskRun parent binding", async () => {
    const update = definition(2);
    const updateRow = lifecycleRow(update);
    const updateSetup = await setup(definitionReservationSteps([
      ...emptyOperations,
      { contains: 'from "task_definition_crypto_revisions"', rows: [] },
      requesterOwner,
      { contains: 'from "tasks"', rows: [{
        owner_id: OWNER_ID, requestor_id: OWNER_ID, task_status: "pending", fire_lock_id: null,
        content_namespace_id: NAMESPACE_ID,
        content_revision: 1, content_representation: "protected",
        crypto_object_id: deriveTaskContentCryptoObjectIdV1(definition()),
        crypto_required_namespace_fingerprint: fingerprintTaskContentNamespaceV1(NAMESPACE_ID),
        crypto_mapping_state: "verified",
      }] },
      { contains: 'insert into "task_definition_crypto_revisions"', rows: [updateRow] },
      { contains: 'from "tasks"', rows: [{
        task_id: TASK_ID, owner_id: OWNER_ID, requestor_id: OWNER_ID, content_revision: 1,
        content_namespace_id: NAMESPACE_ID, content_representation: "protected",
        crypto_object_id: deriveTaskContentCryptoObjectIdV1(definition()),
        crypto_access_revision: 0,
        crypto_required_namespace_fingerprint: fingerprintTaskContentNamespaceV1(NAMESPACE_ID),
      }] },
    ]));
    expect((await updateSetup.store.reserveRevision(reservation(update))).status).toBe("reserved");

    const run = result();
    const runRow = lifecycleRow(run);
    const runSetup = await setup([
      ...emptyOperations,
      { contains: 'from "task_run_result_crypto_revisions"', rows: [] },
      requesterOwner,
      { contains: 'inner join "tasks"', rows: [{
        task_id: TASK_ID, result_revision: 0, result_content_namespace_id: null,
        result_representation: "ordinary", result_crypto_object_id: null,
        result_crypto_required_namespace_fingerprint: null,
        result_crypto_mapping_state: "unmapped",
        run_status: "running", owner_id: OWNER_ID, requestor_id: OWNER_ID,
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

  test("reserves a normal next revision only from the exact receipt-bound stale dual source", async () => {
    const coordinate = definition(2);
    const sourceLedger = lifecycleRow(definition(), {
      representation: "dual",
      completion: "complete",
      disposition: "mapped",
      crypto_completed_at: NOW,
    });
    const nextLedger = lifecycleRow(coordinate, {
      representation: "dual",
    });
    const exact = await setup(definitionReservationSteps([
      ...emptyOperations,
      { contains: 'from "task_definition_crypto_revisions"', rows: [] },
      requesterOwner,
      { contains: 'from "tasks"', rows: [fallbackSourceRow()] },
      { contains: 'from "task_definition_crypto_revisions"', rows: [sourceLedger] },
      { contains: 'insert into "task_definition_crypto_revisions"', rows: [nextLedger] },
      { contains: 'from "tasks"', rows: [fallbackSourceRow()] },
    ]).map((step, index) => index === 0 ? {
      contains: 'from "encryption_transition_policy"',
      rows: [{ mode: "shadow_encryption", revision: 1 }],
    } : step));
    expect((await exact.store.reserveRevision({
      ...reservation(coordinate),
      representation: "dual",
      fallbackRepairSource: fallbackRepairProof(),
    })).status).toBe("reserved");
    expect(exact.connection.steps).toHaveLength(0);

    const changed = await setup(definitionReservationSteps([
      ...emptyOperations,
      { contains: 'from "task_definition_crypto_revisions"', rows: [] },
      requesterOwner,
      { contains: 'from "tasks"', rows: [fallbackSourceRow()] },
    ]).map((step, index) => index === 0 ? {
      contains: 'from "encryption_transition_policy"',
      rows: [{ mode: "shadow_encryption", revision: 1 }],
    } : step));
    expect(await changed.store.reserveRevision({
      ...reservation(coordinate),
      representation: "dual",
      fallbackRepairSource: fallbackRepairProof({
        sourceMutationVersion: "42",
      }),
    })).toEqual({ status: "stale" });
    expect(changed.connection.steps).toHaveLength(0);
  });

  test("refuses a definition update while an occurrence owns the fire lock", async () => {
    const coordinate = definition(2);
    const { store } = await setup(definitionReservationSteps([
      ...emptyOperations,
      { contains: 'from "task_definition_crypto_revisions"', rows: [] },
      requesterOwner,
      { contains: 'from "tasks"', rows: [{
        owner_id: OWNER_ID, requestor_id: OWNER_ID, task_status: "pending", fire_lock_id: RUN_ID,
        content_namespace_id: NAMESPACE_ID,
        content_revision: 1, content_representation: "protected",
        crypto_object_id: deriveTaskContentCryptoObjectIdV1(definition()),
        crypto_required_namespace_fingerprint: fingerprintTaskContentNamespaceV1(NAMESPACE_ID),
        crypto_mapping_state: "verified",
      }] },
    ]));
    expect((await store.reserveRevision(reservation(coordinate))).status).toBe("stale");
  });

  test("accepts only exact operation replay and rejects stale authority", async () => {
    const coordinate = definition();
    const row = lifecycleRow(coordinate, { kind: "definition" });
    const replaySetup = await setup(definitionReservationSteps([
      { contains: 'from "task_definition_crypto_revisions"', rows: [row] },
      { contains: 'from "task_run_result_crypto_revisions"', rows: [] },
      { contains: 'from "tasks"', rows: [] },
    ]));
    expect((await replaySetup.store.reserveRevision(reservation(coordinate))).status).toBe("replayed");

    const collisionSetup = await setup(definitionReservationSteps([
      { contains: 'from "task_definition_crypto_revisions"', rows: [row] },
      { contains: 'from "task_run_result_crypto_revisions"', rows: [] },
    ]));
    const collision = { ...reservation(coordinate), requestDigest: new Uint8Array(32).fill(8) };
    expect((await collisionSetup.store.reserveRevision(collision)).status).toBe("conflict");

    const stale = { ...authority, expectedPolicyRevision: 2 } satisfies TaskContentAuthorityV1;
    const staleSetup = await setup([protectedPublicationPolicy], stale);
    expect((await staleSetup.store.reserveRevision(reservation(coordinate))).status).toBe("stale");
    expect(staleSetup.connection.isolations).toEqual(["serializable"]);
  });

  test("looks up one durable operation without reconstructing its original plan", async () => {
    const coordinate = definition();
    const row = lifecycleRow(coordinate, { kind: "definition" });
    const found = await setup([
      { contains: 'from "task_definition_crypto_revisions"', rows: [row] },
      { contains: 'from "task_run_result_crypto_revisions"', rows: [] },
      { contains: 'from "tasks"', rows: [] },
    ]);
    expect(await found.store.getRevisionByOperation({
      operationId: "operation:definition:1",
    })).toMatchObject({
      status: "found",
      state: { lifecycle: { coordinate } },
    });

    const missing = await setup(emptyOperations);
    expect(await missing.store.getRevisionByOperation({
      operationId: "operation:definition:1",
    })).toEqual({ status: "missing" });

    const conflict = await setup([
      { contains: 'from "task_definition_crypto_revisions"', rows: [row] },
      { contains: 'from "task_run_result_crypto_revisions"', rows: [row] },
    ]);
    expect(await conflict.store.getRevisionByOperation({
      operationId: "operation:definition:1",
    })).toEqual({ status: "conflict" });

    const unavailable = await setup([
      { contains: 'from "task_definition_crypto_revisions"', rows: [row] },
      { contains: 'from "task_run_result_crypto_revisions"', rows: [] },
    ], null);
    expect(await unavailable.store.getRevisionByOperation({
      operationId: "operation:definition:1",
    })).toEqual({ status: "authority_unavailable" });
  });

  test("maps a foreign-owned ordinary definition to its requester in the protected content CAS", async () => {
    const coordinate = definition();
    const pending = lifecycleRow(coordinate, { lease_is_live: true });
    const complete = lifecycleRow(coordinate, {
      completion: "complete", crypto_completed_at: NOW, lease_is_live: true,
    });
    const product = {
      task_id: TASK_ID, owner_id: FOREIGN_OWNER_ID, requestor_id: OWNER_ID, content_revision: 0,
      task_status: "paused",
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
      ...definitionMappingSteps([{
        contains: 'for update',
        rows: [complete],
        inspect(_parameters, statement) {
          expect(statement).toContain("for update");
        },
      },
      requesterOwner,
      { contains: 'from "tasks"', rows: [product] },
      protectedPublicationPolicy,
      {
        contains: 'update "tasks"',
        rows: [{ task_id: TASK_ID }],
        inspect(parameters, statement) {
          const [assignments, predicate] = statement.split(" where ");
          expect(assignments).toContain('"owner_id" =');
          expect(assignments).toContain('"content_representation" =');
          expect(predicate).toContain('"tasks"."requestor_id"');
          expect(predicate).not.toContain('"tasks"."owner_id"');
          expect(parameters).toContain(OWNER_ID);
          expect(parameters).not.toContain(FOREIGN_OWNER_ID);
          expect(statement).toContain('"prompt"');
          expect(statement).toContain('"expected_output"');
          expect(statement).toContain('"last_error"');
          expect(statement).toContain('"metadata"');
          expect(statement).toContain('"status"');
          expect(statement).toContain("convert_from");
          expect(statement).toContain("::jsonb");
          const encoded = JSON.stringify(parameters);
          expect(parameters.some((parameter) => parameter instanceof Uint8Array
            && new TextDecoder().decode(parameter) === '{"mode":"update","publish":"branch"}')).toBe(true);
          expect(encoded).not.toContain("plaintext-canary");
          expect(encoded).not.toContain("expected-canary");
          expect(encoded).not.toContain("error-canary");
          expect(encoded).not.toContain("metadata-canary");
          expect(encoded).toContain("pending");
        },
      },
      { contains: 'update "task_definition_crypto_revisions"', rows: [{ ...complete, disposition: "mapped" }] },
      ]),
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

  test("rejects initial protected reservation by the old owner when the requester differs", async () => {
    const coordinate = definition();
    const { store, connection } = await setup(definitionReservationSteps([
      ...emptyOperations,
      { contains: 'from "task_definition_crypto_revisions"', rows: [] },
      requesterOwner,
      { contains: 'from "tasks"', rows: [{
        owner_id: OWNER_ID,
        requestor_id: FOREIGN_OWNER_ID,
        task_status: "pending",
        fire_lock_id: null,
        content_namespace_id: null,
        content_revision: 0,
        content_representation: "ordinary",
        crypto_object_id: null,
        crypto_required_namespace_fingerprint: null,
        crypto_mapping_state: "unmapped",
      }] },
    ]));

    expect(await store.reserveRevision(reservation(coordinate))).toEqual({ status: "stale" });
    expect(connection.steps).toHaveLength(0);
  });

  test("rejects an inconsistent protected owner on later revision reservation", async () => {
    const coordinate = definition(2);
    const { store, connection } = await setup(definitionReservationSteps([
      ...emptyOperations,
      { contains: 'from "task_definition_crypto_revisions"', rows: [] },
      requesterOwner,
      { contains: 'from "tasks"', rows: [{
        owner_id: FOREIGN_OWNER_ID,
        requestor_id: OWNER_ID,
        task_status: "pending",
        fire_lock_id: null,
        content_namespace_id: NAMESPACE_ID,
        content_revision: 1,
        content_representation: "protected",
        crypto_object_id: deriveTaskContentCryptoObjectIdV1(definition()),
        crypto_required_namespace_fingerprint: fingerprintTaskContentNamespaceV1(NAMESPACE_ID),
        crypto_mapping_state: "verified",
      }] },
    ]));

    expect(await store.reserveRevision(reservation(coordinate))).toEqual({ status: "stale" });
    expect(connection.steps).toHaveLength(0);
  });

  test("rejects result reservation when the protected parent owner and requester differ", async () => {
    const coordinate = result();
    const { store, connection } = await setup([
      ...emptyOperations,
      { contains: 'from "task_run_result_crypto_revisions"', rows: [] },
      requesterOwner,
      { contains: 'inner join "tasks"', rows: [{
        task_id: TASK_ID,
        owner_id: FOREIGN_OWNER_ID,
        requestor_id: OWNER_ID,
        result_revision: 0,
        result_content_namespace_id: null,
        result_representation: "ordinary",
        result_crypto_object_id: null,
        result_crypto_required_namespace_fingerprint: null,
        result_crypto_mapping_state: "unmapped",
        run_status: "running",
        task_status: "running",
        parent_namespace_id: NAMESPACE_ID,
      }] },
    ]);

    expect(await store.reserveRevision(reservation(coordinate))).toEqual({ status: "stale" });
    expect(connection.steps).toHaveLength(0);
  });

  test("initial protected mapping preserves captured consent but a new definition removes it atomically", async () => {
    for (const revision of [1, 2]) {
      const coordinate = definition(revision);
      const complete = lifecycleRow(coordinate, {
        completion: "complete", crypto_completed_at: NOW, lease_is_live: true,
      });
      const captured = { projectGrantId: "synthetic-project-grant" };
      let savedConsent: typeof captured | null = captured;
      const { store, connection } = await setup(definitionMappingSteps([
        { contains: "for update", rows: [complete] },
        requesterOwner,
        { contains: 'from "tasks"', rows: [{
          task_id: TASK_ID, owner_id: OWNER_ID, requestor_id: OWNER_ID, content_revision: revision - 1,
          task_status: "paused", prompt: "", expected_output: null, last_error: null,
          metadata_json: '{}', content_namespace_id: revision === 1 ? null : NAMESPACE_ID,
          content_representation: revision === 1 ? "ordinary" : "protected",
          crypto_object_id: revision === 1 ? null : deriveTaskContentCryptoObjectIdV1(definition(1)),
          crypto_access_revision: 0,
          crypto_required_namespace_fingerprint: revision === 1 ? null : fingerprintTaskContentNamespaceV1(NAMESPACE_ID),
          crypto_mapping_state: revision === 1 ? "unmapped" : "verified",
        }] },
        protectedPublicationPolicy,
        { contains: 'update "tasks"', rows: [{ task_id: TASK_ID }], inspect(parameters, statement) {
          const assignment = statement.split(" where ")[0]!.match(/"local_execution_delegation" = \$(\d+)/u);
          if (revision === 1) expect(assignment).toBeNull();
          else {
            expect(assignment).not.toBeNull();
            expect(parameters[Number(assignment![1]) - 1]).toBeNull();
            savedConsent = null;
            const assignments = statement.split(" where ")[0]!;
            expect(assignments).toContain('"status" = CASE WHEN');
            expect(assignments).toContain('"tasks"."local_execution_delegation" IS NOT NULL');
            expect(assignments).toContain("THEN 'paused'");
            expect(assignments).toContain('"last_error" = CASE WHEN');
            expect(parameters).toContain(TASK_LOCAL_EXECUTION_RECREATE_TEXT);
            expect(assignments).toContain('"fire_lock_id" = CASE WHEN');
          }
          // The definition transition and consent removal share this exact CAS.
          expect(statement).toContain('"tasks"."content_revision" =');
          if (revision === 1) expect(statement.split(" where ")[0]).toContain('"owner_id" =');
          else expect(statement.split(" where ")[1]).toContain('"tasks"."owner_id" =');
        } },
        { contains: 'update "task_definition_crypto_revisions"', rows: [{ ...complete, disposition: "mapped" }] },
      ]));
      expect(await store.compareAndSwapCryptoMapping({
        coordinate, cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
        expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
        expectedRepresentation: "protected", leaseToken: null,
      })).toBe("applied");
      if (revision === 1) expect(savedConsent).toBe(captured);
      else expect(savedConsent).toBeNull();
      expect(connection.steps).toHaveLength(0);
    }
  });

  test("replaying a mapped protected definition preserves its content-free project repair state", async () => {
    const coordinate = definition(2);
    const complete = lifecycleRow(coordinate, { completion: "complete", crypto_completed_at: NOW, lease_is_live: true });
    const { store, connection } = await setup(definitionMappingSteps([
      { contains: "for update", rows: [complete] }, requesterOwner,
      { contains: 'from "tasks"', rows: [{ task_id: TASK_ID, owner_id: OWNER_ID, requestor_id: OWNER_ID,
        task_status: "paused", content_revision: 2, content_namespace_id: NAMESPACE_ID,
        content_representation: "protected", crypto_object_id: deriveTaskContentCryptoObjectIdV1(coordinate),
        crypto_mapping_state: "verified", crypto_required_namespace_fingerprint: fingerprintTaskContentNamespaceV1(NAMESPACE_ID),
        prompt: "", expected_output: null, last_error: TASK_LOCAL_EXECUTION_RECREATE_TEXT,
        metadata_json: '{"mode":"update","publish":"branch"}',
      }] },
      { contains: 'update "task_definition_crypto_revisions"', rows: [{ ...complete, disposition: "mapped" }] },
    ]));
    expect(await store.compareAndSwapCryptoMapping({ coordinate,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
      expectedRepresentation: "protected", leaseToken: null })).toBe("duplicate");
    // No Task write or automatic re-enrollment occurs on replay.
    expect(connection.steps).toHaveLength(0);
  });

  test("does not accept a protected definition duplicate with a mismatched owner", async () => {
    const coordinate = definition(2);
    const complete = lifecycleRow(coordinate, {
      completion: "complete", crypto_completed_at: NOW, lease_is_live: true,
    });
    const { store, connection } = await setup(definitionMappingSteps([
      { contains: "for update", rows: [complete] },
      requesterOwner,
      { contains: 'from "tasks"', rows: [{
        task_id: TASK_ID,
        owner_id: FOREIGN_OWNER_ID,
        requestor_id: OWNER_ID,
        task_status: "paused",
        content_revision: 2,
        content_namespace_id: NAMESPACE_ID,
        content_representation: "protected",
        crypto_object_id: deriveTaskContentCryptoObjectIdV1(coordinate),
        crypto_mapping_state: "verified",
        crypto_required_namespace_fingerprint: fingerprintTaskContentNamespaceV1(NAMESPACE_ID),
        prompt: "",
        expected_output: null,
        last_error: null,
        metadata_json: '{"mode":"update","publish":"branch"}',
      }] },
      protectedPublicationPolicy,
      { contains: 'update "tasks"', rows: [] },
      { contains: 'update "task_definition_crypto_revisions"', rows: [{
        ...complete, disposition: "stale_mapping", failure_code: "mapping_conflict",
      }] },
    ]));

    expect(await store.compareAndSwapCryptoMapping({
      coordinate,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
      expectedRepresentation: "protected",
      leaseToken: null,
    })).toBe("stale");
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
    const { store, connection } = await setup(definitionMappingSteps([
      { contains: 'for update', rows: [complete] },
      { contains: 'update "task_definition_crypto_revisions"', rows: [{
        ...complete, disposition: "stale_mapping", failure_code: "authority_stale",
      }] },
    ]), changed);
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
    const activeConnection: { current?: ScriptedConnection } = {};
    const { store, connection } = await setup([
      {
        contains: 'from "task_run_result_crypto_revisions"',
        rows: [complete],
        inspect(_parameters, statement) {
          expect(statement).not.toContain("for update");
        },
      },
      {
        contains: 'from "encryption_transition_policy"',
        rows: [{ mode: "encrypted_only", revision: 1 }],
        inspect(_parameters, statement) {
          expect(statement).toContain("for share");
          expect(activeConnection.current?.transactionDepth).toBe(1);
          expect(activeConnection.current?.productUpdateLocks).toBe(0);
        },
      },
      {
        contains: 'from "tasks"',
        rows: [{
          owner_id: OWNER_ID, requestor_id: OWNER_ID, namespace_id: NAMESPACE_ID,
          task_status: "completed",
        }],
        inspect(parameters, statement) {
          expect(statement).toContain("for update");
          expect(parameters).toContain(TASK_ID);
        },
      },
      {
        contains: 'from "task_runs"',
        rows: [{
          task_id: TASK_ID, task_run_id: RUN_ID, result_revision: 0,
          run_status: "completed",
          result_content_namespace_id: null, result_representation: "ordinary",
          crypto_object_id: null, crypto_access_revision: 0,
          crypto_required_namespace_fingerprint: null,
          crypto_mapping_state: "unmapped",
        }],
        inspect(parameters, statement) {
          expect(statement).toContain("for update");
          expect(parameters).toContain(RUN_ID);
          expect(parameters).toContain(TASK_ID);
        },
      },
      {
        contains: 'from "task_run_result_crypto_revisions"',
        rows: [complete],
        inspect(_parameters, statement) {
          expect(statement).toContain("for update");
        },
      },
      requesterOwner,
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
    ], () => {
      expect(activeConnection.current?.transactionDepth).toBe(0);
      expect(activeConnection.current?.productUpdateLocks).toBe(0);
      return authority;
    });
    activeConnection.current = connection;
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
    const { store, connection } = await setup(definitionMappingSteps([
      { contains: 'for update', rows: [complete] },
      requesterOwner,
      { contains: 'from "tasks"', rows: [{
        task_id: TASK_ID, owner_id: OWNER_ID, requestor_id: OWNER_ID, task_status: "cancelled",
        content_revision: 0, prompt: "cancelled", expected_output: null,
        last_error: null, metadata_json: '{}', content_namespace_id: null,
        content_representation: "ordinary", crypto_object_id: null,
        crypto_access_revision: 0,
        crypto_required_namespace_fingerprint: null,
        crypto_mapping_state: "unmapped",
      }] },
      protectedPublicationPolicy,
      { contains: 'update "tasks"', rows: [], inspect(_parameters, statement) {
        expect(statement).toContain('"tasks"."status" in');
      } },
      { contains: 'update "task_definition_crypto_revisions"', rows: [{
        ...complete, disposition: "stale_mapping", failure_code: "mapping_conflict",
      }] },
    ]));
    expect(await store.compareAndSwapCryptoMapping({
      coordinate,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
      expectedRepresentation: "protected",
      leaseToken: null,
    })).toBe("stale");
    expect(connection.steps).toHaveLength(0);
  });

  test("fences definition mapping against policy revision and mode changes", async () => {
    const coordinate = definition();
    const complete = lifecycleRow(coordinate, {
      completion: "complete", crypto_completed_at: NOW, lease_is_live: true,
    });
    for (const policy of [
      { mode: "encrypted_only", revision: 2 },
      { mode: "shadow_encryption", revision: 1 },
      { mode: "plaintext_only", revision: 1 },
    ]) {
      const { store, connection } = await setup([
        { contains: 'from "task_definition_crypto_revisions"', rows: [complete] },
        { contains: 'from "encryption_transition_policy"', rows: [policy], inspect(_parameters, statement) {
          expect(statement).toContain("for share");
        } },
      ]);
      expect(await store.compareAndSwapCryptoMapping({
        coordinate,
        cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
        expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
        expectedRepresentation: "protected",
        leaseToken: null,
      })).toBe("wrong_authority");
      expect(connection.steps).toHaveLength(0);
    }
  });

  test("allows dual mapping only while the exact Shadow policy is locked", async () => {
    const coordinate = definition();
    const complete = lifecycleRow(coordinate, {
      representation: "dual", completion: "complete",
      crypto_completed_at: NOW, lease_is_live: true,
    });
    const { store, connection } = await setup(definitionMappingSteps([
      { contains: 'for update', rows: [complete] },
      requesterOwner,
      { contains: 'from "tasks"', rows: [{
        task_id: TASK_ID, owner_id: OWNER_ID, requestor_id: OWNER_ID, content_revision: 0,
        task_status: "paused", prompt: "ordinary", expected_output: null,
        last_error: null, metadata_json: '{}', content_namespace_id: null,
        content_representation: "ordinary", crypto_object_id: null,
        crypto_access_revision: 0, crypto_required_namespace_fingerprint: null,
        crypto_mapping_state: "unmapped",
      }] },
      {
        contains: 'from "encryption_transition_policy"',
        rows: [{ mode: "shadow_encryption", revision: 1 }],
        inspect(_parameters, statement) {
          expect(statement).toContain("for share");
        },
      },
      { contains: 'update "tasks"', rows: [{ task_id: TASK_ID }] },
      { contains: 'update "task_definition_crypto_revisions"', rows: [{
        ...complete, disposition: "mapped",
      }] },
    ]));
    expect(await store.compareAndSwapCryptoMapping({
      coordinate,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
      expectedRepresentation: "dual",
      leaseToken: null,
    })).toBe("applied");
    expect(connection.steps).toHaveLength(0);
  });

  test("maps a reserved repair from the exact stale dual receipt while retaining the predecessor ledger", async () => {
    const coordinate = definition(2);
    const complete = lifecycleRow(coordinate, {
      representation: "dual",
      completion: "complete",
      crypto_completed_at: NOW,
      lease_is_live: true,
    });
    const predecessor = lifecycleRow(definition(), {
      representation: "dual",
      completion: "complete",
      disposition: "mapped",
      crypto_completed_at: NOW,
    });
    const source = fallbackSourceRow();
    const { store, connection } = await setup(definitionMappingSteps([
      { contains: "for update", rows: [complete] },
      requesterOwner,
      { contains: 'from "tasks"', rows: [source] },
      {
        contains: 'from "encryption_transition_policy"',
        rows: [{ mode: "shadow_encryption", revision: 1 }],
      },
      { contains: 'from "task_definition_crypto_revisions"', rows: [predecessor] },
      {
        contains: 'update "tasks"',
        rows: [{ task_id: TASK_ID }],
        inspect(_parameters, statement) {
          expect(statement).toContain('"crypto_mapping_state" = $');
          expect(statement).toContain('"ordinary_fallback_operation_id" = $');
          expect(statement).toContain('"ordinary_fallback_request_digest" = $');
        },
      },
      { contains: 'update "task_definition_crypto_revisions"', rows: [{
        ...complete,
        disposition: "mapped",
      }] },
    ]));
    expect(await store.compareAndSwapCryptoMapping({
      coordinate,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
      expectedRepresentation: "dual",
      leaseToken: null,
    })).toBe("applied");
    expect(connection.steps).toHaveLength(0);
  });

  test("allows exact result replay after policy drift but fences a fresh mapping", async () => {
    const coordinate = result();
    const complete = lifecycleRow(coordinate, {
      completion: "complete", crypto_completed_at: NOW, lease_is_live: true,
    });
    const parent = {
      owner_id: OWNER_ID, requestor_id: OWNER_ID, namespace_id: NAMESPACE_ID,
      task_status: "completed",
    };
    const stalePolicy: Step = {
      contains: 'from "encryption_transition_policy"',
      rows: [{ mode: "encrypted_only", revision: 2 }],
      inspect(_parameters, statement) {
        expect(statement).toContain("for share");
      },
    };
    const duplicateRun = {
      task_id: TASK_ID, task_run_id: RUN_ID, result_revision: 1,
      run_status: "completed",
      result_content_namespace_id: NAMESPACE_ID,
      result_representation: "protected",
      crypto_object_id: deriveTaskContentCryptoObjectIdV1(coordinate),
      crypto_access_revision: 0,
      crypto_required_namespace_fingerprint: fingerprintTaskContentNamespaceV1(NAMESPACE_ID),
      crypto_mapping_state: "verified",
    };
    const replay = await setup([
      { contains: 'from "task_run_result_crypto_revisions"', rows: [complete] },
      stalePolicy,
      { contains: 'from "tasks"', rows: [parent] },
      { contains: 'from "task_runs"', rows: [duplicateRun] },
      { contains: 'from "task_run_result_crypto_revisions"', rows: [complete] },
      requesterOwner,
      { contains: 'update "task_run_result_crypto_revisions"', rows: [{
        ...complete, disposition: "mapped",
      }] },
    ]);
    expect(await replay.store.compareAndSwapCryptoMapping({
      coordinate,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
      expectedRepresentation: "protected",
      leaseToken: null,
    })).toBe("duplicate");
    expect(replay.connection.steps).toHaveLength(0);

    const fresh = await setup([
      { contains: 'from "task_run_result_crypto_revisions"', rows: [complete] },
      stalePolicy,
      { contains: 'from "tasks"', rows: [parent] },
      { contains: 'from "task_runs"', rows: [{
        ...duplicateRun,
        result_revision: 0,
        result_content_namespace_id: null,
        result_representation: "ordinary",
        crypto_object_id: null,
        crypto_required_namespace_fingerprint: null,
        crypto_mapping_state: "unmapped",
      }] },
      { contains: 'from "task_run_result_crypto_revisions"', rows: [complete] },
      requesterOwner,
      { contains: 'update "task_run_result_crypto_revisions"', rows: [{
        ...complete, disposition: "stale_mapping", failure_code: "authority_stale",
      }] },
    ]);
    expect(await fresh.store.compareAndSwapCryptoMapping({
      coordinate,
      cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
      expectedRepresentation: "protected",
      leaseToken: null,
    })).toBe("wrong_authority");
    expect(fresh.connection.steps).toHaveLength(0);
  });

  test("refuses result mapping after the TaskRun is cancelled", async () => {
    const coordinate = result();
    const complete = lifecycleRow(coordinate, {
      completion: "complete", crypto_completed_at: NOW, lease_is_live: true,
    });
    const { store, connection } = await setup([
      {
        contains: 'from "task_run_result_crypto_revisions"',
        rows: [complete],
        inspect(_parameters, statement) {
          expect(statement).not.toContain("for update");
        },
      },
      protectedPublicationPolicy,
      { contains: 'from "tasks"', rows: [{
        owner_id: OWNER_ID, requestor_id: OWNER_ID, namespace_id: NAMESPACE_ID,
        task_status: "running",
      }], inspect(_parameters, statement) {
        expect(statement).toContain("for update");
      } },
      { contains: 'from "task_runs"', rows: [{
        task_id: TASK_ID, task_run_id: RUN_ID, run_status: "cancelled",
        result_revision: 0, result_content_namespace_id: null,
        result_representation: "ordinary", crypto_object_id: null,
        crypto_access_revision: 0,
        crypto_required_namespace_fingerprint: null,
        crypto_mapping_state: "unmapped",
      }], inspect(_parameters, statement) {
        expect(statement).toContain("for update");
      } },
      { contains: 'from "task_run_result_crypto_revisions"', rows: [complete] },
      requesterOwner,
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

  test("rejects a result lifecycle substituted after authority resolution", async () => {
    const coordinate = result();
    const observed = lifecycleRow(coordinate, {
      completion: "complete", crypto_completed_at: NOW, lease_is_live: true,
    });
    const substituted = lifecycleRow(coordinate, {
      completion: "complete", crypto_completed_at: NOW, lease_is_live: true,
      request_digest: new Uint8Array(32).fill(0x61),
    });
    const { store, connection } = await setup([
      { contains: 'from "task_run_result_crypto_revisions"', rows: [observed] },
      protectedPublicationPolicy,
      { contains: 'from "tasks"', rows: [{
        owner_id: OWNER_ID, requestor_id: OWNER_ID, namespace_id: NAMESPACE_ID,
        task_status: "completed",
      }] },
      { contains: 'from "task_runs"', rows: [{
        task_id: TASK_ID, task_run_id: RUN_ID, result_revision: 0,
        run_status: "completed", result_content_namespace_id: null,
        result_representation: "ordinary", crypto_object_id: null,
        crypto_access_revision: 0,
        crypto_required_namespace_fingerprint: null,
        crypto_mapping_state: "unmapped",
      }] },
      { contains: 'from "task_run_result_crypto_revisions"', rows: [substituted] },
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

  test("claims only an exact due coordinate and operation", async () => {
    const coordinate = definition();
    const due = lifecycleRow(coordinate);
    const leased = lifecycleRow(coordinate, {
      lease_token: LEASE_ID,
      lease_expires_at: new Date("2026-09-22T12:01:00.000Z"),
    });
    const { store, connection } = await setup([
      {
        contains: 'from "task_definition_crypto_revisions"',
        rows: [due],
        inspect(_parameters, statement) {
          expect(statement).not.toContain("for update");
        },
      },
      {
        contains: 'from "task_definition_crypto_revisions"',
        rows: [due],
        inspect(parameters, statement) {
          expect(statement).toContain("for update");
          expect(parameters).toContain(TASK_ID);
          expect(parameters).toContain(1);
        },
      },
      {
        contains: 'update "task_definition_crypto_revisions"',
        rows: [leased],
        inspect(parameters, statement) {
          expect(statement).toContain('"operation_id" =');
          expect(statement).toContain('"attempt_count" <');
          expect(statement).toContain('"next_attempt_at" <= CURRENT_TIMESTAMP');
          expect(parameters).toContain("operation:definition:1");
          expect(parameters).toContain(TASK_ID);
          expect(parameters).toContain(1);
        },
      },
      { contains: 'from "tasks"', rows: [] },
    ]);

    const claimed = await store.claimReconciliationCoordinate({
      coordinate,
      operationId: "operation:definition:1",
      leaseToken: LEASE_ID,
    });

    expect(claimed?.lifecycle).toMatchObject({
      coordinate,
      operationId: "operation:definition:1",
      leaseToken: LEASE_ID,
    });
    expect(connection.steps).toHaveLength(0);
    expect(connection.isolations).toEqual(["serializable", "read committed"]);
  });

  test("does not claim a coordinate for a different operation or live lease", async () => {
    const coordinate = definition();
    const due = lifecycleRow(coordinate);
    const wrongOperation = await setup([
      { contains: 'from "task_definition_crypto_revisions"', rows: [due] },
    ]);
    expect(await wrongOperation.store.claimReconciliationCoordinate({
      coordinate,
      operationId: "operation:definition:2",
      leaseToken: LEASE_ID,
    })).toBeNull();
    expect(wrongOperation.connection.steps).toHaveLength(0);

    const leasedElsewhere = lifecycleRow(coordinate, {
      lease_token: "10000000-0000-4000-8000-000000000009",
      lease_expires_at: new Date("2026-09-22T12:01:00.000Z"),
    });
    const unavailable = await setup([
      { contains: 'from "task_definition_crypto_revisions"', rows: [leasedElsewhere] },
      { contains: 'from "task_definition_crypto_revisions"', rows: [leasedElsewhere] },
      {
        contains: 'update "task_definition_crypto_revisions"',
        rows: [],
        inspect(_parameters, statement) {
          expect(statement).toContain('"lease_token" is null');
          expect(statement).toContain('"lease_expires_at" <= CURRENT_TIMESTAMP');
        },
      },
    ]);
    expect(await unavailable.store.claimReconciliationCoordinate({
      coordinate,
      operationId: "operation:definition:1",
      leaseToken: LEASE_ID,
    })).toBeNull();
    expect(unavailable.connection.steps).toHaveLength(0);

    const sameLease = await setup([
      {
        contains: 'from "task_definition_crypto_revisions"',
        rows: [{ ...leasedElsewhere, lease_token: LEASE_ID }],
      },
      {
        contains: 'from "task_definition_crypto_revisions"',
        rows: [{ ...leasedElsewhere, lease_token: LEASE_ID, lease_is_live: true }],
      },
      { contains: 'from "tasks"', rows: [] },
    ]);
    expect(await sameLease.store.claimReconciliationCoordinate({
      coordinate,
      operationId: "operation:definition:1",
      leaseToken: LEASE_ID,
    })).toMatchObject({ lifecycle: { leaseToken: LEASE_ID } });
    expect(sameLease.connection.steps).toHaveLength(0);
  });

  test("returns an exact mapped coordinate without acquiring another lease", async () => {
    const coordinate = definition();
    const mapped = lifecycleRow(coordinate, {
      completion: "complete",
      disposition: "mapped",
      next_attempt_at: null,
      crypto_completed_at: NOW,
    });
    const product = {
      task_id: TASK_ID,
      owner_id: OWNER_ID,
      requestor_id: OWNER_ID,
      task_status: "completed",
      prompt: "",
      expected_output: null,
      last_error: null,
      metadata_json: '{"mode":"update","publish":"branch"}',
      content_revision: 1,
      content_namespace_id: NAMESPACE_ID,
      content_representation: "protected",
      crypto_object_id: deriveTaskContentCryptoObjectIdV1(coordinate),
      crypto_access_revision: 0,
      crypto_required_namespace_fingerprint:
        fingerprintTaskContentNamespaceV1(NAMESPACE_ID),
      crypto_mapping_state: "verified",
    };
    const { store, connection } = await setup([
      { contains: 'from "task_definition_crypto_revisions"', rows: [mapped] },
      { contains: 'from "task_definition_crypto_revisions"', rows: [mapped] },
      { contains: 'from "tasks"', rows: [product] },
    ]);

    const replay = await store.claimReconciliationCoordinate({
      coordinate,
      operationId: "operation:definition:1",
      leaseToken: LEASE_ID,
    });

    expect(replay?.lifecycle).toMatchObject({
      disposition: "mapped",
      leaseToken: null,
    });
    expect(replay?.product).toMatchObject({
      coordinate,
      cryptoMappingState: "verified",
    });
    expect(connection.steps).toHaveLength(0);
  });

  test("rejects an immutable lifecycle substitution after authority resolution", async () => {
    const coordinate = definition();
    const observed = lifecycleRow(coordinate);
    const substituted = lifecycleRow(coordinate, {
      request_digest: new Uint8Array(32).fill(0x61),
    });
    const { store, connection } = await setup([
      { contains: 'from "task_definition_crypto_revisions"', rows: [observed] },
      { contains: 'from "task_definition_crypto_revisions"', rows: [substituted] },
    ]);

    expect(await store.claimReconciliationCoordinate({
      coordinate,
      operationId: "operation:definition:1",
      leaseToken: LEASE_ID,
    })).toBeNull();
    expect(connection.steps).toHaveLength(0);
  });
});


describe("authorized historical Task mapping", () => {
  const provenance = Object.freeze({ version: 1 as const, claimId: LEASE_ID,
    publisherDeviceId: "historical-device", signedRequestDigest: "07".repeat(32),
    sourceDigest: "0c".repeat(32), sourcePayloadHash: "0d".repeat(32), sourceRevision: 0 as const });
  const policy: Step = { contains: 'from "encryption_transition_policy"',
    rows: [{ mode: "shadow_encryption", revision: 1 }] };
  function complete(coordinate: TaskContentCoordinateV1) {
    return lifecycleRow(coordinate, { representation: "dual", completion: "complete",
      crypto_completed_at: NOW, lease_is_live: true, historical_repair: provenance });
  }
  function ordinaryDefinition(status: string) {
    return { task_id: TASK_ID, owner_id: OWNER_ID, requestor_id: OWNER_ID,
      task_status: status, prompt: "historical prompt", expected_output: "expected",
      last_error: null, metadata_json: '{}', content_revision: 0,
      content_namespace_id: null, content_representation: "ordinary", crypto_object_id: null,
      crypto_access_revision: 0, crypto_required_namespace_fingerprint: null, crypto_mapping_state: "unmapped" };
  }
  const mapping = (coordinate: TaskContentCoordinateV1) => ({ coordinate,
    cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
    expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
    expectedRepresentation: "dual" as const, leaseToken: null });

  test("generic background mapping waits without quarantining a historical source", async () => {
    const coordinate = definition();
    const { store, connection } = await setup([{ contains: 'from "task_definition_crypto_revisions"', rows: [complete(coordinate)] }]);
    await rejects(() => store.compareAndSwapCryptoMapping(mapping(coordinate)),
      TaskHistoricalRepairPublicationUnavailableError);
    expect(connection.steps).toHaveLength(0);
  });

  test.each(["pending", "paused", "completed", "errored", "cancelled"])("historical definition preserves %s lifecycle and plaintext siblings", async status => {
    const coordinate = definition();
    const row = complete(coordinate);
    const source = ordinaryDefinition(status);
    const connection = new ScriptedConnection(definitionMappingSteps([
      policy, { contains: 'from "tasks"', rows: [source] },
      { contains: "for update", rows: [row] }, requesterOwner,
      { contains: 'from "tasks"', rows: [source] }, policy,
      { contains: 'update "tasks"', rows: [{ task_id: TASK_ID }], inspect(_parameters, statement) {
        const assignments = statement.split(" where ")[0]!;
        for (const column of ["status", "prompt", "expected_output", "last_error", "metadata", "next_fire_at", "cancelled_at"]) {
          expect(assignments).not.toContain(`"${column}" =`);
        }
      } },
      { contains: 'update "task_definition_crypto_revisions"', rows: [{ ...row, disposition: "mapped" }] },
    ]));
    const handle = await verifyConversationProductPostgresHandle(connection);
    let validations = 0;
    const store = new PostgresTaskContentProductStore(handle, () => authority, undefined, undefined,
      async (_transaction, input) => {
        expect(input.phase).toBe("mapping");
        expect(input.provenance).toEqual(provenance);
        validations += 1;
        return true;
      });
    expect(await store.compareAndSwapCryptoMapping(mapping(coordinate))).toBe("applied");
    expect(validations).toBe(1);
    expect(connection.steps).toHaveLength(0);
  });

  test("changed historical source waits before any product or ledger mutation", async () => {
    const coordinate = definition();
    const connection = new ScriptedConnection(definitionMappingSteps([
      policy, { contains: 'from "tasks"', rows: [ordinaryDefinition("completed")] },
      { contains: "for update", rows: [complete(coordinate)] }, requesterOwner,
    ]));
    const handle = await verifyConversationProductPostgresHandle(connection);
    const store = new PostgresTaskContentProductStore(handle, () => authority,
      undefined, undefined, async () => false);
    await rejects(() => store.compareAndSwapCryptoMapping(mapping(coordinate)),
      TaskHistoricalRepairPublicationUnavailableError);
    expect(connection.steps).toHaveLength(0);
  });

  test("source-versioned history maps exact retained bytes under a compatible current policy", async () => {
    const coordinate = definition();
    const historical = { ...provenance, version: 2 as const,
      genesisManifestHash: "0e".repeat(32) };
    const cryptoObjectId = deriveTaskHistoricalContentCryptoObjectIdV1({
      coordinate, namespaceId: NAMESPACE_ID, sourceDigest: new Uint8Array(32).fill(0x0c),
    });
    const row = lifecycleRow(coordinate, { representation: "dual", completion: "complete",
      crypto_completed_at: NOW, lease_is_live: true, historical_repair: historical,
      crypto_object_id: cryptoObjectId });
    const source = ordinaryDefinition("completed");
    const currentPolicy: Step = { contains: 'from "encryption_transition_policy"',
      rows: [{ mode: "shadow_encryption", revision: 2 }] };
    const connection = new ScriptedConnection(definitionMappingSteps([
      { contains: 'from "task_definition_crypto_revisions"', rows: [row] },
      currentPolicy, { contains: 'from "tasks"', rows: [source] },
      { contains: "for update", rows: [row] }, requesterOwner,
      { contains: 'from "tasks"', rows: [source] }, currentPolicy,
      { contains: 'update "tasks"', rows: [{ task_id: TASK_ID }] },
      { contains: 'update "task_definition_crypto_revisions"', rows: [{ ...row, disposition: "mapped" }] },
    ]));
    const store = new PostgresTaskContentProductStore(
      await verifyConversationProductPostgresHandle(connection),
      () => ({ ...authority, expectedPolicyRevision: 2 }), undefined, undefined,
      async (_tx, proof) => {
        expect(proof.provenance).toEqual(historical);
        expect(proof.currentAuthority.expectedPolicyRevision).toBe(2);
        return true;
      },
    );
    expect(await store.compareAndSwapCryptoMapping({ ...mapping(coordinate), cryptoObjectId }))
      .toBe("applied");
    expect(connection.steps).toHaveLength(0);
  });

  test("legacy cancelled result maps to revision one while retaining its terminal status", async () => {
    const coordinate = result();
    const row = complete(coordinate);
    const connection = new ScriptedConnection([
      { contains: 'from "task_run_result_crypto_revisions"', rows: [row] }, policy,
      { contains: 'from "tasks"', rows: [{ owner_id: OWNER_ID, requestor_id: OWNER_ID,
        namespace_id: NAMESPACE_ID, task_status: "cancelled" }] },
      { contains: 'from "task_runs"', rows: [{ task_id: TASK_ID, task_run_id: RUN_ID,
        run_status: "cancelled", result_revision: 0, result_content_namespace_id: null,
        result_representation: "ordinary", crypto_object_id: null, crypto_access_revision: 0,
        crypto_required_namespace_fingerprint: null, crypto_mapping_state: "unmapped" }] },
      { contains: 'from "task_run_result_crypto_revisions"', rows: [row] }, requesterOwner,
      { contains: 'update "task_runs"', rows: [{ task_run_id: RUN_ID }], inspect(parameters, statement) {
        const assignments = statement.split(" where ")[0]!;
        expect(assignments).not.toContain('"status" =');
        expect(assignments).not.toContain('"result_text" =');
        expect(assignments).not.toContain('"last_error" =');
        expect(parameters).toContain(1);
        expect(parameters).toContain("cancelled");
      } },
      { contains: 'update "task_run_result_crypto_revisions"', rows: [{ ...row, disposition: "mapped" }] },
    ]);
    const handle = await verifyConversationProductPostgresHandle(connection);
    const store = new PostgresTaskContentProductStore(handle, () => authority,
      undefined, undefined, async () => true);
    expect(await store.compareAndSwapCryptoMapping(mapping(coordinate))).toBe("applied");
    expect(connection.steps).toHaveLength(0);
  });
});

// Genuine inspector custody is required even when a caller knows every public coordinate.
test("foreground restart mapping consumes only the authenticated rewrapped head and fences current mode", async () => {
  const { fixture, authority: original } = await import("../fixtures/task-content-crypto-completion.ts");
  const { withVerifiedForegroundTaskDefinitionPublication } = await import("../../src/server/task/postgres-foreground-task-definition-inspector.ts");
  const f = await fixture("foreground");
  await f.adapter.complete(f.prepared); f.rewrapHuman(3);
  const current = { ...original, expectedAccessRevision: 3, expectedPolicyRevision: 4 };
  const coordinate = f.prepared.coordinate;
  const complete = lifecycleRow(coordinate, {
    requester_human_id: current.requesterHumanId, content_namespace_id: current.namespaceId,
    request_digest: f.connection.state.manifests.get(0)!["manifest_hash"],
    authority_fingerprint: fingerprintTaskContentAuthorityV1(original),
    required_namespace_fingerprint: fingerprintTaskContentNamespaceV1(current.namespaceId),
    completion: "complete", crypto_completed_at: NOW,
  });
  const product = { task_id: coordinate.taskId, owner_id: OWNER_ID, requestor_id: OWNER_ID,
    content_revision: 0, task_status: "paused", content_namespace_id: null,
    content_representation: "ordinary", crypto_object_id: null, crypto_access_revision: 0,
    crypto_required_namespace_fingerprint: null, crypto_mapping_state: "unmapped" };
  const policy: Step = { contains: 'from "encryption_transition_policy"', rows: [{ mode: "encrypted_only", revision: 4 }] };
  const common: readonly Step[] = [{ contains: 'from "task_definition_crypto_revisions"', rows: [complete] }, policy, { contains: 'from "tasks"', rows: [product] },
    { contains: 'from "task_definition_crypto_revisions"', rows: [complete] }];
  await withVerifiedForegroundTaskDefinitionPublication({ handle: f.handle, crypto: f.crypto,
    taskId: coordinate.taskId, expectedAgentId: "task-agent", currentAuthority: current,
    payload: { formatVersion: 1, prompt: "Native definition", expectedOutput: null, protectedMetadata: {} },
    ...f.history, assertCurrent: async () => {}, entities: {
      signal: new AbortController().signal, useCurrentSet: async () => { throw new Error("No encryption"); },
      use: async request => ({ status: "executed", value: await request.execute({ namespaceKey: new Uint8Array(32).fill(0x52),
        authority: { namespaceId: current.namespaceId, domainId: current.domainId,
          namespaceAccessRevision: 3, namespaceKeyGeneration: 5, domainKeyGeneration: 1, domainAuthorizationRevision: 2,
          domainHeadDigest: new Uint8Array(32), namespaceHeadDigest: new Uint8Array(32),
          namespacePublicationDigest: new Uint8Array(32), namespacePublicationSetDigest: new Uint8Array(32),
          namespaceAudienceFingerprint: new Uint8Array(32) } }) }),
    }, use: async proof => {
      const mapped = await setup([...common, policy, requesterOwner,
        { contains: 'from "tasks"', rows: [product] }, policy,
        { contains: 'update "tasks"', rows: [{ task_id: coordinate.taskId }], inspect(parameters, statement) {
          const match = /"crypto_access_revision" = \$(\d+)/.exec(statement);
          expect(match).not.toBeNull(); expect(parameters[Number(match![1]) - 1]).toBe(1);
        } }, { contains: 'update "task_definition_crypto_revisions"', rows: [{ ...complete, disposition: "mapped" }] }], current);
      const request = { coordinate, cryptoObjectId: f.prepared.objectId,
        expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(original), expectedRepresentation: "protected" as const,
        leaseToken: null, foregroundDefinitionProof: proof };
      expect(await mapped.store.compareAndSwapCryptoMapping(request)).toBe("applied");
      expect(mapped.connection.steps).toHaveLength(0);
      const forged = await setup(common, current);
      await rejects(forged.store.compareAndSwapCryptoMapping({ ...request,
        foregroundDefinitionProof: { kind: "verified_foreground_task_definition" } }), /foreign/);
      for (const mappedMetadataProof of [proof, { kind: "verified_foreground_task_definition" as const }]) {
        const metadata = await setup([], current);
        await rejects(metadata.store.compareAndSwapCryptoMapping({ coordinate, cryptoObjectId: f.prepared.objectId,
          expectedAuthorityFingerprint: request.expectedAuthorityFingerprint, expectedRepresentation: "protected",
          leaseToken: null, mappedMetadataProof }), /authentic|foreign/);
        expect(metadata.connection.statements).toHaveLength(0);
      }
      const incompatible = await setup([common[0]!, { ...policy, rows: [{ mode: "plaintext_only", revision: 4 }] }], current);
      expect(await incompatible.store.compareAndSwapCryptoMapping(request)).toBe("wrong_authority");
      expect(incompatible.connection.steps).toHaveLength(0);
      for (const representation of ["protected", "dual"] as const) {
        const mappedLifecycle = { ...complete, representation, disposition: "mapped", operational_metadata: '{}' };
        const mappedProduct = { ...product, content_revision: 1, task_status: "completed",
          content_namespace_id: current.namespaceId, content_representation: representation,
          crypto_object_id: f.prepared.objectId, crypto_mapping_state: "verified",
          crypto_required_namespace_fingerprint: fingerprintTaskContentNamespaceV1(current.namespaceId),
          prompt: representation === "dual" ? "Native definition" : "", expected_output: null,
          last_error: null, metadata_json: '{}' };
        const refreshPolicy: Step = { ...policy, rows: [{ mode: representation === "dual" ? "shadow_encryption" : "encrypted_only", revision: 4 }] };
        const refreshSteps = (row = mappedProduct): Step[] => [
          { contains: 'from "task_definition_crypto_revisions"', rows: [mappedLifecycle] }, refreshPolicy,
          { contains: 'from "tasks"', rows: [row] },
          { contains: 'from "task_definition_crypto_revisions"', rows: [mappedLifecycle] }, refreshPolicy, requesterOwner,
          { contains: 'from "tasks"', rows: [row] },
        ];
        const refreshRequest = { ...request, expectedRepresentation: representation };
        const refreshed = await setup([...refreshSteps(), {
          contains: 'update "tasks"', rows: [{ task_id: coordinate.taskId }], inspect(parameters, statement) {
            expect(statement.split(" where ")[0]).toBe('update "tasks" set "crypto_access_revision" = $1');
            expect(parameters[0]).toBe(1);
            expect(statement).toContain('"tasks"."content_revision" =');
            expect(statement).toContain('"tasks"."crypto_access_revision" =');
          },
        }], current);
        expect(await refreshed.store.compareAndSwapCryptoMapping(refreshRequest)).toBe("applied");
        expect(refreshed.connection.steps).toHaveLength(0);
        expect(refreshed.connection.statements.findIndex(sql => sql.includes('from "encryption_transition_policy"')))
          .toBeLessThan(refreshed.connection.statements.findIndex(sql => sql.includes('from "tasks"')));
        const replay = await setup(refreshSteps({ ...mappedProduct, crypto_access_revision: 1 }), current);
        expect(await replay.store.compareAndSwapCryptoMapping(refreshRequest)).toBe("duplicate");
        expect(replay.connection.steps).toHaveLength(0);
        for (const change of [{ crypto_object_id: 'another-object' }, { content_revision: 2 },
          { owner_id: FOREIGN_OWNER_ID }, { content_namespace_id: NAMESPACE_ID },
          { crypto_required_namespace_fingerprint: new Uint8Array(32) }, { crypto_access_revision: 2 }]) {
          const refused = await setup(refreshSteps({ ...mappedProduct, ...change }), current);
          expect(await refused.store.compareAndSwapCryptoMapping(refreshRequest)).toBe("stale");
          expect(refused.connection.steps).toHaveLength(0);
          expect(refused.connection.statements.some(sql => sql.startsWith('update '))).toBe(false);
        }
        if (representation === "dual") {
          const changedSource = await setup(refreshSteps({ ...mappedProduct, prompt: "Changed sibling" }), current);
          await rejects(changedSource.store.compareAndSwapCryptoMapping(refreshRequest), /ordinary definition changed/);
          expect(changedSource.connection.steps).toHaveLength(0);
        }
      }
    } });
});
