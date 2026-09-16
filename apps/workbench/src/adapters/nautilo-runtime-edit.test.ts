import { describe, expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { applyMessageUpdatedInList } from "./nautilo-runtime";

function message(id: string, key: string, revision: number): ThreadMessageLike {
  return {
    id,
    role: "user",
    content: [{ type: "text", text: `before-${id}` }],
    metadata: {
      custom: {
        logicalMessageKey: key,
        editRevision: revision,
      },
    },
  } as ThreadMessageLike;
}

describe("main Room message.updated convergence (M230)", () => {
  test("updates every logical sibling and ignores an equal or stale revision", () => {
    const original = [
      message("1", "turn:shared", 1),
      message("2", "turn:shared", 0),
      message("3", "row:3", 0),
    ];
    const updated = applyMessageUpdatedInList(original, {
      type: "message.updated",
      laneKey: "room:room-1",
      logicalMessageKey: "turn:shared",
      content: "after",
      editedAt: "2026-08-01T10:00:00.000Z",
      editRevision: 2,
    });

    expect(updated).not.toBe(original);
    expect(updated[0]?.content).toEqual([{ type: "text", text: "after" }]);
    expect(updated[1]?.content).toEqual([{ type: "text", text: "after" }]);
    expect(updated[2]).toBe(original[2]);
    expect(
      applyMessageUpdatedInList(updated, {
        type: "message.updated",
        laneKey: "room:room-1",
        logicalMessageKey: "turn:shared",
        content: "stale",
        editedAt: "2026-08-01T09:00:00.000Z",
        editRevision: 2,
      }),
    ).toBe(updated);
  });
});
