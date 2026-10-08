import { expect, test } from "bun:test";
import { createDelegatedLocalExecutionPort, eventBus, type DelegatedTaskIdentity } from "@nautilo/runtime";
import { publishRoomMembersChanged } from "../../src/realtime/ws-publisher";

const task: DelegatedTaskIdentity = { id: "task", ownerId: "owner", requestorId: "human", agentId: "agent",
  callingRoomId: "room", targetRoomId: "task-room", parentTaskId: null, scheduleKind: "now", status: "completed",
  contentRepresentation: "ordinary", contentRevision: 0,
  localExecutionDelegation: { version: 1, humanUserId: "human", agentId: "agent", rootTaskId: "task",
    sourceRoomId: "room", sourceConversationId: "thread", projectGrantId: "grant", ceiling: "basic", profile: null,
    target: { instanceId: "", relayId: "relay", pairingGeneration: "pair", serverOrigin: "https://server.invalid", serverFingerprint: "fingerprint" } } };

test("canonical Room roster publication rechecks retained source without a new tool call", async () => {
  let allowed = true;
  let subscriptions = 0;
  const port = createDelegatedLocalExecutionPort({ taskId: "task", taskRunId: "run", humanUserId: "human", agentId: "agent",
    signal: new AbortController().signal, readTask: async () => structuredClone(task),
    readRun: async () => ({ id: "run", taskId: "task", status: "completed" }),
    assertSource: async () => { if (!allowed) throw new Error("membership withdrawn"); },
    subscribeChanges: check => { subscriptions++; eventBus.onTaskLocalExecutionSourceChanged(check);
      return () => { subscriptions--; eventBus.offTaskLocalExecutionSourceChanged(check); }; },
  });
  const release = port.retain!();
  expect(await port.withAdmission("read", async () => "retained")).toBe("retained");
  const aborted = new Promise<void>(resolve => port.signal.addEventListener("abort", () => resolve(), { once: true }));
  allowed = false;
  publishRoomMembersChanged("room", { kind: "member_removed", actorId: "human-actor", actorKind: "user", displayName: "Human" });
  await aborted;
  expect(port.signal.aborted).toBe(true);
  expect(subscriptions).toBe(0);
  release();
  expect(subscriptions).toBe(0);
});
