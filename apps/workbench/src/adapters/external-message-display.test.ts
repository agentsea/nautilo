import { expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ExternalMessageOrigin, MessageNewEvent } from "@nautilo/types";
import { isOwnHumanMessage } from "../components/message-author";
import { applyCanonicalExternalMessageEvent } from "./nautilo-runtime";
import { initialThreadRoomControllerState, threadRoomReducer } from "../modes/rooms/thread-drawer/thread-room-controller";
import {
  externalMessageAuthorLabel, externalMessageDisplayAttribution,
  reconcileCanonicalExternalMessage, restoreSessionMessages,
} from "./session-rehydrate";

const origin: ExternalMessageOrigin = {
  kind: "external_message", version: 1, provider: "bolter", origin: "https://bolter.chat",
  connectionId: "11111111-1111-4111-8111-111111111111", bindingId: "22222222-2222-4222-8222-222222222222",
  providerAgentId: "fixture-agent", chatId: "fixture-chat", threadRootId: null,
  messageId: "fixture-message", senderId: "local-viewer", senderType: "user",
  senderLabel: "You <fixture>", createdAt: "2026-01-01T00:00:00.000Z",
};
const event: MessageNewEvent = { type: "message.new", laneKey: "room:child-fixture", messageId: "101",
  role: "user", content: "Identical synthetic text", createdAt: origin.createdAt, externalOrigin: origin };

test("production external message.new branch commits, records live hydration and refreshes cache without a local Human id", () => {
  let messages: readonly ThreadMessageLike[] = [];
  let commits = 0;
  let cached = 0;
  const recorded: string[][] = [];
  const apply = (incoming: MessageNewEvent) => applyCanonicalExternalMessageEvent({ event: incoming, messages,
    commit: value => { messages = value; commits++; },
    recordLive: (lane, id) => { recorded.push([lane, id]); }, scheduleCache: () => { cached++; } });
  expect(apply(event)).toBeTrue();
  expect(commits).toBe(1);
  expect(recorded).toEqual([[event.laneKey, event.messageId]]);
  expect(cached).toBe(1);
  expect(messages[0]?.metadata?.custom?.externalOrigin).toEqual(origin);
  expect(apply(event)).toBeTrue();
  expect(commits).toBe(1);
  expect(apply({ ...event, role: "ai" })).toBeFalse();
  const { externalOrigin: _externalOrigin, ...local } = event;
  expect(apply({ ...local, sourceUserId: "local-viewer" })).toBeFalse();
  expect(apply({ ...local, messageId: "102", externalAttributionInvalid: true })).toBeTrue();
  expect(messages[1]?.metadata?.custom?.externalAttributionInvalid).toBeTrue();
});

test("live external receipts append without a local source id and deduplicate only their canonical id", () => {
  const local: ThreadMessageLike = { id: "user-fixture", role: "user", content: [{ type: "text", text: event.content }],
    metadata: { custom: { sourceUserId: "local-viewer" } } };
  const received = reconcileCanonicalExternalMessage([local], event);
  expect(received).toHaveLength(2);
  expect(received[0]).toBe(local);
  expect(received[1]).toMatchObject({ id: "101", content: [{ type: "text", text: event.content }],
    metadata: { custom: { externalOrigin: origin, sentAt: origin.createdAt } } });
  expect(received[1]?.metadata?.custom).not.toHaveProperty("sourceUserId");
  expect(reconcileCanonicalExternalMessage(received, event)).toBe(received);
  expect(reconcileCanonicalExternalMessage(received, { ...event, messageId: "102" })).toHaveLength(3);
  expect(externalMessageAuthorLabel(received[1]?.metadata?.custom ?? {})).toBe("Bolter · You <fixture>");
  expect(isOwnHumanMessage(undefined, origin.senderId)).toBeFalse();
});

test("history and live external attribution converge without borrowing a contradictory local actor", () => {
  const [restored] = restoreSessionMessages([{ id: event.messageId, role: "user", content: event.content,
    createdAt: event.createdAt, externalOrigin: origin, sourceUserId: "local-viewer" }]);
  const [live] = reconcileCanonicalExternalMessage([], event);
  expect(restored).toEqual(live);
  expect(restored?.metadata?.custom).not.toHaveProperty("sourceUserId");
  const repaired = reconcileCanonicalExternalMessage([{ ...live!, metadata: { custom: {
    sourceUserId: "local-viewer", authorAgentId: "local-agent", authorHarnessId: "local-harness",
  } } }], event);
  expect(repaired[0]?.metadata?.custom).not.toHaveProperty("sourceUserId");
  expect(repaired[0]?.metadata?.custom).not.toHaveProperty("authorAgentId");
  expect(repaired[0]?.metadata?.custom).not.toHaveProperty("authorHarnessId");
});

