import { describe, expect, test } from "bun:test";
import { allowsOrdinaryConversationPersistence } from
  "../../src/adapters/runtime-contexts";

describe("ordinary conversation persistence policy", () => {
  test("permits existing Plaintext and Shadow persistence only", () => {
    expect(allowsOrdinaryConversationPersistence("plaintext_only")).toBe(true);
    expect(allowsOrdinaryConversationPersistence("shadow_encryption")).toBe(true);
    expect(allowsOrdinaryConversationPersistence("encrypted_only")).toBe(false);
    expect(allowsOrdinaryConversationPersistence("unknown")).toBe(false);
  });
});
