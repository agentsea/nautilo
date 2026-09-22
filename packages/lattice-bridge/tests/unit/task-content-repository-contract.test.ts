import { describe, expect, test } from "bun:test";

import type { TaskContentAuthorityV1 } from "../../src/task/task-content-authority-v1.ts";
import {
  TASK_CONTENT_PAYLOAD_VERSION_V1,
  assertTaskContentRevisionLifecycleV1,
  deriveTaskContentCryptoObjectIdV1,
  fingerprintTaskContentAuthorityV1,
  fingerprintTaskContentNamespaceV1,
  type TaskContentRevisionLifecycleV1,
} from "../../src/task/task-content-repository.ts";

const TASK_A = "10000000-0000-4000-8000-000000000001";
const TASK_B = "10000000-0000-4000-8000-000000000002";
const RUN_A = "20000000-0000-4000-8000-000000000001";

const authority = Object.freeze({
  authorityVersion: 1,
  kind: "requester_private_namespace",
  keyClass: "ai",
  requesterHumanId: "30000000-0000-4000-8000-000000000001",
  namespaceId: "40000000-0000-4000-8000-000000000001",
  domainId: "50000000-0000-4000-8000-000000000001",
  expectedAccessRevision: 0,
  expectedPolicyRevision: 1,
} satisfies TaskContentAuthorityV1);

function lifecycle(
  overrides: Partial<TaskContentRevisionLifecycleV1> = {},
): TaskContentRevisionLifecycleV1 {
  const coordinate = Object.freeze({
    kind: "definition" as const,
    taskId: TASK_A,
    contentRevision: 1,
  });
  return Object.freeze({
    sequence: 1,
    coordinate,
    operationId: "task-content-operation.1",
    requestDigest: new Uint8Array(32).fill(1),
    requesterHumanId: authority.requesterHumanId,
    namespaceId: authority.namespaceId,
    cryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
    objectType: "nautilo-task-definition-v1",
    payloadVersion: TASK_CONTENT_PAYLOAD_VERSION_V1,
    representation: "protected",
    authorityFingerprint: fingerprintTaskContentAuthorityV1(authority),
    requiredNamespaceFingerprint: fingerprintTaskContentNamespaceV1(
      authority.namespaceId,
    ),
    operationalMetadata: {},
    completion: "pending",
    disposition: "active",
    attemptCount: 0,
    nextAttemptAt: new Date(0),
    leaseToken: null,
    leaseExpiresAt: null,
    failureCode: null,
    cryptoCompletedAt: null,
    ...overrides,
  });
}

describe("Task content repository identity contract", () => {
  test("domain-separates definition and run result identities", () => {
    const definition = deriveTaskContentCryptoObjectIdV1({
      kind: "definition",
      taskId: TASK_A,
      contentRevision: 1,
    });
    const result = deriveTaskContentCryptoObjectIdV1({
      kind: "run_result",
      taskId: TASK_A,
      taskRunId: RUN_A,
      contentRevision: 1,
    });
    expect(definition).toMatch(/^task-definition:v1:[0-9a-f]{64}$/);
    expect(result).toMatch(/^task-run-result:v1:[0-9a-f]{64}$/);
    expect(definition).not.toBe(result);
    expect(definition).not.toBe(deriveTaskContentCryptoObjectIdV1({
      kind: "definition",
      taskId: TASK_B,
      contentRevision: 1,
    }));
    expect(result).not.toBe(deriveTaskContentCryptoObjectIdV1({
      kind: "run_result",
      taskId: TASK_A,
      taskRunId: "20000000-0000-4000-8000-000000000002",
      contentRevision: 1,
    }));
  });

  test("fingerprints every requester-private authority revision", () => {
    const baseline = fingerprintTaskContentAuthorityV1(authority);
    expect(baseline).toHaveLength(32);
    expect(baseline).not.toEqual(fingerprintTaskContentAuthorityV1({
      ...authority,
      expectedAccessRevision: 1,
    }));
    expect(baseline).not.toEqual(fingerprintTaskContentAuthorityV1({
      ...authority,
      expectedPolicyRevision: 2,
    }));
    expect(baseline).not.toEqual(fingerprintTaskContentAuthorityV1({
      ...authority,
      namespaceId: "namespace.private.other",
    }));
    expect(() => fingerprintTaskContentAuthorityV1({
      ...authority,
      expectedPolicyRevision: 0,
    })).toThrow("policy revision");
  });

  test("rejects forged lifecycle identity and unbounded retries", () => {
    expect(() => assertTaskContentRevisionLifecycleV1(lifecycle()))
      .not.toThrow();
    expect(() => assertTaskContentRevisionLifecycleV1(lifecycle({
      cryptoObjectId: "task-definition:v1:forged",
    }))).toThrow("not canonical");
    expect(() => assertTaskContentRevisionLifecycleV1(lifecycle({
      attemptCount: 9,
    }))).toThrow("attempt count");
    expect(() => assertTaskContentRevisionLifecycleV1(lifecycle({
      authorityFingerprint: new Uint8Array(31),
    }))).toThrow("exactly 32 bytes");
  });
});