test("malformed or explicitly invalid provenance stays external and unverified with visible literal content", () => {
  for (const fields of [
    { externalOrigin: { ...origin, origin: "https://example.com" } },
    { externalOrigin: { ...origin, senderType: "system" } },
    { externalOrigin: { ...origin, extraAuthority: "local-viewer" } },
    { externalOrigin: null },
    { externalOrigin: origin, externalAttributionInvalid: true },
  ]) {
    expect(externalMessageDisplayAttribution(fields)).toEqual({ externalAttributionInvalid: true });
    expect(externalMessageAuthorLabel(fields)).toBe("Unverified external sender");
    const unsafe = fields as unknown as Pick<MessageNewEvent, "externalOrigin" | "externalAttributionInvalid">;
    const [live] = reconcileCanonicalExternalMessage([], { ...event, ...unsafe });
    const [history] = restoreSessionMessages([{ id: event.messageId, role: "user", content: event.content,
      createdAt: event.createdAt, sourceUserId: "local-viewer", ...unsafe }]);
    expect(history).toEqual(live);
    expect(history?.metadata?.custom).not.toHaveProperty("sourceUserId");
    expect(history?.metadata?.custom).not.toHaveProperty("externalOrigin");
    expect(history?.content).toEqual([{ type: "text", text: event.content }]);
  }
  expect(externalMessageAuthorLabel({})).toBeNull();
  const local = restoreSessionMessages([{ id: "local", role: "user", content: "Local text", sourceUserId: "local-viewer" }]);
  expect(local[0]?.metadata?.custom?.sourceUserId).toBe("local-viewer");
  expect(reconcileCanonicalExternalMessage(local, { messageId: "other", content: "Unattributed" })).toBe(local);
});

test("thread receipts preserve external provenance without replacing identical optimistic local sends", () => {
  let state = threadRoomReducer(initialThreadRoomControllerState, {
    type: "open", roomId: "child-fixture", visible: true, connected: true,
  });
  state = threadRoomReducer(state, { type: "hydrated", roomId: "child-fixture", messages: [], runtimeMessages: [], activeJobIds: [],
    detail: { parentRoomId: "parent-fixture", subthreadRoomId: "child-fixture",
      anchor: { id: "100", role: "user", content: "Anchor", createdAt: origin.createdAt },
      summary: { replyCount: 0, lastReplyAt: null, summaryRevision: 0 } } });
  state = threadRoomReducer(state, { type: "send.started", requestId: "local-request", content: event.content,
    createdAt: origin.createdAt });
  state = threadRoomReducer(state, { type: "event.received", event });
  expect(state.messages).toHaveLength(2);
  expect(state.runtimeMessages).toHaveLength(2);
  expect(state.runtimeMessages[1]?.metadata?.custom?.externalOrigin).toEqual(origin);
  expect(state.runtimeMessages[1]?.metadata?.custom).not.toHaveProperty("sourceUserId");
  state = threadRoomReducer(state, { type: "event.received", event });
  expect(state.messages).toHaveLength(2);
  expect(state.runtimeMessages).toHaveLength(2);
  state = threadRoomReducer(state, { type: "event.received", event: { ...event,
    externalAttributionInvalid: true, sourceUserId: "local-viewer", authorAgentId: "local-agent" } });
  expect(state.messages[1]).toMatchObject({ externalAttributionInvalid: true });
  expect(state.messages[1]).not.toHaveProperty("externalOrigin");
  expect(state.messages[1]).not.toHaveProperty("sourceUserId");
  expect(state.runtimeMessages[1]?.metadata?.custom).not.toHaveProperty("externalOrigin");
  expect(state.runtimeMessages[1]?.metadata?.custom).not.toHaveProperty("sourceUserId");
  expect(state.runtimeMessages[1]?.metadata?.custom).not.toHaveProperty("authorAgentId");
});

test("thread history and parent anchor retain external provenance through the production hydration projection", () => {
  const row = { id: "101", role: "user", content: event.content, createdAt: origin.createdAt, externalOrigin: origin };
  const detail = { parentRoomId: "parent-fixture", subthreadRoomId: "child-fixture",
    anchor: { ...row, id: "100" }, summary: { replyCount: 1, lastReplyAt: origin.createdAt, summaryRevision: 1 } };
  let state = threadRoomReducer(initialThreadRoomControllerState, {
    type: "open", roomId: "child-fixture", visible: true, connected: true,
  });
  // useThreadRoomController passes the history DTOs and restoreSessionMessages projection unchanged.
  state = threadRoomReducer(state, { type: "hydrated", roomId: "child-fixture", detail,
    messages: [row], runtimeMessages: restoreSessionMessages([row]), activeJobIds: [] });
  expect(state.messages[0]?.externalOrigin).toEqual(origin);
  expect(state.anchor?.externalOrigin).toEqual(origin);
  expect(state.runtimeMessages[0]?.metadata?.custom?.externalOrigin).toEqual(origin);
  expect(externalMessageAuthorLabel(state.runtimeMessages[0]?.metadata?.custom ?? {})).toBe("Bolter · You <fixture>");
  expect(state.runtimeMessages[0]?.metadata?.custom).not.toHaveProperty("sourceUserId");
});
