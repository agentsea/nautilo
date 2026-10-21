import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  agents,
  actors,
  acceptProtectedTaskHumanContinuation,
  readProtectedTaskPendingAttentionCandidate,
  resolveParkedProtectedTaskHumanContinuationAcceptance,
  sealProtectedTaskHumanApprovalPolicy,
  PROTECTED_TASK_HUMAN_APPROVAL_POLICY_METADATA_KEY,
  PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY,
  createDirectDb,
  cryptoObjects,
  eq,
  encryptionTransitionPolicy,
  jobs,
  getUnstartedProtectedTaskRunRecoveryBoundary,
  listUnstartedProtectedTaskRunRecoveryCandidates,
  lockParkedProtectedTaskAdditionalAuthority,
  namespaces,
  protectedTaskContinuationReceipts,
  protectedTaskAdditionalAuthorityContinuationFingerprint,
  protectedTaskSemanticAuthorityRequirementsDigest,
  protectedTaskExecutionSegmentReceipts,
  protectedTaskRunOutputBindings,
  protectedTaskHumanContinuationAcceptanceId,
  persistJobInTransaction,
  discoverAcceptedParkedProtectedTaskHumanContinuation,
  readParkedProtectedTaskAdditionalAuthority,
  recoverUnstartedParkedProtectedTaskClaim,
  recoverUnstartedParkedProtectedTaskRun,
  resolveAppDatabaseConnectionString,
  sealAndParkProtectedTaskRun,
  sealAndParkProtectedTaskHumanRun,
  settleCancelledProtectedTaskRunAuthorization,
  startParkedProtectedTaskRunAdditionalAuthoritySegment,
  startParkedProtectedTaskHumanRunSegment,
  sql,
  taskDefinitionCryptoRevisions,
  taskRuns,
  tasks,
  transitionTaskLifecycleTerminal,
  users,
  type ProtectedTaskDurableJobReference,
  type ProtectedTaskHumanContinuationAcceptance,
  type SealAndParkProtectedTaskHumanRunInput,
  type SealAndParkProtectedTaskRunInput,
  type StartParkedProtectedTaskHumanRunSegmentInput,
  type StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
} from "@nautilo/db";
import { protectedTaskRunResultObjectId } from
  "../../src/queries/protected-task-output-binding-identities";
import * as schema from "../../src/schema/index";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

type AdminDb = ReturnType<typeof createDirectDb>;
type ProductDb = ReturnType<typeof createProductDb>;

type Fixture = Readonly<{
  userId: string;
  humanActorId: string;
  agentId: string;
  namespaceId: string;
  taskId: string;
  taskRunId: string;
  jobId: string;
  nextJobId: string;
  alternateNextJobId: string;
  cryptoObjectId: string;
  graphThreadId: string;
  jobReference: ProtectedTaskDurableJobReference;
}>;

function semanticAuthorityRequirements(fixture: Fixture) {
  return Object.freeze([Object.freeze({
    namespaceId: fixture.namespaceId,
    operations: Object.freeze(["decrypt", "encrypt"] as const),
  })]);
}

let admin: AdminDb;
let productA: ProductDb;
let productB: ProductDb;
let originalPolicy: typeof encryptionTransitionPolicy.$inferSelect;

function createProductDb() {
  const client = postgres(resolveAppDatabaseConnectionString(), { max: 1 });
  return Object.assign(drizzle(client, { schema }), {
    end: () => client.end({ timeout: 1 }),
  });
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  admin = createDirectDb(2);
  productA = createProductDb();
  productB = createProductDb();
  const [policy] = await admin.select().from(encryptionTransitionPolicy)
    .where(eq(encryptionTransitionPolicy.id, "server"));
  if (policy === undefined) throw new Error("Fixture policy is missing");
  originalPolicy = policy;
  // Start fixtures intentionally exercise a next segment at revision two.
  // Use a temporary policy only on the explicitly guarded disposable target.
  await admin.update(encryptionTransitionPolicy).set({ mode: "encrypted_only",
    shadowBehavior: "strict", revision: 2,
    shadowEncryptionStartedAt: new Date("2026-10-07T00:00:00.000Z") })
    .where(eq(encryptionTransitionPolicy.id, "server"));
});

afterAll(async () => {
  try {
    if (originalPolicy !== undefined) await admin.update(encryptionTransitionPolicy)
      .set(originalPolicy).where(eq(encryptionTransitionPolicy.id, "server"));
  } finally {
    await Promise.all([productA.end(), productB.end(), admin.end()]);
  }
});

function fixtureIds(): Fixture {
  const taskId = randomUUID();
  const taskRunId = randomUUID();
  const digest = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
  const cryptoObjectId = `task-definition:v1:${digest}`;
  return Object.freeze({
    userId: randomUUID(),
    humanActorId: randomUUID(),
    agentId: randomUUID(),
    namespaceId: randomUUID(),
    taskId,
    taskRunId,
    jobId: randomUUID(),
    nextJobId: randomUUID(),
    alternateNextJobId: randomUUID(),
    cryptoObjectId,
    graphThreadId: `subagent:task-seal-and-park:${taskRunId}`,
    jobReference: Object.freeze({
      kind: "protected_task_run_v1" as const,
      taskId,
      taskRunId,
      inputObjectId: cryptoObjectId,
      resultObjectId: protectedTaskRunResultObjectId(taskId, taskRunId),
      authorizationRequestId: `task-run-authorization:${taskRunId}`,
      policyRevision: 1,
      executionSegment: 1,
    }),
  });
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await admin.delete(tasks).where(eq(tasks.id, fixture.taskId));
  await admin.delete(taskRuns).where(eq(taskRuns.id, fixture.taskRunId));
  await admin.delete(jobs).where(eq(jobs.id, fixture.jobId));
  await admin.delete(jobs).where(eq(jobs.id, fixture.nextJobId));
  await admin.delete(jobs).where(eq(jobs.id, fixture.alternateNextJobId));
  await admin.delete(taskDefinitionCryptoRevisions).where(eq(
    taskDefinitionCryptoRevisions.taskId,
    fixture.taskId,
  ));
  // The parent FK cascade executes as the parent table's owner. Restore the
  // append-only staging ACL within the same operator-only cleanup transaction.
  await admin.transaction(async tx => {
    const [original] = await tx.execute<{ parent_owner: string; allowed: boolean; can_select: boolean }>(sql`
      select pg_get_userbyid(relowner) as parent_owner,
        has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'DELETE') as allowed,
        has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'SELECT') as can_select
      from pg_class where oid = 'public.crypto_objects'::regclass
    `);
    if (original?.parent_owner !== "nautilo") throw new Error("Fixture crypto owner is unexpected");
    if (!original.allowed) await tx.execute(sql`grant delete on public.task_cancellation_crypto_staging_receipts to nautilo`);
    if (!original.can_select) await tx.execute(sql`grant select on public.task_cancellation_crypto_staging_receipts to nautilo`);
    await tx.delete(cryptoObjects).where(eq(cryptoObjects.objectId, fixture.cryptoObjectId));
    if (!original.allowed) await tx.execute(sql`revoke delete on public.task_cancellation_crypto_staging_receipts from nautilo`);
    if (!original.can_select) await tx.execute(sql`revoke select on public.task_cancellation_crypto_staging_receipts from nautilo`);
    const [restored] = await tx.execute<{ allowed: boolean; can_select: boolean }>(sql`
      select has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'DELETE') as allowed,
        has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'SELECT') as can_select
    `);
    if (restored?.allowed !== original.allowed || restored.can_select !== original.can_select) {
      throw new Error("Fixture staging privileges were not restored");
    }
  });
  await admin.delete(namespaces).where(eq(namespaces.id, fixture.namespaceId));
  await admin.delete(actors).where(eq(actors.id, fixture.humanActorId));
  await admin.delete(users).where(eq(users.id, fixture.userId));
  await admin.delete(agents).where(eq(agents.id, fixture.agentId));
}

