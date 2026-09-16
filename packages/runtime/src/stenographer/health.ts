import {
  STENOGRAPHER_HEALTH_DEGRADED_FAILURES,
  STENOGRAPHER_HEALTH_DEGRADED_OVERDUE_MS,
  STENOGRAPHER_HEALTH_GRACE_MS,
} from "./constants";

export type ExtractionRoomCategory =
  | "processing"
  | "retrying"
  | "caught_up"
  | "accumulating"
  | "due";

export interface ExtractionRoomHealthInput {
  now: Date;
  leaseExpiresAt: Date | null;
  retryAfter: Date | null;
  failureCount: number;
  hasEligibleSourceRows: boolean;
  dueAt: Date | null;
}

export interface ExtractionRoomHealth {
  category: ExtractionRoomCategory;
  staleLease: boolean;
  unprotectedOverdueMs: number;
  failureCount: number;
}

function isFuture(value: Date | null, nowMs: number): boolean {
  return value !== null && value.getTime() > nowMs;
}

export function classifyExtractionRoomHealth(
  input: ExtractionRoomHealthInput,
): ExtractionRoomHealth {
  const nowMs = input.now.getTime();
  const processing = isFuture(input.leaseExpiresAt, nowMs);
  const staleLease =
    input.leaseExpiresAt !== null && input.leaseExpiresAt.getTime() <= nowMs;
  const retrying = input.failureCount > 0 && isFuture(input.retryAfter, nowMs);

  let category: ExtractionRoomCategory;
  if (processing) category = "processing";
  else if (retrying) category = "retrying";
  else if (!input.hasEligibleSourceRows) category = "caught_up";
  else if (input.dueAt === null || input.dueAt.getTime() > nowMs) {
    category = "accumulating";
  } else {
    category = "due";
  }

  const unprotectedOverdueMs =
    category === "due" && input.dueAt !== null
      ? Math.max(0, nowMs - input.dueAt.getTime())
      : 0;
  return {
    category,
    staleLease,
    unprotectedOverdueMs,
    failureCount: input.failureCount,
  };
}

export type CompactionRoomCategory =
  | "idle"
  | "processing"
  | "retrying"
  | "awaiting";

export interface CompactionRoomHealthInput {
  now: Date;
  dueAt: Date | null;
  leaseExpiresAt: Date | null;
  retryAfter: Date | null;
  failureCount: number;
}

export interface CompactionRoomHealth {
  category: CompactionRoomCategory;
  staleLease: boolean;
  unprotectedOverdueMs: number;
  failureCount: number;
}

export function classifyCompactionRoomHealth(
  input: CompactionRoomHealthInput,
): CompactionRoomHealth {
  const nowMs = input.now.getTime();
  const processing = isFuture(input.leaseExpiresAt, nowMs);
  const staleLease =
    input.leaseExpiresAt !== null && input.leaseExpiresAt.getTime() <= nowMs;
  const retrying = input.failureCount > 0 && isFuture(input.retryAfter, nowMs);

  let category: CompactionRoomCategory;
  if (processing) category = "processing";
  else if (retrying) category = "retrying";
  else if (input.dueAt !== null) category = "awaiting";
  else category = "idle";

  const unprotectedOverdueMs =
    category === "awaiting" && input.dueAt !== null
      ? Math.max(0, nowMs - input.dueAt.getTime())
      : 0;
  return {
    category,
    staleLease,
    unprotectedOverdueMs,
    failureCount: input.failureCount,
  };
}

export type JournalHealthClassification = "healthy" | "delayed" | "degraded";

export interface JournalHealthSignals {
  extraction: {
    retryingRooms: number;
    staleLeases: number;
    oldestUnprotectedOverdueMs: number;
    maximumFailureCount: number;
  };
  compaction: {
    retryingRooms: number;
    staleLeases: number;
    oldestUnprotectedOverdueMs: number;
    maximumFailureCount: number;
  };
}

export function classifyStenographerHealth(
  signals: JournalHealthSignals,
): JournalHealthClassification {
  const stages = [signals.extraction, signals.compaction];
  if (
    stages.some(
      (stage) =>
        stage.staleLeases > 0 ||
        stage.maximumFailureCount >=
          STENOGRAPHER_HEALTH_DEGRADED_FAILURES ||
        stage.oldestUnprotectedOverdueMs >=
          STENOGRAPHER_HEALTH_DEGRADED_OVERDUE_MS,
    )
  ) {
    return "degraded";
  }
  if (
    stages.some(
      (stage) =>
        stage.retryingRooms > 0 ||
        stage.oldestUnprotectedOverdueMs >= STENOGRAPHER_HEALTH_GRACE_MS,
    )
  ) {
    return "delayed";
  }
  return "healthy";
}

export interface ExtractionCategoryCounts {
  eligibleRooms: number;
  caughtUpRooms: number;
  accumulatingRooms: number;
  processingRooms: number;
  retryingRooms: number;
  dueRooms: number;
  staleLeases: number;
  oldestUnprotectedOverdueMs: number;
  maximumFailureCount: number;
}

export function aggregateExtractionRoomHealth(
  rooms: readonly ExtractionRoomHealth[],
): ExtractionCategoryCounts {
  const count = (category: ExtractionRoomCategory): number =>
    rooms.filter((room) => room.category === category).length;
  return {
    eligibleRooms: rooms.length,
    caughtUpRooms: count("caught_up"),
    accumulatingRooms: count("accumulating"),
    processingRooms: count("processing"),
    retryingRooms: count("retrying"),
    dueRooms: count("due"),
    staleLeases: rooms.filter((room) => room.staleLease).length,
    oldestUnprotectedOverdueMs: rooms.reduce(
      (oldest, room) => Math.max(oldest, room.unprotectedOverdueMs),
      0,
    ),
    maximumFailureCount: rooms.reduce(
      (maximum, room) => Math.max(maximum, room.failureCount),
      0,
    ),
  };
}

export interface CompactionCategoryCounts {
  awaitingRooms: number;
  processingRooms: number;
  retryingRooms: number;
  staleLeases: number;
  oldestUnprotectedOverdueMs: number;
  maximumFailureCount: number;
}

export function aggregateCompactionRoomHealth(
  rooms: readonly CompactionRoomHealth[],
): CompactionCategoryCounts {
  return {
    awaitingRooms: rooms.filter((room) => room.category === "awaiting").length,
    processingRooms: rooms.filter((room) => room.category === "processing")
      .length,
    retryingRooms: rooms.filter((room) => room.category === "retrying").length,
    staleLeases: rooms.filter((room) => room.staleLease).length,
    oldestUnprotectedOverdueMs: rooms.reduce(
      (oldest, room) => Math.max(oldest, room.unprotectedOverdueMs),
      0,
    ),
    maximumFailureCount: rooms.reduce(
      (maximum, room) => Math.max(maximum, room.failureCount),
      0,
    ),
  };
}
