/**
 * D530 timing seam for the part of initial Room hydration controlled by the
 * Workbench. This intentionally records only a monotonic generation and
 * elapsed durations: it has no room, viewer, origin, token, message, or
 * response-payload inputs, and it never emits telemetry by itself.
 */

export interface RoomHydrationClock {
  now(): number;
}

export type RoomHydrationTimingState =
  | "selected"
  | "token_ready"
  | "history_response"
  | "committed"
  | "failed"
  | "superseded";

export type RoomHydrationTimingRejection =
  | "out_of_order"
  | "terminal"
  | "superseded";

export interface RoomHydrationDurations {
  /** Time from selecting a Room until the access token is available. */
  readonly selectionToTokenReady?: number;
  /** Time after the token is available until the history response arrives. */
  readonly tokenReadyToHistoryResponse?: number;
  /** End-to-end time from Room selection until the history response arrives. */
  readonly selectionToHistoryResponse?: number;
  /** Renderer/reconciliation time after the history response is available. */
  readonly historyResponseToTranscriptCommit?: number;
  /** End-to-end time from Room selection until the transcript is committed. */
  readonly selectionToTranscriptCommit?: number;
}

/** A serializable, payload-free observation suitable for an external reporter. */
export interface RoomHydrationTimingSnapshot {
  /** Monotonic runtime hydration generation, never a Room identifier. */
  readonly generation: number;
  readonly state: RoomHydrationTimingState;
  readonly durations: RoomHydrationDurations;
}

export type RoomHydrationTimingMark =
  | { readonly accepted: true; readonly snapshot: RoomHydrationTimingSnapshot }
  | {
      readonly accepted: false;
      readonly reason: RoomHydrationTimingRejection;
      readonly snapshot: RoomHydrationTimingSnapshot;
    };

export interface RoomHydrationTimingAttempt {
  /** Marks the completion of the runtime's `getAccessToken()` await. */
  tokenReady(): RoomHydrationTimingMark;
  /** Marks receipt of the hydrated history response, before transcript commit. */
  historyResponse(): RoomHydrationTimingMark;
  /** Marks the runtime's authoritative transcript commit. */
  transcriptCommitted(): RoomHydrationTimingMark;
  /** Marks a recoverable or terminal hydration failure without an error payload. */
  failed(): RoomHydrationTimingMark;
  /** Marks this generation as superseded by a newer Room selection. */
  superseded(): RoomHydrationTimingMark;
  snapshot(): RoomHydrationTimingSnapshot;
}

export interface RoomHydrationTiming {
  /**
   * Starts a selected Room generation. Starting a newer generation
   * supersedes the prior attempt, so late callbacks cannot alter its trace.
   */
  start(generation: number): RoomHydrationTimingAttempt;
  current(): RoomHydrationTimingSnapshot | null;
}

interface AttemptRecord {
  readonly generation: number;
  state: RoomHydrationTimingState;
  readonly selectedAt: number;
  tokenReadyAt?: number;
  historyResponseAt?: number;
  transcriptCommittedAt?: number;
}

const defaultClock: RoomHydrationClock = {
  now: () => performance.now(),
};

function durationSince(start: number, end: number): number {
  // A browser's performance clock should be monotonic. Clamp defensively so a
  // custom development clock cannot yield a misleading negative duration.
  return Math.max(0, end - start);
}

function snapshotOf(record: AttemptRecord): RoomHydrationTimingSnapshot {
  const durations: RoomHydrationDurations = {
    ...(record.tokenReadyAt === undefined
      ? {}
      : { selectionToTokenReady: durationSince(record.selectedAt, record.tokenReadyAt) }),
    ...(record.tokenReadyAt === undefined || record.historyResponseAt === undefined
      ? {}
      : {
          tokenReadyToHistoryResponse: durationSince(
            record.tokenReadyAt,
            record.historyResponseAt,
          ),
          selectionToHistoryResponse: durationSince(
            record.selectedAt,
            record.historyResponseAt,
          ),
        }),
    ...(record.historyResponseAt === undefined || record.transcriptCommittedAt === undefined
      ? {}
      : {
          historyResponseToTranscriptCommit: durationSince(
            record.historyResponseAt,
            record.transcriptCommittedAt,
          ),
          selectionToTranscriptCommit: durationSince(
            record.selectedAt,
            record.transcriptCommittedAt,
          ),
        }),
  };

  return Object.freeze({
    generation: record.generation,
    state: record.state,
    durations: Object.freeze(durations),
  });
}

function isTerminal(state: RoomHydrationTimingState): boolean {
  return state === "committed" || state === "failed" || state === "superseded";
}

