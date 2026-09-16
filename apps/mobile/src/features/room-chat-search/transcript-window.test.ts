import { describe, expect, test } from "bun:test";
import type { ChatItem } from "@/lib/messages";

import {
  mergeTranscriptWindow,
  returnTranscriptToLatest,
} from "./transcript-window";

function message(id: string, second: number): ChatItem {
  return {
    kind: "message",
    id,
    role: "assistant",
    text: id,
    createdAt: `2026-08-01T00:00:${String(second).padStart(2, "0")}.000Z`,
    status: "sent",
  };
}

describe("D470 mobile transcript-window merge", () => {
  test("dedupes overlapping windows while preserving existing live identity", () => {
    const existing = message("3", 3);
    const stream: ChatItem = {
      kind: "message",
      id: "streaming:turn-1",
      role: "assistant",
      text: "live",
      createdAt: "2026-08-01T00:00:05.000Z",
    };
    const tool: ChatItem = {
      kind: "tool",
      toolCallId: "tool-2",
      toolName: "lookup",
      status: "success",
      createdAt: "2026-08-01T00:00:02.000Z",
    };
    const out = mergeTranscriptWindow({
      current: [existing, stream],
      hydrated: [message("1", 1), tool, message("3", 3)],
      targetMessageId: "1",
      hasOlder: true,
      hasNewer: false,
    });

    expect(out.items.map((item) => item.kind === "message" ? item.id : item.toolCallId))
      .toEqual(["1", "tool-2", "3", "streaming:turn-1"]);
    expect(out.items[2]).toBe(existing);
    expect(out.items[3]).toBe(stream);
    expect(out.window).toEqual({
      mode: "historical",
      targetMessageId: "1",
      targetFound: true,
      hasOlderGap: true,
      hasNewerGap: false,
    });
  });

  test("records deleted targets without inventing gaps and returns to latest cleanly", () => {
    const out = mergeTranscriptWindow({
      current: [message("4", 4)],
      hydrated: [message("3", 3)],
      targetMessageId: "2",
      hasOlder: false,
      hasNewer: true,
    });
    expect(out.window).toMatchObject({
      targetFound: false,
      hasOlderGap: false,
      hasNewerGap: true,
    });
    expect(returnTranscriptToLatest()).toEqual({
      mode: "latest",
      targetMessageId: null,
      targetFound: false,
      hasOlderGap: false,
      hasNewerGap: false,
    });
  });

  test("keeps early, middle, and recent targets deterministic across older-page merges", () => {
    const latest = [message("8", 8), message("9", 9)];
    const older = [message("1", 1), message("4", 4), message("6", 6)];
    for (const targetMessageId of ["1", "4", "9"]) {
      const out = mergeTranscriptWindow({
        current: latest,
        hydrated: [...older].reverse(),
        targetMessageId,
        hasOlder: targetMessageId !== "1",
        hasNewer: targetMessageId !== "9",
      });
      expect(out.items.map((item) => item.kind === "message" ? item.id : item.toolCallId))
        .toEqual(["1", "4", "6", "8", "9"]);
      expect(out.window.targetFound).toBe(true);
    }
  });
});
