import { describe, expect, test } from "bun:test";

import {
  initialMessageActionRevealState,
  messageActionRevealReducer,
  shouldDismissTranscriptTap,
} from "./message-action-reveal";

describe("message action reveal", () => {
  test("keeps one older message open and transfers the reveal", () => {
    const scoped = messageActionRevealReducer(initialMessageActionRevealState, {
      type: "scope",
      roomId: "room-a",
    });
    const first = messageActionRevealReducer(scoped, { type: "reveal", messageId: "1" });
    const second = messageActionRevealReducer(first, { type: "reveal", messageId: "2" });
    expect(second.revealedMessageId).toBe("2");
  });

  test("dismisses when a room changes or the open message disappears", () => {
    const open = { roomId: "room-a", revealedMessageId: "1" };
    expect(messageActionRevealReducer(open, { type: "dismiss" }).revealedMessageId).toBeNull();
    expect(
      messageActionRevealReducer(open, { type: "scope", roomId: "room-b" }).revealedMessageId,
    ).toBeNull();
  });

  test("only lets an unconsumed touch dismiss its own generation", () => {
    expect(shouldDismissTranscriptTap({
      currentGeneration: 4,
      scheduledGeneration: 4,
      interactionConsumed: false,
    })).toBe(true);
    expect(shouldDismissTranscriptTap({
      currentGeneration: 4,
      scheduledGeneration: 4,
      interactionConsumed: true,
    })).toBe(false);
    expect(shouldDismissTranscriptTap({
      currentGeneration: 5,
      scheduledGeneration: 4,
      interactionConsumed: false,
    })).toBe(false);
  });
});
