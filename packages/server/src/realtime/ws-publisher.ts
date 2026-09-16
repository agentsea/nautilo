import type {
  ActiveRoomSilenceDto,
  ConductorDecisionReasonCode,
  ImportantMessageArrivedEvent,
  EncryptionPolicyChangedEvent,
  MaintenanceState,
  MaintenanceStatusEvent,
  RoomMembershipSystemEventPayload,
  ServerEvent,
  NotificationStateResponse,
  ProtectedMessageDtoV2,
} from "@nautilo/types";
import {
  parseProtectedMessageDtoV2,
  parseProtectedMessageRealtimeEventV2,
  WS_GLOBAL_FANOUT_EVENT_TYPES,
  WS_VOICE_CONTROL_GLOBAL_EVENT_TYPES,
} from "@nautilo/types";
import type { WebSocket } from "ws";
import { log, warn } from "@nautilo/logger";
import {
  getHumanSenderUserIdForMessageBroadcast,
  getChangedNotificationState,
  listRoomsForActor,
  markDelivered,
} from "@nautilo/trust";
import { messageNewDeliveryFacts } from "./message-new-delivery-facts";
import type { RemoteHostPresenceEvent } from "../remote-control/host-presence-stream";

export type WsClientMeta = {
  userId: string;
  actorId: string;
  roomIds: Set<string>;
};

const clients = new Map<WebSocket, WsClientMeta>();
const pendingBroadcasts = new Set<Promise<void>>();

type DeliveryScope =
  | { kind: "all" }
  | { kind: "room"; roomId: string }
  | { kind: "user"; userId: string }
  | { kind: "none" };

/**
 * M077 Bundle 2 — explicit WS delivery audience. `auto` preserves
 * `inferDeliveryScope` behavior for normal bus/tool events. Global fan-out
 * (`kind: "all"`) requires `acknowledgedGlobalLeak: true` so call sites opt
 * in consciously (ISSUE-M077 NFR-C3).
 */
export type WsBroadcastAudience =
  | { kind: "auto" }
  | { kind: "room"; roomId: string }
  | { kind: "user"; userId: string }
  | { kind: "all"; acknowledgedGlobalLeak: boolean };

/** Event types that historically fan out to every connected socket. */
const GLOBAL_FANOUT_EVENT_TYPES = new Set<ServerEvent["type"]>(WS_GLOBAL_FANOUT_EVENT_TYPES);

const VOICE_CONTROL_GLOBAL_EVENT_TYPES = new Set<ServerEvent["type"]>(
  WS_VOICE_CONTROL_GLOBAL_EVENT_TYPES,
);

function isExplicitGlobalOnlyUnderAuto(type: ServerEvent["type"]): boolean {
  return GLOBAL_FANOUT_EVENT_TYPES.has(type) || VOICE_CONTROL_GLOBAL_EVENT_TYPES.has(type);
}

/**
 * High-frequency events — suppressed from the WS emit log so the
 * debug output stays readable. Anything NOT in this set gets a
 * `[ws] → <type>` line, which is what we want for approval /
 * identity / tool control flows (D082 PR A).
 */
const SUPPRESSED_EMIT_LOG_TYPES: ReadonlySet<ServerEvent["type"]> = new Set<ServerEvent["type"]>([
  "message.tokens",
  "agent.progress",
  "voice.audio",
  "voice.sentence",
  "typing.ping",
]);

/**
 * M134 — extract the room uuid from a room-scoped lane key, tolerating the
 * per-single-user / per-bot suffixes the Conductor uses
 * (`room:<id>:user:<actor>:bot:<agentId>`). Returns null for non-room lanes.
 *
 * REGRESSION GUARD: a `$`-anchored `^room:<uuid>$` match silently drops every
 * group-room agent event (the bot's reply never reaches the client) — see
 * ISSUE-M134 P3 + `ws-publisher-lane.test.ts`.
 */
export function roomIdFromLaneKey(laneKey: string): string | null {
  const m = /^room:([0-9a-f-]{36})(?::|$)/i.exec(laneKey);
  return m ? m[1]! : null;
}

/**
 * Stack-162 — structural view of a `ConductorDecision` for the receipt
 * classifier. Defined locally (rather than importing `ConductorDecision`
 * from `@nautilo/runtime`) so the realtime module stays decoupled from the
 * runtime package at import time; a real `ConductorDecision` is structurally
 * compatible. Only the fields the classifier reads are required.
 */
