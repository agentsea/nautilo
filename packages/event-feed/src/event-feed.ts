import {
  eventFeedRecordInputSchema,
  type EventFeedListOptions,
  type EventFeedMarkAllReadResult,
  type EventFeedPage,
  type EventFeedReadMutationResult,
  type EventFeedRecordInput,
} from "@nautilo/types";

export type NormalizedEventFeedRecordInput = EventFeedRecordInput;

export type EventFeedStorageRecordResult =
  | Readonly<{ status: "stored"; eventId: string }>
  | Readonly<{ status: "duplicate"; eventId: string }>
  | Readonly<{ status: "conflict" }>;

export interface EventFeedStorage {
  record(input: NormalizedEventFeedRecordInput): Promise<EventFeedStorageRecordResult>;
  list(userId: string, options: EventFeedListOptions): Promise<EventFeedPage>;
  countUnread(userId: string): Promise<number>;
  setRead(userId: string, eventId: string, read: boolean): Promise<EventFeedReadMutationResult>;
  markAllRead(userId: string): Promise<EventFeedMarkAllReadResult>;
}

export type EventFeedRecordResult =
  | Readonly<{ status: "stored"; eventId: string }>
  | Readonly<{ status: "duplicate"; eventId: string }>
  | Readonly<{ status: "skipped"; code: "empty_audience" }>
  | Readonly<{
      status: "failed";
      code: "invalid_input" | "conflicting_key" | "storage_failed";
    }>;

export interface EventFeedChangedHint {
  readonly userIds: readonly string[];
}

export interface EventFeedWarning {
  readonly operation: "record" | "hint";
  readonly code:
    | "invalid_input"
    | "conflicting_key"
    | "storage_failed"
    | "hint_failed";
}

export interface CreateEventFeedOptions {
  readonly storage: EventFeedStorage;
  readonly onChanged?: (hint: EventFeedChangedHint) => void | Promise<void>;
  readonly warn?: (warning: EventFeedWarning) => void;
}

export interface EventFeed {
  recordBestEffort(input: EventFeedRecordInput): Promise<EventFeedRecordResult>;
  list(userId: string, options?: EventFeedListOptions): Promise<EventFeedPage>;
  countUnread(userId: string): Promise<number>;
  setRead(userId: string, eventId: string, read: boolean): Promise<EventFeedReadMutationResult>;
  markAllRead(userId: string): Promise<EventFeedMarkAllReadResult>;
}

function reportWarning(
  warn: CreateEventFeedOptions["warn"],
  warning: EventFeedWarning,
): void {
  try {
    warn?.(warning);
  } catch {
    // Diagnostics are observational and cannot affect feed outcomes.
  }
}

async function emitChangedBestEffort(
  options: CreateEventFeedOptions,
  userIds: readonly string[],
): Promise<void> {
  if (!options.onChanged || userIds.length === 0) return;
  try {
    await options.onChanged({ userIds });
  } catch {
    reportWarning(options.warn, { operation: "hint", code: "hint_failed" });
  }
}

export function createEventFeed(options: CreateEventFeedOptions): EventFeed {
  return {
    async recordBestEffort(input) {
      let parsed: ReturnType<typeof eventFeedRecordInputSchema.safeParse>;
      try {
        parsed = eventFeedRecordInputSchema.safeParse(input);
      } catch {
        reportWarning(options.warn, { operation: "record", code: "invalid_input" });
        return { status: "failed", code: "invalid_input" };
      }
      if (!parsed.success) {
        reportWarning(options.warn, { operation: "record", code: "invalid_input" });
        return { status: "failed", code: "invalid_input" };
      }

      const recipientUserIds = [...new Set(parsed.data.recipientUserIds)];
      if (recipientUserIds.length === 0) {
        return { status: "skipped", code: "empty_audience" };
      }

      const normalized = { ...parsed.data, recipientUserIds } as NormalizedEventFeedRecordInput;
      try {
        const result = await options.storage.record(normalized);
        if (result.status === "conflict") {
          reportWarning(options.warn, { operation: "record", code: "conflicting_key" });
          return { status: "failed", code: "conflicting_key" };
        }
        if (result.status === "stored") {
          await emitChangedBestEffort(options, recipientUserIds);
        }
        return result;
      } catch {
        reportWarning(options.warn, { operation: "record", code: "storage_failed" });
        return { status: "failed", code: "storage_failed" };
      }
    },

    async list(userId, listOptions = {}) {
      return options.storage.list(userId, listOptions);
    },

    countUnread(userId) {
      return options.storage.countUnread(userId);
    },

    async setRead(userId, eventId, read) {
      const result = await options.storage.setRead(userId, eventId, read);
      if (result.changed) await emitChangedBestEffort(options, [userId]);
      return result;
    },

    async markAllRead(userId) {
      const result = await options.storage.markAllRead(userId);
      if (result.updatedCount > 0) await emitChangedBestEffort(options, [userId]);
      return result;
    },
  };
}
