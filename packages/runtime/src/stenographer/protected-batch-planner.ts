import { createHash } from "node:crypto";

import {
  STENOGRAPHER_MESSAGE_TRIGGER,
  STENOGRAPHER_SILENCE_MS,
} from "./constants";

export const PROTECTED_STENOGRAPHER_MAX_INPUT_OBJECTS = 256;

export type ProtectedStenographerSourceRole =
  | "user"
  | "assistant"
  | "tool"
  | "system";

/**
 * Content-free projection used to decide whether a batch may be requested.
 * `keyClass` and completion are taken from the current immutable message
 * revision, never inferred from plaintext or authorship.
 */
export interface ProtectedStenographerSourceMetadata {
  readonly messageId: number;
  readonly editRevision: number;
  readonly createdAt: Date;
  readonly role: ProtectedStenographerSourceRole;
  readonly fingerprint: string | null;
  readonly transcriptOrigin: "main" | "subagent";
  readonly originatedBy: string | null;
  readonly excludedFromEvidence: boolean;
  readonly keyClass: "ai" | "human" | null;
  readonly cryptoObjectId: string | null;
  readonly cryptoCompletion: "pending" | "complete" | null;
}

export interface ProtectedStenographerSourceObject {
  readonly messageId: number;
  readonly editRevision: number;
  readonly createdAt: Date;
  readonly role: ProtectedStenographerSourceRole;
  readonly fingerprint: string | null;
  readonly cryptoObjectId: string;
  readonly potentialConversationalBoundary: boolean;
}

export interface ProtectedStenographerBatchPlan {
  readonly fromMessageIdExclusive: number;
  readonly throughMessageIdInclusive: number;
  readonly trigger: "count" | "silence" | "skip_excluded";
  readonly coveredMessageIds: readonly number[];
  readonly sourceObjects: readonly ProtectedStenographerSourceObject[];
  readonly inputObjectIds: readonly string[];
  readonly potentialConversationalMessageCount: number;
  readonly requiresContentRecheck: boolean;
  readonly newestEligibleSourceAt: Date | null;
  readonly sourceFingerprint: Uint8Array;
}

export type ProtectedStenographerBatchPlanningResult =
  | Readonly<{
    readonly status: "authorize";
    readonly plan: ProtectedStenographerBatchPlan;
  }>
  | Readonly<{
    readonly status: "skip_excluded";
    readonly plan: ProtectedStenographerBatchPlan;
  }>
  | Readonly<{
    readonly status: "wait";
    readonly reason: "no_pending" | "not_due";
  }>
  | Readonly<{
    readonly status: "blocked";
    readonly reason: "protected_source_unavailable";
    readonly messageIds: readonly number[];
  }>;

export interface PlanProtectedStenographerBatchInput {
  readonly cursorMessageId: number;
  readonly fixedUpperBoundMessageId: number;
  readonly rows: readonly ProtectedStenographerSourceMetadata[];
  readonly now: Date;
  readonly fingerprintsAtOrBeforeCursor?: ReadonlySet<string>;
  readonly retryFixedRange?: boolean;
}

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

