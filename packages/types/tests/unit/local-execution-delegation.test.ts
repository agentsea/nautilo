import { expect, test } from "bun:test";
import { parseLocalExecutionDelegation, localExecutionDelegationGrantScope } from "../../src/local-execution-delegation";
const valid = { version: 1 as const, humanUserId: "human", agentId: "agent", sourceRoomId: "room",
  sourceConversationId: "conversation", rootTaskId: "task", projectGrantId: "grant", ceiling: "basic" as const, profile: null,
  target: { instanceId: "", relayId: "relay", pairingGeneration: "pairing", serverOrigin: "https://server.example", serverFingerprint: "fingerprint" } };
test("closed durable target preserves the default instance without a foreground session or path", () => {
  const parsed = parseLocalExecutionDelegation(valid);
  expect(parsed).toEqual(valid); expect(parsed).not.toBe(valid); expect(parsed?.target).not.toBe(valid.target);
  expect(localExecutionDelegationGrantScope("task")).toBe("task:task");
});
test("rejects ambient paths, copied sessions, elevation and malformed identities", () => {
  for (const value of [{ ...valid, currentFolder: "/fixture" }, { ...valid, desktopSessionId: "old" },
    { ...valid, ceiling: "full_mac" }, { ...valid, profile: { id: "profile", revision: 1 } },
    { ...valid, ceiling: "development" }, { ...valid, humanUserId: " human" },
    { ...valid, target: { ...valid.target, instanceId: " " } },
    { ...valid, target: { ...valid.target, serverOrigin: "https://server.example/path" } },
    { ...valid, target: { ...valid.target, serverOrigin: "https://user:fixture@example.invalid" } },
    { ...valid, target: { ...valid.target, token: "not-an-authority-field" } }]) {
    expect(parseLocalExecutionDelegation(value)).toBeNull();
  }
});
test("Development binds one positive exact profile revision", () => {
  expect(parseLocalExecutionDelegation({ ...valid, ceiling: "development", profile: { id: "profile", revision: 1 } })?.profile).toEqual({ id: "profile", revision: 1 });
  for (const revision of [0, -1, 1.5, "1", Number.NaN]) {
    expect(parseLocalExecutionDelegation({ ...valid, ceiling: "development", profile: { id: "profile", revision } })).toBeNull();
  }
});
