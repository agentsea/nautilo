import { describe, expect, test } from "bun:test";

import { requiresEncryptedForegroundCheckpoint } from
  "../../src/conversation/live-shadow-checkpoint-saver";

describe("live Shadow checkpoint policy", () => {
  test("requires protected graph state for Strict Shadow and Full", () => {
    expect(requiresEncryptedForegroundCheckpoint({
      mode: "shadow_encryption",
      shadowBehavior: "strict",
      revision: 7,
    })).toBe(true);
    expect(requiresEncryptedForegroundCheckpoint({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      revision: 7,
    })).toBe(false);
    expect(requiresEncryptedForegroundCheckpoint({
      mode: "plaintext_only",
      shadowBehavior: "fallback",
      revision: 7,
    })).toBe(false);
    expect(requiresEncryptedForegroundCheckpoint({
      mode: "encrypted_only",
      shadowBehavior: "fallback",
      revision: 7,
    })).toBe(true);
    expect(requiresEncryptedForegroundCheckpoint(undefined)).toBe(false);
  });
});
