/**
 * M075 — WebSocket broadcast audience: room-scoped and user-scoped delivery.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket as WsWebSocket } from "ws";
import { setLogLevel, setLogOutput } from "@nautilo/logger";
import {
  addClient,
  broadcast,
  publishDomainKeyCatchUpDelivered,
  publishDomainKeyCatchUpRequested,
  publishEncryptionPolicyChanged,
} from "../../src/realtime/ws-publisher";

const ROOM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface MockWs {
  readyState: number;
  sent: string[];
  OPEN: number;
  CLOSING: number;
  CLOSED: number;
  CONNECTING: number;
  send(payload: string): void;
  on(event: "close", handler: () => void): void;
  [k: string]: unknown;
}

function makeClient(open = true): MockWs {
  return {
    readyState: open ? 1 : 3,
    sent: [],
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    CONNECTING: 0,
    send(payload: string) {
      this.sent.push(payload);
    },
    on() {
      /* no-op */
    },
  };
}

function metaFor(userId: string, roomIds: string[]): { userId: string; actorId: string; roomIds: Set<string> } {
  return {
    userId,
    actorId: `actor-${userId}`,
    roomIds: new Set(roomIds),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ws-m075-test-"));
  setLogLevel("info");
  setLogOutput("file", join(tmpDir, "test.log"));
});