export interface ConductorDecisionForReceipt {
  kind: "wake" | "ask_user" | "silent";
  reason: string;
  source?: "mention" | "reply" | "ui" | "inferred";
}

/**
 * Stack-162 — the privacy-safe outcome + reason the receipt carries. The
 * `displayReason` is always a server-authored sentence; the raw
 * model-produced `decision.reason` is NEVER forwarded.
 */
export interface SafeDecisionOutcome {
  outcome: "wake" | "silent" | "ask_user" | "error";
  reasonCode: ConductorDecisionReasonCode;
  displayReason: string;
}

/**
 * Stack-162 — controlled Floor Manager silence reasons (no embedded model
 * text). Any `floor: ` reason NOT in this set carries model-generated
 * semantic detail and must collapse to the generic `*_router` code.
 */
const FLOOR_CONTROLLED_SILENT_REASONS: ReadonlySet<string> = new Set([
  "floor: model error",
  "floor: invalid output",
  "floor: out-of-set handle",
  "floor: ask_user options invalid",
  "floor: search loop exhausted",
  "floor: search error",
]);

/** Stack-162 — deterministic wake reasons that route via conversation history. */
const WAKE_HISTORY_REASONS: ReadonlySet<string> = new Set([
  "history-intent",
  "history single-owner",
  "history baseline single-owner",
]);

/**
 * Stack-162 — map a Conductor decision to a privacy-safe receipt outcome +
 * controlled reason code + concise display reason.
 *
 * Privacy contract: this is the ONLY path from a `ConductorDecision.reason`
 * to the wire. It recognizes the deterministic router's exact reason strings
 * and the Floor Manager's fixed failure suffixes, and collapses everything
 * else — including ANY `floor: <model reason>` (model-generated semantic
 * detail) — to a generic `*_router` code with a server-authored display
 * sentence. An arbitrary model-like reason can therefore never be emitted
 * verbatim on `conductor.decision`.
 */
export function classifyConductorDecision(
  decision: ConductorDecisionForReceipt,
): SafeDecisionOutcome {
  if (decision.kind === "wake") {
    switch (decision.source) {
      case "mention":
        return {
          outcome: "wake",
          reasonCode: "wake_mention",
          displayReason: "Selected by @mention.",
        };
      case "reply":
        return {
          outcome: "wake",
          reasonCode: "wake_reply",
          displayReason: "Selected by your reply.",
        };
      case "ui":
        return {
          outcome: "wake",
          reasonCode: "wake_ui",
          displayReason: "Selected by you.",
        };
      case "inferred":
      default: {
        if (decision.reason === "single active focus") {
          return {
            outcome: "wake",
            reasonCode: "wake_active_focus",
            displayReason: "Continuing your active focus.",
          };
        }
        if (decision.reason === "vocative") {
          return {
            outcome: "wake",
            reasonCode: "wake_vocative",
            displayReason: "Selected by name.",
          };
        }
        if (WAKE_HISTORY_REASONS.has(decision.reason)) {
          return {
            outcome: "wake",
            reasonCode: "wake_history",
            displayReason: "Selected from conversation history.",
          };
        }
        // Any other inferred wake (incl. `floor: <model reason>`) — generic.
        return {
          outcome: "wake",
          reasonCode: "wake_router",
          displayReason: "An assistant was selected to reply.",
        };
      }
    }
  }

  if (decision.kind === "ask_user") {
    if (decision.reason === "vocative: ambiguous direct address") {
      return {
        outcome: "ask_user",
        reasonCode: "ask_ambiguous_direct",
        displayReason: "Multiple assistants could match your message — choose one.",
      };
    }
    if (decision.reason === "history-intent: ambiguous owner") {
      return {
        outcome: "ask_user",
        reasonCode: "ask_ambiguous_history",
        displayReason: "Multiple assistants have context here — choose one.",
      };
    }
    // `floor: <model reason>` ask_user — generic; never forward model text.
    return {
      outcome: "ask_user",
      reasonCode: "ask_router",
      displayReason: "Multiple assistants could reply — choose one.",
    };
  }

  // decision.kind === "silent"
  if (decision.reason === "human-addressed") {
    return {
      outcome: "silent",
      reasonCode: "silent_human_addressed",
      displayReason: "No reply — your message was addressed to a person.",
    };
  }
  if (decision.reason === "no deterministic route") {
    return {
      outcome: "silent",
      reasonCode: "silent_no_route",
      displayReason:
        "No reply — no active focus and your message wasn't agent-addressed.",
    };
  }
  if (decision.reason === "addressivity: below threshold") {
    return {
      outcome: "silent",
      reasonCode: "silent_not_addressed",
      displayReason: "No reply — your message didn't seem addressed to an agent.",
    };
  }
  if (decision.reason === "floor: no wakeable bots") {
    return {
      outcome: "silent",
      reasonCode: "silent_no_wakeable",
      displayReason: "No reply — no assistants are available to respond.",
    };
  }
  if (FLOOR_CONTROLLED_SILENT_REASONS.has(decision.reason)) {
    return {
      outcome: "silent",
      reasonCode: "silent_router_unresolved",
      displayReason: "No reply — the router couldn't resolve a respondent.",
    };
  }
  // Any other silent (incl. `floor: <model reason>`) — generic, never emit raw.
  return {
    outcome: "silent",
    reasonCode: "silent_router",
    displayReason: "The router did not select an agent.",
  };
}

