import { describe, expect, test } from "bun:test";
import { normalizeAcceptedChatImageMime } from "../../src/chat-image-mime";

describe("normalizeAcceptedChatImageMime", () => {
  test("accepts png/jpeg/gif/webp", () => {
    expect(normalizeAcceptedChatImageMime("image/png")).toBe("image/png");
    expect(normalizeAcceptedChatImageMime("image/jpeg")).toBe("image/jpeg");
    expect(normalizeAcceptedChatImageMime("image/jpg")).toBe("image/jpeg");
    expect(normalizeAcceptedChatImageMime("image/webp")).toBe("image/webp");
    expect(normalizeAcceptedChatImageMime("image/gif")).toBe("image/gif");
  });

  test("strips parameters", () => {
    expect(normalizeAcceptedChatImageMime("image/png; charset=binary")).toBe("image/png");
  });

  test("rejects injection and unknown types", () => {
    expect(normalizeAcceptedChatImageMime("image/png\r\nX:y")).toBeNull();
    expect(normalizeAcceptedChatImageMime("text/plain")).toBeNull();
    expect(normalizeAcceptedChatImageMime("application/pdf")).toBeNull();
  });
});
