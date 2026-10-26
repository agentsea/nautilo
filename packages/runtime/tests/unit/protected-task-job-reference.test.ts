import { expect, test } from "bun:test";
import { assertProtectedTaskJobReferenceV1 } from "../../src/tasks/protected-task-job-reference";

const taskId = "11111111-1111-4111-8111-111111111111";
const taskRunId = "22222222-2222-4222-8222-222222222222";
const reference = {
  kind: "protected_task_run_v1", taskId, taskRunId,
  inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
  resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
  authorizationRequestId: `task-run-authorization:${taskRunId}`,
  policyRevision: 1, executionSegment: 1,
};

test("durable correlation accepts only native or closed historical lexical definition families", () => {
  for (const inputObjectId of [reference.inputObjectId, `task-historical:v1:${"c".repeat(64)}`]) {
    expect(() => assertProtectedTaskJobReferenceV1({ ...reference, inputObjectId })).not.toThrow();
  }
  for (const inputObjectId of [reference.resultObjectId, "task-historical:v1:anything",
    `task-historical:v2:${"c".repeat(64)}`, `task-historical:v1:${"C".repeat(64)}`]) {
    expect(() => assertProtectedTaskJobReferenceV1({ ...reference, inputObjectId })).toThrow();
  }
  expect(() => assertProtectedTaskJobReferenceV1({ ...reference,
    definitionHistoricalRepair: {} })).toThrow();
});