/** Stack-162 — outcome for a routing catch/error (no decision object exists). */
export function classifyRoutingError(): SafeDecisionOutcome {
  return {
    outcome: "error",
    reasonCode: "routing_error",
    displayReason: "Routing failed — please try again.",
  };
}

function inferDeliveryScope(event: ServerEvent): DeliveryScope {
  if (isExplicitGlobalOnlyUnderAuto(event.type)) {
    warn(
      `[ws] global event type=${event.type} dropped under audience=auto — use { kind: "all", acknowledgedGlobalLeak: true } (M077)`,
    );
    return { kind: "none" };
  }
  if (event.type === "profile.updated" && event.userId) {
    return { kind: "user", userId: event.userId };
  }
  // Native Codex requests are ephemeral and owner-private. They never carry a
  // room/lane fallback: a malformed owner id must drop the request rather than
  // disclose an approval or user-input prompt to Room members.
  if (event.type === "codex.request" || event.type === "codex.request.resolved") {
    if (typeof event.ownerId === "string" && event.ownerId.length > 0) {
      return { kind: "user", userId: event.ownerId };
    }
    warn(
      `[ws] ${event.type} dropped — missing owner id; refusing to room-fan-out native Codex request state`,
    );
    return { kind: "none" };
  }
  if (
    (event.type === "prove_it.challenge" || event.type === "identity.challenge") &&
    event.userId
  ) {
    return { kind: "user", userId: event.userId };
  }
  if (event.type === "approval.ask" && event.userId) {
    return { kind: "user", userId: event.userId };
  }
  if (
    (event.type === "room.notification.changed" ||
      event.type === "notification.message.important") &&
    event.userId
  ) {
    return { kind: "user", userId: event.userId };
  }
  if (event.type === "host.choice") {
    if (event.userId) return { kind: "user", userId: event.userId };
    warn("[ws] host.choice dropped — missing requester userId");
    return { kind: "none" };
  }
  if (event.type === "connected_web.action_attention" || event.type === "connected_web.action_resume_failed") {
    if (event.userId) return { kind: "user", userId: event.userId };
    warn(`[ws] ${event.type} dropped — missing requester userId`);
    return { kind: "none" };
  }
  if (event.type === "approval.resolved") {
    if (event.userId.length > 0) {
      return { kind: "user", userId: event.userId };
    }
    warn(
      `[ws] approval.resolved dropped — missing requester userId (approvalId=${event.approvalId}); refusing to room-fan-out private approval state`,
    );
    return { kind: "none" };
  }
  // Ambiguous-route recovery belongs only to the Human who sent the prompt.
  // The room lane is correlation metadata, never delivery authority. Fail
  // closed so a malformed chooser cannot fall through to room-wide fan-out.
  if (event.type === "conductor.ask_user") {
    if (typeof event.userId === "string" && event.userId.length > 0) {
      return { kind: "user", userId: event.userId };
    }
    warn(
      `[ws] conductor.ask_user dropped — missing requester userId (roomId=${event.roomId}); refusing to room-fan-out private routing recovery`,
    );
    return { kind: "none" };
  }
  if (
    event.type === "message.shared_agent_authorization_required"
    || event.type === "message.runtime_invocation_authorization_required"
  ) {
    if (typeof event.userId === "string" && event.userId.length > 0) {
      return { kind: "user", userId: event.userId };
    }
    warn(
      `[ws] ${event.type} dropped — missing requester userId; refusing to room-fan-out foreground crypto authority`,
    );
    return { kind: "none" };
  }
  // Stack-162 — requester-private decision receipt. Delivered ONLY to the
  // requester's connections (never room-fanned-out), so the safe explanation
  // of a routing decision cannot reach other room members. `userId` is the
  // load-bearing discriminator; `laneKey`/`roomId`/`userActorId` are client
  // correlation aids only. Fail CLOSED on a missing/empty userId — never
  // fall through to laneKey/room routing (that would leak the receipt to
  // every room member).
  if (event.type === "conductor.decision") {
    if (typeof event.userId === "string" && event.userId.length > 0) {
      return { kind: "user", userId: event.userId };
    }
    warn(
      `[ws] conductor.decision dropped — missing requester userId (roomId=${event.roomId}); refusing to room-fan-out a private receipt`,
    );
    return { kind: "none" };
  }
  if (
    (event.type === "voice.audio" || event.type === "voice.sentence") &&
    "userId" in event &&
    typeof (event as { userId?: string }).userId === "string" &&
    (event as { userId: string }).userId.length > 0
  ) {
    return { kind: "user", userId: (event as { userId: string }).userId };
  }

  if (event.type === "room_members_changed" && event.roomId) {
    return { kind: "room", roomId: event.roomId };
  }

  if (event.type === "room.silence.changed" && event.roomId) {
    return { kind: "room", roomId: event.roomId };
  }
  if (event.type === "room.conductor_mode.changed" && event.roomId) {
    return { kind: "room", roomId: event.roomId };
  }

  // M143 — task lifecycle events are owner-private (D14). Never room-broadcast;
  // the result message the run posts into a shared room emits its own
  // room-scoped `message.new`.
  if (
    (event.type === "task.fired" ||
      event.type === "task.completed" ||
      event.type === "task.errored" ||
      event.type === "task.status" ||
      event.type === "task.awaiting_reply" ||
      event.type === "task.progress") &&
    event.ownerId
  ) {
    return { kind: "user", userId: event.ownerId };
  }

  if (event.type === "typing.ping" && event.roomId) {
    return { kind: "room", roomId: event.roomId };
  }

  const laneKey =
    "laneKey" in event && typeof event.laneKey === "string" ? event.laneKey : "";
  const roomId = roomIdFromLaneKey(laneKey);
  if (roomId) {
    return { kind: "room", roomId };
  }

  // Task runs execute on an internal `task:<taskId>` JobManager lane. Their
  // owner-visible lifecycle is carried by the owner-private `task.*` events
  // above, while any Room report-back emits its own room-scoped `message.new`.
  // A task lane contains no room or owner authority, so generic `job.*`,
  // progress, and tool frames that reach this fallback must stay server-local.
  // Treat that as an intentional fail-closed sink rather than warning that the
  // event is unexpectedly unroutable or guessing a broader audience.
  if (laneKey.startsWith("task:")) {
    return { kind: "none" };
  }

  if (laneKey.startsWith("guest:")) {
    log(
      `[ws] dropped guest-lane event type=${event.type} laneKey=${laneKey} (no room-scoped WS fan-out)`,
    );
    return { kind: "none" };
  }

  warn(`[ws] unroutable event type=${event.type} laneKey=${laneKey || "(empty)"} — dropping`);
  return { kind: "none" };
}

