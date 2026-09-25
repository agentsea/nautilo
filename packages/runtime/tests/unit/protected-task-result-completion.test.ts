import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  deriveTaskContentCryptoObjectIdV1,
  encodeTaskRunResultPayloadV1,
  type TaskRunResultPayloadV1,
} from "@nautilo/lattice-bridge";

import {
  completeProtectedTaskRunResult,
  type CompleteProtectedTaskRunResultDependencies,
  type CompleteProtectedTaskRunResultInput,
} from "../../src/tasks/protected-task-result-completion";

const TASK_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000002";
const NAMESPACE_ID = "30000000-0000-4000-8000-000000000003";
const DOMAIN_ID = "40000000-0000-4000-8000-000000000004";
const REQUEST_ID = `task-run-authorization:${RUN_ID}`;
const coordinate = Object.freeze({
  kind: "run_result" as const,
  taskId: TASK_ID,
  taskRunId: RUN_ID,
  contentRevision: 1,
});
const resultObjectId = deriveTaskContentCryptoObjectIdV1(coordinate);

function fixture(payload: TaskRunResultPayloadV1) {
  const controller = new AbortController();
  const reference = Object.freeze({
    kind: "protected_task_run_v1" as const,
    taskId: TASK_ID,
    taskRunId: RUN_ID,
    inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
    resultObjectId,
    authorizationRequestId: REQUEST_ID,
    policyRevision: 7,
  });
  const evidence = {
    requestId: REQUEST_ID,
    workId: RUN_ID,
    policyRevision: 7,
    result: {
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      objectId: resultObjectId,
      namespace: { namespaceId: NAMESPACE_ID },
    },
  };
  const authority = {
    authorityVersion: 1 as const,
    kind: "requester_private_namespace" as const,
    keyClass: "ai" as const,
    requesterHumanId: "50000000-0000-4000-8000-000000000005",
    namespaceId: NAMESPACE_ID,
    domainId: DOMAIN_ID,
    expectedAccessRevision: 4,
    expectedPolicyRevision: 7,
  };
  const input = {
    payload,
    reference,
    evidence,
    authority,
    signal: controller.signal,
    scheduleKind: "cron" as const,
    completedAt: new Date("2026-09-25T12:00:00.000Z"),
  } as CompleteProtectedTaskRunResultInput;
  const prepared = { coordinate, objectId: resultObjectId };
  let prepareCalls = 0;
  const publications: Array<Parameters<
    CompleteProtectedTaskRunResultDependencies["publish"]
  >[0]> = [];
  const dependencies: CompleteProtectedTaskRunResultDependencies = {
    prepare: () => {
      prepareCalls += 1;
      return prepared as ReturnType<CompleteProtectedTaskRunResultDependencies["prepare"]>;
    },
    publish: async (publication) => {
      publications.push(publication);
      return {
        status: "mapped",
        taskId: TASK_ID,
        taskRunId: RUN_ID,
        resultObjectId,
        resultRevision: 1,
      };
    },
  };
  return { input, controller, dependencies, publications, prepareCalls: () => prepareCalls };
}

describe("protected Task result completion", () => {
  test("binds the exact live grant to one canonical encrypted result publication", async () => {
    const payload: TaskRunResultPayloadV1 = {
      formatVersion: 1,
      resultText: "Protected answer",
      lastError: null,
    };
    const scenario = fixture(payload);
    const receipt = await completeProtectedTaskRunResult(
      scenario.input,
      scenario.dependencies,
    );

    expect(receipt).toMatchObject({ status: "mapped", taskRunId: RUN_ID });
    expect(scenario.prepareCalls()).toBe(1);
    expect(scenario.publications).toHaveLength(1);
    const publication = scenario.publications[0]!;
    expect(publication.outcome).toBe("completed");
    expect(publication.scheduleKind).toBe("cron");
    expect(publication.ordinaryContent).toEqual({ coordinate, payload });
    const bytes = encodeTaskRunResultPayloadV1(payload);
    expect(publication.requestDigest).toEqual(
      createHash("sha256").update(bytes).digest(),
    );
    bytes.fill(0);
  });

  test("rejects a substituted grant or aborted operation before preparation", async () => {
    const scenario = fixture({
      formatVersion: 1,
      resultText: null,
      lastError: "Protected Task execution failed",
    });
    const substituted = {
      ...scenario.input,
      evidence: {
        ...scenario.input.evidence,
        requestId: "another-request",
      },
    } as CompleteProtectedTaskRunResultInput;
    const failure = await completeProtectedTaskRunResult(
      substituted,
      scenario.dependencies,
    ).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(scenario.prepareCalls()).toBe(0);
    expect(scenario.publications).toEqual([]);

    scenario.controller.abort();
    const aborted = await completeProtectedTaskRunResult(
      scenario.input,
      scenario.dependencies,
    ).then(() => null, (error: unknown) => error);
    expect(aborted).toBeInstanceOf(Error);
    expect(scenario.prepareCalls()).toBe(0);
    expect(scenario.publications).toEqual([]);
  });
});
