import { describe, expect, test } from "bun:test";
import {
  ClassifiedDataOperationError,
  TASK_RUN_RESULT_OBJECT_TYPE_V1,
  bindEncryptionDataOperationOwner,
  deriveTaskContentCryptoObjectIdV1,
  fingerprintTaskContentAuthorityV1,
  type PreparedTaskContentCryptoRevisionV1,
  type TaskContentAuthorityV1,
  type TaskRunResultContentCoordinateV1,
} from "@nautilo/lattice-bridge";

import type { ProtectedTaskJobReferenceV1 } from
  "../../src/tasks/protected-task-job-reference";
import {
  publishProtectedTaskRunResult,
  type ProtectedTaskRunTerminalPort,
  type PublishProtectedTaskRunResultInput,
} from "../../src/tasks/protected-task-result-publication";

const TASK_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000002";
const HUMAN_ID = "30000000-0000-4000-8000-000000000003";
const NAMESPACE_ID = "40000000-0000-4000-8000-000000000004";
const DOMAIN_ID = "50000000-0000-4000-8000-000000000005";
const COMPLETED_AT = new Date("2026-09-25T12:00:00.000Z");

const authority = Object.freeze({
  authorityVersion: 1,
  kind: "requester_private_namespace",
  keyClass: "ai",
  requesterHumanId: HUMAN_ID,
  namespaceId: NAMESPACE_ID,
  domainId: DOMAIN_ID,
  expectedAccessRevision: 4,
  expectedPolicyRevision: 7,
} satisfies TaskContentAuthorityV1);

function operationOwner(
  mode: "plaintext_only" | "shadow_encryption" | "encrypted_only",
) {
  return bindEncryptionDataOperationOwner({
    policy: {
      resolve: async () => ({
        policy: { mode, shadowBehavior: "strict" },
        revalidationToken: 19,
      }),
      revalidate: async () => undefined,
    },
  });
}

const owner = operationOwner("encrypted_only");

function coordinate(
  taskId = TASK_ID,
  taskRunId = RUN_ID,
): TaskRunResultContentCoordinateV1 {
  return Object.freeze({
    kind: "run_result",
    taskId,
    taskRunId,
    contentRevision: 1,
  });
}

function prepared(
  resultCoordinate = coordinate(),
  contentAuthority = authority,
): PreparedTaskContentCryptoRevisionV1 {
  return Object.freeze({
    coordinate: resultCoordinate,
    objectId: deriveTaskContentCryptoObjectIdV1(resultCoordinate),
    objectType: TASK_RUN_RESULT_OBJECT_TYPE_V1,
    payloadVersion: 1,
    namespaceId: contentAuthority.namespaceId,
    authorityFingerprint: fingerprintTaskContentAuthorityV1(contentAuthority),
  });
}

function reference(
  resultObjectId = deriveTaskContentCryptoObjectIdV1(coordinate()),
  policyRevision = authority.expectedPolicyRevision,
): ProtectedTaskJobReferenceV1 {
  return Object.freeze({
    kind: "protected_task_run_v1",
    taskId: TASK_ID,
    taskRunId: RUN_ID,
    inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
    resultObjectId,
    authorizationRequestId: `task-run-authorization:${RUN_ID}`,
    policyRevision,
  });
}

type Repository = PublishProtectedTaskRunResultInput["repository"];
type PublishPrepared = Repository["publishPrepared"];