function resolveDeliveryScope(
  event: ServerEvent,
  audience: WsBroadcastAudience,
): DeliveryScope {
  if (audience.kind === "all") {
    if (audience.acknowledgedGlobalLeak === true) {
      return { kind: "all" };
    }
    warn(
      `[ws] rejected broadcast: kind=all requires acknowledgedGlobalLeak: true (event=${event.type})`,
    );
    return { kind: "none" };
  }
  if (audience.kind === "room") {
    return { kind: "room", roomId: audience.roomId };
  }
  if (audience.kind === "user") {
    return { kind: "user", userId: audience.userId };
  }
  return inferDeliveryScope(event);
}

function scopeForLog(scope: DeliveryScope): string {
  if (scope.kind === "user") return `user:${scope.userId}`;
  if (scope.kind === "room") return `room:${scope.roomId}`;
  return scope.kind;
}

function shouldDeliver(meta: WsClientMeta, scope: DeliveryScope): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "none") return false;
  if (scope.kind === "user") return meta.userId === scope.userId;
  return meta.roomIds.has(scope.roomId);
}

export function addClient(socket: WebSocket, meta: WsClientMeta) {
  clients.set(socket, meta);
  // D112 Phase 19.3 — log on connect so a userId / roomId binding regression
  // is grep-able. Pairs with the enriched DROPPED log; together they make
  // user-lane delivery failures (approval.ask, prove_it.challenge,
  // identity.challenge) self-diagnosing.
  log(
    `[ws] client connected: userId=${meta.userId} actorId=${meta.actorId} rooms=${meta.roomIds.size}`,
  );
  socket.on("close", () => {
    clients.delete(socket);
  });
}

