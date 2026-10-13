import { describe, expect, test } from "bun:test";
import { bolterAuthLinkSchema, bolterConnectionObservationSchema, bolterCreateRoomRequestSchema,
  bolterReviewedMessageRequestSchema, bolterNativeCommandSchema } from "../../src/bolter";
const id = "11111111-1111-4111-8111-111111111111";
describe("Bolter shared authority boundaries", () => {
  test("requires explicit sponsorship and a server observed choice for a fresh Room", () => {
    const body = { choiceId: "observed-choice", agentId: id, name: "Conversation", modelSponsorshipAccepted: true };
    expect(bolterCreateRoomRequestSchema.safeParse(body).success).toBe(true);
    for (const patch of [{ roomId: id }, { namespaceId: id }, { chatId: "override" }, { modelSponsorshipAccepted: false }]) {
      expect(bolterCreateRoomRequestSchema.safeParse({ ...body, ...patch }).success).toBe(false);
    }
  });
  test("reviewed text preserves the exact body and rejects caller authority", () => {
    const body = { expectedRevision: 0, requestId: id, content: " /command\nexact text " };
    expect(bolterReviewedMessageRequestSchema.parse(body).content).toBe(body.content);
    expect(bolterReviewedMessageRequestSchema.safeParse({ ...body, sourceInboxId: id }).success).toBe(false);
    expect(bolterReviewedMessageRequestSchema.safeParse({ ...body, userId: id }).success).toBe(false);
  });
  test("provider login links cannot escape the exact origin", () => {
    expect(bolterAuthLinkSchema.safeParse({ url: "https://bolter.chat/auth?code=fixture", code: "fixture" }).success).toBe(true);
    for (const url of ["https://bolter.chat.example.test", "http://bolter.chat", "https://bolter.chat:444/auth"]) {
      expect(bolterAuthLinkSchema.safeParse({ url, code: "fixture" }).success).toBe(false);
    }
  });
  test("spawn never upgrades unqualified runtime into confirmed listening", () => {
    const observation = { runtime: "qualification_required", authentication: "unknown", identity: null, receiver: "running" };
    expect(bolterConnectionObservationSchema.safeParse(observation).success).toBe(true);
    expect(bolterConnectionObservationSchema.safeParse({ ...observation, receiver: "listening" }).success).toBe(false);
    expect(bolterConnectionObservationSchema.safeParse({ ...observation, authentication: "confirmed" }).success).toBe(false);
  });
  test("native commands are finite and never accept raw executable arguments", () => {
    expect(bolterNativeCommandSchema.safeParse({ action: "check", connectionId: id, generation: 1 }).success).toBe(true);
    expect(bolterNativeCommandSchema.safeParse({ action: "check", connectionId: id, generation: 1, args: ["other"] }).success).toBe(false);
  });
});
