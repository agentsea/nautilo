import { describe, expect, test } from "bun:test";
import { protectedTaskSemanticAuthorityRequirementsDigest } from "@nautilo/db";

import { protectedTaskInterruptCoordinates } from
  "../../src/graph/interrupt-mapping";

const NAMESPACE = "10000000-0000-4000-8000-000000000001";

function state(value: Record<string, unknown>) {
  return { tasks: [{ interrupts: [{ id: "interrupt-1", value }] }] };
}

describe("protected Task interrupt mapping", () => {
  test("extracts a detached additional-authority continuation coordinate", () => {
    const requestDigest = new Uint8Array(32).fill(1);
    const semanticAuthorityRequirements = [{
      namespaceId: NAMESPACE,
      operations: ["decrypt", "encrypt"] as const,
    }];
    const requiredAuthorityDigest =
      protectedTaskSemanticAuthorityRequirementsDigest(
        semanticAuthorityRequirements,
      );
    const coordinates = protectedTaskInterruptCoordinates(state({
      type: "protected_task_additional_authority",
      authorizationRequestId: "task-runtime-request-2",
      effectDisposition: "not_started_v1",
      operationId: "memory-operation-1",
      requestDigest,
      requiredAuthorityDigest,
      semanticAuthorityRequirements,
    }));

    expect(coordinates).toEqual([{
      id: "interrupt-1",
      kind: "additional_authority",
      requestId: "task-runtime-request-2",
      effectDisposition: "not_started_v1",
      operationId: "memory-operation-1",
      requestDigest,
      requiredAuthorityDigest,
      semanticAuthorityRequirements,
    }]);
    expect((coordinates[0] as { requestDigest: Uint8Array }).requestDigest)
      .not.toBe(requestDigest);
    expect((coordinates[0] as { requiredAuthorityDigest: Uint8Array })
      .requiredAuthorityDigest).not.toBe(requiredAuthorityDigest);
  });

  test.each([
    ["short request digest", {
      type: "protected_task_additional_authority",
      authorizationRequestId: "task-runtime-request-2",
      effectDisposition: "not_started_v1",
      operationId: "memory-operation-1",
      requestDigest: new Uint8Array(31),
      requiredAuthorityDigest: new Uint8Array(32),
      semanticAuthorityRequirements: [{
        namespaceId: NAMESPACE,
        operations: ["decrypt"],
      }],
    }],
    ["non-canonical operations", {
      type: "protected_task_additional_authority",
      authorizationRequestId: "task-runtime-request-2",
      effectDisposition: "not_started_v1",
      operationId: "memory-operation-1",
      requestDigest: new Uint8Array(32),
      requiredAuthorityDigest: new Uint8Array(32),
      semanticAuthorityRequirements: [{
        namespaceId: NAMESPACE,
        operations: ["encrypt", "decrypt"],
      }],
    }],
    ["authority digest mismatch", {
      type: "protected_task_additional_authority",
      authorizationRequestId: "task-runtime-request-2",
      effectDisposition: "not_started_v1",
      operationId: "memory-operation-1",
      requestDigest: new Uint8Array(32),
      requiredAuthorityDigest: new Uint8Array(32).fill(9),
      semanticAuthorityRequirements: [{
        namespaceId: NAMESPACE,
        operations: ["decrypt"],
      }],
    }],
    ["started effect", {
      type: "protected_task_additional_authority",
      authorizationRequestId: "task-runtime-request-2",
      effectDisposition: "started",
      operationId: "memory-operation-1",
      requestDigest: new Uint8Array(32),
      requiredAuthorityDigest: new Uint8Array(32),
      semanticAuthorityRequirements: [{
        namespaceId: NAMESPACE,
        operations: ["decrypt"],
      }],
    }],
  ] as const)("rejects %s", (_label, value) => {
    expect(() => protectedTaskInterruptCoordinates(state(value)))
      .toThrow("additional authority interrupt is malformed");
  });
});