/**
 * M075 — reload room membership for every open WS owned by `userId`
 * (same `sessionActorId` on every tab for that user).
 */
export async function refreshRoomSubscriptionsForUser(
  userId: string,
  sessionActorId: string,
): Promise<void> {
  const rows = await listRoomsForActor(sessionActorId, {
    includeRoster: false,
    includeSubthreads: true,
  });
  const next = new Set(rows.map((r) => r.id));
  for (const [, meta] of clients) {
    if (meta.userId === userId) {
      meta.roomIds = next;
    }
  }
}

export interface HumanRoomCatalogTarget {
  readonly userId: string;
  readonly actorId: string;
}

/**
 * Converge every affected Human's live Room view after a Room is created.
 * Subscription refresh deliberately completes before the private catalogue
 * invalidations are published, so the client can immediately receive the
 * new Room's first room-scoped event without reconnecting.
 */
export async function convergeHumanRoomCatalogs(
  targets: readonly HumanRoomCatalogTarget[],
): Promise<void> {
  const unique = new Map<string, HumanRoomCatalogTarget>();
  for (const target of targets) {
    if (!target.userId || !target.actorId) continue;
    unique.set(target.userId, target);
  }
  const affected = [...unique.values()];
  await Promise.all(
    affected.map(({ userId, actorId }) => refreshRoomSubscriptionsForUser(userId, actorId)),
  );
  for (const { userId } of affected) publishRoomCatalogChanged(userId);
}

/**
 * Maps a bus `ServerEvent` to the WS audience the production bridge uses.
 * Exported for unit tests that assert bridge / publisher alignment.
 */
export function audienceForBridgedServerEvent(event: ServerEvent): WsBroadcastAudience {
  if (isExplicitGlobalOnlyUnderAuto(event.type)) {
    return { kind: "all", acknowledgedGlobalLeak: true };
  }
  if (event.type === "room_members_changed") {
    return { kind: "room", roomId: event.roomId };
  }
  if (event.type === "room.silence.changed") {
    return { kind: "room", roomId: event.roomId };
  }
  if (event.type === "room.conductor_mode.changed") {
    return { kind: "room", roomId: event.roomId };
  }
  return { kind: "auto" };
}

export function broadcast(
  event: ServerEvent,
  audience: WsBroadcastAudience = { kind: "auto" },
): void {
  const pending = broadcastAsync(event, audience);
  pendingBroadcasts.add(pending);
  void pending.then(
    () => pendingBroadcasts.delete(pending),
    () => pendingBroadcasts.delete(pending),
  );
}

/** Wait for every asynchronous websocket publication already in flight. */
export async function flushPendingWebSocketBroadcasts(): Promise<void> {
  while (pendingBroadcasts.size > 0) {
    await Promise.all([...pendingBroadcasts]);
  }
}