function fixture(options: Readonly<{
  orphanCompletion?: boolean;
  terminalResult?: Awaited<ReturnType<ProtectedTaskRunTerminalPort["terminalize"]>>;
}> = {}) {
  const calls: string[] = [];
  const terminalInputs: Array<Parameters<
    ProtectedTaskRunTerminalPort["terminalize"]
  >[0]> = [];
  const receipts = new Map<string, string>();
  const reservations = new Map<string, string>();
  const mappedOperations = new Set<string>();
  const identity = (input: Readonly<{
    requestDigest: Uint8Array;
    resultObjectId: string;
    outcome?: string;
  }>) => [
    Buffer.from(input.requestDigest).toString("hex"),
    input.resultObjectId,
    input.outcome,
  ].join(":");
  const terminal: ProtectedTaskRunTerminalPort = {
    async terminalize(input) {
      calls.push("terminal");
      terminalInputs.push(input);
      if (options.terminalResult !== undefined) return options.terminalResult;
      const current = identity(input);
      const prior = receipts.get(input.operationId);
      if (prior !== undefined) {
        return prior === current
          ? Object.freeze({ status: "exact_replay" as const })
          : Object.freeze({ status: "rejected" as const, reason: "conflict" as const });
      }
      receipts.set(input.operationId, current);
      return Object.freeze({ status: "transitioned" as const });
    },
  };
  const publishPrepared: PublishPrepared = async (request) =>
    request.owner.runMutation({
      protected: async (context) => {
        if (request.representation !== "protected") {
          throw new Error("Test repository received a dual result");
        }
        const reservationIdentity = identity({
          requestDigest: request.requestDigest,
          resultObjectId: request.prepared.objectId,
        });
        const priorReservation = reservations.get(request.operationId);
        if (
          priorReservation !== undefined
          && priorReservation !== reservationIdentity
        ) {
          throw new ClassifiedDataOperationError(
            "integrity",
            "Test result reservation conflict",
          );
        }
        reservations.set(request.operationId, reservationIdentity);
        calls.push(`reserve:${request.operationId}`);
        const product = await request.publishProduct(context);
        calls.push("complete");
        const replayed = mappedOperations.has(request.operationId);
        mappedOperations.add(request.operationId);
        return Object.freeze({
          product,
          representation: "protected" as const,
          protectedRevision: options.orphanCompletion
            ? Object.freeze({
                status: "orphaned" as const,
                reason: "stale_mapping" as const,
                coordinate: request.prepared.coordinate,
                cryptoObjectId: request.prepared.objectId,
              })
            : Object.freeze({
                status: replayed
                  ? "replayed" as const
                  : "mapped" as const,
                coordinate: request.prepared.coordinate,
                cryptoObjectId: request.prepared.objectId,
              }),
        });
      },
    });
  const repository: Repository = { publishPrepared };
  const input = Object.freeze({
    repository,
    terminal,
    owner,
    reference: reference(),
    authority,
    prepared: prepared(),
    requestDigest: new Uint8Array(32).fill(9),
    outcome: "completed" as const,
    scheduleKind: "now" as const,
    completedAt: COMPLETED_AT,
  });
  return { calls, input, terminalInputs };
}

