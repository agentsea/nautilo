/**
 * D468 — the one inbound handoff boundary for Mobile URLs and push responses.
 *
 * Inbound payloads are untrusted transport hints. This module deliberately
 * keeps parsing, deduplication, binding lookup, and exact-target
 * revalidation free of React and native globals so the root provider has one
 * small, testable owner instead of competing URL/notification listeners.
 */
import {
  mobilePushEnvelopeV1Schema,
  type MobilePushEnvelopeV1,
} from "@nautilo/types";

export type InboundUrlIntent =
  | { readonly kind: "add-server"; readonly url: string }
  | { readonly kind: "invite"; readonly serverUrl: string; readonly token: string }
  | { readonly kind: "invalid-invite"; readonly reason: "missing-server" | "invalid-server" | "invalid-token" }
  | {
      readonly kind: "remote-pair";
      readonly challengeId: string;
      readonly secret: string;
      readonly ceremonyContext: string;
    }
  | { readonly kind: "callback" }
  | { readonly kind: "unknown" };

export type PushBindingRecord = { readonly bindingId: string };

export type PushIntentServer = {
  readonly id: string;
  readonly serverUrl: string;
};

export type PushIntentServerSnapshot = {
  readonly server: PushIntentServer;
  readonly lifecycleRevision: number;
};

export type PushIntentClient = {
  setToken(token: string): void;
  getRoom(roomId: string): Promise<{
    readonly id: string;
    readonly parentRoomId?: string | null;
  }>;
  getRoomMessagesAround(input: {
    readonly roomId: string;
    readonly messageId: string;
    readonly limit?: number;
  }): Promise<{
    readonly target: { readonly messageId: string };
  }>;
};

export interface MobilePushIntentResolverDeps {
  readonly loadRegistry: () => Promise<{ readonly servers: readonly PushIntentServer[] }>;
  readonly loadBinding: (serverId: string) => Promise<PushBindingRecord | null>;
  readonly loadServerRegistrationSnapshot: (
    serverId: string,
  ) => Promise<PushIntentServerSnapshot | null>;
  readonly isServerRegistrationCurrent: (
    snapshot: PushIntentServerSnapshot,
  ) => Promise<boolean>;
  readonly ensureValidToken: (serverId: string, serverUrl: string) => Promise<string | null>;
  readonly createClient: (serverUrl: string) => PushIntentClient;
}

type ResolvedServer = {
  readonly serverId: string;
  readonly serverUrl: string;
  /** Local registry generation, never sourced from a notification. */
  readonly lifecycleRevision: number;
};

export type MobilePushIntentResolution =
  | { readonly kind: "test_acknowledged" }
  | { readonly kind: "needs_you_unavailable" }
  | { readonly kind: "unknown_binding" }
  | { readonly kind: "signed_out"; readonly target: ResolvedServer }
  | { readonly kind: "offline"; readonly target: ResolvedServer }
  | { readonly kind: "unavailable"; readonly target: ResolvedServer }
  | { readonly kind: "denied" }
  | { readonly kind: "deleted" }
  | { readonly kind: "current_room"; readonly target: ResolvedServer & { readonly roomId: string } }
  | {
      readonly kind: "navigate";
      readonly target: ResolvedServer & { readonly roomId: string; readonly messageId: string };
    };

export interface MobilePushIntentResolver {
  resolve(envelope: MobilePushEnvelopeV1): Promise<MobilePushIntentResolution>;
  findBindingServer(bindingId: string): Promise<PushIntentServer | null>;
}

/** A validated push target only needs a visible switch when its origin differs. */
export function shouldSwitchToPushServer(
  active: PushIntentServer | null,
  target: PushIntentServer,
): boolean {
  return active?.id !== target.id || active.serverUrl !== target.serverUrl;
}

const MAX_INBOUND_DEDUP_KEYS = 128;

/**
 * Parse only the exact V1 envelope. The raw notification response never
 * becomes route state, AsyncStorage, or SecureStore data.
 */
