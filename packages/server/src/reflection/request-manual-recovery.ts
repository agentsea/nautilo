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
}

/**
 * Accept a fresh, potentially billable Reflection computation for each exact
 * service-funded terminal hold visible through the operator's observation
 * cutoff. Authorization is recorded on the new generation; claim-time source,
 * authority, funding, and publication admission remain canonical.
 */
export async function requestManualReflectionRecovery(
  input: RequestManualReflectionRecoveryInput,
): Promise<Readonly<{ queued: number; held: number }>> {
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
  const semanticWork = new PostgresSemanticWorkStore({
    handle,
    commitments: createHmacRecordSemanticCommitmentPort(
      resolveCurrentReflectionCommitmentKey(),
    ),
  });
  return semanticWork.requestManualProviderRecovery({
    now: input.now,
    observedThrough: input.observedThrough,
    authorizedBy: operator.id,
    modelId: input.modelId,
  });
}