/**
 * Creates an injectable-clock, in-memory timing seam. Callers may forward the
 * resulting snapshots to their own development/test reporting path, but this
 * helper deliberately does not retain a trace history or perform logging.
 */
export function createRoomHydrationTiming(
  clock: RoomHydrationClock = defaultClock,
): RoomHydrationTiming {
  let currentRecord: AttemptRecord | null = null;

  const isCurrent = (record: AttemptRecord): boolean => currentRecord === record;

  const reject = (
    record: AttemptRecord,
    reason: RoomHydrationTimingRejection,
  ): RoomHydrationTimingMark => ({ accepted: false, reason, snapshot: snapshotOf(record) });

  const inactiveReason = (record: AttemptRecord): RoomHydrationTimingRejection => {
    if (record.state === "superseded" || !isCurrent(record)) return "superseded";
    return "terminal";
  };

  const mark = (
    record: AttemptRecord,
    expected: RoomHydrationTimingState,
    next: RoomHydrationTimingState,
    assignTime?: (at: number) => void,
  ): RoomHydrationTimingMark => {
    if (!isCurrent(record) || isTerminal(record.state)) {
      return reject(record, inactiveReason(record));
    }
    if (record.state !== expected) return reject(record, "out_of_order");
    assignTime?.(clock.now());
    record.state = next;
    return { accepted: true, snapshot: snapshotOf(record) };
  };

  const attemptFor = (record: AttemptRecord): RoomHydrationTimingAttempt => ({
    tokenReady: () =>
      mark(record, "selected", "token_ready", (at) => {
        record.tokenReadyAt = at;
      }),
    historyResponse: () =>
      mark(record, "token_ready", "history_response", (at) => {
        record.historyResponseAt = at;
      }),
    transcriptCommitted: () =>
      mark(record, "history_response", "committed", (at) => {
        record.transcriptCommittedAt = at;
      }),
    failed: () => {
      if (!isCurrent(record) || isTerminal(record.state)) {
        return reject(record, inactiveReason(record));
      }
      record.state = "failed";
      return { accepted: true, snapshot: snapshotOf(record) };
    },
    superseded: () => {
      if (!isCurrent(record) || isTerminal(record.state)) {
        return reject(record, inactiveReason(record));
      }
      record.state = "superseded";
      if (currentRecord === record) currentRecord = null;
      return { accepted: true, snapshot: snapshotOf(record) };
    },
    snapshot: () => snapshotOf(record),
  });

  return {
    start(generation) {
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new RangeError("Room hydration generation must be a non-negative safe integer");
      }
      if (currentRecord && generation <= currentRecord.generation) {
        throw new RangeError("Room hydration generations must increase monotonically");
      }
      if (currentRecord && !isTerminal(currentRecord.state)) {
        currentRecord.state = "superseded";
      }
      const record: AttemptRecord = {
        generation,
        state: "selected",
        selectedAt: clock.now(),
      };
      currentRecord = record;
      return attemptFor(record);
    },
    current: () => (currentRecord ? snapshotOf(currentRecord) : null),
  };
}

/**
 * Read-only instrumentation map for `GET /api/rooms/:id/messages`.
 * These boundaries are server-owned, so D530's client seam can only observe
 * their aggregate time between token readiness and history response.
 */
export const ROOM_HYDRATION_SERVER_LATENCY_MAP = Object.freeze([
  Object.freeze({
    phase: "membership_admission",
    endpoint: "/api/rooms/:id/messages",
    source: "packages/server/src/routes/sessions.ts",
    boundary: "getRoomDetailForMember(roomIdParam, sessionActorId)",
  }),
  Object.freeze({
    phase: "message_page_query",
    endpoint: "/api/rooms/:id/messages",
    source: "packages/server/src/routes/sessions.ts",
    boundary: "getRoomMessagesAcrossMemberSessions",
  }),
  Object.freeze({
    phase: "reaction_enrichment",
    endpoint: "/api/rooms/:id/messages",
    source: "packages/server/src/routes/sessions.ts",
    boundary: "safeReactionsForMessages(messages, sessionUserId)",
  }),
  Object.freeze({
    phase: "artifact_enrichment",
    endpoint: "/api/rooms/:id/messages",
    source: "packages/server/src/routes/sessions.ts",
    boundary: "safeArtifactsForMessages(messages, roomIdParam)",
  }),
  Object.freeze({
    phase: "response_completion",
    endpoint: "/api/rooms/:id/messages",
    source: "packages/server/src/routes/sessions.ts",
    boundary: "messages.map(...) response projection through reply.send(...) completion",
  }),
] as const);
