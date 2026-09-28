import { describe, expect, test } from "bun:test";

import {
  deriveTaskContentCryptoObjectIdV1,
  type TaskRunResultPayloadV1,
} from "@nautilo/lattice-bridge";

import {
  completeProtectedTaskRunResult,
  publishPreparedProtectedTaskRunResult,
  type CompleteProtectedTaskRunResultDependencies,
  type CompleteProtectedTaskRunResultInput,
  type PublishPreparedProtectedTaskRunResultInput,
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
      contentRevision: 1 as const,
      objectId: resultObjectId,
      signerAgentId: "60000000-0000-4000-8000-000000000006",
      namespace: {
        namespaceId: NAMESPACE_ID,
        domainId: DOMAIN_ID,
        operations: ["encrypt"] as const,
        expectedAccessRevision: 4,
        expectedPolicyRevision: 7,
      },
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
    digestPrepared: () => new Uint8Array(32).fill(9),
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
  return {
    input,
    prepared: prepared as ReturnType<
      CompleteProtectedTaskRunResultDependencies["prepare"]
    >,
    controller,
    dependencies,
    publications,
    prepareCalls: () => prepareCalls,
  };
}

describe("protected Task result completion", () => {
  test("publishes an exact native-prepared result without preparing it again", async () => {
    const payload: TaskRunResultPayloadV1 = {
      formatVersion: 1,
      resultText: "Protected answer",
      lastError: null,
    };
    const scenario = fixture(payload);
    const receipt = await publishPreparedProtectedTaskRunResult({
      repository: scenario.input.repository,
      terminal: scenario.input.terminal,
      dualTerminal: scenario.input.dualTerminal,
      owner: scenario.input.owner,
      reference: scenario.input.reference,
      authority: scenario.input.authority,
      prepared: scenario.prepared,
      evidence: scenario.input.evidence,
      signal: scenario.input.signal,
      scheduleKind: scenario.input.scheduleKind,
      completedAt: scenario.input.completedAt,
      ordinaryContent: Object.freeze({ coordinate, payload }),
    } as PublishPreparedProtectedTaskRunResultInput, scenario.dependencies);

    expect(receipt).toMatchObject({ status: "mapped", taskRunId: RUN_ID });
    expect(scenario.prepareCalls()).toBe(0);
    expect(scenario.publications).toHaveLength(1);
    const publication = scenario.publications[0]!;
    expect(publication.outcome).toBe("completed");
    expect(publication.scheduleKind).toBe("cron");
    expect(publication.ordinaryContent).toEqual({ coordinate, payload });
    expect(publication.requestDigest).toEqual(new Uint8Array(32).fill(9));
  });

  test.each([
    ["grant", (input: PublishPreparedProtectedTaskRunResultInput) => ({
      ...input,
      evidence: { ...input.evidence, requestId: "another-request" },
    })],
    ["prepared coordinate", (input: PublishPreparedProtectedTaskRunResultInput) => ({
      ...input,
      prepared: {
        ...input.prepared,
        coordinate: { ...input.prepared.coordinate, taskRunId: TASK_ID },
      },
    })],
    ["ordinary sibling", (input: PublishPreparedProtectedTaskRunResultInput) => ({
      ...input,
      ordinaryContent: {
        ...input.ordinaryContent,
        coordinate: { ...input.ordinaryContent.coordinate, taskRunId: TASK_ID },
      },
    })],
  ] as const)("rejects a substituted %s before digest or publication", async (
    _label,
    substitute,
  ) => {
    const scenario = fixture({
      formatVersion: 1,
      resultText: "Protected answer",
      lastError: null,
    });
    let digestCalls = 0;
    const input = {
      repository: scenario.input.repository,
      terminal: scenario.input.terminal,
      dualTerminal: scenario.input.dualTerminal,
      owner: scenario.input.owner,
      reference: scenario.input.reference,
      authority: scenario.input.authority,
      prepared: scenario.prepared,
      evidence: scenario.input.evidence,
      signal: scenario.input.signal,
      scheduleKind: scenario.input.scheduleKind,
      completedAt: scenario.input.completedAt,
      ordinaryContent: Object.freeze({
        coordinate,
        payload: scenario.input.payload,
      }),
    } as PublishPreparedProtectedTaskRunResultInput;
    const failure = await publishPreparedProtectedTaskRunResult(
      substitute(input) as PublishPreparedProtectedTaskRunResultInput,
      {
        ...scenario.dependencies,
        digestPrepared: () => {
          digestCalls += 1;
          return new Uint8Array(32).fill(9);
        },
      },
    ).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(digestCalls).toBe(0);
    expect(scenario.publications).toEqual([]);
  });

  test("routes legacy preparation through prepared-result publication", async () => {
    const payload: TaskRunResultPayloadV1 = {
      formatVersion: 1,
      resultText: null,
      lastError: "Protected Task execution failed",
    };
    const scenario = fixture(payload);
    const receipt = await completeProtectedTaskRunResult(
      scenario.input,
      scenario.dependencies,
    );

    expect(receipt).toMatchObject({ status: "mapped", taskRunId: RUN_ID });
    expect(scenario.prepareCalls()).toBe(1);
    expect(scenario.publications).toHaveLength(1);
    expect(scenario.publications[0]).toMatchObject({
      outcome: "errored",
      ordinaryContent: { coordinate, payload },
    });
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
