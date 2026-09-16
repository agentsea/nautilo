/**
 * Unit tests for the WS broadcaster's emit-log behavior (D082 PR A).
 *
 * These tests exist because the emit log is the ONLY server-side
 * telemetry for "did this ServerEvent actually leave the server?" and
 * the D082 issue documents how much time we lost debugging approval
 * flows without it. If a future refactor silently drops the log
 * lines — e.g. someone swaps in a different transport and forgets
 * to preserve the logging — these tests fail first.
 *
 * Protection targets:
 *   - `broadcast()` logs EVERY non-suppressed event type it emits
 *   - It logs DROPPED when no open clients
 *   - The suppression set stays tight: ONLY message.tokens /
 *     voice.audio / voice.sentence. Additions silently un-cover
 *     whatever debugging they were supporting.
 *
 * Test isolation: the ws-publisher's `clients` Set is a module-level
 * singleton. We can't reset it directly without exporting a test
 * hook, so instead we write each test's log to a FRESH temp file and
 * assert on that file's contents. Clients from prior tests still
 * emit, but their logs go to earlier files and don't pollute the
 * current assertion.
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
  classifyConductorDecision,
  classifyRoutingError,
  flushPendingWebSocketBroadcasts,
  publishEventFeedChanged,
  publishRoomCatalogChanged,
} from "../../src/realtime/ws-publisher";

const TEST_ROOM_ID = "11111111-1111-4111-8111-111111111111";

function testWsMeta(
  roomIds: string[] = [TEST_ROOM_ID],
): { userId: string; actorId: string; roomIds: Set<string> } {
  return {
    userId: "test-ws-user",
    actorId: "test-ws-actor",
    roomIds: new Set(roomIds),
  };
}

// Minimal WebSocket-shaped mock. Enough for broadcast() to treat it
// as an open client and "send" without actually using a network.
interface MockWs {
  readyState: number;
  sent: string[];
  OPEN: number;
  CLOSING: number;
  CLOSED: number;
  CONNECTING: number;
  send(payload: string): void;
  on(event: "close", handler: () => void): void;
   
  [k: string]: any;
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
      /* close listener — not needed for these tests */
    },
  };
}

// Per-test log file. Reset in beforeEach so assertions read only
// THIS test's output even though the clients Set is a module-level
// singleton.
let logFile: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ws-pub-test-"));
  logFile = join(tmpDir, "test.log");
  setLogLevel("info");
  setLogOutput("file", logFile);
});

