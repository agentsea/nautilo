/**
 * M240 — content-free cross-server notification summaries.
 *
 * Renderer clocks are diagnostic only. Electron main stamps `receivedAtMs`
 * from its injected monotonic clock and owns freshness + aggregation.
 */

export const NOTIFICATION_SUMMARY_FRESH_MS = 120_000;
const MAX_EPOCH_LENGTH = 200;

export type NotificationSummaryInput = {
  epoch: unknown;
  generation: unknown;
  generatedAt: unknown;
  unreadCount: unknown;
  importantUnreadCount: unknown;
};

export interface ValidatedNotificationSummary {
  epoch: string;
  generation: number;
  generatedAt: string;
  unreadCount: number;
  importantUnreadCount: number;
}

export interface StoredNotificationSummary extends ValidatedNotificationSummary {
  receivedAtMs: number;
}

export type PublicNotificationSummary =
  | {
      state: "fresh" | "stale";
      unreadCount: number;
      importantUnreadCount: number;
    }
  | { state: "unknown" };

export interface NotificationAggregate {
  unreadCount: number;
  importantUnreadCount: number;
  unavailableServerCount: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

const SUMMARY_KEYS = new Set([
  "epoch",
  "generation",
  "generatedAt",
  "unreadCount",
  "importantUnreadCount",
]);

export function validateNotificationSummaryInput(
  input: NotificationSummaryInput,
): ValidatedNotificationSummary | null {
  if (
    !isPlainObject(input) ||
    Object.keys(input).length !== SUMMARY_KEYS.size ||
    Object.keys(input).some((key) => !SUMMARY_KEYS.has(key))
  ) {
    return null;
  }

  if (typeof input.epoch !== "string") return null;
  const epoch = input.epoch.trim();
  if (
    epoch.length === 0 ||
    epoch.length > MAX_EPOCH_LENGTH ||
    containsControlCharacter(epoch)
  ) {
    return null;
  }
  if (
    typeof input.generation !== "number" ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1
  ) {
    return null;
  }
  if (
    typeof input.generatedAt !== "string" ||
    input.generatedAt.length === 0 ||
    !Number.isFinite(Date.parse(input.generatedAt))
  ) {
    return null;
  }
  if (
    !isSafeCount(input.unreadCount) ||
    !isSafeCount(input.importantUnreadCount) ||
    input.importantUnreadCount > input.unreadCount
  ) {
    return null;
  }

  return {
    epoch,
    generation: input.generation,
    generatedAt: input.generatedAt,
    unreadCount: input.unreadCount,
    importantUnreadCount: input.importantUnreadCount,
  };
}

export function isSummaryFresh(
  summary: StoredNotificationSummary,
  nowMs: number,
): boolean {
  return nowMs >= summary.receivedAtMs &&
    nowMs - summary.receivedAtMs < NOTIFICATION_SUMMARY_FRESH_MS;
}

export function publicSummaryState(input: {
  summary: StoredNotificationSummary | null;
  eligible: boolean;
  nowMs: number;
}): PublicNotificationSummary {
  if (!input.summary) return { state: "unknown" };
  return {
    state:
      input.eligible && isSummaryFresh(input.summary, input.nowMs)
        ? "fresh"
        : "stale",
    unreadCount: input.summary.unreadCount,
    importantUnreadCount: input.summary.importantUnreadCount,
  };
}

export function saturatingAdd(a: number, b: number): number {
  if (a >= Number.MAX_SAFE_INTEGER - b) return Number.MAX_SAFE_INTEGER;
  return a + b;
}

export function aggregatePublicSummaries(
  summaries: readonly PublicNotificationSummary[],
): NotificationAggregate {
  let unreadCount = 0;
  let importantUnreadCount = 0;
  let unavailableServerCount = 0;
  for (const summary of summaries) {
    if (summary.state !== "fresh") {
      unavailableServerCount += 1;
      continue;
    }
    unreadCount = saturatingAdd(unreadCount, summary.unreadCount);
    importantUnreadCount = saturatingAdd(
      importantUnreadCount,
      summary.importantUnreadCount,
    );
  }
  return { unreadCount, importantUnreadCount, unavailableServerCount };
}