async function broadcastAsync(
  event: ServerEvent,
  audience: WsBroadcastAudience,
): Promise<void> {
  const payload = JSON.stringify(event);
  const scope = resolveDeliveryScope(event, audience);

  let skipSelfMarkDeliveredUserId: string | null = null;
  if (event.type === "message.new") {
    const facts = messageNewDeliveryFacts(event);
    if (facts.messageId !== null) {
      if (facts.senderUserId !== null) {
        skipSelfMarkDeliveredUserId = facts.senderUserId;
      } else {
        skipSelfMarkDeliveredUserId =
          await getHumanSenderUserIdForMessageBroadcast(facts.messageId);
      }
    }
  }

  if (!SUPPRESSED_EMIT_LOG_TYPES.has(event.type)) {
    const openCount = [...clients].filter(
      ([c, meta]) => c.readyState === c.OPEN && shouldDeliver(meta, scope),
    ).length;
    const total = clients.size;

    if (openCount === 0 && scope.kind !== "none") {
      // D112 Phase 19.3 — enrich the drop log with the actual scope and the
      // meta of every connected socket so a userId / roomId mismatch is
      // diagnosable from the log alone instead of requiring an attached
      // debugger. The historical line ("DROPPED → no matching subscribers")
      // told us *that* an event was dropped but not *why* — for `approval.ask`
      // (which routes by userId) you couldn't tell whether the socket simply
      // hadn't auth'd yet, the auth resolved to the wrong userId, or the
      // event payload had no userId at all. The added context is small
      // (one short JSON-ish blob per dropped event, suppressed log types
      // already filtered above) and only fires on the unhappy path.
      const scopeStr = scopeForLog(scope);
      const metas = [...clients]
        .filter(([c]) => c.readyState === c.OPEN)
        .map(([, m]) => `userId=${m.userId ?? "(none)"} rooms=${m.roomIds.size}`)
        .join("; ");
      log(
        `[ws] DROPPED → (no matching subscribers, ${total} total sockets) ${event.type} scope=${scopeStr} sockets=[${metas}]`,
      );
    } else if (scope.kind !== "none") {
      log(`[ws] → (${openCount}/${total} matching) ${event.type}`);
    }
  }

  for (const [client, meta] of clients) {
    if (client.readyState !== client.OPEN) continue;
    if (!shouldDeliver(meta, scope)) continue;
    client.send(payload);
    if (event.type === "message.new") {
      const { messageId } = messageNewDeliveryFacts(event);
      if (messageId !== null) {
        const skipForSelf =
          skipSelfMarkDeliveredUserId !== null && meta.userId === skipSelfMarkDeliveredUserId;
        if (!skipForSelf) {
          void markDelivered(messageId, meta.userId).catch(() => {});
        }
      }
    }
  }
}

/**
 * Stack-3 Phase 6b — fan out a typing ping to every socket subscribed
 * to `event.roomId`, skipping any socket whose `userId` matches the
 * sender. Skips emit logging entirely (high-frequency) and uses the
 * synchronous broadcast path because there's no per-recipient async
 * work like `markDelivered`.
 */
export function publishTypingPing(event: import("@nautilo/types").TypingPingEvent): void {
  const payload = JSON.stringify(event);
  for (const [client, meta] of clients) {
    if (client.readyState !== client.OPEN) continue;
    if (!meta.roomIds.has(event.roomId)) continue;
    if (meta.userId === event.userId) continue;
    client.send(payload);
  }
}

/**
 * D458 Wave 7 — the only websocket publication path for remote-host presence.
 *
 * These are canonical `ServerEvent` variants, but they deliberately bypass the
 * event bus and automatic audience inference. Keeping the recipient argument
 * separate from the event prevents a projection cache from carrying a user or
 * relay identifier onto the wire. This helper never uses `auto`, a room
 * audience, or global fan-out.
 */
export function publishRemoteHostPresenceFrame(
  recipientUserId: string,
  frame: RemoteHostPresenceEvent,
): void {
  const payload = JSON.stringify(frame);
  for (const [client, meta] of clients) {
    if (client.readyState !== client.OPEN) continue;
    if (meta.userId !== recipientUserId) continue;
    client.send(payload);
  }
}

/** D124 P8 — notify room subscribers that roster / transcript may have changed. */
export function publishRoomMembersChanged(
  roomId: string,
  event: RoomMembershipSystemEventPayload,
  recipientSyncNamespaceId?: string,
): void {
  broadcast({
    type: "room_members_changed",
    roomId,
    event,
    ...(recipientSyncNamespaceId === undefined
      ? {}
      : { recipientSyncNamespaceId }),
  }, { kind: "room", roomId });
}

/** Notify every online client of each current Human participant that bounded
 * V2 key fulfilment can run, including for non-conversational access Rooms. */
export function publishDomainKeyCatchUpRequested(input: Readonly<{
  roomId: string;
  namespaceId: string;
  keyClass: "human" | "ai";
  recipientUserIds: readonly string[];
}>): void {
  const event = {
    type: "crypto.domain_key_catch_up_requested",
    roomId: input.roomId,
    laneKey: `room:${input.roomId}`,
    namespaceId: input.namespaceId,
    keyClass: input.keyClass,
  } as const;
  for (const userId of new Set(input.recipientUserIds)) {
    if (userId.length > 0) broadcast(event, { kind: "user", userId });
  }
}

/** Notify every online client of each current Human participant that a durable
 * envelope is ready, including for non-conversational access Rooms. */
