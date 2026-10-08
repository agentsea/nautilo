import { expect, test } from "bun:test";
import { isRelayLocalExecutionHistoryRead, parseRelayLocalExecutionHistoryBinding, projectRelayCapabilitiesForProtocol, type RelayLocalExecutionHistoryBindingV1 } from "../../src/protocol";
const binding: RelayLocalExecutionHistoryBindingV1 = { version: 1, executionId: "execution-a", generation: "old-generation", invocationId: "read-a", sourceMessageId: 42,
  reader: { instanceId: "", humanUserId: "human-a", agentId: "agent-a", conversationId: "room:a", roomId: "a", relayId: "relay-a", desktopSessionId: "new-session", pairingGeneration: "pair-a" } };
test("history reader accepts canonical default identity but no selector extensions or whitespace", () => {
  expect(parseRelayLocalExecutionHistoryBinding(binding)).toEqual(binding);
  for (const value of [{ ...binding, owner: {} }, { ...binding, sourceMessageId: 0 }, { ...binding, reader: { ...binding.reader, instanceId: " " } }, { ...binding, reader: { ...binding.reader, humanUserId: "" } }]) expect(parseRelayLocalExecutionHistoryBinding(value)).toBeNull();
});
test("historical locator grants only read, never old input or Stop authority", () => {
  expect(isRelayLocalExecutionHistoryRead("write_stdin", { session_id: "execution-a", cursor: 4, max_output_bytes: 4 }, binding)).toBe(true);
  for (const args of [{ session_id: "execution-a", cancel: true }, { session_id: "execution-a", chars: "input" }, { session_id: "foreign" }, { session_id: "execution-a", cursor: -1 }, { session_id: "execution-a", owner: "human-a" }]) expect(isRelayLocalExecutionHistoryRead("write_stdin", args, binding)).toBe(false);
  expect(isRelayLocalExecutionHistoryRead("exec_command", { session_id: "execution-a" }, binding)).toBe(false);
});
test("old peer cannot advertise history while existing execution stays supported", () => {
  const caps = { profile: "desktop-agent" as const, canExecuteLocal: true, canReadLocalExecutionHistory: true };
  expect(projectRelayCapabilitiesForProtocol(caps, 20).canReadLocalExecutionHistory).toBeUndefined();
  expect(projectRelayCapabilitiesForProtocol(caps, 20).canExecuteLocal).toBe(true);
  expect(projectRelayCapabilitiesForProtocol(caps, 21).canReadLocalExecutionHistory).toBe(true);
});
