import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { planLegacyMagentControlRemediation, verifyLegacyMagentControl,
  type LegacyMagentControlCandidate } from "../helpers/magent-control-remediation";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
function candidate(): LegacyMagentControlCandidate {
  const input = { sessionId: "operator-session", resume: false, roomId: "external-room", agentId: "external-agent", activity: [], sources: [] };
  const content = JSON.stringify({ request: "Return a structured room decision", outputSchema: {
    type: "object", additionalProperties: false, properties: {}, required: ["action", "messageIds", "body", "notifyAgentIds"],
  }, input });
  const origin = { kind: "external_message", version: 1, provider: "magent", origin: "https://operator.example",
    connectionId: id(2), bindingId: id(3), providerAgentId: "external-agent", chatId: "external-room",
    threadRootId: null, messageId: hash(input), senderId: "magent-connector:external-agent", senderType: "anima",
    senderLabel: "mAgent connector", createdAt: "2026-01-01T00:00:00.000Z" };
  return { ownerId: id(1), binding: { id: id(3), userId: id(1), connectionId: id(2), provider: "magent",
    origin: origin.origin, providerAgentId: origin.providerAgentId, chatId: origin.chatId, threadId: "", roomId: id(4), agentId: id(5) },
    connection: { id: id(2), userId: id(1), provider: "magent", transportKind: "operator-unix" },
    receipt: { id: id(6), userId: id(1), bindingId: id(3), providerMessageId: origin.messageId,
      externalSenderId: origin.senderId, sessionMessageId: 10, turnId: id(7), fingerprint: hash([origin.provider,
        origin.origin, origin.providerAgentId, origin.chatId, origin.threadRootId, origin.messageId, origin.senderId,
        origin.senderType, origin.createdAt, content]) },
    session: { id: id(8), ownerId: id(1), roomId: id(4), agentId: id(5), threadId: `room:${id(4)}:bot:${id(5)}` },
    source: { id: 10, sessionId: id(8), role: "user", content, humanTurnId: id(7),
      fingerprint: hash(["external-room-input-v1", id(6)]), metadata: { externalReceiptId: id(6), externalOrigin: origin } } };
}

describe("legacy operator control remediation", () => {
  test("recognizes provenance-backed connector control and deduplicates a rebuild plan", () => {
    const value = candidate();
    expect(verifyLegacyMagentControl(value)).toBe(true);
    expect(planLegacyMagentControlRemediation([value, value])).toEqual({ sourceMessageIds: [10], resultMessageIds: [], checkpointThreadsToRebuild: [value.session.threadId] });
  });
  test("JSON shape or copied external metadata alone cannot hide an ordinary row", () => {
    for (const mutate of [
      (v: LegacyMagentControlCandidate) => { v.connection.provider = "bolter"; },
      (v: LegacyMagentControlCandidate) => { v.binding.userId = id(99); },
      (v: LegacyMagentControlCandidate) => { v.receipt.sessionMessageId = 11; },
      (v: LegacyMagentControlCandidate) => { v.source.humanTurnId = id(99); },
      (v: LegacyMagentControlCandidate) => { v.receipt.fingerprint = "mismatch"; },
      (v: LegacyMagentControlCandidate) => { v.source.fingerprint = "mismatch"; },
      (v: LegacyMagentControlCandidate) => { v.source.content = "{}"; },
      (v: LegacyMagentControlCandidate) => { v.session.threadId += ":fork:other"; },
      (v: LegacyMagentControlCandidate) => { v.source.metadata = null; },
    ]) {
      const value = candidate(); mutate(value);
      expect(verifyLegacyMagentControl(value)).toBe(false);
      expect(planLegacyMagentControlRemediation([value]).sourceMessageIds).toEqual([]);
    }
  });
});

test("linked result requires exact source, receipt, execution metadata and fingerprints", async () => {
  const { verifyLegacyMagentControlResult } = await import("../helpers/magent-control-remediation");
  const input = candidate();
  const content = '{"action":"ignore","messageIds":[],"body":"","notifyAgentIds":[]}';
  const fingerprint = hash(["external-room-final-v1", input.receipt.id, id(9), content]);
  const value = { input, jobId: id(9), acceptanceId: id(10), outbox: { sourceInboxId: input.receipt.id,
    sessionMessageId: 11, explicitShareId: null, fingerprint }, result: { id: 11, sessionId: input.session.id,
    role: "assistant", content, humanTurnId: null, replyToMessageId: input.source.id, fingerprint,
    metadata: { externalFinalReply: { kind: "external_room_final_reply_v1", receiptId: input.receipt.id,
      jobId: id(9), turnId: input.receipt.turnId, acceptanceId: id(10) } } } };
  expect(verifyLegacyMagentControlResult(value)).toBe(true);
  value.result.replyToMessageId = 99;
  expect(verifyLegacyMagentControlResult(value)).toBe(false);
  value.result.replyToMessageId = input.source.id;
  value.result.metadata.externalFinalReply.jobId = id(99);
  expect(verifyLegacyMagentControlResult(value)).toBe(false);
});
