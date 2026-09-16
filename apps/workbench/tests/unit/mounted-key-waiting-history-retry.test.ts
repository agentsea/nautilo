import { describe, expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { MessageBackfillBatchResult } from "@nautilo/lattice-bridge/client/browser";
import type { MessageBackfillUrgentSelection } from "@nautilo/api-client/browser";

import {
  mountedKeyWaitingHistorySelections,
  refreshMountedKeyWaitingHistorySnapshot,
} from "../../src/adapters/nautilo-runtime";
import { replaceRefreshedRoomMessage } from "../../src/adapters/room-history-around";
import { createWorkbenchMessageBackfillScheduler } from "../../src/adapters/message-backfill-scheduler";

class FakeClock {
  nowMs = 1_000;
  private nextId = 0;
  private readonly tasks = new Map<number, Readonly<{
    at: number;
    callback: () => void;
  }>>();

  readonly clock = {
    now: () => this.nowMs,
    schedule: (callback: () => void, delayMs: number) => {
      const id = this.nextId++;
      this.tasks.set(id, { at: this.nowMs + delayMs, callback });
      return () => { this.tasks.delete(id); };
    },
  };

  runDue(): void {
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.nowMs)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (next === undefined) return;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
  }
}

const visibleDocument = {
  visibilityState: "visible" as const,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

function text(id: string, label: string): ThreadMessageLike {
  return { id, role: "assistant", content: [{ type: "text", text: label }] };
}

function waiting(id: number, revision: number): ThreadMessageLike {
  return {
    ...text(String(id), `waiting ${id}`),
    metadata: { custom: {
      editRevision: revision,
      historyUnavailable: true,
      historyUnavailableReason: "key_waiting",
    } },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("mounted key-waiting history retry", () => {
  test("a transient first reread continues automatically through every mounted row", async () => {
    const clock = new FakeClock();
    const olderPage = text("1", "loaded older page");
    const draft = text("optimistic-1", "draft");
    const liveTail = text("live-1", "live stream");
    let mounted = [
      olderPage,
      waiting(11, 0),
      waiting(42, 1),
      waiting(77, 2),
      draft,
      liveTail,
    ];
    const exactAttempts: number[] = [];
    const urgentRepairHints: number[] = [];

    const refresh = async (
      selection: MessageBackfillUrgentSelection,
      continueAfterSuccess: boolean,
    ) => {
      exactAttempts.push(selection.messageId);
      if (exactAttempts.length === 1) return "retry" as const;

      mounted = replaceRefreshedRoomMessage(
        mounted,
        [
          text("9", "offscreen around-page neighbor"),
          {
            ...text(String(selection.messageId), `opened ${selection.messageId}`),
            metadata: { custom: { editRevision: selection.revision } },
          },
        ],
        String(selection.messageId),
      );
      if (continueAfterSuccess) {
        const next = mountedKeyWaitingHistorySelections("room-a", mounted)[0];
        if (next !== undefined) {
          scheduler.prioritize(next);
          scheduler.refreshHistory(next);
        }
      }
      return "refreshed" as const;
    };

    const scheduler = createWorkbenchMessageBackfillScheduler({
      client: {
        prioritize: (selection) => { urgentRepairHints.push(selection.messageId); },
        async runBatch(): Promise<MessageBackfillBatchResult> {
          return { state: "caught_up", resumeAt: null };
        },
      },
      visibility: visibleDocument,
      clock: clock.clock,
      errorResumeAt: () => clock.nowMs + 30_000,
      onPrioritizedHistoryChanged: (selection) => refresh(selection, true),
    });
    scheduler.setReady(true);
    clock.runDue();
    await flush();

    const initialSelections = mountedKeyWaitingHistorySelections("room-a", mounted);
    expect(await refreshMountedKeyWaitingHistorySnapshot({
      selections: initialSelections,
      isCurrent: () => true,
      refresh: (selection) => refresh(selection, false),
      onRetry: (selection) => scheduler.refreshHistory(selection),
    })).toBe("retry");

    for (let turn = 0; turn < 8; turn += 1) {
      clock.runDue();
      await flush();
    }

    expect(exactAttempts).toEqual([11, 11, 42, 77]);
    expect(urgentRepairHints).toEqual([42, 77]);
    expect(mountedKeyWaitingHistorySelections("room-a", mounted)).toEqual([]);
    expect(mounted.map((message) => String(message.id))).toEqual([
      "1", "11", "42", "77", "optimistic-1", "live-1",
    ]);
    expect(mounted[0]).toBe(olderPage);
    expect(mounted[4]).toBe(draft);
    expect(mounted[5]).toBe(liveTail);
    scheduler.dispose();
  });

  test("a stale Room, viewer, admission, origin, or refresh generation cannot queue a retry", async () => {
    const selection = { roomId: "room-a", messageId: 11, revision: 0 };
    const axes = [
      "roomId",
      "viewerKey",
      "viewerGeneration",
      "admissionGeneration",
      "origin",
      "refreshGeneration",
    ] as const;

    for (const axis of axes) {
      const source = {
        roomId: "room-a",
        viewerKey: "viewer-a",
        viewerGeneration: 3,
        admissionGeneration: 5,
        origin: "https://nautilo.test",
        refreshGeneration: 7,
      };
      const current: Record<(typeof axes)[number], string | number> = { ...source };
      const retries: MessageBackfillUrgentSelection[] = [];
      const attempt = refreshMountedKeyWaitingHistorySnapshot({
        selections: [selection],
        isCurrent: () => axes.every((key) => current[key] === source[key]),
        refresh: async () => {
          current[axis] = typeof current[axis] === "number"
            ? (current[axis]) + 1
            : `${current[axis]}-stale`;
          return "retry";
        },
        onRetry: (retrySelection) => { retries.push(retrySelection); },
      });

      expect(await attempt).toBe("cancelled");
      expect(retries).toEqual([]);
    }
  });
});
