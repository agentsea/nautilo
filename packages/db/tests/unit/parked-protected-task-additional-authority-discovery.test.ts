import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  protectedTaskSemanticAuthorityRequirementsDigest,
  protectedTaskAdditionalAuthorityContinuationFingerprint,
  type ProtectedTaskExecutionContinuationProof,
} from "../../src/queries/protected-task-execution-receipts";
import {
  discoverParkedProtectedTaskAdditionalAuthority,
  parseParkedProtectedTaskAdditionalAuthority,
  readParkedProtectedTaskAdditionalAuthority,
  sameParkedProtectedTaskAdditionalAuthority,
  type ParkedProtectedTaskAdditionalAuthorityJobRow,
  type ParkedProtectedTaskAdditionalAuthorityRunRow,
  type ParkedProtectedTaskAdditionalAuthorityTaskRow,
  type ProtectedTaskDurableJobReference,
} from "../../src/queries/tasks";
import { protectedTaskRunResultObjectId } from
  "../../src/queries/protected-task-output-binding-identities";
import { protectedTaskContinuationReceipts } from
  "../../src/schema/protected-task-continuation-receipts";
import { protectedTaskExecutionSegmentReceipts } from
  "../../src/schema/protected-task-execution-segment-receipts";
import { taskRuns } from "../../src/schema/task-runs";

const ids = Object.freeze({
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  owner: "40000000-0000-4000-8000-000000000004",
  agent: "50000000-0000-4000-8000-000000000005",
  namespace: "60000000-0000-4000-8000-000000000006",
});
const definitionObjectId = `task-definition:v1:${"a".repeat(64)}`;
const authorizationRequestId = "authority-request:1";
const graphThreadId = `subagent:${ids.task}:${ids.run}`;
const parkedAt = new Date("2026-10-07T12:34:56.000Z");
const startedAt = new Date("2026-10-07T12:00:00.000Z");
const digest = (seed: number): Uint8Array => new Uint8Array(32).fill(seed);
const semanticAuthorityRequirements = Object.freeze([Object.freeze({
  namespaceId: ids.namespace,
  operations: Object.freeze(["decrypt", "encrypt"] as const),
})]);

function reference(
  overrides: Partial<ProtectedTaskDurableJobReference> = {},
): ProtectedTaskDurableJobReference {
  return {
    kind: "protected_task_run_v1",
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId: definitionObjectId,
    resultObjectId: protectedTaskRunResultObjectId(ids.task, ids.run),
    authorizationRequestId: `task-run-authorization:${ids.run}`,
    policyRevision: 1,
    executionSegment: 1,
    ...overrides,
  };
}

function task(
  overrides: Partial<ParkedProtectedTaskAdditionalAuthorityTaskRow> = {},
): ParkedProtectedTaskAdditionalAuthorityTaskRow {
  return {
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.owner,
    agentId: ids.agent,
    callingRoomId: null,
    scheduleKind: "now",
    status: "awaiting",
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 1,
    cryptoObjectId: definitionObjectId,
    cryptoAccessRevision: 2,
    cryptoRequiredNamespaceFingerprint: digest(1),
    cryptoMappingState: "verified",
    contentPristine: true,
    ...overrides,
  };
}

function run(
  overrides: Partial<ParkedProtectedTaskAdditionalAuthorityRunRow> = {},
): ParkedProtectedTaskAdditionalAuthorityRunRow {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: ids.job,
    graphThreadId,
    status: "awaiting",
    startedAt: new Date(startedAt),
    pristine: true,
    ...overrides,
  };
}

function parkReceipt(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.job,
    graphThreadId,
    generation: 3,
    executionSegment: 1,
    interrupts: [{
      id: "interrupt:authority:1",
      kind: "additional_authority",
      requestId: authorizationRequestId,
    }],
    parkedAt: parkedAt.toISOString(),
    ...overrides,
  };
}

function job(
  overrides: Partial<ParkedProtectedTaskAdditionalAuthorityJobRow> = {},
): ParkedProtectedTaskAdditionalAuthorityJobRow {
  return {
    id: ids.job,
    ownerId: ids.owner,
    requestorId: ids.owner,
    laneKey: `task:${ids.task}`,
    type: "foreground",
    status: "completed",
    startedAt: new Date(startedAt),
    completedAt: new Date(parkedAt),
    reference: reference(),
    parkReceipt: parkReceipt(),
    pristine: true,
    ...overrides,
  };
}