async function createFixture(options: Readonly<{
  startedJob?: boolean;
}> = {}): Promise<Fixture> {
  const fixture = fixtureIds();
  const fingerprint = new Uint8Array(32).fill(0x41);
  try {
    await admin.insert(users).values({
      id: fixture.userId,
      name: "Protected Task atomic park fixture",
      email: `task-atomic-park-${fixture.userId}@test.local`,
    });
    await admin.insert(actors).values({
      id: fixture.humanActorId,
      ownerId: fixture.userId,
      kind: "user",
      displayName: "Protected Task Human continuation fixture",
    });
    await admin.insert(agents).values({
      id: fixture.agentId,
      handle: `task-atomic-park-${fixture.agentId}`,
    });
    await admin.insert(namespaces).values({
      id: fixture.namespaceId,
      scope: "private",
      label: "Protected Task atomic park fixture",
    });
    await admin.insert(tasks).values({
      id: fixture.taskId,
      ownerId: fixture.userId,
      requestorId: fixture.userId,
      agentId: fixture.agentId,
      prompt: "",
      expectedOutput: null,
      status: "running",
    });
    await admin.insert(cryptoObjects).values({
      objectId: fixture.cryptoObjectId,
      payloadHash: new Uint8Array(32).fill(0x42),
      payloadBytes: new Uint8Array([1]),
    });
    await admin.insert(taskDefinitionCryptoRevisions).values({
      taskId: fixture.taskId,
      contentNamespaceId: fixture.namespaceId,
      contentRevision: 1,
      operationId: `task-atomic-park:${fixture.taskId}`,
      requestDigest: new Uint8Array(32).fill(0x43),
      authorityFingerprint: new Uint8Array(32).fill(0x44),
      requesterHumanId: fixture.userId,
      anchorNamespaceId: fixture.namespaceId,
      cryptoObjectId: fixture.cryptoObjectId,
      representation: "protected",
      requiredNamespaceFingerprint: fingerprint,
      completion: "complete",
      disposition: "mapped",
      nextAttemptAt: null,
      cryptoCompletedAt: new Date(),
    });
    await admin.update(tasks).set({
      contentRepresentation: "protected",
      contentNamespaceId: fixture.namespaceId,
      contentRevision: 1,
      cryptoObjectId: fixture.cryptoObjectId,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: fingerprint,
      cryptoMappingState: "verified",
    }).where(eq(tasks.id, fixture.taskId));
    await admin.insert(jobs).values({
      id: fixture.jobId,
      ownerId: fixture.userId,
      requestorId: fixture.userId,
      laneKey: `task:${fixture.taskId}`,
      type: "foreground",
      status: "running",
      input: fixture.jobReference,
      startedAt: options.startedJob === false
        ? null
        : new Date("2026-10-07T12:00:00.000Z"),
    });
    await admin.insert(taskRuns).values({
      id: fixture.taskRunId,
      taskId: fixture.taskId,
      jobId: fixture.jobId,
      graphThreadId: fixture.graphThreadId,
      status: "running",
    });
    // This database fixture seeds an already-started segment, including the
    // immutable output coordinates which every legitimate start must retain.
    await admin.insert(protectedTaskRunOutputBindings).values({
      taskRunId: fixture.taskRunId, bindingId: `task-run-output:${fixture.taskRunId}`,
      deliveryMode: "none", resultRevision: 1,
      resultOperationId: `task-run-result:${fixture.taskRunId}`,
      resultObjectId: fixture.jobReference.resultObjectId,
      acceptedPolicyRevision: fixture.jobReference.policyRevision,
      acceptedAt: new Date("2026-10-07T11:00:00.000Z"),
    });
    return fixture;
  } catch (error) {
    await cleanupFixture(fixture);
    throw error;
  }
}

function input(fixture: Fixture): SealAndParkProtectedTaskRunInput {
  const requirements = semanticAuthorityRequirements(fixture);
  return {
    park: {
      taskId: fixture.taskId,
      taskRunId: fixture.taskRunId,
      graphThreadId: fixture.graphThreadId,
      jobId: fixture.jobId,
      generation: 1,
      executionSegment: 1,
      interrupts: [{
        id: "interrupt:authority:1",
        kind: "additional_authority",
        requestId: "authority-request:1",
      }],
      parkedAt: new Date("2026-10-07T12:34:56.000Z"),
      jobReference: fixture.jobReference,
    },
    segment: {
      route: "native_langgraph_v1",
      checkpoint: {
        contract: "encrypted_langgraph_v1",
        expectedCheckpointCount: 1,
        checkpointOrderedDigest: new Uint8Array(32).fill(0x51),
        expectedBlobCount: 1,
        blobOrderedDigest: new Uint8Array(32).fill(0x52),
        expectedPendingWriteCount: 0,
        pendingWriteOrderedDigest: new Uint8Array(32).fill(0x55),
      },
    },
    continuation: {
      kind: "pre_effect_interrupt_v1",
      reason: "additional_authority",
      effectDisposition: "not_started_v1",
      interruptId: "interrupt:authority:1",
      operationId: "task-effect:1",
      requestDigest: new Uint8Array(32).fill(0x53),
      requiredAuthorityDigest:
        protectedTaskSemanticAuthorityRequirementsDigest(requirements),
      stableRoutingDigest: new Uint8Array(32).fill(0x54),
      semanticAuthorityRequirements: requirements,
    },
  };
}

function additionalAuthorityReference(
  fixture: Fixture,
): ProtectedTaskDurableJobReference {
  const parked = input(fixture);
  return Object.freeze({
    ...fixture.jobReference,
    authorizationRequestId: "authority-request:1",
    policyRevision: 2,
    executionSegment: 2,
    resumeContinuationFingerprint:
      protectedTaskAdditionalAuthorityContinuationFingerprint({
        taskRunId: fixture.taskRunId,
        executionSegment: 1,
        jobId: fixture.jobId,
        kind: "pre_effect_interrupt_v1",
        reason: "additional_authority",
        effectDisposition: "not_started_v1",
        interruptId: parked.continuation.interruptId,
        operationId: parked.continuation.operationId,
        requestDigest: parked.continuation.requestDigest,
        requiredAuthorityDigest: parked.continuation.requiredAuthorityDigest,
        stableRoutingDigest: parked.continuation.stableRoutingDigest,
      }),
  });
}