export function publishDomainKeyCatchUpDelivered(input: Readonly<{
  roomId: string;
  namespaceId: string;
  keyClass: "human" | "ai";
  recipientUserIds: readonly string[];
}>): void {
  const event = {
    type: "crypto.domain_key_catch_up_delivered",
    roomId: input.roomId,
    laneKey: `room:${input.roomId}`,
    namespaceId: input.namespaceId,
    keyClass: input.keyClass,
  } as const;
  for (const userId of new Set(input.recipientUserIds)) {
    if (userId.length > 0) broadcast(event, { kind: "user", userId });
  }
}

/**
 * Notify every live client owned by one Human that its authorized Room list
 * must be re-read. The frame is identifier-free and the audience is explicit,
 * so it cannot disclose a newly-created Room to another user.
 */
export function publishRoomCatalogChanged(recipientUserId: string): void {
  if (recipientUserId.length === 0) return;
  broadcast({ type: "room.catalog.changed" }, { kind: "user", userId: recipientUserId });
}

/** M323 — prompt every live session for one Human to refresh durable feed state. */
export function publishEventFeedChanged(recipientUserId: string): void {
  if (recipientUserId.length === 0) return;
  broadcast({ type: "event_feed.changed" }, { kind: "user", userId: recipientUserId });
}

/** D279 Phase 3.6 — fan out silence state to room members (mirrors roster push). */
export function publishRoomSilenceChanged(
  roomId: string,
  silence: ActiveRoomSilenceDto | null,
): void {
  broadcast(
    {
      type: "room.silence.changed",
      roomId,
      laneKey: `room:${roomId}`,
      silence,
    },
    { kind: "room", roomId },
  );
}

/** D302 P5b — fan out conductor-mode policy updates to room members. */
export function publishRoomConductorModeChanged(
  roomId: string,
  conductorMode: "advanced" | "standard",
): void {
  broadcast(
    {
      type: "room.conductor_mode.changed",
      roomId,
      laneKey: `room:${roomId}`,
      conductorMode,
    },
    { kind: "room", roomId },
  );
}

/** ISSUE-M172 — fan out a hard-delete of a room message to room members. */
export function publishMessageDeleted(args: { roomId: string; messageId: number }): void {
  broadcast(
    {
      type: "message.deleted",
      laneKey: `room:${args.roomId}`,
      messageId: args.messageId,
    },
    { kind: "room", roomId: args.roomId },
  );
}

/** M230 — fan out an authoritative logical Human-turn edit to Room members. */
export function publishMessageUpdated(args: {
  roomId: string;
  logicalMessageKey: string;
  content: string;
  editedAt: string;
  editRevision: number;
}): void {
  broadcast(
    {
      type: "message.updated",
      laneKey: `room:${args.roomId}`,
      logicalMessageKey: args.logicalMessageKey,
      content: args.content,
      editedAt: args.editedAt,
      editRevision: args.editRevision,
    },
    { kind: "room", roomId: args.roomId },
  );
}

/** Publish a committed Full edit without exposing an ordinary replacement. */
export function publishProtectedMessageUpdated(args: Readonly<{
  roomId: string;
  message: ProtectedMessageDtoV2;
}>): void {
  const message = parseProtectedMessageDtoV2(args.message);
  if (message.projection.roomId !== args.roomId
    || message.projection.logicalMessageKey === undefined
    || message.projection.editedAt === undefined
    || message.projection.editRevision < 1) {
    throw new TypeError("Protected message update coordinates are invalid");
  }
  broadcast(parseProtectedMessageRealtimeEventV2({
    wireVersion: 2,
    type: "message.updated",
    protection: "protected",
    laneKey: `room:${args.roomId}`,
    logicalMessageKey: message.projection.logicalMessageKey,
    editRevision: message.projection.editRevision,
    message,
  }), { kind: "room", roomId: args.roomId });
}

function publishNotificationChange(
  change: import("@nautilo/trust").ChangedNotificationState,
): void {
  broadcast(
    {
      type: "room.notification.changed",
      ...change,
    },
    { kind: "user", userId: change.userId },
  );
}

/**
 * M236 — publish a just-computed complete snapshot after an account-default
 * mutation. This is bounded and performs no DB work per Room.
 */
