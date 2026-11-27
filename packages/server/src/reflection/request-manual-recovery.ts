import {
  and,
  eq,
  isNull,
  users,
  type DirectDatabase,
  type PostgresJsBridgeExecutor,
} from "@nautilo/db";
import {
  PostgresSemanticWorkStore,
  createHmacRecordSemanticCommitmentPort,
  repairBlockedDerivedRecordLineage,
  verifyRecordProductPostgresHandle,
} from "@nautilo/reflection-bridge/server";

import { resolveCurrentReflectionCommitmentKey } from "./record-repository-selection";

export interface RequestManualReflectionRecoveryInput {
  readonly db: Pick<DirectDatabase, "select">;
  readonly executor: PostgresJsBridgeExecutor;
  readonly now: Date;
  readonly observedThrough: Date;
  readonly authorizedBy: string;
  readonly modelId: string;
  readonly page?: Readonly<{ after: string | null; limit: number }>;
}

type ReflectionRecoveryPhase = "derived" | "provider";

type ReflectionRecoveryCursor = Readonly<{
  version: 1;
  phase: ReflectionRecoveryPhase;
  observedThrough: string;
  after: string | null;
}>;

function encodeReflectionRecoveryCursor(cursor: ReflectionRecoveryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeReflectionRecoveryCursor(value: string): ReflectionRecoveryCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("Reflection recovery cursor is invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Reflection recovery cursor is invalid");
  }
  const row = parsed as Record<string, unknown>;
  if (Object.keys(row).length !== 4
    || row["version"] !== 1
    || (row["phase"] !== "derived" && row["phase"] !== "provider")
    || typeof row["observedThrough"] !== "string"
    || !Number.isFinite(new Date(row["observedThrough"]).getTime())
    || (row["after"] !== null && typeof row["after"] !== "string")) {
    throw new TypeError("Reflection recovery cursor is invalid");
  }
  return {
    version: 1,
    phase: row["phase"],
    observedThrough: row["observedThrough"],
    after: row["after"],
  };
}

/**
 * Accept a fresh, potentially billable Reflection computation for each exact
 * service-funded terminal hold visible through the operator's observation
 * cutoff. Authorization is recorded on the new generation; claim-time source,
 * authority, funding, and publication admission remain canonical.
 */
export async function requestManualReflectionRecovery(
  input: RequestManualReflectionRecoveryInput,
): Promise<Readonly<{
  queued: number;
  held: number;
  nextCursor?: string;
  derivedRepair: Readonly<{
    retired: number;
    sourcesQueued: number;
    summariesQueued: number;
  }>;
}>> {
  if (input.page !== undefined && (
    !Number.isSafeInteger(input.page.limit)
    || input.page.limit < 1
    || (input.page.after !== null && input.page.after.length === 0)
  )) {
    throw new RangeError("Reflection recovery page is invalid");
  }
  const initialCursor: ReflectionRecoveryCursor = {
    version: 1,
    phase: "derived",
    observedThrough: input.observedThrough.toISOString(),
    after: null,
  };
  const cursor = input.page?.after === null || input.page === undefined
    ? initialCursor
    : decodeReflectionRecoveryCursor(input.page.after);
  if (cursor.observedThrough !== input.observedThrough.toISOString()) {
    throw new RangeError("Reflection recovery continuation changed its observation cutoff");
  }
  const [operator] = await input.db.select({ id: users.id }).from(users).where(and(
    eq(users.id, input.authorizedBy),
    isNull(users.disabledAt),
  )).limit(1);
  if (operator === undefined) {
    throw new Error("Reflection recovery authorizer is unavailable");
  }
  const handle = await verifyRecordProductPostgresHandle(
    {
      query: input.executor.query.bind(input.executor),
      transaction: use => use(input.executor),
    },
  );
  const commitments = createHmacRecordSemanticCommitmentPort(
    resolveCurrentReflectionCommitmentKey(),
  );
  const store = new PostgresSemanticWorkStore({
    handle,
    commitments,
  });
  const repaired = cursor.phase === "provider"
    ? { requeued: 0, scanned: 0 }
    : await repairBlockedDerivedRecordLineage({
        handle,
        now: input.now,
        observedThrough: input.observedThrough,
        authorizedBy: operator.id,
        ...(input.page === undefined
          ? {}
          : { page: { after: cursor.after, limit: input.page.limit } }),
      });
  if (input.page !== undefined && repaired.nextCursor !== undefined) {
    return {
      queued: repaired.requeued,
      held: 0,
      nextCursor: encodeReflectionRecoveryCursor({
        version: 1,
        phase: "derived",
        observedThrough: cursor.observedThrough,
        after: repaired.nextCursor,
      }),
      derivedRepair: {
        retired: 0,
        sourcesQueued: 0,
        summariesQueued: repaired.requeued,
      },
    };
  }
  const remaining = input.page === undefined
    ? undefined
    : input.page.limit - (repaired.scanned ?? 0);
  const providerRecovery = await store.requestManualProviderRecovery({
    now: input.now,
    authorizedAt: input.observedThrough,
    observedThrough: input.observedThrough,
    authorizedBy: operator.id,
    modelId: input.modelId,
    ...(remaining === undefined
      ? {}
      : {
          page: {
            after: cursor.phase === "provider" ? cursor.after : null,
            limit: remaining,
          },
        }),
  });
  return {
    queued: repaired.requeued + providerRecovery.queued,
    held: providerRecovery.held,
    ...(providerRecovery.nextCursor === undefined
      ? {}
      : {
          nextCursor: encodeReflectionRecoveryCursor({
            version: 1,
            phase: "provider",
            observedThrough: cursor.observedThrough,
            after: providerRecovery.nextCursor,
          }),
        }),
    derivedRepair: {
      retired: 0,
      // The current repair safely re-arms the derived summary itself. It does
      // not admit a source Record rebuild, so keep the public source count
      // distinct from the total queued count above.
      sourcesQueued: 0,
      summariesQueued: repaired.requeued,
    },
  };
}