async function insertAdditionalAuthorityJob(
  fixture: Fixture,
  jobId = fixture.nextJobId,
): Promise<void> {
  await admin.insert(jobs).values({
    id: jobId,
    ownerId: fixture.userId,
    requestorId: fixture.userId,
    laneKey: `task:${fixture.taskId}`,
    type: "foreground",
    status: "queued",
    input: additionalAuthorityReference(fixture),
  });
}

function additionalAuthorityStartInput(
  fixture: Fixture,
  jobId = fixture.nextJobId,
): StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput {
  const parked = input(fixture);
  return {
    taskId: fixture.taskId,
    taskRunId: fixture.taskRunId,
    graphThreadId: fixture.graphThreadId,
    priorJobId: fixture.jobId,
    jobId,
    generation: parked.park.generation,
    interrupts: parked.park.interrupts,
    parkedAt: parked.park.parkedAt,
    contentRepresentation: "protected",
    contentNamespaceId: fixture.namespaceId,
    contentRevision: 1,
    cryptoObjectId: fixture.cryptoObjectId,
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(0x41),
    priorJobReference: fixture.jobReference,
    jobReference: additionalAuthorityReference(fixture),
    checkpointManifest: parked.segment.checkpoint,
    continuation: {
      interruptId: parked.continuation.interruptId,
      operationId: parked.continuation.operationId,
      requestDigest: parked.continuation.requestDigest,
      requiredAuthorityDigest: parked.continuation.requiredAuthorityDigest,
      stableRoutingDigest: parked.continuation.stableRoutingDigest,
      semanticAuthorityRequirements:
        parked.continuation.semanticAuthorityRequirements,
    },
  };
}

const humanInterrupt = Object.freeze({
  id: "interrupt:approval:1",
  kind: "approval" as const,
  requestId: "approval:1",
  allowedVerbs: Object.freeze(["once", "deny"] as const),
});

function humanParkInput(fixture: Fixture): SealAndParkProtectedTaskHumanRunInput {
  const base = input(fixture);
  return {
    park: { ...base.park, interrupts: [humanInterrupt] },
    segment: base.segment,
    stableRoutingDigest: new Uint8Array(32).fill(0x54),
  };
}

function humanAcceptance(
  fixture: Fixture,
  overrides: Partial<ProtectedTaskHumanContinuationAcceptance> = {},
): ProtectedTaskHumanContinuationAcceptance {
  const acceptedBy = overrides.acceptedBy ?? {
    userId: fixture.userId,
    humanActorId: fixture.humanActorId,
  };
  const interrupt = overrides.interrupt ?? humanInterrupt;
  const response = overrides.response ?? {
    kind: "approval" as const,
    verb: "once" as const,
  };
  const acceptedAt = overrides.acceptedAt
    ?? new Date(humanParkInput(fixture).park.parkedAt.getTime() + 1);
  return {
    acceptanceId: overrides.acceptanceId
      ?? protectedTaskHumanContinuationAcceptanceId({
        taskId: fixture.taskId,
        taskRunId: fixture.taskRunId,
        priorJobId: fixture.jobId,
        executionSegment: 1,
        acceptedBy,
        interrupt,
        response,
      }),
    acceptedBy,
    interrupt,
    response,
    acceptedAt,
  };
}

function humanAcceptanceInput(
  fixture: Fixture,
  acceptance = humanAcceptance(fixture),
) {
  const parked = humanParkInput(fixture);
  return {
    taskId: fixture.taskId,
    taskRunId: fixture.taskRunId,
    graphThreadId: fixture.graphThreadId,
    priorJobId: fixture.jobId,
    generation: parked.park.generation,
    executionSegment: parked.park.executionSegment,
    interrupts: parked.park.interrupts,
    parkedAt: parked.park.parkedAt,
    stableRoutingDigest: parked.stableRoutingDigest,
    priorJobReference: fixture.jobReference,
    acceptance,
  } as const;
}

function humanReference(
  fixture: Fixture,
  acceptance = humanAcceptance(fixture),
): ProtectedTaskDurableJobReference {
  return Object.freeze({
    ...fixture.jobReference,
    authorizationRequestId: acceptance.acceptanceId,
    policyRevision: 2,
    executionSegment: 2,
    resumeAcceptanceId: acceptance.acceptanceId,
  });
}

async function insertHumanContinuationJob(
  fixture: Fixture,
  jobId = fixture.nextJobId,
  acceptance = humanAcceptance(fixture),
): Promise<void> {
  await admin.insert(jobs).values({
    id: jobId,
    ownerId: fixture.userId,
    requestorId: fixture.userId,
    laneKey: `task:${fixture.taskId}`,
    type: "foreground",
    status: "queued",
    input: humanReference(fixture, acceptance),
  });
}

function humanStartInput(
  fixture: Fixture,
  jobId = fixture.nextJobId,
  acceptance = humanAcceptance(fixture),
): StartParkedProtectedTaskHumanRunSegmentInput {
  const parked = humanParkInput(fixture);
  return {
    taskId: fixture.taskId,
    taskRunId: fixture.taskRunId,
    graphThreadId: fixture.graphThreadId,
    priorJobId: fixture.jobId,
    jobId,
    generation: parked.park.generation,
    interrupts: parked.park.interrupts,
    parkedAt: parked.park.parkedAt,
    stableRoutingDigest: parked.stableRoutingDigest,
    contentRepresentation: "protected",
    contentNamespaceId: fixture.namespaceId,
    contentRevision: 1,
    cryptoObjectId: fixture.cryptoObjectId,
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(0x41),
    checkpointManifest: parked.segment.checkpoint,
    priorJobReference: fixture.jobReference,
    jobReference: humanReference(fixture, acceptance),
    acceptance,
  };
}