export function parseMobilePushEnvelope(value: unknown): MobilePushEnvelopeV1 | null {
  const parsed = mobilePushEnvelopeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Safely pull Expo's opaque `content.data` field out of a Notification. */
function notificationData(value: unknown): unknown {
  if (!value || typeof value !== "object") return null;
  const request = (value as { request?: unknown }).request;
  if (!request || typeof request !== "object") return null;
  const content = (request as { content?: unknown }).content;
  if (!content || typeof content !== "object") return null;
  return (content as { data?: unknown }).data ?? null;
}

/** Parse a received Expo notification without exposing its native shape. */
export function parseMobilePushNotification(value: unknown): MobilePushEnvelopeV1 | null {
  return parseMobilePushEnvelope(notificationData(value));
}

/** An explicit Human-requested test must remain visible even in foreground. */
export function shouldPresentForegroundPush(envelope: MobilePushEnvelopeV1): boolean {
  return envelope.kind === "test";
}

/** Safely pull Expo's opaque `content.data` field out of a response object. */
function notificationResponseData(value: unknown): unknown {
  if (!value || typeof value !== "object") return null;
  return notificationData((value as { notification?: unknown }).notification);
}

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

function targetFor(snapshot: PushIntentServerSnapshot): ResolvedServer {
  return {
    serverId: snapshot.server.id,
    serverUrl: snapshot.server.serverUrl,
    lifecycleRevision: snapshot.lifecycleRevision,
  };
}

export type ImportantMessageEnvelope = MobilePushEnvelopeV1 & {
  readonly kind: "important_message";
  readonly bindingId: string;
  readonly roomId: string;
  readonly topLevelRoomId: string;
  readonly messageId: number;
};

function isImportantMessage(
  envelope: MobilePushEnvelopeV1,
): envelope is ImportantMessageEnvelope {
  return envelope.kind === "important_message";
}

function isNetworkFailure(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 0) return true;
  if (error instanceof TypeError) return true;
  return error instanceof Error && /network|fetch|offline|timeout|unreachable/i.test(error.message);
}

/**
 * The only local binding lookup. A binding ID is not a server selector:
 * absence or a duplicate local ownership fails closed rather than choosing a
 * server or accepting a URL from the push payload.
 */
async function findLocalPushBindingServer(
  bindingId: string,
  deps: Pick<MobilePushIntentResolverDeps, "loadRegistry" | "loadBinding">,
): Promise<PushIntentServer | null> {
  let registry: Awaited<ReturnType<typeof deps.loadRegistry>>;
  try {
    registry = await deps.loadRegistry();
  } catch {
    return null;
  }
  const matches: PushIntentServer[] = [];
  for (const server of registry.servers) {
    try {
      const binding = await deps.loadBinding(server.id);
      if (binding?.bindingId === bindingId) matches.push(server);
    } catch {
      // A SecureStore read failure is not evidence that a different server is
      // safe to choose. Treat it like an unknown binding.
      return null;
    }
  }
  return matches.length === 1 ? matches[0] ?? null : null;
}

/**
 * Revalidate a V1 payload before the visible active server is changed. The
 * client is dedicated to the candidate server; it never rebinds the active
 * API singleton during validation.
 */
