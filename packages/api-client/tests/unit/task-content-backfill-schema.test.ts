import { describe, expect, test } from "bun:test";
import {
  LATTICE_LIMITS,
  MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2,
} from "@nautilo/lattice-crypto/wire-limits";

import {
  taskContentBackfillAckRequestSchema,
  taskContentBackfillClaimResponseSchema,
  taskContentBackfillPublishRequestSchema,
  taskContentBackfillPublishResponseSchema,
  taskContentBackfillRecoverResponseSchema,
  taskContentBackfillSourceResponseSchema,
} from "../../src/schemas/task-content-backfill.ts";

const TASK_ID = "91000000-0000-4000-8000-000000000001";
const RUN_ID = "91000000-0000-4000-8000-000000000002";
const CLAIM_ID = "91000000-0000-4000-8000-000000000003";
const HUMAN_ID = "91000000-0000-4000-8000-000000000004";
const USER_ID = "91000000-0000-4000-8000-000000000005";
const ROOM_ID = "91000000-0000-4000-8000-000000000006";
const NAMESPACE_ID = "91000000-0000-4000-8000-000000000007";
const DIGEST = "A".repeat(43);

const candidate = Object.freeze({
  kind: "result" as const,
  taskId: TASK_ID,
  taskRunId: RUN_ID,
  sourceUpdatedAt: 1_000,
  sourceStartedAt: 900,
  sourceCompletedAt: 1_100,
  sourceRevision: 0,
  sourceStatus: "completed" as const,
});

const claim = Object.freeze({
  claimId: CLAIM_ID,
  humanActorId: HUMAN_ID,
  requesterUserId: USER_ID,
  deviceId: "device.1",
  policyRevision: 3,
  expiresAt: 10_000,
  candidate,
});

const plan = Object.freeze({
  planVersion: 1 as const,
  claimId: CLAIM_ID,
  operationId: "task-historical-publish:one",
  coordinate: Object.freeze({
    kind: "run_result" as const,
    taskId: TASK_ID,
    taskRunId: RUN_ID,
    contentRevision: 1 as const,
  }),
  objectId: `task-historical:v1:${"a".repeat(64)}`,
  namespaceId: NAMESPACE_ID,
  domainId: "human-domain.1",
  requesterHumanId: HUMAN_ID,
  deviceId: "device.1",
  hostAuthorizationRevision: 4,
  expectedAccessRevision: 2,
  expectedPolicyRevision: 3,
  keyGeneration: 5,
  bindingHashBase64url: DIGEST,
  sourceDigestBase64url: DIGEST,
  sourcePayloadHashBase64url: DIGEST,
  operationalFieldsDigestBase64url: DIGEST,
  planDigestBase64url: DIGEST,
  expiresAt: 9_000,
});

describe("Task content backfill transport schemas", () => {
  test("accepts exact retained claims and closed publication sources", () => {
    expect(taskContentBackfillClaimResponseSchema.parse({
      status: "ready",
      value: { status: "claimed", claim },
    })).toEqual({ status: "ready", value: { status: "claimed", claim } });

    const source = {
      status: "source" as const,
      sourceRoomId: ROOM_ID,
      plan,
      payloadBytesBase64url: "eyJmb3JtYXRWZXJzaW9uIjoxfQ",
    };
    expect(taskContentBackfillSourceResponseSchema.parse(source)).toEqual(source);
    expect(() => taskContentBackfillSourceResponseSchema.parse({
      ...source,
      prompt: "plaintext must not cross this transport",
    })).toThrow();
  });

  test("keeps terminal source outcomes explicit and bounded", () => {
    expect(taskContentBackfillSourceResponseSchema.parse({ status: "inactive" }))
      .toEqual({ status: "inactive" });
    expect(taskContentBackfillPublishResponseSchema.parse({ status: "inactive" }))
      .toEqual({ status: "inactive" });
    expect(taskContentBackfillRecoverResponseSchema.parse({ status: "inactive" }))
      .toEqual({ status: "inactive" });
    expect(taskContentBackfillSourceResponseSchema.parse({
      status: "waiting_for_authority",
      resumeAt: null,
    })).toEqual({ status: "waiting_for_authority", resumeAt: null });
    expect(taskContentBackfillAckRequestSchema.parse({
      claimId: CLAIM_ID,
      outcome: "waiting_parent",
    })).toEqual({ claimId: CLAIM_ID, outcome: "waiting_parent" });
    expect(() => taskContentBackfillAckRequestSchema.parse({
      claimId: CLAIM_ID,
      outcome: "failed",
    })).toThrow();
  });

  test("rejects malformed coordinates and noncanonical wire bytes", () => {
    expect(() => taskContentBackfillClaimResponseSchema.parse({
      status: "ready",
      value: {
        status: "claimed",
        claim: { ...claim, candidate: { ...candidate, sourceRevision: -1 } },
      },
    })).toThrow();
    expect(() => taskContentBackfillSourceResponseSchema.parse({
      status: "source",
      sourceRoomId: ROOM_ID,
      plan: { ...plan, coordinate: { ...plan.coordinate, taskRunId: TASK_ID } },
      payloadBytesBase64url: "has=padding",
    })).toThrow();
  });

  test("uses lattice wire bounds for plaintext source and encrypted upload", () => {
    const maximumSourceLength = Math.ceil(LATTICE_LIMITS.plaintextBytes * 4 / 3);
    const baseSource = {
      status: "source" as const,
      sourceRoomId: ROOM_ID,
      plan,
    };
    const parsedSource = taskContentBackfillSourceResponseSchema.parse({
      ...baseSource,
      payloadBytesBase64url: "A".repeat(maximumSourceLength),
    });
    expect(parsedSource.status).toBe("source");
    if (parsedSource.status !== "source") throw new Error("Expected source");
    expect(parsedSource.payloadBytesBase64url).toHaveLength(maximumSourceLength);
    expect(() => taskContentBackfillSourceResponseSchema.parse({
      ...baseSource,
      payloadBytesBase64url: "A".repeat(maximumSourceLength + 1),
    })).toThrow();

    const maximumCiphertextLength = Math.ceil(
      MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2 * 4 / 3,
    );
    const upload = {
      claimId: CLAIM_ID,
      requestBytesBase64url: "c2lnbmVk",
      payloadBytesBase64url: "A".repeat(maximumCiphertextLength),
      manifestBytesBase64url: "bWFuaWZlc3Q",
      envelopeBytesBase64url: "ZW52ZWxvcGU",
    };
    expect(taskContentBackfillPublishRequestSchema.parse(upload)
      .payloadBytesBase64url).toHaveLength(maximumCiphertextLength);
    expect(() => taskContentBackfillPublishRequestSchema.parse({
      ...upload,
      payloadBytesBase64url: "A".repeat(maximumCiphertextLength + 1),
    })).toThrow();
  });
});
