import { describe, expect, test } from "bun:test";

import {
  isRoomPendingAttentionEventForViewer,
  isTaskPendingAttentionEventForViewer,
  NautiloApiClient,
  type NautiloApiFetch,
  type RoomPendingAttentionEvent,
  type TaskPendingAttentionEvent,
} from "../../src/client";

const ROOM = "40000000-0000-4000-8000-000000000322";
const HUMAN = "20000000-0000-4000-8000-000000000322";
const AGENT = "30000000-0000-4000-8000-000000000322";
const USER = "10000000-0000-4000-8000-000000000322";
const TASK = "50000000-0000-4000-8000-000000000322";
const RUN = "60000000-0000-4000-8000-000000000322";

function approval(laneKey: string): RoomPendingAttentionEvent {
  return {
    type: "approval.ask",
    approvalId: "approval-322",
    threadId: "thread-322",
    laneKey,
    userId: USER,
    tools: [{ name: "read_file", args: { path: "/tmp/example" } }],
    reason: "Review required",
    reasonCode: "destructive-tool",
    allowedVerbs: ["once", "deny"],
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("pending attention HTTP contract", () => {
  test("posts exact action-session/device coordinates with an opaque cursor", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const fetchImpl: NautiloApiFetch = async (target, init) => {
      seen = {
        url: typeof target === "string" ? target
          : target instanceof URL ? target.href : target.url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      return json({ status: "ready", events: [], nextCursor: null });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    await client.getRoomPendingAttention(ROOM, {
      clientActionSessionId: "action-session-322",
      authorizationDeviceId: "device-322",
      cursor: "eyJ2IjoxLCJjcmVhdGVkQXQiOiIyMDI2LTA5LTA5VDAwOjAwOjAwLjAwMFoifQ",
    });

    expect(seen).toEqual({
      url: `https://nautilo.test/api/rooms/${ROOM}/pending-attention`,
      body: {
        clientActionSessionId: "action-session-322",
        authorizationDeviceId: "device-322",
        cursor: "eyJ2IjoxLCJjcmVhdGVkQXQiOiIyMDI2LTA5LTA5VDAwOjAwOjAwLjAwMFoifQ",
      },
    });
  });

  test("admits only exact direct or Human-bound group Room lanes", () => {
    const expected = { roomId: ROOM, userId: USER, humanActorId: HUMAN };
    expect(isRoomPendingAttentionEventForViewer(approval(`room:${ROOM}`), expected))
      .toBeTrue();
    expect(isRoomPendingAttentionEventForViewer(
      approval(`room:${ROOM}:user:${HUMAN}:bot:${AGENT}`),
      expected,
    )).toBeTrue();
    for (const laneKey of [
      `room:${ROOM}:unexpected`,
      `room:${ROOM}:user:${AGENT}:bot:${AGENT}`,
      `room:${ROOM}:user:not-a-uuid:bot:${AGENT}`,
      `room:${ROOM}:user:${HUMAN}:bot:not-a-uuid`,
    ]) {
      expect(isRoomPendingAttentionEventForViewer(approval(laneKey), expected))
        .toBeFalse();
    }
  });

  test("rejects arbitrary realtime events from the recovery response", async () => {
    const client = new NautiloApiClient("https://nautilo.test", {
      fetchImpl: () => Promise.resolve(json({
        status: "ready",
        events: [{
          type: "message.tokens",
          laneKey: `room:${ROOM}`,
          content: "must not replay",
          chunkSequence: 1,
          done: true,
          threadId: "thread-322",
          userId: USER,
        }],
        nextCursor: null,
      })),
    });
    let rejected = false;
    try {
      await client.getRoomPendingAttention(ROOM, {
        clientActionSessionId: "action-session-322",
        authorizationDeviceId: "device-322",
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBeTrue();
  });

  test("posts exact Task page and one-use read coordinates", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const taskEvent: TaskPendingAttentionEvent = {
      ...approval(`task:${TASK}`),
      origin: "task" as const,
      taskId: TASK,
      taskRunId: RUN,
      userId: USER,
    };
    const fetchImpl: NautiloApiFetch = async (target, init) => {
      const url = typeof target === "string" ? target
        : target instanceof URL ? target.href : target.url;
      seen.push({
        url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return url.endsWith("/read")
        ? json({ status: "read", events: [taskEvent] })
        : json({ status: "ready", nextCursor: "opaque-next" });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    expect(await client.getTaskPendingAttention({
      clientActionSessionId: "action-session-322",
      authorizationDeviceId: "device-322",
      cursor: "opaque-current",
    })).toEqual({ status: "ready", nextCursor: "opaque-next" });
    expect(await client.readTaskPendingAttention({
      clientActionSessionId: "action-session-322",
      authorizationDeviceId: "device-322",
      taskId: TASK,
      taskRunId: RUN,
      challengeId: "challenge-322",
      authorizationBytesBase64url: "authorization-322",
    })).toEqual({ status: "read", events: [taskEvent] });
    expect(seen).toEqual([
      {
        url: "https://nautilo.test/api/tasks/pending-attention",
        body: {
          clientActionSessionId: "action-session-322",
          authorizationDeviceId: "device-322",
          cursor: "opaque-current",
        },
      },
      {
        url: "https://nautilo.test/api/tasks/pending-attention/read",
        body: {
          clientActionSessionId: "action-session-322",
          authorizationDeviceId: "device-322",
          taskId: TASK,
          taskRunId: RUN,
          challengeId: "challenge-322",
          authorizationBytesBase64url: "authorization-322",
        },
      },
    ]);
  });

  test("admits only an exact owner Task/run/lane event", () => {
    const event: TaskPendingAttentionEvent = {
      ...approval(`task:${TASK}`),
      origin: "task" as const,
      taskId: TASK,
      taskRunId: RUN,
      userId: USER,
    };
    const expected = { taskId: TASK, taskRunId: RUN, userId: USER };
    expect(isTaskPendingAttentionEventForViewer(event, expected)).toBeTrue();
    expect(isTaskPendingAttentionEventForViewer({ ...event, taskRunId: AGENT }, expected))
      .toBeFalse();
    expect(isTaskPendingAttentionEventForViewer({ ...event, userId: HUMAN }, expected))
      .toBeFalse();
    expect(isTaskPendingAttentionEventForViewer({ ...event, laneKey: `task:${AGENT}` }, expected))
      .toBeFalse();
  });
});
