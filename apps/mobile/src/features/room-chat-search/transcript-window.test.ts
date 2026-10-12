import { describe, expect, test } from "bun:test";
import type { ServerEvent } from "@nautilo/types";
import { applyStreamEvent, chatItemKey, type ChatItem } from "@/lib/messages";

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

const canonicalToolId = "nc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_0";

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

  test("reconciles one live tool card to its persisted row across repeated windows", () => {
    const live: ChatItem = {
      kind: "tool",
      toolCallId: canonicalToolId,
      toolName: "lookup",
      argsSummary: "live arguments",
      status: "running",
      createdAt: "2026-08-01T00:00:02.000Z",
    };
    const hydrated: ChatItem = {
      kind: "tool",
      toolCallId: canonicalToolId,
      presentationKey: "persisted-row-10",
      toolName: "lookup",
      status: "success",
      result: "stale hydration result",
      createdAt: "2026-08-01T00:00:03.000Z",
    };
    const first = mergeTranscriptWindow({
      current: [live],
      hydrated: [hydrated],
      targetMessageId: "missing",
      hasOlder: false,
      hasNewer: false,
    });

    expect(first.items).toEqual([{
      ...live,
      presentationKey: "persisted-row-10",
    }]);

    const completed = applyStreamEvent(first.items, {
      type: "tool.end",
      toolCallId: canonicalToolId,
      toolName: "lookup",
      status: "success",
      duration: 1,
      result: "live result",
    } as ServerEvent);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      kind: "tool",
      toolCallId: canonicalToolId,
      presentationKey: "persisted-row-10",
      status: "success",
      result: "live result",
    });

    const repeated = mergeTranscriptWindow({
      current: completed,
      hydrated: [hydrated],
      targetMessageId: "missing",
      hasOlder: false,
      hasNewer: false,
    });
    expect(repeated.items).toEqual(completed);

    const legacyRows: ChatItem[] = ["legacy-row-1", "legacy-row-2"].map(
      (presentationKey, index) => ({
        kind: "tool",
        toolCallId: "reused-provider-id",
        presentationKey,
        toolName: "lookup",
        status: "success",
        result: String(index),
        createdAt: `2026-08-01T00:00:0${index + 4}.000Z`,
      }),
    );
    const legacy = mergeTranscriptWindow({
      current: [],
      hydrated: legacyRows,
      targetMessageId: "missing",
      hasOlder: false,
      hasNewer: false,
    });
    expect(legacy.items).toEqual(legacyRows);
  });

  test("does not bind a resumed legacy live card to colliding around-window rows", () => {
    const live: ChatItem = {
      kind: "tool",
      toolCallId: "reused-provider-id",
      toolName: "lookup",
      argsSummary: "new invocation",
      status: "running",
      createdAt: "2026-08-01T00:00:03.000Z",
    };
    const persisted: ChatItem[] = ["legacy-row-1", "legacy-row-2"].map(
      (presentationKey, index) => ({
        kind: "tool",
        toolCallId: "reused-provider-id",
        presentationKey,
        toolName: "lookup",
        status: "success",
        result: `old result ${index}`,
        createdAt: `2026-08-01T00:00:0${index + 1}.000Z`,
      }),
    );
    const merged = mergeTranscriptWindow({
      current: [live],
      hydrated: persisted,
      targetMessageId: "missing",
      hasOlder: false,
      hasNewer: false,
    });

    expect(merged.items).toHaveLength(3);
    expect(merged.items).toEqual([...persisted, live]);
  });

  test("keeps numeric legacy row and live invocation keys distinct in an around window", () => {
    const persisted: ChatItem = {
      kind: "tool",
      toolCallId: "401",
      presentationKey: "401",
      toolName: "lookup",
      status: "success",
      result: "old result",
      createdAt: "2026-08-01T00:00:01.000Z",
    };
    const live: ChatItem = {
      kind: "tool",
      toolCallId: "401",
      toolName: "lookup",
      status: "success",
      result: "new result",
      createdAt: "2026-08-01T00:00:02.000Z",
    };
    const merged = mergeTranscriptWindow({
      current: [persisted, live],
      hydrated: [persisted],
      targetMessageId: "missing",
      hasOlder: false,
      hasNewer: false,
    });

    expect(merged.items).toEqual([persisted, live]);
    expect(merged.items.map(chatItemKey)).toEqual(["tool:row:401", "tool:live:401"]);
    expect(merged.items.map((item) => item.kind === "tool" ? item.result : undefined))
      .toEqual(["old result", "new result"]);
  });

  test("does not adopt a live card when canonical around-window identity is duplicated", () => {
    const live: ChatItem = {
      kind: "tool",
      toolCallId: canonicalToolId,
      toolName: "lookup",
      status: "running",
      createdAt: "2026-08-01T00:00:03.000Z",
    };
    const persisted: ChatItem[] = ["canonical-row-1", "canonical-row-2"].map(
      (presentationKey, index) => ({
        kind: "tool",
        toolCallId: canonicalToolId,
        presentationKey,
        toolName: "lookup",
        status: "success",
        result: `persisted ${index}`,
        createdAt: `2026-08-01T00:00:0${index + 1}.000Z`,
      }),
    );
    const merged = mergeTranscriptWindow({
      current: [live],
      hydrated: persisted,
      targetMessageId: "missing",
      hasOlder: false,
      hasNewer: false,
    });

    expect(merged.items).toHaveLength(3);
    expect(merged.items).toEqual([...persisted, live]);
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
