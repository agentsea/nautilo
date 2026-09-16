import { describe, expect, test } from "bun:test";

import { mayHandleAttentionEvent } from "./attention-policy";

describe("Mobile Agent attention policy", () => {
  test("drops every Agent-resume prompt without invocation authority", () => {
    for (const type of [
      "approval.ask",
      "host.choice",
      "prove_it.challenge",
      "identity.challenge",
    ] as const) {
      expect(mayHandleAttentionEvent(type, false)).toBe(false);
      expect(mayHandleAttentionEvent(type, true)).toBe(true);
    }
  });

  test("retains passive cleanup events without invocation authority", () => {
    expect(mayHandleAttentionEvent("message.new", false)).toBe(true);
    expect(mayHandleAttentionEvent("approval.resolved", false)).toBe(true);
  });
});