function proof(
  overrides: Readonly<{
    segment?: Record<string, unknown>;
    continuation?: Record<string, unknown>;
  }> = {},
): ProtectedTaskExecutionContinuationProof {
  return {
    segment: {
      taskRunId: ids.run,
      executionSegment: 1,
      jobId: ids.job,
      route: "native_langgraph_v1",
      transcriptContract: "protected_message_associations_v1",
      expectedTranscriptAssociationCount: 0,
      transcriptAssociationDigest: digest(2),
      checkpointContract: "encrypted_langgraph_v1",
      expectedCheckpointCount: 1,
      checkpointDigest: digest(3),
      expectedCheckpointBlobCount: 1,
      checkpointBlobDigest: digest(4),
      expectedPendingWriteCount: 0,
      pendingWriteDigest: digest(5),
      sealedAt: new Date(parkedAt),
      ...overrides.segment,
    },
    continuation: {
      taskRunId: ids.run,
      executionSegment: 1,
      jobId: ids.job,
      kind: "pre_effect_interrupt_v1",
      reason: "additional_authority",
      effectDisposition: "not_started_v1",
      interruptId: "interrupt:authority:1",
      operationId: "tool-call:1",
      requestDigest: digest(6),
      requiredAuthorityDigest: protectedTaskSemanticAuthorityRequirementsDigest(
        semanticAuthorityRequirements,
      ),
      stableRoutingDigest: digest(7),
      semanticAuthorityRequirements,
      sealedAt: new Date(parkedAt),
      ...overrides.continuation,
    },
  } as ProtectedTaskExecutionContinuationProof;
}

function parse(overrides: Readonly<{
  task?: ParkedProtectedTaskAdditionalAuthorityTaskRow;
  run?: ParkedProtectedTaskAdditionalAuthorityRunRow;
  job?: ParkedProtectedTaskAdditionalAuthorityJobRow;
  proof?: ProtectedTaskExecutionContinuationProof | null;
  authorizationRequestId?: string;
}> = {}) {
  return parseParkedProtectedTaskAdditionalAuthority({
    task: overrides.task ?? task(),
    run: overrides.run ?? run(),
    job: overrides.job ?? job(),
    proof: Object.hasOwn(overrides, "proof") ? overrides.proof! : proof(),
    authorizationRequestId:
      overrides.authorizationRequestId ?? authorizationRequestId,
  });
}

function loaderDb(candidateRows: readonly unknown[]) {
  let taskRunSelects = 0;
  const rowsFor = (table: unknown): readonly unknown[] => {
    if (table === taskRuns) {
      taskRunSelects += 1;
      return taskRunSelects === 1
        ? candidateRows
        : [{ id: ids.run, taskId: ids.task }];
    }
    if (table === protectedTaskExecutionSegmentReceipts) {
      return [proof().segment];
    }
    if (table === protectedTaskContinuationReceipts) {
      return [proof().continuation];
    }
    throw new Error("unexpected discovery table");
  };
  const queryFor = (table: unknown) => {
    const query = {
      innerJoin: (_join: unknown, _condition: unknown) => query,
      where: (_condition: unknown) => query,
      orderBy: (_order: unknown) => query,
      limit: (_limit: number) => Promise.resolve(rowsFor(table)),
    };
    return query;
  };
  return {
    select: (_projection?: unknown) => ({
      from: (table: unknown) => queryFor(table),
    }),
  } as unknown as Pick<DirectDatabase, "select">;
}

