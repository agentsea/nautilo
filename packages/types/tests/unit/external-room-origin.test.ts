import { expect, test } from "bun:test";
import { parseExternalMessageOrigin } from "../../src/external-message-origin";

const origin = {
  kind: "external_message", version: 1, provider: "bolter", origin: "https://bolter.chat",
  connectionId: "10000000-0000-4000-8000-000000000001", bindingId: "10000000-0000-4000-8000-000000000002",
  providerAgentId: "provider-agent", chatId: "chat", threadRootId: null, messageId: "message",
  senderId: "external-sender", senderType: "user", senderLabel: "Outside participant", createdAt: "2026-01-01T00:00:00.000Z",
} as const;
test("external attribution is validated, immutable and cannot assert a local Actor", () => {
  const parsed = parseExternalMessageOrigin(origin);
  expect(parsed).toEqual(origin);
  expect(Object.isFrozen(parsed)).toBe(true);
  for (const bad of [{ ...origin, actorId: "local-human" }, { ...origin, sponsorUserId: "human" },
    { ...origin, provider: "unknown" }, { ...origin, origin: "https://bolter.chat.evil.example" },
    { ...origin, senderType: "system" }, { ...origin, createdAt: "yesterday" },
    { ...origin, threadRootId: "" }, { ...origin, messageId: " \n" }]) {
    expect(parseExternalMessageOrigin(bad)).toBeNull();
  }
});
