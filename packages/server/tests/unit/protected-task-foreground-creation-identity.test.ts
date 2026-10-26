import { expect, test } from "bun:test";
import type { TaskCreationInvocationProvenance } from "@nautilo/agent";
import { classifyProtectedTaskMetadataV1 } from "@nautilo/types";
import type { ProtectedTaskCreationPlanV1, TaskCreateInput } from "@nautilo/runtime";
import { protectedTaskForegroundCreationIdentity, protectedTaskForegroundCreationCandidateIdentity,
  protectedTaskForegroundUpdateIdentity } from "../../src/routes/protected-task-foreground-creation-identity";

const metadata = classifyProtectedTaskMetadataV1({});
if (metadata.status !== "supported") throw new Error("Fixture metadata unsupported");
const plan: ProtectedTaskCreationPlanV1 = {
  canonicalTaskIdentity: { ownerId: "user", requestorId: "user", agentId: "agent" },
  authority: { authorityVersion: 1, kind: "requester_private_namespace", keyClass: "ai", requesterHumanId: "actor",
    namespaceId: "namespace", domainId: "domain", expectedAccessRevision: 1, expectedPolicyRevision: 1 },
  shape: { conversation: "public", memory: "namespace", executor: "native" },
  payload: { formatVersion: 1, prompt: "Private task", expectedOutput: null, protectedMetadata: {} },
  operationalMetadata: metadata.operational,
};
const invocation: TaskCreationInvocationProvenance = { ownerId: "user", roomId: "room", entrypoint: "foreground.main",
  effect: { turnId: "turn", toolCallId: "call", timeReferenceMs: 1_800_000_000_000 } };
const candidate: TaskCreateInput = { ownerId: "user", requestorId: "user", agentId: "agent", callingRoomId: "room", prompt: "Private task" };
const identity = (overrides: Partial<Parameters<typeof protectedTaskForegroundCreationIdentity>[0]> = {}) =>
  protectedTaskForegroundCreationIdentity({ invocation, prepared: plan, candidate, ...overrides });

test("renewed authority and operational JSON key order preserve the exact tool Task and schedule", () => {
  const first = identity({ candidate: { ...candidate, selectionSpec: { objective: "cheap", band: "smart" } } });
  const renewed: ProtectedTaskCreationPlanV1 = { ...plan, authority: { ...plan.authority, expectedPolicyRevision: 7, expectedAccessRevision: 4 } };
  const replay = identity({ prepared: renewed,
    candidate: { ...candidate, selectionSpec: { band: "smart", objective: "cheap" } } });
  expect(replay).toEqual(first);
  expect(first.taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect(first.scheduleReference.getTime()).toBe(invocation.effect!.timeReferenceMs);
});

test("pre-admission lock discovery agrees with admitted source despite foreign Agent ownership", () => {
  const discovered = protectedTaskForegroundCreationCandidateIdentity({ invocation, candidate: { ...candidate, ownerId: "agent-owner" } });
  expect(discovered).toEqual(identity());
  expect(candidate.ownerId).toBe("user");
});

test("changed payload or routing changes the Task but conflicts on the same durable effect", () => {
  const first = identity();
  for (const changed of [identity({ prepared: { ...plan, payload: { ...plan.payload, prompt: "Different" } } }),
    identity({ candidate: { ...candidate, resultDelivery: "raw" } })]) {
    expect(changed.taskId).not.toBe(first.taskId);
    expect(changed.operationId).toBe(first.operationId);
  }
  const otherCall = identity({ invocation: { ...invocation, effect: { ...invocation.effect!, toolCallId: "other" } } });
  expect(otherCall.taskId).not.toBe(first.taskId);
  expect(otherCall.operationId).not.toBe(first.operationId);
});

test("caller-provided IDs and fresh clocks cannot substitute for missing trusted tool provenance", () => {
  const withoutEffect: TaskCreationInvocationProvenance = { ownerId: invocation.ownerId, roomId: invocation.roomId, entrypoint: invocation.entrypoint };
  for (const provenance of [null, withoutEffect,
    { ...invocation, roomId: "other" }, { ...invocation, ownerId: "other" },
    { ...invocation, entrypoint: "background.task" as const },
    { ...invocation, effect: { ...invocation.effect!, timeReferenceMs: NaN } }]) {
    expect(() => identity({ invocation: provenance })).toThrow("trusted checkpointed tool effect");
  }
});

test("Task updates use the trusted tool effect and exact Task coordinate", () => {
  const first = protectedTaskForegroundUpdateIdentity({ invocation, taskId: "task-1",
    requestorId: "user", agentId: "agent", callingRoomId: "room" });
  expect(protectedTaskForegroundUpdateIdentity({ invocation, taskId: "task-1",
    requestorId: "user", agentId: "agent", callingRoomId: "room" })).toEqual(first);
  expect(protectedTaskForegroundUpdateIdentity({ invocation, taskId: "task-2",
    requestorId: "user", agentId: "agent", callingRoomId: "room" })).not.toEqual(first);
  expect(protectedTaskForegroundUpdateIdentity({ invocation: { ...invocation,
    effect: { ...invocation.effect!, toolCallId: "other" } }, taskId: "task-1",
    requestorId: "user", agentId: "agent", callingRoomId: "room" })).not.toEqual(first);
  expect(() => protectedTaskForegroundUpdateIdentity({ invocation, taskId: "task-1",
    requestorId: "other", agentId: "agent", callingRoomId: "room" })).toThrow(/trusted checkpointed tool effect/u);
});

test("Task authorization work binds the complete candidate and exact observed update source", () => {
  const first = identity();
  expect(first.workDescriptorDigest).toHaveLength(32);
  expect(identity({ prepared: { ...plan, payload: { ...plan.payload, prompt: "changed" } } }).workDescriptorDigest)
    .not.toEqual(first.workDescriptorDigest);
  const update = (contentRevision: number, mutationVersion: string) => protectedTaskForegroundUpdateIdentity({
    invocation, taskId: "task-1", requestorId: "user", agentId: "agent", callingRoomId: "room",
    source: { contentRevision, mutationVersion },
  });
  const current = update(3, "123");
  for (const changed of [update(4, "123"), update(3, "124")]) {
    expect(changed.operationId).toBe(current.operationId);
    expect(changed.workDescriptorDigest).not.toEqual(current.workDescriptorDigest);
  }
  const intent = { taskId: "task-1", ownerId: "user", requestorId: "user", agentId: "agent",
    callingRoomId: "room", prompt: "first" };
  const withRequest = (prompt: string) => protectedTaskForegroundUpdateIdentity({
    invocation, taskId: "task-1", requestorId: "user", agentId: "agent", callingRoomId: "room",
    source: { contentRevision: 3, mutationVersion: "123" }, request: { ...intent, prompt },
  });
  expect(withRequest("first").operationId).toBe(withRequest("second").operationId);
  expect(withRequest("first").workDescriptorDigest).not.toEqual(withRequest("second").workDescriptorDigest);
});
