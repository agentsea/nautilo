import { describe, expect, test } from "bun:test";
import {
  assertProductPublicationRepresentation,
  conversationAppendRequestDigest,
  conversationVerificationMatchesRepresentation,
  type ConversationAppendInput,
} from "../../src/message/conversation-repository";

const full: ConversationAppendInput = {
  sessionId: "10000000-0000-4000-8000-000000000318",
  idempotencyKey: "full:m318",
  content: null, toolCalls: null, toolName: null, metadata: null,
  keyClass: "ai", authorRole: "assistant", fingerprint: "full:m318",
  humanTurnId: null, transcriptOrigin: "main", parentThreadId: null,
  scopeId: null, subthreadRoomId: null, replyToMessageId: null,
  publicationPolicy: { expectedRevision: 8, representation: "protected_only" },
  notificationContext: {
    mentionedHumanUserIds: [], causalHumanUserId: null, causalHumanTurnId: null,
  },
  structuralProjection: {
    notificationEligibility: "eligible", subthreadReplyClassification: "counted",
  },
};

describe("protected-only product publication", () => {
  test("Full-origin authentication cannot be recorded as ordinary parity", () => {
    for (const status of ["client_verified", "server_verified"] as const) {
      expect(conversationVerificationMatchesRepresentation("full_encryption", status)).toBe(false);
      expect(conversationVerificationMatchesRepresentation("shadow_encryption", status)).toBe(true);
    }
    for (const status of ["pending", "client_authenticated", "server_authenticated"] as const) {
      expect(conversationVerificationMatchesRepresentation("full_encryption", status)).toBe(true);
    }
  });
  test("accepts explicit content-free publication and rejects hidden ordinary bodies", () => {
    expect(() => assertProductPublicationRepresentation(full)).not.toThrow();
    for (const input of [
      { ...full, content: "sentinel" },
      { ...full, toolCalls: "sentinel" },
      { ...full, toolName: "sentinel" },
      { ...full, metadata: { private: "sentinel" } },
    ]) expect(() => assertProductPublicationRepresentation(input)).toThrow("ordinary body");
  });

  test("missing ordinary content cannot masquerade as Shadow", () => {
    expect(() => assertProductPublicationRepresentation({
      ...full, publicationPolicy: undefined,
    })).toThrow("explicit protected-only");
    expect(() => assertProductPublicationRepresentation({
      ...full, publicationPolicy: { expectedRevision: 8, representation: "ordinary_and_protected" },
    })).toThrow("explicit protected-only");
    expect(() => assertProductPublicationRepresentation({
      ...full, content: "ordinary", publicationPolicy: undefined,
    })).not.toThrow();
  });

  test("replay identity binds representation and prepared policy revision", () => {
    const digest = conversationAppendRequestDigest(full);
    expect(conversationAppendRequestDigest({
      ...full, publicationPolicy: { expectedRevision: 9, representation: "protected_only" },
    })).not.toEqual(digest);
    expect(conversationAppendRequestDigest({
      ...full, publicationPolicy: { expectedRevision: 8, representation: "ordinary_and_protected" },
    })).not.toEqual(digest);
  });
});