afterEach(() => {
  setLogOutput("silent");
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("ws-publisher M075 audience", () => {
  test("encryption policy invalidation reaches every admitted socket without content", () => {
    const first = makeClient(true);
    const second = makeClient(true);
    addClient(first as unknown as WsWebSocket, metaFor("first", [ROOM_A]));
    addClient(second as unknown as WsWebSocket, metaFor("second", [ROOM_B]));

    publishEncryptionPolicyChanged(7);

    const expected = JSON.stringify({
      type: "encryption.policy.changed",
      policyRevision: 7,
    });
    expect(first.sent).toEqual([expected]);
    expect(second.sent).toEqual([expected]);
  });

  test("M301 Domain-key catch-up hints reach only current Human participants", () => {
    const source = makeClient(true);
    const sourceSecondDevice = makeClient(true);
    const outsider = makeClient(true);
    addClient(source as unknown as WsWebSocket, metaFor("source", []));
    addClient(sourceSecondDevice as unknown as WsWebSocket, metaFor("source", []));
    addClient(outsider as unknown as WsWebSocket, metaFor("outsider", [ROOM_A]));

    publishDomainKeyCatchUpRequested({
      roomId: ROOM_A,
      namespaceId: "namespace-a",
      keyClass: "human",
      recipientUserIds: ["source", "source"],
    });

    expect(source.sent).toEqual([JSON.stringify({
      type: "crypto.domain_key_catch_up_requested",
      roomId: ROOM_A,
      laneKey: `room:${ROOM_A}`,
      namespaceId: "namespace-a",
      keyClass: "human",
    })]);
    expect(sourceSecondDevice.sent).toEqual(source.sent);
    expect(outsider.sent).toHaveLength(0);
  });

  test("M301 durable delivery hints reach only current Human participants", () => {
    const target = makeClient(true);
    const outsider = makeClient(true);
    addClient(target as unknown as WsWebSocket, metaFor("target", []));
    addClient(outsider as unknown as WsWebSocket, metaFor("outsider-2", [ROOM_A]));

    publishDomainKeyCatchUpDelivered({
      roomId: ROOM_A,
      namespaceId: "namespace-a",
      keyClass: "ai",
      recipientUserIds: ["target"],
    });

    expect(target.sent).toEqual([JSON.stringify({
      type: "crypto.domain_key_catch_up_delivered",
      roomId: ROOM_A,
      laneKey: `room:${ROOM_A}`,
      namespaceId: "namespace-a",
      keyClass: "ai",
    })]);
    expect(outsider.sent).toHaveLength(0);
  });

  test("room-scoped tool.start is delivered only to sockets subscribed to that room", () => {
    const cA = makeClient(true);
    const cB = makeClient(true);
    addClient(cA as unknown as WsWebSocket, metaFor("user-a", [ROOM_A]));
    addClient(cB as unknown as WsWebSocket, metaFor("user-b", [ROOM_B]));

    broadcast({
      type: "tool.start",
      toolCallId: "tc1",
      toolName: "run_shell",
      laneKey: `room:${ROOM_A}`,
    });

    expect(cA.sent.length).toBe(1);
    expect(cB.sent.length).toBe(0);
  });

  test("user-scoped approval.ask is delivered only to the targeted userId", () => {
    const cA = makeClient(true);
    const cB = makeClient(true);
    addClient(cA as unknown as WsWebSocket, metaFor("user-a", [ROOM_A]));
    addClient(cB as unknown as WsWebSocket, metaFor("user-b", [ROOM_A]));

    broadcast({
      type: "approval.ask",
      approvalId: "ap1",
      threadId: "t1",
      laneKey: `room:${ROOM_A}`,
      userId: "user-b",
      tools: [],
      reason: "test",
      reasonCode: "command-scanner-medium",
      allowedVerbs: ["once", "deny"],
    });

    expect(cA.sent.length).toBe(0);
    expect(cB.sent.length).toBe(1);
  });

  test("connected website action attention is delivered only to its requesting user", () => {
    const cA = makeClient(true);
    const cB = makeClient(true);
    addClient(cA as unknown as WsWebSocket, metaFor("user-a", [ROOM_A]));
    addClient(cB as unknown as WsWebSocket, metaFor("user-b", [ROOM_A]));

    broadcast({
      type: "connected_web.action_attention",
      threadId: "thread-connected-web",
      laneKey: `room:${ROOM_A}`,
      toolCallId: "tool-connected-web",
      userId: "user-b",
      intervention: {
        kind: "authentication_required",
        mode: "connect",
        reason: "not_connected",
        target: { selector: "example.com" },
      },
    });

    expect(cA.sent).toHaveLength(0);
    expect(cB.sent).toHaveLength(1);
  });

  test("connected website action attention without a requester is dropped", () => {
    const cA = makeClient(true);
    addClient(cA as unknown as WsWebSocket, metaFor("user-a", [ROOM_A]));

    broadcast({
      type: "connected_web.action_attention",
      threadId: "thread-connected-web",
      laneKey: `room:${ROOM_A}`,
      toolCallId: "tool-connected-web",
      intervention: {
        kind: "authentication_required",
        mode: "connect",
        reason: "not_connected",
        target: { selector: "example.com" },
      },
    } as unknown as Parameters<typeof broadcast>[0]);

    expect(cA.sent).toHaveLength(0);
  });

  test("connected website action resume failure is delivered only to its requesting user", () => {
    const cA = makeClient(true);
    const cB = makeClient(true);
    addClient(cA as unknown as WsWebSocket, metaFor("user-a", [ROOM_A]));
    addClient(cB as unknown as WsWebSocket, metaFor("user-b", [ROOM_A]));

    broadcast({
      type: "connected_web.action_resume_failed",
      threadId: "thread-connected-web",
      laneKey: `room:${ROOM_A}`,
      toolCallId: "tool-connected-web",
      userId: "user-b",
      cancelRecovery: "available",
    });

    expect(cA.sent).toHaveLength(0);
    expect(cB.sent).toHaveLength(1);
  });

  test("connected website action resume failure without a requester is dropped", () => {
    const cA = makeClient(true);
    addClient(cA as unknown as WsWebSocket, metaFor("user-a", [ROOM_A]));

    broadcast({
      type: "connected_web.action_resume_failed",
      threadId: "thread-connected-web",
      laneKey: `room:${ROOM_A}`,
      toolCallId: "tool-connected-web",
      cancelRecovery: "unavailable",
    } as unknown as Parameters<typeof broadcast>[0]);

    expect(cA.sent).toHaveLength(0);
  });

  test("session.persistence_failed fan-out reaches every connected client", () => {
    const cA = makeClient(true);
    const cB = makeClient(true);
    addClient(cA as unknown as WsWebSocket, metaFor("user-a", [ROOM_A]));
    addClient(cB as unknown as WsWebSocket, metaFor("user-b", [ROOM_B]));

    broadcast(
      {
        type: "session.persistence_failed",
        threadId: "t-global",
        sessionId: null,
        errorCode: "test",
        droppedCount: 0,
      },
      { kind: "all", acknowledgedGlobalLeak: true },
    );

    expect(cA.sent.length).toBe(1);
    expect(cB.sent.length).toBe(1);
  });

  test("internal task-lane job events fail closed without unroutable warnings", () => {
    const cA = makeClient(true);
    const cB = makeClient(true);
    addClient(cA as unknown as WsWebSocket, metaFor("owner", [ROOM_A]));
    addClient(cB as unknown as WsWebSocket, metaFor("other", [ROOM_B]));

    broadcast({
      type: "job.coalesced",
      virtualJobId: "virtual-task-job",
      laneKey: "task:task-1",
    });
    broadcast({
      type: "job.dispatched",
      virtualJobIds: ["virtual-task-job"],
      jobId: "task-job",
      laneKey: "task:task-1",
    });
    broadcast({
      type: "job.status",
      jobId: "task-job",
      status: "completed",
      laneKey: "task:task-1",
    });

    expect(cA.sent).toHaveLength(0);
    expect(cB.sent).toHaveLength(0);
    expect(readFileSync(join(tmpDir, "test.log"), "utf8")).not.toContain(
      "unroutable event",
    );
  });
});

describe("ws-publisher M077 Bundle 2 — explicit global audience", () => {
  test("worker.complete with audience=auto is not delivered (requires acknowledged leak)", () => {
    const cA = makeClient(true);
    addClient(cA as unknown as WsWebSocket, metaFor("user-a", [ROOM_A]));
    broadcast({
      type: "worker.complete",
      jobId: "j-no-auto",
      result: "success",
    });
    expect(cA.sent.length).toBe(0);
  });

  test("worker.complete with kind=all but acknowledgedGlobalLeak false is dropped", () => {
    const cA = makeClient(true);
    addClient(cA as unknown as WsWebSocket, metaFor("user-a", [ROOM_A]));
    broadcast(
      {
        type: "worker.complete",
        jobId: "j-no-ack",
        result: "success",
      },
      { kind: "all", acknowledgedGlobalLeak: false },
    );
    expect(cA.sent.length).toBe(0);
  });

  test("worker.complete with acknowledgedGlobalLeak true fans out globally", () => {
    const cA = makeClient(true);
    const cB = makeClient(true);
    addClient(cA as unknown as WsWebSocket, metaFor("user-a", [ROOM_A]));
    addClient(cB as unknown as WsWebSocket, metaFor("user-b", [ROOM_B]));
    broadcast(
      {
        type: "worker.complete",
        jobId: "j-acked",
        result: "success",
      },
      { kind: "all", acknowledgedGlobalLeak: true },
    );
    expect(cA.sent.length).toBe(1);
    expect(cB.sent.length).toBe(1);
  });

  test("voice.status with audience=auto is not delivered (explicit global)", () => {
    const cA = makeClient(true);
    addClient(cA as unknown as WsWebSocket, metaFor("user-a", [ROOM_A]));
    broadcast({
      type: "voice.status",
      voice: "off",
      speaking: false,
    });
    expect(cA.sent.length).toBe(0);
  });

  test("voice.status with acknowledged global audience fans out", () => {
    const cA = makeClient(true);
    const cB = makeClient(true);
    addClient(cA as unknown as WsWebSocket, metaFor("user-a", [ROOM_A]));
    addClient(cB as unknown as WsWebSocket, metaFor("user-b", [ROOM_B]));
    broadcast(
      {
        type: "voice.status",
        voice: "on",
        speaking: true,
      },
      { kind: "all", acknowledgedGlobalLeak: true },
    );
    expect(cA.sent.length).toBe(1);
    expect(cB.sent.length).toBe(1);
  });

  test("M085 job.forked and fork.spliced deliver to room subscribers", () => {
    const cA = makeClient(true);
    const cB = makeClient(true);
    addClient(cA as unknown as WsWebSocket, metaFor("user-a", [ROOM_A]));
    addClient(cB as unknown as WsWebSocket, metaFor("user-b", [ROOM_B]));

    broadcast({
      type: "job.forked",
      laneKey: `room:${ROOM_A}`,
      jobId: "job-fork-1",
      virtualJobIds: ["v1"],
      parentThreadId: "parent-thread",
      forkThreadId: "parent-thread:fork:turn:abcd1234",
      syntheticNoteCount: 1,
      sequence: 2,
    });
    broadcast({
      type: "fork.spliced",
      laneKey: `room:${ROOM_A}`,
      jobId: "job-fork-1",
      parentThreadId: "parent-thread",
      forkThreadId: "parent-thread:fork:turn:abcd1234",
      sequence: 2,
      splicedMessageCount: 3,
    });

    expect(cA.sent.length).toBe(2);
    expect(cB.sent.length).toBe(0);
  });
});