export function createPushIntentResolver(
  deps: MobilePushIntentResolverDeps,
): MobilePushIntentResolver {
  const findBindingServer = (bindingId: string) => findLocalPushBindingServer(bindingId, deps);

  return {
    findBindingServer,
    async resolve(envelope) {
      // A test notification intentionally has no target. It is a receipt for
      // the user's test action, never a synthetic message or a server lookup.
      if (envelope.kind === "test") return { kind: "test_acknowledged" };
      // Stack 292 deliberately does not fabricate D337 Needs-you truth.
      if (envelope.kind === "needs_you") return { kind: "needs_you_unavailable" };
      if (!isImportantMessage(envelope)) return { kind: "unknown_binding" };

      const matchedServer = await findBindingServer(envelope.bindingId);
      if (!matchedServer) return { kind: "unknown_binding" };
      let snapshot: PushIntentServerSnapshot | null;
      try {
        snapshot = await deps.loadServerRegistrationSnapshot(matchedServer.id);
      } catch {
        return { kind: "unknown_binding" };
      }
      if (!snapshot || snapshot.server.serverUrl !== matchedServer.serverUrl) {
        return { kind: "unknown_binding" };
      }
      const target = targetFor(snapshot);

      let token: string | null;
      try {
        token = await deps.ensureValidToken(snapshot.server.id, snapshot.server.serverUrl);
      } catch {
        return { kind: "unavailable", target };
      }
      try {
        if (!(await deps.isServerRegistrationCurrent(snapshot))) return { kind: "unknown_binding" };
      } catch {
        return { kind: "unknown_binding" };
      }
      if (!token) return { kind: "signed_out", target };

      const client = deps.createClient(snapshot.server.serverUrl);
      client.setToken(token);
      let room: Awaited<ReturnType<PushIntentClient["getRoom"]>>;
      try {
        room = await client.getRoom(envelope.roomId);
      } catch (error) {
        const status = statusOf(error);
        if (status === 401) return { kind: "signed_out", target };
        if (status === 403) return { kind: "denied" };
        if (status === 404) return { kind: "deleted" };
        return isNetworkFailure(error) ? { kind: "offline", target } : { kind: "unavailable", target };
      }

      // The push must not use its top-level pointer to smuggle a different
      // Room. A subthread has exactly the advertised parent; a top-level Room
      // has no different parent.
      const hierarchyMatches = envelope.roomId === envelope.topLevelRoomId
        ? room.id === envelope.topLevelRoomId && (room.parentRoomId == null)
        : room.id === envelope.roomId && room.parentRoomId === envelope.topLevelRoomId;
      if (!hierarchyMatches) return { kind: "denied" };

      const messageId = String(envelope.messageId);
      try {
        const around = await client.getRoomMessagesAround({
          roomId: envelope.roomId,
          messageId,
          limit: 30,
        });
        if (around.target.messageId !== messageId) return { kind: "denied" };
      } catch (error) {
        const status = statusOf(error);
        if (status === 401) return { kind: "signed_out", target };
        if (status === 403) return { kind: "denied" };
        // The Room survived but the historical message did not. Open current
        // context without pretending that the unread target still exists.
        if (status === 404) {
          return { kind: "current_room", target: { ...target, roomId: envelope.roomId } };
        }
        return isNetworkFailure(error) ? { kind: "offline", target } : { kind: "unavailable", target };
      }
      try {
        if (!(await deps.isServerRegistrationCurrent(snapshot))) return { kind: "unknown_binding" };
      } catch {
        return { kind: "unknown_binding" };
      }
      return {
        kind: "navigate",
        target: { ...target, roomId: envelope.roomId, messageId },
      };
    },
  };
}

/** One memory-only, single-consumer pending navigation — no push history. */
export interface OneShotPushHandoff {
  replace(input: {
    readonly envelope: ImportantMessageEnvelope;
    readonly serverId: string;
    readonly reason: "signed_out" | "offline";
  }): void;
  takeForSignedIn(serverId: string): ImportantMessageEnvelope | null;
  takeForReconnect(serverId: string): ImportantMessageEnvelope | null;
  clear(): void;
}

export function createOneShotPushHandoff(): OneShotPushHandoff {
  let pending: {
    envelope: ImportantMessageEnvelope;
    serverId: string;
    reason: "signed_out" | "offline";
  } | null = null;

  const take = (
    reason: "signed_out" | "offline",
    serverId: string,
  ): ImportantMessageEnvelope | null => {
    if (!pending || pending.reason !== reason || pending.serverId !== serverId) return null;
    const envelope = pending.envelope;
    pending = null;
    return envelope;
  };

  return {
    replace(input) {
      pending = { ...input };
    },
    takeForSignedIn(serverId) {
      return take("signed_out", serverId);
    },
    takeForReconnect(serverId) {
      return take("offline", serverId);
    },
    clear() {
      pending = null;
    },
  };
}

export function shouldSuppressForegroundPush(
  envelope: MobilePushEnvelopeV1,
  context: {
    readonly bindingServerId: string | null;
    readonly activeServerId: string | null;
    readonly openRoomId: string | null;
  },
): boolean {
  return envelope.kind === "important_message"
    && context.bindingServerId !== null
    && context.bindingServerId === context.activeServerId
    && context.openRoomId === envelope.roomId;
}

type Unsubscribe = () => void;

export interface InboundIntentCoordinator {
  start(): void;
  stop(): void;
  consumeUrl(raw: string): Promise<void>;
  consumeNotificationResponse(response: unknown): Promise<void>;
}

