import { describe, expect, test } from "bun:test";

import { isActionableRoutingReceipt } from "@/features/room-chat-pane/routing-receipt-presentation";

describe("routing receipt presentation", () => {
  test("keeps routine outcomes out of the conversation", () => {
    for (const outcome of ["wake", "silent", "error"] as const) {
      expect(isActionableRoutingReceipt(outcome)).toBe(false);
    }
  });

  test("identifies only a concrete chooser recovery as actionable", () => {
    expect(isActionableRoutingReceipt("ask_user")).toBe(true);
  });
});
