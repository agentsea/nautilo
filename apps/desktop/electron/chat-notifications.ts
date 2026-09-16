/**
 * M239 — privacy-safe macOS important-message delivery.
 *
 * Electron main owns validation, active-session and activity checks, bounded
 * de-duplication, native copy, notification lifetime, and trusted click
 * routing. Every Electron side effect is injected so the complete policy is
 * unit-testable without booting Electron.
 */

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_LABEL_CODE_POINTS = 200;
const MAX_NATIVE_ERROR_LENGTH = 500;
const RECENT_MESSAGE_LIMIT = 4_096;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GENERIC_SENDER = "Nautilo";
const GENERIC_ROOM = "a room";
const GENERIC_THREAD = "a thread";

function containsControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_IDENTIFIER_LENGTH ||
    containsControlChar(trimmed) ||
    !UUID_RE.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function validateMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_IDENTIFIER_LENGTH ||
    containsControlChar(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function validateLabel(value: unknown, fallback: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    containsControlChar(trimmed) ||
    [...trimmed].length > MAX_LABEL_CODE_POINTS
  ) {
    return null;
  }
  return trimmed || fallback;
}

export function isMacosAppEffectivelyActive(input: {
  eventStateActive: boolean;
  hasFocusedAppWindow: boolean;
}): boolean {
  return input.eventStateActive && input.hasFocusedAppWindow;
}

export type ImportantMessageInput = {
  messageId: unknown;
  senderDisplayName: unknown;
  roomId: unknown;
  topLevelRoomId: unknown;
  roomLabel: unknown;
  parentRoomLabel?: unknown;
};

export interface NotificationNavigationTarget {
  topLevelRoomId: string;
  subthreadRoomId?: string;
}

export interface ValidatedImportantMessage {
  messageId: string;
  senderDisplayName: string;
  roomId: string;
  topLevelRoomId: string;
  roomLabel: string;
  parentRoomLabel?: string;
  navigationTarget: NotificationNavigationTarget;
}

const IMPORTANT_MESSAGE_KEYS = new Set([
  "messageId",
  "senderDisplayName",
  "roomId",
  "topLevelRoomId",
  "roomLabel",
  "parentRoomLabel",
]);

/**
 * Accept only the locked content-free payload. Unknown fields are rejected so
 * a renderer cannot smuggle native copy, message content, URLs, or sound
 * controls across this boundary.
 */
export function validateImportantMessageInput(
  input: ImportantMessageInput,
): ValidatedImportantMessage | null {
  if (!isPlainObject(input)) return null;
  if (Object.keys(input).some((key) => !IMPORTANT_MESSAGE_KEYS.has(key))) {
    return null;
  }

  const messageId = validateMessageId(input.messageId);
  const roomId = validateUuid(input.roomId);
  const topLevelRoomId = validateUuid(input.topLevelRoomId);
  if (!messageId || !roomId || !topLevelRoomId) return null;

  const isSubthread = roomId !== topLevelRoomId;
  const senderDisplayName = validateLabel(
    input.senderDisplayName,
    GENERIC_SENDER,
  );
  const roomLabel = validateLabel(
    input.roomLabel,
    isSubthread ? GENERIC_THREAD : GENERIC_ROOM,
  );
  if (!senderDisplayName || !roomLabel) return null;

  if (!isSubthread) {
    if (Object.hasOwn(input, "parentRoomLabel")) return null;
    return {
      messageId,
      senderDisplayName,
      roomId,
      topLevelRoomId,
      roomLabel,
      navigationTarget: { topLevelRoomId },
    };
  }

  const parentRoomLabel = validateLabel(
    input.parentRoomLabel,
    GENERIC_ROOM,
  );
  if (!parentRoomLabel) return null;
  return {
    messageId,
    senderDisplayName,
    roomId,
    topLevelRoomId,
    roomLabel,
    parentRoomLabel,
    navigationTarget: {
      topLevelRoomId,
      subthreadRoomId: roomId,
    },
  };
}

/**
 * Per-live-session insertion-ordered LRU. Duplicate claims refresh recency but
 * remain rejected. State is process-local and intentionally never persisted.
 */
export class NotificationMessageDeduper {
  private readonly bySession = new Map<string, Map<string, true>>();

  constructor(private readonly limit = RECENT_MESSAGE_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("notification dedupe limit must be a positive safe integer");
    }
  }

  claim(sessionKey: string, messageId: string): boolean {
    let recent = this.bySession.get(sessionKey);
    if (!recent) {
      recent = new Map();
      this.bySession.set(sessionKey, recent);
    }
    if (recent.has(messageId)) {
      recent.delete(messageId);
      recent.set(messageId, true);
      return false;
    }
    recent.set(messageId, true);
    if (recent.size > this.limit) {
      const oldest = recent.keys().next().value;
      if (typeof oldest === "string") recent.delete(oldest);
    }
    return true;
  }

  clearSession(sessionKey: string): void {
    this.bySession.delete(sessionKey);
  }

  retainSessions(sessionKeys: ReadonlySet<string>): void {
    for (const sessionKey of this.bySession.keys()) {
      if (!sessionKeys.has(sessionKey)) this.bySession.delete(sessionKey);
    }
  }

  sizeForTest(sessionKey: string): number {
    return this.bySession.get(sessionKey)?.size ?? 0;
  }
}