function safeCounter(label: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function portableNullable(
  label: string,
  value: unknown,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || !PORTABLE_ID.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
  return value;
}

function validateRow(
  row: ProtectedStenographerSourceMetadata,
): void {
  safeCounter("Protected source message id", row.messageId);
  if (row.messageId < 1) {
    throw new RangeError("Protected source message id must be positive");
  }
  safeCounter("Protected source edit revision", row.editRevision);
  if (!(row.createdAt instanceof Date) || !Number.isFinite(
    row.createdAt.getTime(),
  )) {
    throw new TypeError("Protected source timestamp is invalid");
  }
  if (
    row.role !== "user"
    && row.role !== "assistant"
    && row.role !== "tool"
    && row.role !== "system"
  ) {
    throw new TypeError("Protected source role is invalid");
  }
  portableNullable("Protected source fingerprint", row.fingerprint);
  portableNullable("Protected source origin", row.originatedBy);
  if (
    row.transcriptOrigin !== "main"
    && row.transcriptOrigin !== "subagent"
  ) {
    throw new TypeError("Protected transcript origin is invalid");
  }
  if (typeof row.excludedFromEvidence !== "boolean") {
    throw new TypeError("Protected source exclusion is invalid");
  }
  if (
    row.keyClass !== null
    && row.keyClass !== "ai"
    && row.keyClass !== "human"
  ) {
    throw new TypeError("Protected source key class is invalid");
  }
  portableNullable("Protected source object id", row.cryptoObjectId);
  if (
    row.cryptoCompletion !== null
    && row.cryptoCompletion !== "pending"
    && row.cryptoCompletion !== "complete"
  ) {
    throw new TypeError("Protected source completion is invalid");
  }
}

function policyEligible(
  row: ProtectedStenographerSourceMetadata,
): boolean {
  return row.transcriptOrigin === "main"
    && row.originatedBy !== "task"
    && row.originatedBy !== "connected_web_operation"
    && !row.excludedFromEvidence
    && row.keyClass !== "human";
}

function potentialConversation(
  row: ProtectedStenographerSourceMetadata,
): boolean {
  return policyEligible(row)
    && (row.role === "user" || row.role === "assistant");
}

export function fingerprintProtectedStenographerCoveredRange(
  input: Readonly<{
    fromMessageIdExclusive: number;
    throughMessageIdInclusive: number;
    rows: readonly ProtectedStenographerSourceMetadata[];
  }>,
): Uint8Array {
  const fromMessageIdExclusive = safeCounter(
    "Protected covered-range lower bound",
    input.fromMessageIdExclusive,
  );
  const throughMessageIdInclusive = safeCounter(
    "Protected covered-range upper bound",
    input.throughMessageIdInclusive,
  );
  const rows: readonly ProtectedStenographerSourceMetadata[] = input.rows;
  const runtimeRows: unknown = input.rows;
  if (
    throughMessageIdInclusive < fromMessageIdExclusive
    || !Array.isArray(runtimeRows)
    || rows.length > PROTECTED_STENOGRAPHER_MAX_INPUT_OBJECTS
  ) {
    throw new RangeError("Protected covered-range inventory is out of range");
  }
  for (const [index, row] of rows.entries()) {
    validateRow(row);
    if (
      row.messageId <= fromMessageIdExclusive
      || row.messageId > throughMessageIdInclusive
    ) {
      throw new RangeError(
        "Protected covered-range message is outside its range",
      );
    }
    if (index > 0 && row.messageId <= rows[index - 1]!.messageId) {
      throw new TypeError(
        row.messageId === rows[index - 1]!.messageId
          ? "Protected covered-range message identities must be unique"
          : "Protected covered-range messages must be ordered",
      );
    }
  }
  const canonical = JSON.stringify([
    "nautilo/stenographer/protected-source-fingerprint/v1",
    fromMessageIdExclusive,
    throughMessageIdInclusive,
    rows.map((row) => [
      row.messageId,
      row.editRevision,
      row.createdAt.getTime(),
      row.role,
      row.fingerprint,
      row.transcriptOrigin,
      row.originatedBy,
      row.excludedFromEvidence,
      row.keyClass,
      row.cryptoObjectId,
      row.cryptoCompletion,
    ]),
  ]);
  return Uint8Array.from(
    createHash("sha256").update(canonical, "utf8").digest(),
  );
}

function frozenPlan(
  input: Readonly<{
    cursor: number;
    through: number;
    trigger: ProtectedStenographerBatchPlan["trigger"];
    covered: readonly ProtectedStenographerSourceMetadata[];
    potentialById: ReadonlyMap<number, boolean>;
  }>,
): ProtectedStenographerBatchPlan {
  const sourceObjects = input.covered
    .filter((row) => policyEligible(row))
    .map((row) =>
      Object.freeze({
        messageId: row.messageId,
        editRevision: row.editRevision,
        createdAt: new Date(row.createdAt),
        role: row.role,
        fingerprint: row.fingerprint,
        cryptoObjectId: row.cryptoObjectId!,
        potentialConversationalBoundary:
          input.potentialById.get(row.messageId) === true,
      })
    );
  const inputObjectIds = sourceObjects.map((row) => row.cryptoObjectId);
  if (new Set(inputObjectIds).size !== inputObjectIds.length) {
    throw new TypeError(
      "Protected Stenographer source contains a duplicate object identity",
    );
  }
  const newest = sourceObjects.reduce<Date | null>(
    (latest, row) =>
      latest === null || row.createdAt.getTime() > latest.getTime()
        ? row.createdAt
        : latest,
    null,
  );
  return Object.freeze({
    fromMessageIdExclusive: input.cursor,
    throughMessageIdInclusive: input.through,
    trigger: input.trigger,
    coveredMessageIds: Object.freeze(
      input.covered.map((row) => row.messageId),
    ),
    sourceObjects: Object.freeze(sourceObjects),
    inputObjectIds: Object.freeze(inputObjectIds),
    potentialConversationalMessageCount: sourceObjects.filter(
      (row) => row.potentialConversationalBoundary,
    ).length,
    requiresContentRecheck: sourceObjects.some(
      (row) => row.role === "assistant",
    ),
    newestEligibleSourceAt: newest === null ? null : new Date(newest),
    sourceFingerprint: fingerprintProtectedStenographerCoveredRange({
      fromMessageIdExclusive: input.cursor,
      throughMessageIdInclusive: input.through,
      rows: input.covered,
    }),
  });
}

/**
 * Plans only from product metadata and current crypto mappings. It cannot
 * inspect message bodies, participant labels, journal statements, or rollups.
 */
export function planProtectedStenographerBatch(
  input: PlanProtectedStenographerBatchInput,
): ProtectedStenographerBatchPlanningResult {
  const cursor = safeCounter(
    "Protected Stenographer cursor",
    input.cursorMessageId,
  );
  const fixedUpper = safeCounter(
    "Protected Stenographer upper bound",
    input.fixedUpperBoundMessageId,
  );
  if (fixedUpper < cursor) {
    throw new RangeError(
      "Protected Stenographer upper bound precedes the cursor",
    );
  }
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new TypeError("Protected Stenographer clock is invalid");
  }
  for (const row of input.rows) validateRow(row);
  const ordered = input.rows
    .filter((row) =>
      row.messageId > cursor && row.messageId <= fixedUpper
    )
    .sort((left, right) => left.messageId - right.messageId);
  if (
    ordered.some((row, index) =>
      index > 0 && ordered[index - 1]!.messageId === row.messageId
    )
  ) {
    throw new TypeError(
      "Protected Stenographer source contains a duplicate message id",
    );
  }
  const pending = ordered.slice(
    0,
    PROTECTED_STENOGRAPHER_MAX_INPUT_OBJECTS,
  );
  if (pending.length === 0) {
    if (!input.retryFixedRange) {
      return Object.freeze({ status: "wait", reason: "no_pending" });
    }
    const plan = frozenPlan({
      cursor,
      through: fixedUpper,
      trigger: "skip_excluded",
      covered: [],
      potentialById: new Map(),
    });
    return Object.freeze({ status: "skip_excluded", plan });
  }

  const seenFingerprints = new Set(
    input.fingerprintsAtOrBeforeCursor ?? [],
  );
  const potentialById = new Map<number, boolean>();
  for (const row of pending) {
    let potential = potentialConversation(row);
    if (
      policyEligible(row)
      && row.role === "user"
      && row.fingerprint !== null
    ) {
      if (seenFingerprints.has(row.fingerprint)) {
        potential = false;
      } else {
        seenFingerprints.add(row.fingerprint);
      }
    }
    potentialById.set(row.messageId, potential);
  }

  const potentialRows = pending.filter(
    (row) => potentialById.get(row.messageId) === true,
  );
  let through: number;
  let trigger: ProtectedStenographerBatchPlan["trigger"];
  if (input.retryFixedRange) {
    through = fixedUpper;
    trigger = pending.some(policyEligible)
      ? potentialRows.length >= STENOGRAPHER_MESSAGE_TRIGGER
        ? "count"
        : "silence"
      : "skip_excluded";
  } else if (potentialRows.length >= STENOGRAPHER_MESSAGE_TRIGGER) {
    through =
      potentialRows[STENOGRAPHER_MESSAGE_TRIGGER - 1]!.messageId;
    trigger = "count";
  } else if (potentialRows.length > 0) {
    const newestEligible = pending
      .filter(policyEligible)
      .reduce<Date | null>(
        (latest, row) =>
          latest === null
              || row.createdAt.getTime() > latest.getTime()
            ? row.createdAt
            : latest,
        null,
      );
    if (
      newestEligible === null
      || input.now.getTime() - newestEligible.getTime()
        < STENOGRAPHER_SILENCE_MS
    ) {
      return Object.freeze({ status: "wait", reason: "not_due" });
    }
    through = pending.at(-1)!.messageId;
    trigger = "silence";
  } else {
    through = pending.at(-1)!.messageId;
    trigger = "skip_excluded";
  }

  const covered = pending.filter((row) => row.messageId <= through);
  const unavailable = covered
    .filter(policyEligible)
    .filter((row) =>
      row.keyClass !== "ai"
      || row.cryptoCompletion !== "complete"
      || row.cryptoObjectId === null
    )
    .map((row) => row.messageId);
  if (unavailable.length > 0) {
    return Object.freeze({
      status: "blocked",
      reason: "protected_source_unavailable",
      messageIds: Object.freeze(unavailable),
    });
  }
  const plan = frozenPlan({
    cursor,
    through,
    trigger,
    covered,
    potentialById,
  });
  return trigger === "skip_excluded"
    ? Object.freeze({ status: "skip_excluded", plan })
    : Object.freeze({ status: "authorize", plan });
}