export function publishNotificationStateSnapshot(
  userId: string,
  state: NotificationStateResponse,
): void {
  const topLevelById = new Map(state.rooms.map((room) => [room.roomId, room]));
  for (const room of state.rooms) {
    publishNotificationChange({
      userId,
      roomId: room.roomId,
      topLevelRoomId: room.roomId,
      roomOwnUnreadCount: room.ownUnreadCount,
      roomOwnImportantUnreadCount: room.ownImportantUnreadCount,
      topLevelUnreadCount: room.unreadCount,
      topLevelImportantUnreadCount: room.importantUnreadCount,
    });
  }
  for (const subthread of state.subthreads) {
    const parent = topLevelById.get(subthread.parentRoomId);
    if (!parent) continue;
    publishNotificationChange({
      userId,
      roomId: subthread.roomId,
      topLevelRoomId: subthread.parentRoomId,
      roomOwnUnreadCount: subthread.unreadCount,
      roomOwnImportantUnreadCount: subthread.importantUnreadCount,
      topLevelUnreadCount: parent.unreadCount,
      topLevelImportantUnreadCount: parent.importantUnreadCount,
    });
  }
}

/**
 * M236/M240 — recompute complete per-recipient notification state for a Room
 * and publish the one canonical viewer-private delta. Pass an empty recipient
 * list to no-op.
 */
export async function recomputeAndPublishNotificationState(
  args: {
    roomId: string;
    recipientUserIds: string[];
  },
  dependencies: {
    getChangedState?: typeof getChangedNotificationState;
  } = {},
): Promise<void> {
  const { roomId, recipientUserIds } = args;
  if (recipientUserIds.length === 0) return;
  const getChangedState =
    dependencies.getChangedState ?? getChangedNotificationState;
  const changes = await getChangedState(
    roomId,
    recipientUserIds,
  );
  for (const change of changes) {
    publishNotificationChange(change);
  }
}

/** M236 — deliver one already-classified, arrival-only event viewer-privately. */
export function publishImportantMessageArrived(
  event: ImportantMessageArrivedEvent,
): void {
  if (event.userId.length === 0) return;
  broadcast(event, { kind: "user", userId: event.userId });
}

/**
 * D420 (Wave 3 task 3.2.1) — convert a durable maintenance snapshot's
 * `Date | null` expiry to the ISO-8601 `string | null` the realtime event
 * carries. Centralized so the publisher + the WS connect-snapshot provider
 * cannot drift on the wire format.
 */
function maintenanceExpiryToIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * D420 (Wave 3 task 3.2.1) — build the payload-free
 * {@link MaintenanceStatusEvent} from a durable maintenance snapshot.
 * Carries state / operation / lease + hard expiry ONLY — never work counts,
 * job ids, prompts, or room/user payload.
 */
export function buildMaintenanceStatusEvent(snapshot: {
  state: MaintenanceState;
  operationId: string | null;
  leaseExpiresAt: Date | string | null;
  hardExpiresAt: Date | string | null;
}): MaintenanceStatusEvent {
  return {
    type: "maintenance.status",
    state: snapshot.state,
    operationId: snapshot.operationId,
    leaseExpiresAt: maintenanceExpiryToIso(snapshot.leaseExpiresAt),
    hardExpiresAt: maintenanceExpiryToIso(snapshot.hardExpiresAt),
  };
}

/**
 * D420 (Wave 3 task 3.2.1) — publish a `maintenance.status` event to every
 * authenticated connected socket. Maintenance is a server-wide property, so
 * this is an explicit global fan-out (mirrors `policy.changed`); the event
 * is payload-free and safe to deliver to every client regardless of room
 * subscription. Call this whenever the durable `server_maintenance` state
 * changes: enter draining, applying, successful completion/cancel, lease
 * renewal, and expiry recovery.
 */
export function publishMaintenanceStatus(snapshot: {
  state: MaintenanceState;
  operationId: string | null;
  leaseExpiresAt: Date | string | null;
  hardExpiresAt: Date | string | null;
}): void {
  broadcast(buildMaintenanceStatusEvent(snapshot), {
    kind: "all",
    acknowledgedGlobalLeak: true,
  });
}

/**
 * Publish a content-free encryption-policy invalidation to every registered
 * authenticated socket. Production registration follows the configured WS
 * admission check. Plaintext-policy connections are intentionally included:
 * they must learn when a new policy starts requiring device enrollment. The
 * revision identifies the committed change; clients must re-read canonical policy and
 * admission before acting.
 */
export function publishEncryptionPolicyChanged(
  policyRevision: number,
): void {
  const event: EncryptionPolicyChangedEvent = {
    type: "encryption.policy.changed",
    policyRevision,
  };
  broadcast(event, {
    kind: "all",
    acknowledgedGlobalLeak: true,
  });
}