export type ShowImportantMessageResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "inactive-sender"
        | "invalid-payload"
        | "duplicate-message"
        | "unsupported-platform"
        | "unsupported-api"
        | "test-environment"
        | "no-window"
        | "app-active"
        | "show-failed";
    };

export interface NotificationHandle {
  show(): void;
  onClick(handler: () => void): void;
  onClose(handler: () => void): void;
  onFailed(handler: (error: string) => void): void;
}

const pendingNotifications = new Set<NotificationHandle>();

export function pendingNotificationCountForTest(): number {
  return pendingNotifications.size;
}

export interface ChatNotificationDeps {
  platform(): string;
  isNotificationSupported(): boolean;
  isTestEnvironment(): boolean;
  isMainWindowAlive(): boolean;
  isAppActive(): boolean;
  /**
   * Return the active trusted session key for this sender. Unknown, destroyed,
   * and background senders return null.
   */
  resolveActiveSessionKey(senderId: number): string | null;
  claimMessage(sessionKey: string, messageId: string): boolean;
  createNotification(opts: { title: string; body: string }): NotificationHandle;
  logNativeFailure(error: string): void;
  showMainWindow(): void;
  focusMainWindow(): void;
  /**
   * Main wiring rechecks that senderId still belongs to expectedSessionKey and
   * that it is still active before emitting the structured target.
   */
  sendNavigate(
    senderId: number,
    expectedSessionKey: string,
    target: NotificationNavigationTarget,
  ): void;
}

export function redactNativeError(error: unknown): string {
  if (typeof error !== "string") return "";
  let out = "";
  for (let index = 0; index < error.length; index += 1) {
    const code = error.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      if (code === 0x09 || code === 0x0a || code === 0x0d) out += " ";
      continue;
    }
    out += error[index];
  }
  if (out.length > MAX_NATIVE_ERROR_LENGTH) {
    out = `${out.slice(0, MAX_NATIVE_ERROR_LENGTH)}…`;
  }
  return out.trim();
}

/**
 * Gate order deliberately claims a valid active-session message before
 * platform support, activity, or native delivery. A suppressed/failed request
 * therefore cannot reappear later after focus or permission changes.
 */
export function showImportantMessage(
  senderId: number,
  input: ImportantMessageInput,
  deps: ChatNotificationDeps,
): ShowImportantMessageResult {
  const sessionKey = deps.resolveActiveSessionKey(senderId);
  if (!sessionKey) return { ok: false, reason: "inactive-sender" };

  const payload = validateImportantMessageInput(input);
  if (!payload) return { ok: false, reason: "invalid-payload" };
  if (!deps.claimMessage(sessionKey, payload.messageId)) {
    return { ok: false, reason: "duplicate-message" };
  }
  if (deps.platform() !== "darwin") {
    return { ok: false, reason: "unsupported-platform" };
  }
  if (!deps.isNotificationSupported()) {
    return { ok: false, reason: "unsupported-api" };
  }
  if (deps.isTestEnvironment()) {
    return { ok: false, reason: "test-environment" };
  }
  if (!deps.isMainWindowAlive()) {
    return { ok: false, reason: "no-window" };
  }
  if (deps.isAppActive()) {
    return { ok: false, reason: "app-active" };
  }

  const body =
    payload.navigationTarget.subthreadRoomId === undefined
      ? `New message in ${payload.roomLabel}`
      : `New reply in ${payload.roomLabel}, ${payload.parentRoomLabel}`;

  let notification: NotificationHandle;
  try {
    notification = deps.createNotification({
      title: payload.senderDisplayName,
      body,
    });
  } catch {
    return { ok: false, reason: "show-failed" };
  }

  let settled = false;
  const settle = (): boolean => {
    if (settled) return false;
    settled = true;
    pendingNotifications.delete(notification);
    return true;
  };

  notification.onClick(() => {
    if (!settle()) return;
    if (!deps.isMainWindowAlive()) return;
    if (deps.resolveActiveSessionKey(senderId) !== sessionKey) return;
    deps.showMainWindow();
    deps.focusMainWindow();
    deps.sendNavigate(senderId, sessionKey, payload.navigationTarget);
  });
  notification.onClose(() => {
    settle();
  });
  notification.onFailed((error) => {
    if (!settle()) return;
    deps.logNativeFailure(redactNativeError(error));
  });

  try {
    pendingNotifications.add(notification);
    notification.show();
  } catch {
    settle();
    return { ok: false, reason: "show-failed" };
  }
  return { ok: true };
}