test("product role atomically seals and parks one exact protected execution segment", async () => {
  const fixture = await createFixture();
  try {
    const identities = await Promise.all([productA, productB].map(db => db.execute(sql`
      SELECT current_user::text AS current_user
    `)));
    expect(identities.map(rows => rows[0]?.["current_user"]))
      .toEqual(["nautilo", "nautilo"]);

    const results = await Promise.all([
      sealAndParkProtectedTaskRun(productA, input(fixture)),
      sealAndParkProtectedTaskRun(productB, input(fixture)),
    ]);
    expect(results.map(result => result.status).sort())
      .toEqual(["exact_replay", "parked"]);

    expect(await productA.select().from(protectedTaskExecutionSegmentReceipts)
      .where(eq(
        protectedTaskExecutionSegmentReceipts.taskRunId,
        fixture.taskRunId,
      ))).toHaveLength(1);
    expect(await productA.select().from(protectedTaskContinuationReceipts)
      .where(eq(
        protectedTaskContinuationReceipts.taskRunId,
        fixture.taskRunId,
      ))).toHaveLength(1);
    const [persistedRun] = await productA.select().from(taskRuns)
      .where(eq(taskRuns.id, fixture.taskRunId)).limit(1);
    const [persistedJob] = await productA.select().from(jobs)
      .where(eq(jobs.id, fixture.jobId)).limit(1);
    expect(persistedRun?.status).toBe("awaiting");
    expect(persistedJob?.status).toBe("completed");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("a late park rejection rolls back product-role immutable receipt inserts", async () => {
  const fixture = await createFixture({ startedJob: false });
  try {
    expect(await sealAndParkProtectedTaskRun(productA, input(fixture))).toEqual({
      status: "rejected",
      stage: "park",
      reason: "stale",
    });
    expect(await productA.select().from(protectedTaskExecutionSegmentReceipts)
      .where(eq(
        protectedTaskExecutionSegmentReceipts.taskRunId,
        fixture.taskRunId,
      ))).toEqual([]);
    expect(await productA.select().from(protectedTaskContinuationReceipts)
      .where(eq(
        protectedTaskContinuationReceipts.taskRunId,
        fixture.taskRunId,
      ))).toEqual([]);
    const [persistedRun] = await productA.select().from(taskRuns)
      .where(eq(taskRuns.id, fixture.taskRunId)).limit(1);
    const [persistedJob] = await productA.select().from(jobs)
      .where(eq(jobs.id, fixture.jobId)).limit(1);
    expect(persistedRun?.status).toBe("running");
    expect(persistedJob?.status).toBe("running");
    expect(persistedJob?.completedAt).toBeNull();
  } finally {
    await cleanupFixture(fixture);
  }
});

test("conflicting checkpoint digests race on independent product transactions", async () => {
  const fixture = await createFixture();
  try {
    const left = input(fixture);
    const right: SealAndParkProtectedTaskRunInput = {
      ...input(fixture),
      segment: {
        ...input(fixture).segment,
        checkpoint: {
          ...input(fixture).segment.checkpoint,
          checkpointOrderedDigest: new Uint8Array(32).fill(0x61),
        },
      },
    };
    const results = await Promise.all([
      sealAndParkProtectedTaskRun(productA, left),
      sealAndParkProtectedTaskRun(productB, right),
    ]);
    expect(results.filter(result => result.status === "parked")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected"))
      .toEqual([{ status: "rejected", stage: "segment", reason: "conflict" }]);

    const segments = await productA.select()
      .from(protectedTaskExecutionSegmentReceipts)
      .where(eq(
        protectedTaskExecutionSegmentReceipts.taskRunId,
        fixture.taskRunId,
      ));
    const continuations = await productA.select()
      .from(protectedTaskContinuationReceipts)
      .where(eq(
        protectedTaskContinuationReceipts.taskRunId,
        fixture.taskRunId,
      ));
    expect(segments).toHaveLength(1);
    expect(continuations).toHaveLength(1);
    expect([
      left.segment.checkpoint.checkpointOrderedDigest,
      right.segment.checkpoint.checkpointOrderedDigest,
    ]).toContainEqual(segments[0]!.checkpointDigest);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("cancellation and atomic park serialize without retaining loser receipts", async () => {
  const fixture = await createFixture();
  try {
    const cancelledAt = new Date("2026-10-07T12:34:56.000Z");
    const [parkResult, cancellationResult] = await Promise.all([
      sealAndParkProtectedTaskRun(productA, input(fixture)),
      transitionTaskLifecycleTerminal(productB, {
        taskId: fixture.taskId,
        taskStatus: "cancelled",
        taskPatch: { cancelledAt },
        runId: fixture.taskRunId,
        runStatus: "cancelled",
        runPatch: { completedAt: cancelledAt },
        requireRunningPair: true,
      }),
    ]);
    const segments = await productA.select()
      .from(protectedTaskExecutionSegmentReceipts)
      .where(eq(
        protectedTaskExecutionSegmentReceipts.taskRunId,
        fixture.taskRunId,
      ));
    const continuations = await productA.select()
      .from(protectedTaskContinuationReceipts)
      .where(eq(
        protectedTaskContinuationReceipts.taskRunId,
        fixture.taskRunId,
      ));

    if (parkResult.status === "parked") {
      expect(cancellationResult).toMatchObject({
        transitioned: false,
        outcome: "not_running",
      });
      expect(segments).toHaveLength(1);
      expect(continuations).toHaveLength(1);
    } else {
      expect(parkResult).toEqual({
        status: "rejected",
        stage: "park",
        reason: "stale",
      });
      expect(cancellationResult).toMatchObject({
        transitioned: true,
        outcome: "transitioned",
      });
      expect(segments).toEqual([]);
      expect(continuations).toEqual([]);
    }
  } finally {
    await cleanupFixture(fixture);
  }
});

test("product-role continuation start has one durable next-Job winner", async () => {
  const fixture = await createFixture();
  try {
    // A started segment may already have selected its model before parking.
    await admin.update(taskRuns).set({ modelId: "test:selected-model" })
      .where(eq(taskRuns.id, fixture.taskRunId));
    const discoveryIdentity = {
      taskRunId: fixture.taskRunId,
      authorizationRequestId: "authority-request:1",
    } as const;
    expect(await readParkedProtectedTaskAdditionalAuthority(
      productA,
      discoveryIdentity,
    )).toBeNull();
    expect(await sealAndParkProtectedTaskRun(productA, input(fixture)))
      .toMatchObject({ status: "parked" });
    expect(await readParkedProtectedTaskAdditionalAuthority(
      productA,
      discoveryIdentity,
    )).toMatchObject({
      authorizationRequestId: discoveryIdentity.authorizationRequestId,
      nextExecutionSegment: 2,
      occurrence: {
        task: { id: fixture.taskId, status: "awaiting" },
        run: {
          id: fixture.taskRunId,
          jobId: fixture.jobId,
          status: "awaiting",
        },
      },
      priorJob: { id: fixture.jobId, generation: 1 },
    });
    await insertAdditionalAuthorityJob(fixture);
    const conflict: StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput = {
      ...additionalAuthorityStartInput(fixture),
      checkpointManifest: {
        ...additionalAuthorityStartInput(fixture).checkpointManifest,
        checkpointOrderedDigest: new Uint8Array(32).fill(0x71),
      },
    };
    expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(
      productA,
      conflict,
    )).toEqual({ status: "rejected", reason: "conflict" });

    await insertAdditionalAuthorityJob(fixture, fixture.alternateNextJobId);
    const candidates = [
      additionalAuthorityStartInput(fixture),
      additionalAuthorityStartInput(fixture, fixture.alternateNextJobId),
    ] as const;
    const results = await Promise.all([
      startParkedProtectedTaskRunAdditionalAuthoritySegment(
        productA,
        candidates[0],
      ),
      startParkedProtectedTaskRunAdditionalAuthoritySegment(
        productB,
        candidates[1],
      ),
    ]);
    expect(results.filter(result => result.status === "started")).toHaveLength(1);
    expect(results.filter(result =>
      result.status === "rejected" && result.reason === "stale"
    )).toHaveLength(1);
    expect(await readParkedProtectedTaskAdditionalAuthority(
      productA,
      discoveryIdentity,
    )).toBeNull();
    const winnerIndex = results.findIndex(result => result.status === "started");
    expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(
      productA,
      candidates[winnerIndex]!,
    )).toEqual({ status: "exact_replay" });

    const [persistedRun] = await productA.select().from(taskRuns)
      .where(eq(taskRuns.id, fixture.taskRunId)).limit(1);
    expect(persistedRun).toMatchObject({
      status: "running",
      jobId: candidates[winnerIndex]!.jobId,
    });
    expect(await productA.select().from(protectedTaskExecutionSegmentReceipts)
      .where(eq(
        protectedTaskExecutionSegmentReceipts.taskRunId,
        fixture.taskRunId,
      ))).toHaveLength(1);
    expect(await productA.select().from(protectedTaskContinuationReceipts)
      .where(eq(
        protectedTaskContinuationReceipts.taskRunId,
        fixture.taskRunId,
      ))).toHaveLength(1);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("Human acceptance binds the current actor and starts only one next Job", async () => {
  const fixture = await createFixture();
  try {
    expect(await sealAndParkProtectedTaskHumanRun(
      productA,
      humanParkInput(fixture),
    )).toEqual({ status: "parked" });

    const wrongActor = humanAcceptance(fixture, {
      acceptedBy: { userId: fixture.userId, humanActorId: randomUUID() },
    });
    expect(await acceptProtectedTaskHumanContinuation(
      productA,
      humanAcceptanceInput(fixture, wrongActor),
    )).toEqual({ status: "rejected", reason: "stale" });

    const acceptance = humanAcceptance(fixture);
    expect(await acceptProtectedTaskHumanContinuation(
      productA,
      humanAcceptanceInput(fixture, acceptance),
    )).toEqual({ status: "accepted", acceptance });
    const retry = humanAcceptance(fixture, {
      acceptedAt: new Date(acceptance.acceptedAt.getTime() + 1),
    });
    expect(await acceptProtectedTaskHumanContinuation(
      productA,
      humanAcceptanceInput(fixture, retry),
    )).toEqual({ status: "exact_replay", acceptance });
    expect(await discoverAcceptedParkedProtectedTaskHumanContinuation(
      productA,
      { taskRunId: fixture.taskRunId },
    )).toMatchObject({
      acceptance: {
        acceptanceId: acceptance.acceptanceId,
        acceptedBy: acceptance.acceptedBy,
        response: acceptance.response,
      },
      nextExecutionSegment: 2,
    });

    await insertHumanContinuationJob(fixture, fixture.nextJobId, acceptance);
    await insertHumanContinuationJob(
      fixture,
      fixture.alternateNextJobId,
      acceptance,
    );
    const candidates = [
      humanStartInput(fixture, fixture.nextJobId, acceptance),
      humanStartInput(fixture, fixture.alternateNextJobId, acceptance),
    ] as const;
    const results = await Promise.all([
      startParkedProtectedTaskHumanRunSegment(productA, candidates[0]),
      startParkedProtectedTaskHumanRunSegment(productB, candidates[1]),
    ]);
    expect(results.filter(result => result.status === "started")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected"))
      .toEqual([{ status: "rejected", reason: "conflict" }]);
    const winner = results.findIndex(result => result.status === "started");
    expect(await startParkedProtectedTaskHumanRunSegment(
      productA,
      candidates[winner]!,
    )).toEqual({ status: "exact_replay" });
    const [persistedRun] = await productA.select({
      status: taskRuns.status,
      jobId: taskRuns.jobId,
    }).from(taskRuns).where(eq(taskRuns.id, fixture.taskRunId));
    expect(persistedRun).toEqual({
      status: "running",
      jobId: candidates[winner]!.jobId,
    });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("Human recovery restores only a consumed acceptance for an unstarted Job", async () => {
  const fixture = await createFixture();
  try {
    expect(await sealAndParkProtectedTaskHumanRun(
      productA,
      humanParkInput(fixture),
    )).toEqual({ status: "parked" });
    const acceptance = humanAcceptance(fixture);
    expect(await acceptProtectedTaskHumanContinuation(
      productA,
      humanAcceptanceInput(fixture, acceptance),
    )).toMatchObject({ status: "accepted" });
    await insertHumanContinuationJob(fixture, fixture.nextJobId, acceptance);
    const start = humanStartInput(fixture, fixture.nextJobId, acceptance);
    expect(await startParkedProtectedTaskHumanRunSegment(productA, start))
      .toEqual({ status: "started" });

    let deferrals = 0;
    const recoveredAt = new Date(start.parkedAt.getTime() + 2);
    expect(await recoverUnstartedParkedProtectedTaskRun(
      productA,
      start,
      recoveredAt,
      async () => {
        deferrals += 1;
        const [nextJob] = await productB.select({
          status: jobs.status,
          startedAt: jobs.startedAt,
        }).from(jobs).where(eq(jobs.id, fixture.nextJobId));
        expect(nextJob).toEqual({ status: "cancelled", startedAt: null });
        return true;
      },
    )).toEqual({ status: "recovered" });
    expect(deferrals).toBe(1);
    const [priorJob] = await productA.select({ metadata: jobs.metadata })
      .from(jobs).where(eq(jobs.id, fixture.jobId));
    expect(priorJob?.metadata[
      "nautilo.protectedTaskHumanContinuationAcceptance.v1"
    ]).toMatchObject({
      acceptanceId: acceptance.acceptanceId,
    });
    expect(priorJob?.metadata[
      "nautilo.protectedTaskHumanContinuationAcceptance.v1"
    ]).not.toHaveProperty("consumedByJobId");
    const [run] = await productA.select({
      status: taskRuns.status,
      jobId: taskRuns.jobId,
    }).from(taskRuns).where(eq(taskRuns.id, fixture.taskRunId));
    expect(run).toEqual({ status: "awaiting", jobId: fixture.jobId });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("Human recovery cannot reset a continuation after its Job started", async () => {
  const fixture = await createFixture();
  try {
    expect(await sealAndParkProtectedTaskHumanRun(
      productA,
      humanParkInput(fixture),
    )).toEqual({ status: "parked" });
    const acceptance = humanAcceptance(fixture);
    expect(await acceptProtectedTaskHumanContinuation(
      productA,
      humanAcceptanceInput(fixture, acceptance),
    )).toMatchObject({ status: "accepted" });
    await insertHumanContinuationJob(fixture, fixture.nextJobId, acceptance);
    const start = humanStartInput(fixture, fixture.nextJobId, acceptance);
    expect(await startParkedProtectedTaskHumanRunSegment(productA, start))
      .toEqual({ status: "started" });
    await admin.update(jobs).set({
      status: "running",
      startedAt: new Date(start.parkedAt.getTime() + 1),
    }).where(eq(jobs.id, fixture.nextJobId));
    let deferrals = 0;
    expect(await recoverUnstartedParkedProtectedTaskRun(
      productA,
      start,
      new Date(start.parkedAt.getTime() + 2),
      () => {
        deferrals += 1;
        return Promise.resolve(true);
      },
    )).toEqual({ status: "stale" });
    expect(deferrals).toBe(0);
    const [run] = await productA.select({
      status: taskRuns.status,
      jobId: taskRuns.jobId,
    }).from(taskRuns).where(eq(taskRuns.id, fixture.taskRunId));
    expect(run).toEqual({ status: "running", jobId: fixture.nextJobId });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("cancellation and additional-authority start serialize on the Task", async () => {
  const fixture = await createFixture();
  try {
    expect(await sealAndParkProtectedTaskRun(productA, input(fixture)))
      .toMatchObject({ status: "parked" });
    await insertAdditionalAuthorityJob(fixture);
    const cancelledAt = new Date("2026-10-07T12:40:00.000Z");
    const [startResult, cancellationResult] = await Promise.all([
      startParkedProtectedTaskRunAdditionalAuthoritySegment(
        productA,
        additionalAuthorityStartInput(fixture),
      ),
      transitionTaskLifecycleTerminal(productB, {
        taskId: fixture.taskId,
        taskStatus: "cancelled",
        taskPatch: { cancelledAt },
        runId: fixture.taskRunId,
        runStatus: "cancelled",
        runPatch: { completedAt: cancelledAt },
      }),
    ]);

    if (startResult.status === "started") {
      expect(cancellationResult).toMatchObject({
        transitioned: true,
        outcome: "transitioned",
      });
    } else {
      expect(startResult).toEqual({ status: "rejected", reason: "stale" });
      expect(cancellationResult).toMatchObject({
        transitioned: true,
        outcome: "transitioned",
      });
    }
    const [persistedTask] = await productA.select().from(tasks)
      .where(eq(tasks.id, fixture.taskId)).limit(1);
    const [persistedRun] = await productA.select().from(taskRuns)
      .where(eq(taskRuns.id, fixture.taskRunId)).limit(1);
    expect(persistedTask?.status).toBe("cancelled");
    expect(persistedRun?.status).toBe("cancelled");
    expect(await productA.select().from(protectedTaskExecutionSegmentReceipts)
      .where(eq(
        protectedTaskExecutionSegmentReceipts.taskRunId,
        fixture.taskRunId,
      ))).toHaveLength(1);
    expect(await productA.select().from(protectedTaskContinuationReceipts)
      .where(eq(
        protectedTaskContinuationReceipts.taskRunId,
        fixture.taskRunId,
      ))).toHaveLength(1);
  } finally {
    await cleanupFixture(fixture);
  }
});


for (const linked of [false, true]) {
  test(`product-role recovery restores an unstarted ${linked ? "linked" : "unlinked"} continuation`, async () => {
    const fixture = await createFixture();
    try {
      await admin.update(taskRuns).set({ modelId: "test:selected-model" })
        .where(eq(taskRuns.id, fixture.taskRunId));
      expect(await sealAndParkProtectedTaskRun(productA, input(fixture)))
        .toMatchObject({ status: "parked" });
      await insertAdditionalAuthorityJob(fixture);
      const start = additionalAuthorityStartInput(fixture);
      if (linked) {
        expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(productA, start))
          .toEqual({ status: "started" });
      }
      const discover = async () => {
        const through = await getUnstartedProtectedTaskRunRecoveryBoundary(productA);
        expect(through).toBeDefined();
        const page = await listUnstartedProtectedTaskRunRecoveryCandidates(productA, {
          limit: 100, through: through!,
        });
        return page.candidates.find(candidate => candidate.input.jobId === fixture.nextJobId);
      };
      expect(await discover()).toMatchObject({ route: "parked_additional_authority",
        lifecycle: linked ? "linked" : "parked", jobStatus: "queued",
        input: { taskRunId: fixture.taskRunId, jobId: fixture.nextJobId } });
      const recoveredAt = new Date(start.parkedAt.getTime() + 1);
      const deferred = await recoverUnstartedParkedProtectedTaskRun(
        productA, start, recoveredAt, async () => {
          const [job] = await productB.select({ status: jobs.status, startedAt: jobs.startedAt })
            .from(jobs).where(eq(jobs.id, fixture.nextJobId));
          expect(job).toEqual({ status: "cancelled", startedAt: null });
          return false;
        },
      );
      expect(deferred).toEqual({ status: "cancelled" });
      expect(await discover()).toMatchObject({ route: "parked_additional_authority",
        lifecycle: linked ? "linked" : "parked", jobStatus: "cancelled" });
      const [beforeRetry] = await productA.select({ status: taskRuns.status, jobId: taskRuns.jobId })
        .from(taskRuns).where(eq(taskRuns.id, fixture.taskRunId));
      expect(beforeRetry).toEqual({ status: linked ? "running" : "awaiting",
        jobId: linked ? fixture.nextJobId : fixture.jobId });
      expect(await recoverUnstartedParkedProtectedTaskRun(
        productA, start, new Date(recoveredAt.getTime() + 1), () => Promise.resolve(true),
      )).toEqual({ status: linked ? "recovered" : "exact_replay" });
      const [run] = await productA.select({ status: taskRuns.status, jobId: taskRuns.jobId,
        graphThreadId: taskRuns.graphThreadId, modelId: taskRuns.modelId }).from(taskRuns)
        .where(eq(taskRuns.id, fixture.taskRunId));
      expect(run).toEqual({ status: "awaiting", jobId: fixture.jobId,
        graphThreadId: fixture.graphThreadId, modelId: "test:selected-model" });
      await insertAdditionalAuthorityJob(fixture, fixture.alternateNextJobId);
      expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(
        productA, additionalAuthorityStartInput(fixture, fixture.alternateNextJobId),
      )).toEqual({ status: "started" });
      expect(await productA.select().from(protectedTaskExecutionSegmentReceipts)
        .where(eq(protectedTaskExecutionSegmentReceipts.taskRunId, fixture.taskRunId)))
        .toHaveLength(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });
}

test("product-role parked claim recovery proves exact Job absence", async () => {
  const fixture = await createFixture();
  try {
    expect(await sealAndParkProtectedTaskRun(productA, input(fixture)))
      .toMatchObject({ status: "parked" });
    const expected = await readParkedProtectedTaskAdditionalAuthority(productA, {
      taskRunId: fixture.taskRunId,
      authorizationRequestId: "authority-request:1",
    });
    expect(expected).not.toBeNull();
    let deferrals = 0;
    expect(await recoverUnstartedParkedProtectedTaskClaim(
      productA,
      { expected: expected!, jobReference: additionalAuthorityReference(fixture) },
      new Date(input(fixture).park.parkedAt.getTime() + 1),
      async () => {
        deferrals += 1;
        const rows = await productB.select({ id: jobs.id }).from(jobs)
          .where(eq(jobs.input, additionalAuthorityReference(fixture)));
        expect(rows).toEqual([]);
        return true;
      },
    )).toEqual({ status: "recovered" });
    expect(deferrals).toBe(1);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("same locked parked proof serializes persistence before claim recovery", async () => {
  const fixture = await createFixture();
  let persistedJobId: string | null = null;
  try {
    expect(await sealAndParkProtectedTaskRun(productA, input(fixture)))
      .toMatchObject({ status: "parked" });
    const expected = await readParkedProtectedTaskAdditionalAuthority(productA, {
      taskRunId: fixture.taskRunId,
      authorizationRequestId: "authority-request:1",
    });
    expect(expected).not.toBeNull();
    let releasePersistence!: () => void;
    let lockedPersistence!: () => void;
    const release = new Promise<void>(resolve => { releasePersistence = resolve; });
    const locked = new Promise<void>(resolve => { lockedPersistence = resolve; });
    const persisted = productA.transaction(async tx => {
      expect(await lockParkedProtectedTaskAdditionalAuthority(tx, expected!))
        .not.toBeNull();
      lockedPersistence();
      await release;
      return persistJobInTransaction(tx, {
        ownerId: fixture.userId,
        requestorId: fixture.userId,
        laneKey: `task:${fixture.taskId}`,
        type: "foreground",
        input: additionalAuthorityReference(fixture),
        publicationPolicy: {
          expectedRevision: 2,
          representation: "protected_only",
        },
      });
    });
    await locked;
    let recoverySettled = false;
    const recovery = recoverUnstartedParkedProtectedTaskClaim(
      productB,
      { expected: expected!, jobReference: additionalAuthorityReference(fixture) },
      new Date(input(fixture).park.parkedAt.getTime() + 1),
      async () => true,
    ).finally(() => { recoverySettled = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(recoverySettled).toBe(false);
    releasePersistence();
    const jobId = await persisted;
    persistedJobId = jobId;
    expect(await recovery).toEqual({ status: "recovered" });
    expect(await productA.select({ status: jobs.status, startedAt: jobs.startedAt })
      .from(jobs).where(eq(jobs.id, jobId)))
      .toEqual([{ status: "cancelled", startedAt: null }]);
  } finally {
    if (persistedJobId !== null) {
      await admin.delete(jobs).where(eq(jobs.id, persistedJobId));
    }
    await cleanupFixture(fixture);
  }
});

test("product-role recovery never resets a continuation after its Job started", async () => {
  const fixture = await createFixture();
  try {
    expect(await sealAndParkProtectedTaskRun(productA, input(fixture)))
      .toMatchObject({ status: "parked" });
    await insertAdditionalAuthorityJob(fixture);
    const start = additionalAuthorityStartInput(fixture);
    expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(productA, start))
      .toEqual({ status: "started" });
    await admin.update(jobs).set({ status: "running", startedAt: new Date(start.parkedAt.getTime() + 1) })
      .where(eq(jobs.id, fixture.nextJobId));
    let deferrals = 0;
    expect(await recoverUnstartedParkedProtectedTaskRun(productA, start,
      new Date(start.parkedAt.getTime() + 2), () => {
        deferrals += 1;
        return Promise.resolve(true);
      })).toEqual({ status: "stale" });
    expect(deferrals).toBe(0);
    const [run] = await productA.select({ status: taskRuns.status, jobId: taskRuns.jobId })
      .from(taskRuns).where(eq(taskRuns.id, fixture.taskRunId));
    expect(run).toEqual({ status: "running", jobId: fixture.nextJobId });
  } finally {
    await cleanupFixture(fixture);
  }
});


test("terminal grant settlement cancels an unlinked continuation Job after Stop", async () => {
  const fixture = await createFixture();
  try {
    expect(await sealAndParkProtectedTaskRun(productA, input(fixture)))
      .toMatchObject({ status: "parked" });
    await insertAdditionalAuthorityJob(fixture);
    const start = additionalAuthorityStartInput(fixture);
    const cancelledAt = new Date(start.parkedAt.getTime() + 1);
    expect(await transitionTaskLifecycleTerminal(productA, {
      taskId: fixture.taskId, taskStatus: "cancelled", taskPatch: { cancelledAt },
      runId: fixture.taskRunId, runStatus: "cancelled", runPatch: { completedAt: cancelledAt },
    })).toMatchObject({ transitioned: true });
    const settlement = {
      taskRunId: fixture.taskRunId, contentNamespaceId: fixture.namespaceId,
      authorizationRequestId: start.jobReference.authorizationRequestId,
      policyRevision: start.jobReference.policyRevision,
    };
    expect(await settleCancelledProtectedTaskRunAuthorization(productA, settlement,
      () => Promise.resolve(true))).toBe(true);
    expect(await productA.select({ id: jobs.id, status: jobs.status, startedAt: jobs.startedAt })
      .from(jobs).where(eq(jobs.id, fixture.nextJobId)))
      .toEqual([{ id: fixture.nextJobId, status: "cancelled", startedAt: null }]);
    expect(await settleCancelledProtectedTaskRunAuthorization(productA, settlement,
      () => Promise.resolve(true))).toBe(true);
    expect(await productA.select({ status: jobs.status }).from(jobs)
      .where(eq(jobs.id, fixture.jobId))).toEqual([{ status: "completed" }]);
  } finally {
    await cleanupFixture(fixture);
  }
});


const legacyApprovalInterrupt = Object.freeze({
  id: humanInterrupt.id, kind: humanInterrupt.kind, requestId: humanInterrupt.requestId,
});
async function legacyApprovalCandidate(fixture: Fixture) {
  const parked = humanParkInput(fixture);
  expect(await sealAndParkProtectedTaskHumanRun(productA, {
    ...parked, park: { ...parked.park, interrupts: [legacyApprovalInterrupt] },
  })).toEqual({ status: "parked" });
  const viewer = { userId: fixture.userId, humanActorId: fixture.humanActorId };
  const candidate = await readProtectedTaskPendingAttentionCandidate(productA, {
    viewer, taskId: fixture.taskId, taskRunId: fixture.taskRunId,
  });
  if (candidate === null) throw new Error("Expected exact pending legacy approval");
  return { viewer, candidate, policies: [{ interruptId: humanInterrupt.id,
    requestId: humanInterrupt.requestId, allowedVerbs: ["once", "deny"] as const }] };
}
function legacyApprovalAcceptance(fixture: Fixture, verb: "once" | "deny") {
  const acceptance = humanAcceptance(fixture, {
    interrupt: legacyApprovalInterrupt, response: { kind: "approval", verb },
  });
  return { ...humanAcceptanceInput(fixture, acceptance), interrupts: [legacyApprovalInterrupt] };
}
async function approvalMetadata(fixture: Fixture) {
  const [row] = await productA.select({ metadata: jobs.metadata }).from(jobs)
    .where(eq(jobs.id, fixture.jobId));
  if (row === undefined) throw new Error("Expected parked approval Job");
  return row.metadata;
}

test("product role seals legacy approval policy exactly once before acceptance", async () => {
  const fixture = await createFixture();
  try {
    const identities = await productA.execute(sql`SELECT current_user::text AS current_user`);
    expect(identities[0]?.["current_user"]).toBe("nautilo");
    const binding = await legacyApprovalCandidate(fixture);
    const accept = legacyApprovalAcceptance(fixture, "once");
    expect(await acceptProtectedTaskHumanContinuation(productA, accept))
      .toEqual({ status: "rejected", reason: "stale" });
    expect(await approvalMetadata(fixture)).not.toHaveProperty(PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY);
    expect(await sealProtectedTaskHumanApprovalPolicy(productA, binding)).toEqual({ status: "sealed" });
    const sealed = await approvalMetadata(fixture);
    expect(await sealProtectedTaskHumanApprovalPolicy(productB, binding)).toEqual({ status: "exact_replay" });
    expect(await approvalMetadata(fixture)).toEqual(sealed);
    expect(await sealProtectedTaskHumanApprovalPolicy(productB, { ...binding,
      policies: [{ ...binding.policies[0]!, allowedVerbs: ["deny"] }],
    })).toEqual({ status: "rejected", reason: "conflict" });
    expect(await approvalMetadata(fixture)).toEqual(sealed);
    const resolved = await resolveParkedProtectedTaskHumanContinuationAcceptance(productA, {
      taskId: fixture.taskId, graphThreadId: fixture.graphThreadId, acceptedBy: binding.viewer,
      interrupt: { kind: "approval", requestId: humanInterrupt.requestId },
    });
    expect(resolved).toMatchObject({ status: "resolved", interrupt: { allowedVerbs: ["once", "deny"] } });
    expect(await acceptProtectedTaskHumanContinuation(productA, accept))
      .toMatchObject({ status: "accepted" });
    expect(await acceptProtectedTaskHumanContinuation(productB, accept))
      .toMatchObject({ status: "exact_replay" });
  } finally { await cleanupFixture(fixture); }
});

test("legacy approval rejects stale checkpoint bindings and tampered policy without poisoning acceptance", async () => {
  const fixture = await createFixture();
  try {
    const binding = await legacyApprovalCandidate(fixture);
    for (const candidate of [
      { ...binding.candidate, priorJob: { ...binding.candidate.priorJob,
        generation: binding.candidate.priorJob.generation + 1 } },
      { ...binding.candidate, checkpointManifest: { ...binding.candidate.checkpointManifest,
        checkpointOrderedDigest: new Uint8Array(32).fill(0x76) } },
    ]) {
      expect(await sealProtectedTaskHumanApprovalPolicy(productA, { ...binding, candidate }))
        .toEqual({ status: "rejected", reason: "stale" });
      expect(await approvalMetadata(fixture)).not.toHaveProperty(PROTECTED_TASK_HUMAN_APPROVAL_POLICY_METADATA_KEY);
    }
    expect(await sealProtectedTaskHumanApprovalPolicy(productA, binding)).toEqual({ status: "sealed" });
    const original = await approvalMetadata(fixture);
    const sidecar = original[PROTECTED_TASK_HUMAN_APPROVAL_POLICY_METADATA_KEY];
    if (sidecar === null || typeof sidecar !== "object" || Array.isArray(sidecar)) {
      throw new Error("Expected sealed policy sidecar");
    }
    await admin.update(jobs).set({ metadata: { ...original,
      [PROTECTED_TASK_HUMAN_APPROVAL_POLICY_METADATA_KEY]: { ...sidecar,
        checkpointManifestDigest: "tampered-checkpoint" },
    } }).where(eq(jobs.id, fixture.jobId));
    expect(await sealProtectedTaskHumanApprovalPolicy(productA, binding))
      .toEqual({ status: "rejected", reason: "conflict" });
    expect(await acceptProtectedTaskHumanContinuation(productA, legacyApprovalAcceptance(fixture, "once")))
      .toEqual({ status: "rejected", reason: "stale" });
    expect(await approvalMetadata(fixture)).not.toHaveProperty(PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY);
    // Restore only this fixture's exact pre-tamper bytes; a failed attempt has
    // written no acceptance that could prevent the legitimate Human response.
    await admin.update(jobs).set({ metadata: original }).where(eq(jobs.id, fixture.jobId));
    expect(await acceptProtectedTaskHumanContinuation(productA, legacyApprovalAcceptance(fixture, "once")))
      .toMatchObject({ status: "accepted" });
  } finally { await cleanupFixture(fixture); }
});

test("legacy approval remains denyable without a policy sidecar", async () => {
  const fixture = await createFixture();
  try {
    await legacyApprovalCandidate(fixture);
    expect(await acceptProtectedTaskHumanContinuation(productA, legacyApprovalAcceptance(fixture, "deny")))
      .toMatchObject({ status: "accepted" });
    expect(await approvalMetadata(fixture)).not.toHaveProperty(PROTECTED_TASK_HUMAN_APPROVAL_POLICY_METADATA_KEY);
  } finally { await cleanupFixture(fixture); }
});

for (const allowedVerbs of [["deny"], ["once", "deny"]] as const) {
  test(`fresh approval policy ${allowedVerbs.join("/")} is enforced before acceptance`, async () => {
    const fixture = await createFixture();
    try {
      const parked = humanParkInput(fixture);
      const interrupt = { ...humanInterrupt, allowedVerbs };
      expect(await sealAndParkProtectedTaskHumanRun(productA, {
        ...parked, park: { ...parked.park, interrupts: [interrupt] },
      })).toEqual({ status: "parked" });
      const acceptance = humanAcceptance(fixture, { interrupt });
      const accepted = await acceptProtectedTaskHumanContinuation(productA, {
        ...humanAcceptanceInput(fixture, acceptance), interrupts: [interrupt],
      });
      if (allowedVerbs.length === 1) {
        expect(accepted).toEqual({ status: "rejected", reason: "stale" });
        expect(await approvalMetadata(fixture)).not.toHaveProperty(PROTECTED_TASK_HUMAN_ACCEPTANCE_METADATA_KEY);
        const denied = humanAcceptance(fixture, { interrupt, response: { kind: "approval", verb: "deny" } });
        expect(await acceptProtectedTaskHumanContinuation(productA, {
          ...humanAcceptanceInput(fixture, denied), interrupts: [interrupt],
        })).toMatchObject({ status: "accepted" });
      } else expect(accepted).toMatchObject({ status: "accepted" });
      expect(await approvalMetadata(fixture)).not.toHaveProperty(PROTECTED_TASK_HUMAN_APPROVAL_POLICY_METADATA_KEY);
    } finally { await cleanupFixture(fixture); }
  });
}
