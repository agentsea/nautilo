import {
  STENOGRAPHER_MESSAGE_TRIGGER,
  STENOGRAPHER_SILENCE_MS,
} from "./constants";

export type StenographerSourceRole =
  | "user"
  | "assistant"
  | "tool"
  | "system";

export interface StenographerSourceRow {
  id: number;
  createdAt: Date;
  role: StenographerSourceRole;
  text: string;
  fingerprint?: string | null;
  /**
   * False for system/task-hidden/subagent-origin rows. Such rows are covered
   * by the cursor range, but are not model evidence.
   */
  eligibleSource?: boolean;
  /**
   * True for rows falling in a Room-wide or per-agent deaf interval. These are
   * covered without being supplied to the shared Stenographer.
   */
  excludedFromEvidence?: boolean;
}

export interface PlanStenographerBatchInput {
  cursorMessageId: number;
  fixedUpperBoundMessageId: number;
  rows: readonly StenographerSourceRow[];
  now: Date;
  fingerprintsAtOrBeforeCursor?: ReadonlySet<string>;
  /**
   * Reuses a previously claimed range after failure. Missing rows inside the
   * range are tombstones: they are not evidence, but the successful retry
   * still advances through the original fixed upper bound.
   */
  retryFixedRange?: boolean;
}

export type StenographerBatchTrigger = "count" | "silence" | "skip_excluded";

export interface StenographerPlannedSourceRow extends StenographerSourceRow {
  conversationalBoundary: boolean;
}

export interface StenographerBatchPlan {
  fromMessageIdExclusive: number;
  throughMessageIdInclusive: number;
  trigger: StenographerBatchTrigger;
  sourceRows: StenographerPlannedSourceRow[];
  coveredMessageIds: number[];
  conversationalMessageCount: number;
  newestEligibleSourceAt: Date | null;
}

export function isConversationalSourceRow(
  row: Pick<StenographerSourceRow, "role" | "text">,
): boolean {
  return row.role === "user" ||
    (row.role === "assistant" && row.text.trim().length > 0);
}

function rowEligibleForEvidence(row: StenographerSourceRow): boolean {
  return row.eligibleSource !== false && row.excludedFromEvidence !== true;
}

function compareByMessageId(
  a: StenographerSourceRow,
  b: StenographerSourceRow,
): number {
  return a.id - b.id;
}

function compareForEvidence(
  a: StenographerSourceRow,
  b: StenographerSourceRow,
): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id;
}

function validateBatchInput(input: PlanStenographerBatchInput): void {
  if (!Number.isInteger(input.cursorMessageId) || input.cursorMessageId < 0) {
    throw new RangeError("cursorMessageId must be a non-negative integer");
  }
  if (
    !Number.isInteger(input.fixedUpperBoundMessageId) ||
    input.fixedUpperBoundMessageId < input.cursorMessageId
  ) {
    throw new RangeError(
      "fixedUpperBoundMessageId must be an integer at or above the cursor",
    );
  }
  for (const row of input.rows) {
    if (!Number.isInteger(row.id) || row.id <= 0) {
      throw new RangeError("source row IDs must be positive integers");
    }
    if (!Number.isFinite(row.createdAt.getTime())) {
      throw new RangeError("source row timestamps must be valid");
    }
  }
}

export function planStenographerBatch(
  input: PlanStenographerBatchInput,
): StenographerBatchPlan | null {
  validateBatchInput(input);

  const pending = input.rows
    .filter(
      (row) =>
        row.id > input.cursorMessageId &&
        row.id <= input.fixedUpperBoundMessageId,
    )
    .sort(compareByMessageId);
  if (pending.length === 0 && !input.retryFixedRange) return null;

  const priorFingerprints = input.fingerprintsAtOrBeforeCursor ?? new Set();
  const seenFingerprints = new Set(priorFingerprints);
  const conversationalById = new Map<number, boolean>();
  let excludedConversationalRows = 0;

  for (const row of pending) {
    let conversational =
      rowEligibleForEvidence(row) && isConversationalSourceRow(row);

    if (rowEligibleForEvidence(row) &&
      row.role === "user" && row.fingerprint !== null &&
      row.fingerprint !== undefined) {
      if (seenFingerprints.has(row.fingerprint)) {
        conversational = false;
      } else {
        seenFingerprints.add(row.fingerprint);
      }
    }

    if (
      !rowEligibleForEvidence(row) &&
      isConversationalSourceRow(row)
    ) {
      excludedConversationalRows += 1;
    }
    conversationalById.set(row.id, conversational);
  }

  const conversationalRows = pending.filter(
    (row) => conversationalById.get(row.id) === true,
  );

  let throughMessageIdInclusive: number;
  let trigger: StenographerBatchTrigger;

  if (input.retryFixedRange) {
    throughMessageIdInclusive = input.fixedUpperBoundMessageId;
    trigger = pending.some(rowEligibleForEvidence)
      ? conversationalRows.length >= STENOGRAPHER_MESSAGE_TRIGGER
        ? "count"
        : "silence"
      : "skip_excluded";
  } else if (conversationalRows.length >= STENOGRAPHER_MESSAGE_TRIGGER) {
    throughMessageIdInclusive =
      conversationalRows[STENOGRAPHER_MESSAGE_TRIGGER - 1]!.id;
    trigger = "count";
  } else if (conversationalRows.length > 0) {
    const newestEligibleSource = pending
      .filter(rowEligibleForEvidence)
      .reduce<StenographerSourceRow | undefined>(
        (newest, row) =>
          newest === undefined || compareForEvidence(newest, row) < 0
            ? row
            : newest,
        undefined,
      );
    if (
      newestEligibleSource === undefined ||
      input.now.getTime() - newestEligibleSource.createdAt.getTime() <
        STENOGRAPHER_SILENCE_MS
    ) {
      return null;
    }
    throughMessageIdInclusive = pending.at(-1)!.id;
    trigger = "silence";
  } else if (excludedConversationalRows > 0 || pending.length > 0) {
    // Deaf and otherwise non-evidence-only ranges must not strand either the
    // live or historical authoritative cursor forever.
    throughMessageIdInclusive = pending.at(-1)!.id;
    trigger = "skip_excluded";
  } else {
    return null;
  }

  if (throughMessageIdInclusive <= input.cursorMessageId) {
    throw new Error("batch planner produced an empty or inverted range");
  }

  const covered = pending.filter(
    (row) => row.id <= throughMessageIdInclusive,
  );
  const sourceRows = covered
    .filter(rowEligibleForEvidence)
    .map((row) => ({
      ...row,
      conversationalBoundary: conversationalById.get(row.id) === true,
    }))
    .sort(compareForEvidence);
  const newestEligibleSource = sourceRows.reduce<Date | null>(
    (latest, row) =>
      latest === null || row.createdAt.getTime() > latest.getTime()
        ? row.createdAt
        : latest,
    null,
  );

  return {
    fromMessageIdExclusive: input.cursorMessageId,
    throughMessageIdInclusive,
    trigger,
    sourceRows,
    coveredMessageIds: covered.map((row) => row.id),
    conversationalMessageCount: sourceRows.filter(
      (row) => row.conversationalBoundary,
    ).length,
    newestEligibleSourceAt: newestEligibleSource,
  };
}