describe("parked protected Task additional-authority discovery", () => {
  test("returns one deep-copied content-free candidate", () => {
    const taskRow = task();
    const runRow = run();
    const jobRow = job();
    const mutableManifest = [{
      namespaceId: ids.namespace,
      operations: ["decrypt", "encrypt"],
    }];
    const proofRow = proof({ continuation: {
      semanticAuthorityRequirements: mutableManifest,
      requiredAuthorityDigest:
        protectedTaskSemanticAuthorityRequirementsDigest(mutableManifest),
    } });
    const candidate = parse({
      task: taskRow,
      run: runRow,
      job: jobRow,
      proof: proofRow,
    });
    expect(candidate).not.toBeNull();
    expect(candidate).toMatchObject({
      authorizationRequestId,
      nextExecutionSegment: 2,
      occurrence: {
        task: { id: ids.task, status: "awaiting" },
        run: { id: ids.run, jobId: ids.job, status: "awaiting" },
      },
      priorJob: { id: ids.job, generation: 3 },
    });
    expect(candidate?.continuationFingerprint).toBe(
      protectedTaskAdditionalAuthorityContinuationFingerprint(
        proofRow.continuation,
      ),
    );
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate?.occurrence.task)).toBe(true);
    expect(Object.isFrozen(candidate?.proof.segment)).toBe(true);

    taskRow.cryptoRequiredNamespaceFingerprint?.fill(0);
    runRow.startedAt.setTime(0);
    (proofRow.segment.checkpointDigest as Uint8Array).fill(0);
    (proofRow.continuation.stableRoutingDigest as Uint8Array).fill(0);
    proofRow.segment.sealedAt.setTime(0);
    mutableManifest[0]!.operations[0] = "encrypt";
    expect(candidate?.occurrence.task.cryptoRequiredNamespaceFingerprint)
      .toEqual(digest(1));
    expect(candidate?.occurrence.run.startedAt).toEqual(startedAt);
    expect(candidate?.proof.segment.checkpointDigest).toEqual(digest(3));
    expect(candidate?.proof.segment.sealedAt).toEqual(parkedAt);
    expect(candidate?.proof.continuation.semanticAuthorityRequirements)
      .toEqual(semanticAuthorityRequirements);
    expect(candidate?.proof.continuation.stableRoutingDigest)
      .toEqual(digest(7));
    expect(sameParkedProtectedTaskAdditionalAuthority(candidate!, candidate!))
      .toBe(true);
  });

  test("rejects stale lifecycle, ordinary Jobs, and identity substitution", () => {
    const invalid = [
      parse({ authorizationRequestId: "authority-request:spoofed" }),
      parse({ proof: null }),
      parse({ task: task({ status: "running" }) }),
      parse({ task: task({ contentRepresentation: "ordinary" }) }),
      parse({ task: task({ cryptoMappingState: "stale" }) }),
      parse({ task: task({ contentPristine: false }) }),
      parse({ run: run({ status: "running" }) }),
      parse({ run: run({ pristine: false }) }),
      parse({ run: run({ taskId: ids.owner }) }),
      parse({ job: job({ status: "cancelled" }) }),
      parse({ job: job({ pristine: false }) }),
      parse({ job: job({ reference: { kind: "ordinary" } }) }),
      parse({ job: job({ reference: reference({ policyRevision: 0 }) }) }),
      parse({ job: job({ completedAt: null }) }),
      parse({ job: job({ parkReceipt: parkReceipt({ taskId: ids.owner }) }) }),
      parse({ job: job({ parkReceipt: parkReceipt({ interrupts: [{
        id: "interrupt:authority:1",
        kind: "additional_authority",
        requestId: authorizationRequestId,
      }, {
        id: "interrupt:authority:2",
        kind: "additional_authority",
        requestId: authorizationRequestId,
      }] }) }) }),
    ];
    for (const candidate of invalid) expect(candidate).toBeNull();
  });

  test("rejects non-resumable, mismatched, or physically empty proof", () => {
    const invalid = [
      parse({ proof: proof({ segment: { expectedCheckpointCount: 0 } }) }),
      parse({ proof: proof({ segment: { jobId: ids.owner } }) }),
      parse({ proof: proof({ segment: { sealedAt: startedAt } }) }),
      parse({ proof: proof({ continuation: { kind: "checkpoint_safe_v1" } }) }),
      parse({ proof: proof({ continuation: { reason: "grant_refresh" } }) }),
      parse({ proof: proof({ continuation: { effectDisposition: "none_v1" } }) }),
      parse({ proof: proof({ continuation: { interruptId: "interrupt:other" } }) }),
      parse({ proof: proof({ continuation: { sealedAt: startedAt } }) }),
      parse({ proof: proof({ continuation: {
        semanticAuthorityRequirements: null,
      } }) }),
      parse({ proof: proof({ continuation: {
        stableRoutingDigest: null,
      } }) }),
      parse({ proof: proof({ continuation: {
        stableRoutingDigest: new Uint8Array(31),
      } }) }),
    ];
    for (const candidate of invalid) expect(candidate).toBeNull();
  });

  test("loader is unlocked discovery and returns null before park or after start", async () => {
    expect(await readParkedProtectedTaskAdditionalAuthority(loaderDb([]), {
      taskRunId: ids.run,
      authorizationRequestId,
    })).toBeNull();

    const row = { task: task(), run: run(), job: job() };
    const discovered = await readParkedProtectedTaskAdditionalAuthority(
      loaderDb([row]),
      { taskRunId: ids.run, authorizationRequestId },
    );
    expect(discovered).not.toBeNull();

    expect(await readParkedProtectedTaskAdditionalAuthority(loaderDb([{
      ...row,
      run: run({ status: "running" }),
    }]), {
      taskRunId: ids.run,
      authorizationRequestId,
    })).toBeNull();

    expect(await discoverParkedProtectedTaskAdditionalAuthority(
      loaderDb([row]),
      { taskRunId: ids.run },
    )).toMatchObject({ authorizationRequestId });
  });
});
