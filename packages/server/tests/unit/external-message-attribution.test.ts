import { expect, test } from "bun:test";
import { externalMessageAttributionFields, parseExternalMessageOrigin } from "@nautilo/types";
import { serializeRoomMessageForAround } from "../../src/routes/sessions";

const origin = parseExternalMessageOrigin({ kind: "external_message", version: 1, provider: "bolter", origin: "https://bolter.chat",
  connectionId: "10000000-0000-4000-8000-000000000001", bindingId: "10000000-0000-4000-8000-000000000002",
  providerAgentId: "provider-agent", chatId: "chat", threadRootId: null, messageId: "message", senderId: "sender",
  senderType: "user", senderLabel: "Outside participant", createdAt: "2026-01-01T00:00:00Z" })!;
const row = { id: "1", role: "user", content: "Outside content", toolCalls: null, sourceUserId: "sponsor", createdAt: new Date("2026-01-01T00:00:00Z") };
test("the actual transcript DTO serializer omits sponsor-as-author for verified and unverified external input", () => {
  const external = serializeRoomMessageForAround({ ...row, externalOrigin: origin });
  expect(external.externalOrigin).toEqual(origin);
  expect(external).not.toHaveProperty("sourceUserId");
  expect(external.content).toBe("Outside content");
  const unverified = serializeRoomMessageForAround({ ...row, externalAttributionInvalid: true });
  expect(unverified.externalAttributionInvalid).toBe(true);
  expect(unverified).not.toHaveProperty("sourceUserId");
  expect(unverified).not.toHaveProperty("externalOrigin");
  expect(unverified.content).toBe("Outside content");
});
test("ordinary Human and Genie DTO authorship stays intact and only inbound user rows carry external attribution", () => {
  expect(serializeRoomMessageForAround(row).sourceUserId).toBe("sponsor");
  const assistant = serializeRoomMessageForAround({ ...row, role: "assistant", authorAgentId: "genie", externalOrigin: origin });
  expect(assistant.authorAgentId).toBe("genie");
  expect(assistant).not.toHaveProperty("externalOrigin");
});
test("receipt-free durable external authorship remains unverified in the transcript DTO", () => {
  const fields = externalMessageAttributionFields("user", null, undefined, true);
  const result = serializeRoomMessageForAround({ ...row, ...fields });
  expect(result.externalAttributionInvalid).toBe(true);
  expect(result).not.toHaveProperty("sourceUserId");
  expect(result).not.toHaveProperty("externalOrigin");
  expect(result.content).toBe("Outside content");
});

test("around serialization exposes parity siblings only for protected reads", () => {
  const parity = {
    ...row,
    role: "assistant",
    foregroundExecutionId: "foreground:one",
    modelInputExposure: { version: 1, status: "incomplete" },
  };
  expect(serializeRoomMessageForAround(parity)).not.toHaveProperty(
    "foregroundExecutionId",
  );
  expect(serializeRoomMessageForAround(parity)).not.toHaveProperty(
    "modelInputExposure",
  );
  expect(serializeRoomMessageForAround(parity, {
    includeProtectedParityMetadata: true,
  })).toMatchObject({
    foregroundExecutionId: "foreground:one",
    modelInputExposure: { version: 1, status: "incomplete" },
  });
  expect(() => serializeRoomMessageForAround({
    ...parity,
    modelInputExposure: { version: 1, status: "complete", dependencies: "invalid" },
  }, { includeProtectedParityMetadata: true })).toThrow(
    "Room history model-input exposure metadata is invalid",
  );
});