export interface InboundIntentCoordinatorDeps {
  readonly parseUrl: (raw: string) => InboundUrlIntent;
  readonly linking: {
    getInitialUrl(): Promise<string | null>;
    addUrlListener(listener: (url: string) => void): Unsubscribe;
  };
  readonly notifications: {
    getLastResponse(): unknown;
    addResponseListener(listener: (response: unknown) => void): Unsubscribe;
    addReceivedListener(listener: (notification: unknown) => void): Unsubscribe;
  };
  readonly onUrlIntent: (intent: Exclude<InboundUrlIntent, { readonly kind: "callback" | "unknown" }>) => void | Promise<void>;
  readonly onPushResponse: (envelope: MobilePushEnvelopeV1) => void | Promise<void>;
  readonly onForegroundPush: (envelope: MobilePushEnvelopeV1) => void | Promise<void>;
}

function addBounded(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  while (seen.size > MAX_INBOUND_DEDUP_KEYS) {
    const oldest = seen.values().next().value;
    if (typeof oldest !== "string") break;
    seen.delete(oldest);
  }
  return true;
}

/**
 * Transport-local duplicate key for an invite locator.  It is never persisted
 * or displayed; retain only a short irreversible digest instead of a bearer.
 */
function inviteDedupeKey(serverUrl: string, token: string): string {
  let hash = 0x811c9dc5;
  const source = `${serverUrl}\u0000${token}`;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `invite:${serverUrl}:${(hash >>> 0).toString(16)}`;
}

function dedupeUrlKey(intent: InboundUrlIntent): string | null {
  switch (intent.kind) {
    case "add-server":
      return `add-server:${intent.url}`;
    case "invite":
      return inviteDedupeKey(intent.serverUrl, intent.token);
    case "invalid-invite":
      return `invalid-invite:${intent.reason}`;
    case "remote-pair":
      return `remote-pair:${intent.challengeId}`;
    case "callback":
    case "unknown":
      return null;
  }
}

/**
 * Starts the sole root listener set. Linking's cold/warm path and Expo's
 * cold/warm response path both pass through the same serialized, bounded
 * dedupe boundary; OAuth callbacks are classified then intentionally ignored.
 */
export function createInboundIntentCoordinator(
  deps: InboundIntentCoordinatorDeps,
): InboundIntentCoordinator {
  let started = false;
  let stopped = false;
  let listeners: Unsubscribe[] = [];
  let tail: Promise<void> = Promise.resolve();
  const handledUrls = new Set<string>();
  const handledResponses = new Set<string>();
  const handledForeground = new Set<string>();

  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const next = tail.catch(() => {}).then(operation);
    tail = next.catch(() => {});
    return next;
  };

  const consumeUrl = (raw: string): Promise<void> => serialize(async () => {
    if (stopped || !raw) return;
    const intent = deps.parseUrl(raw);
    const key = dedupeUrlKey(intent);
    if (!key || !addBounded(handledUrls, key)) return;
    if (intent.kind === "callback" || intent.kind === "unknown") return;
    await deps.onUrlIntent(intent);
  });

  const consumeNotificationResponse = (response: unknown): Promise<void> => serialize(async () => {
    if (stopped) return;
    const envelope = parseMobilePushEnvelope(notificationResponseData(response));
    if (!envelope || !addBounded(handledResponses, envelope.notificationId)) return;
    await deps.onPushResponse(envelope);
  });

  const consumeForegroundNotification = (notification: unknown): Promise<void> => serialize(async () => {
    if (stopped) return;
    const envelope = parseMobilePushNotification(notification);
    if (!envelope || !addBounded(handledForeground, envelope.notificationId)) return;
    await deps.onForegroundPush(envelope);
  });

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      listeners = [
        deps.linking.addUrlListener((url) => { void consumeUrl(url).catch(() => {}); }),
        deps.notifications.addResponseListener((response) => {
          void consumeNotificationResponse(response).catch(() => {});
        }),
        deps.notifications.addReceivedListener((notification) => {
          void consumeForegroundNotification(notification).catch(() => {});
        }),
      ];
      void deps.linking.getInitialUrl()
        .then((url) => (url ? consumeUrl(url) : undefined))
        .catch(() => {});
      // Expo retains the last response for cold starts. The listener is
      // already live; notificationId dedupe makes an initial/warm race safe.
      void consumeNotificationResponse(deps.notifications.getLastResponse()).catch(() => {});
    },
    stop() {
      if (!started) return;
      stopped = true;
      started = false;
      for (const unsubscribe of listeners.splice(0)) unsubscribe();
    },
    consumeUrl,
    consumeNotificationResponse,
  };
}