describe("protected Task result publication", () => {
  test("orders reservation, content-free terminal CAS, and crypto mapping", async () => {
    const state = fixture();
    const receipt = await publishProtectedTaskRunResult(state.input);

    expect(receipt).toEqual({
      status: "mapped",
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      resultObjectId: deriveTaskContentCryptoObjectIdV1(coordinate()),
      resultRevision: 1,
    });
    expect(state.calls).toEqual([
      `reserve:task-run-result:${RUN_ID}`,
      "terminal",
      "complete",
    ]);
    expect(state.terminalInputs).toEqual([{
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      scheduleKind: "now",
      operationId: `task-run-result:${RUN_ID}`,
      requestDigest: new Uint8Array(32).fill(9),
      resultObjectId: deriveTaskContentCryptoObjectIdV1(coordinate()),
      resultRevision: 1,
      resultRepresentation: "protected",
      outcome: "completed",
      completedAt: COMPLETED_AT,
      requiredRunStatus: "running",
      policyRevalidationToken: 19,
    }]);
  });

  test("terminalizes an error with closed facts and no result or Job body", async () => {
    const state = fixture();
    await publishProtectedTaskRunResult({
      ...state.input,
      outcome: "errored",
    });

    const terminal = state.terminalInputs[0]!;
    expect(terminal.outcome).toBe("errored");
    expect(Object.keys(terminal).sort()).toEqual([
      "completedAt",
      "operationId",
      "outcome",
      "policyRevalidationToken",
      "requestDigest",
      "requiredRunStatus",
      "resultObjectId",
      "resultRepresentation",
      "resultRevision",
      "scheduleKind",
      "taskId",
      "taskRunId",
    ]);
    expect("resultText" in terminal).toBe(false);
    expect("lastError" in terminal).toBe(false);
    expect("jobInput" in terminal).toBe(false);
  });

  test("keeps recurring parent semantics separate from exact running-run fence", async () => {
    const state = fixture();
    await publishProtectedTaskRunResult({
      ...state.input,
      scheduleKind: "cron",
    });

    expect(state.terminalInputs[0]).toMatchObject({
      scheduleKind: "cron",
      requiredRunStatus: "running",
      taskRunId: RUN_ID,
    });
  });

  test("uses one stable operation identity and accepts an exact replay", async () => {
    const state = fixture();
    const first = await publishProtectedTaskRunResult(state.input);
    const replay = await publishProtectedTaskRunResult(state.input);

    expect(first.status).toBe("mapped");
    expect(replay.status).toBe("replayed");
    expect(state.terminalInputs.map((input) => input.operationId)).toEqual([
      `task-run-result:${RUN_ID}`,
      `task-run-result:${RUN_ID}`,
    ]);
    expect(state.calls).toEqual([
      `reserve:task-run-result:${RUN_ID}`, "terminal", "complete",
      `reserve:task-run-result:${RUN_ID}`, "terminal", "complete",
    ]);
  });

  test("rejects a conflicting retry before the terminal CAS", async () => {
    const state = fixture();
    await publishProtectedTaskRunResult(state.input);
    const error = await publishProtectedTaskRunResult({
      ...state.input,
      requestDigest: new Uint8Array(32).fill(10),
    }).then(() => null, (cause: unknown) => cause);

    expect(error).toBeInstanceOf(ClassifiedDataOperationError);
    expect(error).toMatchObject({ failureClass: "integrity" });
    expect(state.terminalInputs).toHaveLength(1);
    expect(state.calls).toEqual([
      `reserve:task-run-result:${RUN_ID}`, "terminal", "complete",
    ]);
  });

  test("rejects substituted coordinates, objects, and policy before reserve", async () => {
    const wrongRun = "60000000-0000-4000-8000-000000000006";
    const mismatches: PublishProtectedTaskRunResultInput[] = [];

    for (const mutate of [
      (input: PublishProtectedTaskRunResultInput) => ({
        ...input,
        prepared: prepared(coordinate(TASK_ID, wrongRun)),
      }),
      (input: PublishProtectedTaskRunResultInput) => ({
        ...input,
        reference: reference(`task-run-result:v1:${"f".repeat(64)}`),
      }),
      (input: PublishProtectedTaskRunResultInput) => ({
        ...input,
        reference: reference(
          deriveTaskContentCryptoObjectIdV1(coordinate()),
          authority.expectedPolicyRevision + 1,
        ),
      }),
    ]) {
      const state = fixture();
      const mismatch = mutate(state.input);
      mismatches.push(mismatch);
      const error = await publishProtectedTaskRunResult(mismatch).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(TypeError);
      expect(state.calls).toEqual([]);
    }
    expect(mismatches).toHaveLength(3);
  });

  test("rejects Shadow and ordinary policies without an ordinary fallback", async () => {
    for (const mode of ["shadow_encryption", "plaintext_only"] as const) {
      const state = fixture();
      const error = await publishProtectedTaskRunResult({
        ...state.input,
        owner: operationOwner(mode),
      }).then(() => null, (cause: unknown) => cause);

      expect(error).toBeInstanceOf(ClassifiedDataOperationError);
      expect(error).toMatchObject({ failureClass: "unsupported" });
      expect(state.calls).toEqual([]);
      expect(state.terminalInputs).toEqual([]);
    }
  });

  test("fails closed when the terminal CAS rejects", async () => {
    const state = fixture({
      terminalResult: Object.freeze({
        status: "rejected",
        reason: "not_running",
      }),
    });
    const error = await publishProtectedTaskRunResult(state.input).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ClassifiedDataOperationError);
    expect(error).toMatchObject({ failureClass: "stale" });
    expect(state.calls).toEqual([
      `reserve:task-run-result:${RUN_ID}`,
      "terminal",
    ]);
  });

  test("fails closed when completion cannot map the exact result", async () => {
    const state = fixture({ orphanCompletion: true });
    const error = await publishProtectedTaskRunResult(state.input).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ClassifiedDataOperationError);
    expect(error).toMatchObject({ failureClass: "integrity" });
    expect(state.calls).toEqual([
      `reserve:task-run-result:${RUN_ID}`,
      "terminal",
      "complete",
    ]);
  });
});
