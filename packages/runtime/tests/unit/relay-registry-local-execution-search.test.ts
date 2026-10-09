import { expect, test } from "bun:test";
import type { RelayLocalExecutionBindingV1, RelayLocalExecutionHistoryBindingV1, RelayServerMessage } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";
async function fixture(protocol = 26, capable = true) {
  const registry = new InMemoryRelayRegistry(); const sent: RelayServerMessage[] = [];
  await registry.register("relay", "human", { profile: "desktop-agent", canExecuteLocal: true, canReadLocalExecutionHistory: true, canSearchLocalExecutionOutput: capable,
    localExecution: { version: 1, generation: "host", pipe: true, pty: true, capacity: 2 } }, message => {
    sent.push(message); if (message.type === "relay:dispatch") registry.resolveDispatch(message.correlationId, { status: "ok", result: { state: "running", resources: "owned" } });
  }, protocol, "desktop", 1, "raw-pair");
  const pairingGeneration = registry.getLocalExecutionPairingGeneration("relay")!;
  const binding: RelayLocalExecutionBindingV1 = { version: 1, generation: "host", invocationId: "start", executionId: "execution", operation: "start",
    owner: { instanceId: "", humanUserId: "human", agentId: "agent", runId: "run", conversationId: "thread", relayId: "relay", desktopSessionId: "desktop", pairingGeneration,
      serverBindingId: "server", profileId: null, profileRevision: null, grantIds: [], grantRevision: null, protectedPolicyVersion: null } };
  const history: RelayLocalExecutionHistoryBindingV1 = { version: 1, generation: "old", executionId: "old-execution", invocationId: "history", sourceMessageId: 1,
    reader: { instanceId: "", humanUserId: "human", agentId: "agent", conversationId: "thread", roomId: "room", relayId: "relay", desktopSessionId: "desktop", pairingGeneration } };
  return { registry, sent, binding, history };
}
const outcome = (promise: Promise<unknown>) => promise.then(() => "sent", () => "denied");
for (const [protocol, capable] of [[25, true], [26, false], [26, true]] as const) test(`live and historical search exact feature admission ${protocol}/${capable}`, async () => {
  const f = await fixture(protocol, capable);
  await f.registry.dispatch("relay", { toolName: "exec_command", args: { cmd: "fixture" }, impact: "destructive", approvalObtained: true, localExecutionBinding: f.binding });
  const read = { toolName: "write_stdin", args: { session_id: "execution", search: "needle", cursor: 0 }, impact: "read-only" as const, approvalObtained: true,
    localExecutionBinding: { ...f.binding, operation: "read" as const, invocationId: "read" } };
  const expected = protocol === 26 && capable ? "sent" : "denied";
  expect(await outcome(f.registry.dispatch("relay", read))).toBe(expected);
  expect(await outcome(f.registry.dispatch("relay", { toolName: "write_stdin", args: { session_id: "old-execution", search: "needle", cursor: 0 },
    impact: "read-only", approvalObtained: true, localExecutionHistoryBinding: f.history }))).toBe(expected);
  expect(f.sent).toHaveLength(expected === "sent" ? 3 : 1);
  const before = f.sent.length;
  for (const extra of [{ chars: "" }, { cancel: true }, { yield_time_ms: 0 }]) expect(await outcome(f.registry.dispatch("relay", { ...read, args: { ...read.args, ...extra } }))).toBe("denied");
  expect(await outcome(f.registry.dispatch("relay", { ...read, localExecutionBinding: { ...read.localExecutionBinding, owner: { ...f.binding.owner, humanUserId: "foreign" } } }))).toBe("denied");
  expect(f.sent).toHaveLength(before);
  // Ordinary reads and unrelated tools' search arguments are not feature-gated.
  expect(await outcome(f.registry.dispatch("relay", { ...read, args: { session_id: "execution" } }))).toBe("sent");
  expect(await outcome(f.registry.dispatch("relay", { toolName: "other_tool", args: { search: "query" }, impact: "read-only", approvalObtained: true }))).toBe("sent");
});
