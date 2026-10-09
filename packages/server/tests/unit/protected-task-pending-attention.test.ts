import { expect, test } from "bun:test";
import { bindEncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import type { ServerEvent } from "@nautilo/types";
import { candidate, ids } from "../fixtures/protected-task-pending-attention";
import { createProtectedTaskPendingAttention, protectedTaskAttentionEvents } from "../../src/routes/protected-task-pending-attention";

function approval(): Extract<ServerEvent, { type: "approval.ask" }> {
  return { type: "approval.ask", approvalId: "approval:request",
    threadId: candidate().occurrence.run.graphThreadId, laneKey: `task:${ids.task}`,
    userId: "old-recipient", tools: [], reason: "Review action",
    reasonCode: "destructive-tool", allowedVerbs: ["once", "room", "deny"] };
}

test("sealed Task approval is patched with canonical recipient, exact Run and orphan controls", () => {
  const original = candidate();
  const orphan = candidate({ occurrence: { ...original.occurrence,
    task: { ...original.occurrence.task, targetRoomId: null } } });
  expect(protectedTaskAttentionEvents([approval()], orphan, ids.requestor)).toEqual([{
    ...approval(), userId: ids.requestor, origin: "task", taskId: ids.task,
    taskRunId: ids.run, allowedVerbs: ["once", "deny"],
  }]);
  expect(protectedTaskAttentionEvents([approval()], original, ids.owner)[0])
    .toMatchObject({ allowedVerbs: ["once", "room", "deny"] });
});

test("Task attention rejects missing, duplicate, wrong-thread, wrong-lane and wrong-request events", () => {
  for (const events of [[], [approval(), approval()],
    [{ ...approval(), threadId: "other-thread" }],
    [{ ...approval(), laneKey: "task:other" }],
    [{ ...approval(), approvalId: "other-request" }]]) {
    expect(() => protectedTaskAttentionEvents(events, candidate(), ids.owner)).toThrow();
  }
});

test("Task proof and identity prompts bind sealed interrupt coordinates", () => {
  const pending = candidate({ pendingAttentionInterrupts: [
    { id: "proof-interrupt", kind: "prove_it" },
    { id: "identity-interrupt", kind: "identity", requestId: "identity-request" },
  ] });
  const common = { threadId: pending.occurrence.run.graphThreadId, laneKey: `task:${ids.task}` };
  const events: Extract<ServerEvent, { type: "prove_it.challenge" | "identity.challenge" }>[] = [
    { ...common, type: "prove_it.challenge", challengeId: "proof-interrupt", tools: [] },
    { ...common, type: "identity.challenge", challengeId: "identity-request", expiresAt: "2026-10-09T13:00:00Z" },
  ];
  expect(protectedTaskAttentionEvents(events, pending, ids.requestor)).toEqual(events.map(event => ({
    ...event, origin: "task", taskId: ids.task, taskRunId: ids.run, userId: ids.requestor,
  })));
  expect(() => protectedTaskAttentionEvents([{ ...events[0]!, challengeId: "wrong" } as ServerEvent, events[1]!], pending, ids.requestor)).toThrow();
});

test("Plain Task attention does not query metadata or request private key custody", async () => {
  const forbidden = () => { throw new Error("protected port reached in Plain mode"); };
  const service = createProtectedTaskPendingAttention({
    db: {} as never, restricted: {} as never, serverScope: "test-server",
    recipients: {} as never,
    owner: bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({ policy: { mode: "plaintext_only", shadowBehavior: "fallback" }, revalidationToken: 0 }),
      revalidate: async () => {},
    } }),
  }, { metadata: { list: forbidden, readCurrent: forbidden },
    resolveSourceRoom: forbidden, inspect: forbidden, readEvents: forbidden });
  try {
    expect(await service.page({ userId: ids.owner, humanActorId: ids.actor,
      clientDeviceId: "device", clientActionSessionId: "session" }))
      .toEqual({ status: "unavailable", nextCursor: null });
  } finally { service.close(); }
});
