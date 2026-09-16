import { asc, eq, lt, sql } from "drizzle-orm";

import type { Database } from "../config/database";
import {
  encryptionTransitionBoundaryHealth,
  type StrictShadowBoundaryActorClass,
  type StrictShadowBoundaryReason,
  type StrictShadowBoundaryState,
} from "../schema/encryption-transition";

export type StrictShadowBoundaryHealthDb = Pick<
  Database,
  "delete" | "insert" | "select"
>;

export type StrictShadowBoundaryHealthRecord = Readonly<{
  policyRevision: number;
  boundaryId: string;
  family: string;
  operation: string;
  actorClass: StrictShadowBoundaryActorClass;
  state: StrictShadowBoundaryState;
  reason: StrictShadowBoundaryReason;
  retryable: boolean;
  occurrenceCount: bigint;
  firstObservedAt: Date;
  lastObservedAt: Date;
}>;

export type RecordStrictShadowBoundaryHealthInput = Readonly<Omit<
  StrictShadowBoundaryHealthRecord,
  "occurrenceCount" | "firstObservedAt" | "lastObservedAt"
> & { observedAt: Date }>;

function assertSafeInput(input: RecordStrictShadowBoundaryHealthInput): void {
  if (!Number.isSafeInteger(input.policyRevision) || input.policyRevision < 1) {
    throw new TypeError("Strict Shadow policy revision must be positive");
  }
  for (const [name, value, maximum] of [
    ["boundaryId", input.boundaryId, 256],
    ["family", input.family, 64],
    ["operation", input.operation, 64],
  ] as const) {
    if (value.length < 1 || value.length > maximum) {
      throw new TypeError(`Strict Shadow ${name} is out of bounds`);
    }
  }
  if (Number.isNaN(input.observedAt.getTime())) {
    throw new TypeError("Strict Shadow observation time is invalid");
  }
  if ((input.state === "verified") !== (input.reason === "none")) {
    throw new TypeError("Strict Shadow verified state is incoherent");
  }
  if (
    (input.state === "waiting_for_authority" || input.state === "repairing")
    && !input.retryable
  ) {
    throw new TypeError("Strict Shadow pending state must be retryable");
  }
}

/**
 * Replace the current signal for one registered boundary and discard older
 * policy epochs. Cardinality is therefore bounded by the executable registry.
 */
export async function recordStrictShadowBoundaryHealth(
  db: StrictShadowBoundaryHealthDb,
  input: RecordStrictShadowBoundaryHealthInput,
): Promise<void> {
  assertSafeInput(input);
  await db.delete(encryptionTransitionBoundaryHealth).where(
    lt(
      encryptionTransitionBoundaryHealth.policyRevision,
      input.policyRevision,
    ),
  );
  await db.insert(encryptionTransitionBoundaryHealth).values({
    policyRevision: input.policyRevision,
    boundaryId: input.boundaryId,
    family: input.family,
    operation: input.operation,
    actorClass: input.actorClass,
    state: input.state,
    reason: input.reason,
    retryable: input.retryable,
    occurrenceCount: 1n,
    firstObservedAt: input.observedAt,
    lastObservedAt: input.observedAt,
  }).onConflictDoUpdate({
    target: [
      encryptionTransitionBoundaryHealth.policyRevision,
      encryptionTransitionBoundaryHealth.boundaryId,
    ],
    set: {
      family: sql`case
        when excluded.last_observed_at >= ${encryptionTransitionBoundaryHealth.lastObservedAt}
          then excluded.family
        else ${encryptionTransitionBoundaryHealth.family}
      end`,
      operation: sql`case
        when excluded.last_observed_at >= ${encryptionTransitionBoundaryHealth.lastObservedAt}
          then excluded.operation
        else ${encryptionTransitionBoundaryHealth.operation}
      end`,
      actorClass: sql`case
        when excluded.last_observed_at >= ${encryptionTransitionBoundaryHealth.lastObservedAt}
          then excluded.actor_class
        else ${encryptionTransitionBoundaryHealth.actorClass}
      end`,
      state: sql`case
        when excluded.last_observed_at >= ${encryptionTransitionBoundaryHealth.lastObservedAt}
          then excluded.state
        else ${encryptionTransitionBoundaryHealth.state}
      end`,
      reason: sql`case
        when excluded.last_observed_at >= ${encryptionTransitionBoundaryHealth.lastObservedAt}
          then excluded.reason
        else ${encryptionTransitionBoundaryHealth.reason}
      end`,
      retryable: sql`case
        when excluded.last_observed_at >= ${encryptionTransitionBoundaryHealth.lastObservedAt}
          then excluded.retryable
        else ${encryptionTransitionBoundaryHealth.retryable}
      end`,
      occurrenceCount:
        sql`${encryptionTransitionBoundaryHealth.occurrenceCount} + 1`,
      firstObservedAt:
        sql`least(${encryptionTransitionBoundaryHealth.firstObservedAt}, excluded.first_observed_at)`,
      lastObservedAt:
        sql`greatest(${encryptionTransitionBoundaryHealth.lastObservedAt}, excluded.last_observed_at)`,
    },
  });
}

export async function readStrictShadowBoundaryHealth(
  db: Pick<Database, "select">,
  policyRevision: number,
): Promise<readonly StrictShadowBoundaryHealthRecord[]> {
  if (!Number.isSafeInteger(policyRevision) || policyRevision < 1) return [];
  return db.select().from(encryptionTransitionBoundaryHealth).where(
    eq(encryptionTransitionBoundaryHealth.policyRevision, policyRevision),
  ).orderBy(asc(encryptionTransitionBoundaryHealth.boundaryId));
}