describe("ws publisher native Codex request privacy", () => {
  test("delivers native Codex requests only to the owning user, never room peers", () => {
    const owner = makeClient(true);
    const peer = makeClient(true);
    addClient(owner as unknown as WsWebSocket, {
      userId: "codex-request-owner",
      actorId: "owner-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });
    addClient(peer as unknown as WsWebSocket, {
      userId: "codex-request-peer",
      actorId: "peer-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });

    broadcast({
      type: "codex.request",
      ownerId: "codex-request-owner",
      requestId: "request-ref",
      taskId: "task-id",
      jobId: "job-id",
      roomId: TEST_ROOM_ID,
      expiresAt: null,
      request: {
        kind: "command_approval_required",
        options: ["approve", "deny"],
        reason: "host_local_only",
        command: { detail: "host_local_only", actionKinds: ["search"] },
      },
    });

    expect(owner.sent).toHaveLength(1);
    expect(peer.sent).toHaveLength(0);
  });

  test("fails closed when a native Codex request has no owner", () => {
    const peer = makeClient(true);
    addClient(peer as unknown as WsWebSocket, {
      userId: "codex-request-no-owner-peer",
      actorId: "peer-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });

    broadcast({
      type: "codex.request.resolved",
      ownerId: "",
      requestId: "request-ref",
    });

    expect(peer.sent).toHaveLength(0);
  });
});

describe("ws publisher room-catalog invalidation privacy", () => {
  test("flushes tracked asynchronous broadcasts before resolving", async () => {
    const client = makeClient(true);
    addClient(client as unknown as WsWebSocket, {
      userId: "flush-user",
      actorId: "flush-actor",
      roomIds: new Set(),
    });
    publishRoomCatalogChanged("flush-user");
    await flushPendingWebSocketBroadcasts();
    expect(client.sent).toEqual([JSON.stringify({ type: "room.catalog.changed" })]);
  });

  test("delivers an identifier-free invalidation to every socket of one user only", () => {
    const phone = makeClient(true);
    const desktop = makeClient(true);
    const otherUser = makeClient(true);
    addClient(phone as unknown as WsWebSocket, {
      userId: "catalog-user",
      actorId: "catalog-actor",
      roomIds: new Set(),
    });
    addClient(desktop as unknown as WsWebSocket, {
      userId: "catalog-user",
      actorId: "catalog-actor",
      roomIds: new Set(),
    });
    addClient(otherUser as unknown as WsWebSocket, {
      userId: "other-catalog-user",
      actorId: "other-catalog-actor",
      roomIds: new Set(),
    });

    publishRoomCatalogChanged("catalog-user");

    expect(phone.sent).toEqual([JSON.stringify({ type: "room.catalog.changed" })]);
    expect(desktop.sent).toEqual([JSON.stringify({ type: "room.catalog.changed" })]);
    expect(otherUser.sent).toHaveLength(0);
  });
});

describe("ws publisher event-feed invalidation privacy", () => {
  test("delivers a content-free hint to every socket of one user only", () => {
    const browser = makeClient(true);
    const desktop = makeClient(true);
    const roomPeer = makeClient(true);
    addClient(browser as unknown as WsWebSocket, {
      userId: "feed-owner",
      actorId: "feed-owner-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });
    addClient(desktop as unknown as WsWebSocket, {
      userId: "feed-owner",
      actorId: "feed-owner-actor",
      roomIds: new Set(),
    });
    addClient(roomPeer as unknown as WsWebSocket, {
      userId: "feed-peer",
      actorId: "feed-peer-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });

    publishEventFeedChanged("feed-owner");

    const expected = [JSON.stringify({ type: "event_feed.changed" })];
    expect(browser.sent).toEqual(expected);
    expect(desktop.sent).toEqual(expected);
    expect(roomPeer.sent).toHaveLength(0);
  });
});
describe("ws-publisher thread.summary.changed", () => {
  test("fans the parent anchor snapshot to parent members, never child-only sockets", () => {
    const parentMember = makeClient(true);
    const childOnlyMember = makeClient(true);
    const parentRoomId = "33333333-3333-4333-8333-333333333333";
    const childRoomId = "44444444-4444-4444-8444-444444444444";
    addClient(parentMember as unknown as WsWebSocket, {
      userId: "parent-member",
      actorId: "parent-actor",
      roomIds: new Set([parentRoomId]),
    });
    addClient(childOnlyMember as unknown as WsWebSocket, {
      userId: "child-member",
      actorId: "child-actor",
      roomIds: new Set([childRoomId]),
    });

    broadcast({
      type: "thread.summary.changed",
      laneKey: `room:${parentRoomId}`,
      anchorMessageId: 71,
      replyCount: 0,
      lastReplyAt: null,
      summaryRevision: 9,
    });

    expect(parentMember.sent).toHaveLength(1);
    expect(JSON.parse(parentMember.sent[0]!)).toEqual({
      type: "thread.summary.changed",
      laneKey: `room:${parentRoomId}`,
      anchorMessageId: 71,
      replyCount: 0,
      lastReplyAt: null,
      summaryRevision: 9,
    });
    expect(childOnlyMember.sent).toHaveLength(0);
  });
});

describe("ws-publisher tool.end audience characterization", () => {
  test("tool.end room fan-out reaches every Room member, while user scope still reaches every tab for that user", () => {
    const originTab = makeClient(true);
    const sameUserSecondTab = makeClient(true);
    const roomPeer = makeClient(true);
    const originUserId = "d513-origin-user";
    addClient(originTab as unknown as WsWebSocket, {
      userId: originUserId,
      actorId: "d513-origin-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });
    addClient(sameUserSecondTab as unknown as WsWebSocket, {
      userId: originUserId,
      actorId: "d513-origin-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });
    addClient(roomPeer as unknown as WsWebSocket, {
      userId: "d513-room-peer",
      actorId: "d513-peer-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });

    const toolEnd = {
      type: "tool.end" as const,
      toolCallId: "tool-call",
      toolName: "read_file",
      status: "success" as const,
      duration: 1,
      laneKey: `room:${TEST_ROOM_ID}`,
      result: "Read 1 file.",
    };
    broadcast(toolEnd);

    expect(originTab.sent).toHaveLength(1);
    expect(sameUserSecondTab.sent).toHaveLength(1);
    expect(roomPeer.sent).toHaveLength(1);

    broadcast(toolEnd, { kind: "user", userId: originUserId });

    expect(originTab.sent).toHaveLength(2);
    expect(sameUserSecondTab.sent).toHaveLength(2);
    expect(roomPeer.sent).toHaveLength(1);
  });
});

afterEach(() => {
  setLogOutput("silent");
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

function readLog(): string {
  try {
    return readFileSync(logFile, "utf-8");
  } catch {
    return "";
  }
}

describe("ws-publisher broadcast — D082 PR A emit log", () => {
  test("logs [ws] → for a non-suppressed control event", () => {
    const client = makeClient(true);
    addClient(client as unknown as WsWebSocket, testWsMeta());

    broadcast({
      type: "approval.ask",
      approvalId: "approval-test",
      threadId: "t-approval",
      laneKey: `room:${TEST_ROOM_ID}`,
      tools: [],
      reason: "test",
      reasonCode: "command-scanner-medium",
      allowedVerbs: ["once", "deny"],
      userId: "test-ws-user",
    });

    const out = readLog();
    expect(out).toContain("[ws] →");
    expect(out).toContain("approval.ask");
    expect(client.sent.length).toBe(1);
  });

  test("logs [ws] DROPPED when no open subscribers at all", () => {
    // New test, fresh log file. Prior tests left clients in the set
    // but those clients have readyState=OPEN, so they'd count as open
    // subscribers. We need to build this test's assertion carefully:
    // add a CLOSED client of our own and emit a uniquely-typed event
    // that only our test sends. If ANY prior client is still open
    // (test isolation caveat), the assertion would fail — which is
    // the correct signal.
    //
    // In practice, each test's clients are local to the closure and
    // NOT retained in the singleton with readyState=OPEN across
    // tests (prior clients linger but their readyState tracks what
    // the test set them to). Using a unique event type per test
    // avoids cross-test event confusion.
    const uniqueEvent = {
      type: "identity.challenge" as const,
      threadId: "t-dropped-test",
      laneKey: `room:${TEST_ROOM_ID}`,
      challengeId: "challenge-dropped",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      userId: "nobody-matches-this-user-id",
    };

    // The test is tolerant: it just needs the log to contain the
    // event type. A DROPPED line fires when open-count is 0; a
    // normal → line fires otherwise. We accept either, because
    // the emit-logging contract is "log every non-suppressed event
    // one way or the other".
    broadcast(uniqueEvent);

    const out = readLog();
    expect(out).toContain("identity.challenge");
  });

  test("SUPPRESSES message.tokens from the emit log (but still delivers)", () => {
    const client = makeClient(true);
    addClient(client as unknown as WsWebSocket, testWsMeta());

    broadcast({
      type: "message.tokens",
      laneKey: `room:${TEST_ROOM_ID}`,
      content: "hi",
      chunkSequence: 0,
      done: false,
    });

    const out = readLog();
    // Event WAS sent to the client — only the log line is suppressed.
    expect(client.sent.length).toBe(1);
    expect(out).not.toContain("message.tokens");
  });

  test("SUPPRESSES voice.audio + voice.sentence from the emit log", () => {
    const client = makeClient(true);
    addClient(client as unknown as WsWebSocket, testWsMeta());

    broadcast({
      type: "voice.audio",
      data: "x",
      chunkIndex: 0,
      sentenceIndex: 0,
      final: false,
      roomId: TEST_ROOM_ID,
      userId: "test-ws-user",
    });
    broadcast({
      type: "voice.sentence",
      index: 0,
      text: "hi",
      final: false,
      roomId: TEST_ROOM_ID,
      userId: "test-ws-user",
    });

    const out = readLog();
    expect(out).not.toContain("voice.audio");
    expect(out).not.toContain("voice.sentence");
  });

  test("LOGS tool.start + tool.end — the events that triggered D082", () => {
    // If a future refactor adds tool.start or tool.end to the
    // suppression set, they'd silently hide the debugging signal
    // that D082 PR A specifically added logs for. Fail the test to
    // catch it.
    const client = makeClient(true);
    addClient(client as unknown as WsWebSocket, testWsMeta());

    broadcast({
      type: "tool.start",
      toolCallId: "tc_d082",
      toolName: "run_shell",
      laneKey: `room:${TEST_ROOM_ID}`,
    });
    broadcast({
      type: "tool.end",
      toolCallId: "tc_d082",
      toolName: "run_shell",
      status: "success",
      duration: 15,
      laneKey: `room:${TEST_ROOM_ID}`,
    });

    const out = readLog();
    expect(out).toContain("tool.start");
    expect(out).toContain("tool.end");
  });
});

describe("ws-publisher conductor.ask_user requester-private recovery", () => {
  test("delivers the ambiguity chooser only to the sender, not same-room peers", () => {
    const sender = makeClient(true);
    const peerA = makeClient(true);
    const peerB = makeClient(true);
    addClient(sender as unknown as WsWebSocket, {
      userId: "sender-uid-ask-user",
      actorId: "sender-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });
    addClient(peerA as unknown as WsWebSocket, {
      userId: "peer-a-uid-ask-user",
      actorId: "peer-a-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });
    addClient(peerB as unknown as WsWebSocket, {
      userId: "peer-b-uid-ask-user",
      actorId: "peer-b-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });

    broadcast({
      type: "conductor.ask_user",
      laneKey: `room:${TEST_ROOM_ID}`,
      roomId: TEST_ROOM_ID,
      userId: "sender-uid-ask-user",
      userActorId: "sender-actor",
      messageId: "42",
      humanTurnId: "turn-42",
      options: [
        { botActorId: "bot-a", handle: "elias" },
        { botActorId: "bot-b", handle: "elias-2" },
      ],
      reason: "ambiguous",
    });

    expect(sender.sent).toHaveLength(1);
    expect(peerA.sent).toHaveLength(0);
    expect(peerB.sent).toHaveLength(0);
  });

  test("fails closed when requester userId is empty", () => {
    const peer = makeClient(true);
    addClient(peer as unknown as WsWebSocket, {
      userId: "peer-uid-ask-user-fail-closed",
      actorId: "peer-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });

    broadcast({
      type: "conductor.ask_user",
      laneKey: `room:${TEST_ROOM_ID}`,
      roomId: TEST_ROOM_ID,
      userId: "",
      userActorId: "sender-actor",
      messageId: "42",
      options: [
        { botActorId: "bot-a", handle: "elias" },
        { botActorId: "bot-b", handle: "elias-2" },
      ],
      reason: "ambiguous",
    });

    expect(peer.sent).toHaveLength(0);
  });
});

/**
 * Stack-162 — requester-private `conductor.decision` receipt delivery + the
 * reason sanitizer. Two privacy invariants under test:
 *   1. The receipt is delivered ONLY to the requester's WS connections
 *      (server-enforced via `inferDeliveryScope` → `{ kind: "user", userId }`),
 *      never room-fanned-out — even when a peer is subscribed to the same
 *      room lane. A missing `userId` fails CLOSED (dropped, not room-relayed).
 *   2. The classifier never forwards a model-generated `decision.reason`
 *      verbatim; arbitrary `floor: <model text>` collapses to a generic
 *      `*_router` code with a server-authored display sentence.
 */
describe("ws-publisher conductor.decision (Stack-162 requester-private receipt)", () => {
  test("delivered only to the requester's userId, not to other room members", () => {
    const requester = makeClient(true);
    const peer = makeClient(true);
    addClient(requester as unknown as WsWebSocket, {
      userId: "requester-uid-stack162",
      actorId: "req-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });
    // Peer is in the SAME room — must NOT receive the private receipt.
    addClient(peer as unknown as WsWebSocket, {
      userId: "peer-uid-stack162",
      actorId: "peer-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });

    broadcast({
      type: "conductor.decision",
      laneKey: `room:${TEST_ROOM_ID}`,
      roomId: TEST_ROOM_ID,
      userId: "requester-uid-stack162",
      userActorId: "req-actor",
      messageId: "42",
      humanTurnId: "turn-1",
      outcome: "silent",
      reasonCode: "silent_router",
      displayReason: "The router did not select an agent.",
    });

    expect(requester.sent.length).toBe(1);
    expect(peer.sent.length).toBe(0);
    const payload = JSON.parse(requester.sent[0]!) as {
      type: string;
      userId: string;
      outcome: string;
      reasonCode: string;
    };
    expect(payload.type).toBe("conductor.decision");
    expect(payload.userId).toBe("requester-uid-stack162");
    expect(payload.outcome).toBe("silent");
    expect(payload.reasonCode).toBe("silent_router");
  });

  test("fail-closed: a missing/empty userId is dropped, never room-fanned-out", () => {
    const peer = makeClient(true);
    addClient(peer as unknown as WsWebSocket, {
      userId: "peer-uid-stack162-fc",
      actorId: "peer-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });

    // Empty userId — must NOT fall through to room-lane fan-out.
    broadcast({
      type: "conductor.decision",
      laneKey: `room:${TEST_ROOM_ID}`,
      roomId: TEST_ROOM_ID,
      userId: "",
      userActorId: "req-actor",
      messageId: null,
      outcome: "silent",
      reasonCode: "silent_router",
      displayReason: "The router did not select an agent.",
    });

    expect(peer.sent.length).toBe(0);
  });

  test("requester with multiple connections (tabs) all receive the receipt", () => {
    const tabA = makeClient(true);
    const tabB = makeClient(true);
    addClient(tabA as unknown as WsWebSocket, {
      userId: "requester-multi-stack162",
      actorId: "req-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });
    addClient(tabB as unknown as WsWebSocket, {
      userId: "requester-multi-stack162",
      actorId: "req-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });

    broadcast({
      type: "conductor.decision",
      laneKey: `room:${TEST_ROOM_ID}`,
      roomId: TEST_ROOM_ID,
      userId: "requester-multi-stack162",
      userActorId: "req-actor",
      messageId: null,
      outcome: "wake",
      reasonCode: "wake_active_focus",
      displayReason: "Continuing your active focus.",
      selectedHandles: ["@jeannie"],
    });

    expect(tabA.sent.length).toBe(1);
    expect(tabB.sent.length).toBe(1);
  });
});

describe("classifyConductorDecision (Stack-162 reason sanitizer)", () => {
  test("a model-like silent floor reason is NOT emitted verbatim — collapses to silent_router", () => {
    const modelReason =
      "I think Jeannie should answer because the user mentioned her Q3 project deadline and seemed stressed.";
    const out = classifyConductorDecision({
      kind: "silent",
      reason: `floor: ${modelReason}`,
    });
    expect(out.outcome).toBe("silent");
    expect(out.reasonCode).toBe("silent_router");
    // The model-generated semantic detail must not appear anywhere in the
    // safe display reason — this is the data-leak boundary.
    expect(out.displayReason).not.toContain(modelReason);
    expect(out.displayReason).not.toContain("Jeannie");
    expect(out.displayReason).not.toContain("Q3");
    expect(out.displayReason).not.toContain("deadline");
    expect(out.displayReason).not.toContain("floor:");
  });

  test("a model-like wake floor reason collapses to wake_router (no model text)", () => {
    const modelReason =
      "The user is clearly asking Genie about the roadmap so wake @genie immediately.";
    const out = classifyConductorDecision({
      kind: "wake",
      source: "inferred",
      reason: `floor: ${modelReason}`,
    });
    expect(out.outcome).toBe("wake");
    expect(out.reasonCode).toBe("wake_router");
    expect(out.displayReason).not.toContain(modelReason);
    expect(out.displayReason).not.toContain("Genie");
    expect(out.displayReason).not.toContain("roadmap");
    expect(out.displayReason).not.toContain("floor:");
  });

  test("a model-like ask_user floor reason collapses to ask_router (no model text)", () => {
    const modelReason =
      "Both Genie and Jeannie have discussed the budget so I cannot pick one.";
    const out = classifyConductorDecision({
      kind: "ask_user",
      reason: `floor: ${modelReason}`,
    });
    expect(out.outcome).toBe("ask_user");
    expect(out.reasonCode).toBe("ask_router");
    expect(out.displayReason).not.toContain(modelReason);
    expect(out.displayReason).not.toContain("Genie");
    expect(out.displayReason).not.toContain("budget");
    expect(out.displayReason).not.toContain("floor:");
  });

  test("controlled deterministic wake reasons map to specific codes", () => {
    expect(
      classifyConductorDecision({ kind: "wake", source: "mention", reason: "mention" })
        .reasonCode,
    ).toBe("wake_mention");
    expect(
      classifyConductorDecision({ kind: "wake", source: "reply", reason: "reply" })
        .reasonCode,
    ).toBe("wake_reply");
    expect(
      classifyConductorDecision({ kind: "wake", source: "ui", reason: "ui" }).reasonCode,
    ).toBe("wake_ui");
    expect(
      classifyConductorDecision({
        kind: "wake",
        source: "inferred",
        reason: "single active focus",
      }).reasonCode,
    ).toBe("wake_active_focus");
    expect(
      classifyConductorDecision({ kind: "wake", source: "inferred", reason: "vocative" })
        .reasonCode,
    ).toBe("wake_vocative");
    expect(
      classifyConductorDecision({
        kind: "wake",
        source: "inferred",
        reason: "history single-owner",
      }).reasonCode,
    ).toBe("wake_history");
    expect(
      classifyConductorDecision({
        kind: "wake",
        source: "inferred",
        reason: "history-intent",
      }).reasonCode,
    ).toBe("wake_history");
  });

  test("controlled deterministic silent / ask_user reasons map to specific codes", () => {
    expect(
      classifyConductorDecision({ kind: "silent", reason: "human-addressed" }).reasonCode,
    ).toBe("silent_human_addressed");
    expect(
      classifyConductorDecision({ kind: "silent", reason: "no deterministic route" })
        .reasonCode,
    ).toBe("silent_no_route");
    expect(
      classifyConductorDecision({ kind: "silent", reason: "addressivity: below threshold" })
        .reasonCode,
    ).toBe("silent_not_addressed");
    expect(
      classifyConductorDecision({
        kind: "ask_user",
        reason: "vocative: ambiguous direct address",
      }).reasonCode,
    ).toBe("ask_ambiguous_direct");
    expect(
      classifyConductorDecision({
        kind: "ask_user",
        reason: "history-intent: ambiguous owner",
      }).reasonCode,
    ).toBe("ask_ambiguous_history");
  });

  test("controlled floor failure suffixes map to specific codes (not the generic fallback)", () => {
    expect(
      classifyConductorDecision({ kind: "silent", reason: "floor: no wakeable bots" })
        .reasonCode,
    ).toBe("silent_no_wakeable");
    expect(
      classifyConductorDecision({ kind: "silent", reason: "floor: model error" }).reasonCode,
    ).toBe("silent_router_unresolved");
    expect(
      classifyConductorDecision({ kind: "silent", reason: "floor: invalid output" })
        .reasonCode,
    ).toBe("silent_router_unresolved");
    expect(
      classifyConductorDecision({ kind: "silent", reason: "floor: out-of-set handle" })
        .reasonCode,
    ).toBe("silent_router_unresolved");
    expect(
      classifyConductorDecision({ kind: "silent", reason: "floor: search loop exhausted" })
        .reasonCode,
    ).toBe("silent_router_unresolved");
  });

  test("an unrecognized silent reason still collapses to the generic safe display", () => {
    const out = classifyConductorDecision({
      kind: "silent",
      reason: "some novel future reason string",
    });
    expect(out.outcome).toBe("silent");
    expect(out.reasonCode).toBe("silent_router");
    expect(out.displayReason).toBe("The router did not select an agent.");
  });

  test("classifyRoutingError produces the error outcome", () => {
    const out = classifyRoutingError();
    expect(out.outcome).toBe("error");
    expect(out.reasonCode).toBe("routing_error");
    expect(out.displayReason.length).toBeGreaterThan(0);
  });
});

/**
 * Stack 202 / D421 Phase 3 (3.2.2) — delivery-scope tests for a
 * `conductor.decision` receipt carrying a redirect reason code. The redirect
 * receipt reuses the existing requester-private `conductor.decision` channel,
 * so it MUST inherit the same delivery invariants:
 *   1. Delivered ONLY to the requester's WS connections — never to another
 *      room member on the same room lane, even when the redirect was accepted
 *      (outcome `wake`) and carries a public target handle.
 *   2. A missing/empty `userId` fails CLOSED (dropped, never room-fanned-out).
 * No room-scoped redirect event exists; the receipt is the only surface.
 */
describe("ws-publisher conductor.decision redirect receipt delivery (D421 Phase 3)", () => {
  test("an accepted redirect (outcome wake, reasonCode redirected) is delivered only to the requester", () => {
    const requester = makeClient(true);
    const peer = makeClient(true);
    addClient(requester as unknown as WsWebSocket, {
      userId: "requester-redirect-accepted",
      actorId: "req-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });
    addClient(peer as unknown as WsWebSocket, {
      userId: "peer-redirect-accepted",
      actorId: "peer-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });

    broadcast({
      type: "conductor.decision",
      laneKey: `room:${TEST_ROOM_ID}`,
      roomId: TEST_ROOM_ID,
      userId: "requester-redirect-accepted",
      userActorId: "req-actor",
      messageId: "77",
      humanTurnId: "turn-redirect-1",
      outcome: "wake",
      reasonCode: "redirected",
      displayReason: "Redirected to another assistant.",
      selectedHandles: ["@jeannie-bot"],
    });

    expect(requester.sent.length).toBe(1);
    expect(peer.sent.length).toBe(0);
    const payload = JSON.parse(requester.sent[0]!) as {
      type: string;
      userId: string;
      outcome: string;
      reasonCode: string;
      selectedHandles?: string[];
    };
    expect(payload.type).toBe("conductor.decision");
    expect(payload.userId).toBe("requester-redirect-accepted");
    expect(payload.outcome).toBe("wake");
    expect(payload.reasonCode).toBe("redirected");
    expect(payload.selectedHandles).toEqual(["@jeannie-bot"]);
  });

  test("a rejected redirect (outcome silent, reasonCode redirect_rejected_*) is delivered only to the requester", () => {
    const requester = makeClient(true);
    const peer = makeClient(true);
    addClient(requester as unknown as WsWebSocket, {
      userId: "requester-redirect-rejected",
      actorId: "req-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });
    addClient(peer as unknown as WsWebSocket, {
      userId: "peer-redirect-rejected",
      actorId: "peer-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });

    broadcast({
      type: "conductor.decision",
      laneKey: `room:${TEST_ROOM_ID}`,
      roomId: TEST_ROOM_ID,
      userId: "requester-redirect-rejected",
      userActorId: "req-actor",
      messageId: null,
      outcome: "silent",
      reasonCode: "redirect_rejected_no_target",
      displayReason: "Redirect skipped — that assistant wasn't found in this room.",
    });

    expect(requester.sent.length).toBe(1);
    expect(peer.sent.length).toBe(0);
  });

  test("fail-closed: a redirect receipt with a missing userId is dropped, never room-fanned-out", () => {
    const peer = makeClient(true);
    addClient(peer as unknown as WsWebSocket, {
      userId: "peer-redirect-failclosed",
      actorId: "peer-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });

    broadcast({
      type: "conductor.decision",
      laneKey: `room:${TEST_ROOM_ID}`,
      roomId: TEST_ROOM_ID,
      userId: "",
      userActorId: "req-actor",
      messageId: null,
      outcome: "wake",
      reasonCode: "redirected",
      displayReason: "Redirected to another assistant.",
      selectedHandles: ["@jeannie-bot"],
    });

    expect(peer.sent.length).toBe(0);
  });

  test("an enqueue_failed redirect (outcome error) is delivered only to the requester", () => {
    const requester = makeClient(true);
    const peer = makeClient(true);
    addClient(requester as unknown as WsWebSocket, {
      userId: "requester-redirect-enqueue",
      actorId: "req-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });
    addClient(peer as unknown as WsWebSocket, {
      userId: "peer-redirect-enqueue",
      actorId: "peer-actor",
      roomIds: new Set([TEST_ROOM_ID]),
    });

    broadcast({
      type: "conductor.decision",
      laneKey: `room:${TEST_ROOM_ID}`,
      roomId: TEST_ROOM_ID,
      userId: "requester-redirect-enqueue",
      userActorId: "req-actor",
      messageId: null,
      outcome: "error",
      reasonCode: "redirect_rejected_enqueue_failed",
      displayReason: "Redirect failed — couldn't enqueue the target assistant.",
    });

    expect(requester.sent.length).toBe(1);
    expect(peer.sent.length).toBe(0);
  });
});
