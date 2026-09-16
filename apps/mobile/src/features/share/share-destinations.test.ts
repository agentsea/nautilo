import { describe, expect, test } from "bun:test";

import {
  conversationAttachmentAvailability,
  isConversationAttachmentMimeType,
} from "./share-destinations";

describe("Share destination availability", () => {
  test("matches the existing composer upload families", () => {
    expect(isConversationAttachmentMimeType("image/png")).toBe(true);
    expect(isConversationAttachmentMimeType("audio/mpeg")).toBe(true);
    expect(isConversationAttachmentMimeType("text/plain")).toBe(true);
    expect(isConversationAttachmentMimeType("application/pdf")).toBe(false);
    expect(isConversationAttachmentMimeType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
  });

  test("does not infer attachment authority from a Role name", () => {
    expect(conversationAttachmentAvailability("image/png"))
      .toEqual({ available: true, reason: null });
  });

  test("routes unsupported document formats to Workspace regardless of role", () => {
    expect(conversationAttachmentAvailability("application/pdf"))
      .toEqual({ available: false, reason: "format" });
  });
});
