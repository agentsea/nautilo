import { and, count, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { parseMemoryOperationBinding, type MemoryOperationBinding } from "@nautilo/types";
import { getSharedDirectDb, type DirectDatabase } from "../config/direct-database";
import { llmUsageEvents } from "../schema/llm-usage";
import { reflectionRecordSemanticWork } from "../schema/reflection-records";

type ServiceBinding = Extract<MemoryOperationBinding, { kind: "service" }>;
type QueryDb = Pick<DirectDatabase, "select">;

export type ReflectionRecoveryDiagnostics = Readonly<{
  providerSucceededResultMissing: number;
  providerOutcomeUnknown: number;
  resumedFromSavedProposal: number;
  quarantinedByReason: { invalidSelection: number; missingAuthority: number };
}>;

function serviceBinding(value: unknown): ServiceBinding | null {
  try {
    const binding = parseMemoryOperationBinding(value);
    return binding.kind === "service" && binding.role === "memoryReflection" ? binding : null;
  } catch {
    return null;
  }
}

type SettledAttempt = Pick<typeof llmUsageEvents.$inferSelect,
  "model" | "providerRequestId" | "attemptOutcome">;

function isExactSettledSuccess(row: SettledAttempt, modelId: string): boolean {
  return row.model === modelId
    && row.providerRequestId !== null
    && row.providerRequestId.length > 0
    && row.attemptOutcome === "succeeded";
}

export function classifyReflectionHeldProviderEvidence(
  rows: readonly SettledAttempt[],
  modelId: string,
): "provider_succeeded_result_missing" | "provider_outcome_unknown" {
  return rows.length > 0 && rows.every(row => isExactSettledSuccess(row, modelId))
    ? "provider_succeeded_result_missing"
    : "provider_outcome_unknown";
}

/**
 * Content-free diagnostics only. A terminal hold is result-missing only when
 * every wire for its immutable operation is a fully settled success; any
 * absent or ambiguous evidence remains unknown. This grants no replay or
 * publication authority.
 */
export async function readReflectionRecoveryDiagnostics(
  input: Readonly<{
    since: Date;
    until: Date;
    operationIds(binding: ServiceBinding): readonly string[];
  }>,
  db: QueryDb = getSharedDirectDb(),
): Promise<ReflectionRecoveryDiagnostics> {
  const held = await db.select({
    binding: reflectionRecordSemanticWork.acceptedModelBinding,
  }).from(reflectionRecordSemanticWork).where(and(
    eq(reflectionRecordSemanticWork.state, "complete"),
    eq(reflectionRecordSemanticWork.completionOutcome, "provider_outcome_unknown"),
    eq(reflectionRecordSemanticWork.acceptedModelBindingGeneration, reflectionRecordSemanticWork.generation),
  ));

  const families = new Map<string, { binding: ServiceBinding; count: number; operationIds: string[] }>();
  let unproven = 0;
  for (const row of held) {
    const binding = serviceBinding(row.binding);
    if (binding === null) {
      unproven += 1;
      continue;
    }
    const key = JSON.stringify(binding);
    const family = families.get(key) ?? { binding, count: 0, operationIds: [] };
    family.count += 1;
    families.set(key, family);
  }

  const operationToFamily = new Map<string, string>();
  for (const [key, family] of families) {
    family.operationIds = [...new Set(input.operationIds(family.binding))];
    for (const operationId of family.operationIds) operationToFamily.set(operationId, key);
  }
  const allOperationIds = [...operationToFamily.keys()];
  const attemptsByFamily = new Map<string, SettledAttempt[]>();
  if (allOperationIds.length > 0) {
    const operationId = sql<string>`${llmUsageEvents.metadata}->>'operationId'`;
    const attempts = await db.select({
      operationId,
      model: llmUsageEvents.model,
      providerRequestId: llmUsageEvents.providerRequestId,
      attemptOutcome: llmUsageEvents.attemptOutcome,
    }).from(llmUsageEvents).where(and(
      eq(llmUsageEvents.callType, "room_reflection"),
      inArray(operationId, allOperationIds),
    ));
    for (const attempt of attempts) {
      const key = operationToFamily.get(attempt.operationId);
      if (key === undefined) continue;
      const familyAttempts = attemptsByFamily.get(key) ?? [];
      familyAttempts.push(attempt);
      attemptsByFamily.set(key, familyAttempts);
    }
  }

  let providerSucceededResultMissing = 0;
  for (const [key, family] of families) {
    const attempts = attemptsByFamily.get(key) ?? [];
    if (classifyReflectionHeldProviderEvidence(attempts, family.binding.modelId) === "provider_succeeded_result_missing") {
      providerSucceededResultMissing += family.count;
    } else {
      unproven += family.count;
    }
  }

  const [resume] = await db.select({
    count: count(),
  }).from(reflectionRecordSemanticWork).where(and(
    gte(reflectionRecordSemanticWork.organizerProposalResumedAt, input.since),
    lte(reflectionRecordSemanticWork.organizerProposalResumedAt, input.until),
    or(
      isNull(reflectionRecordSemanticWork.completionOutcome),
      ne(reflectionRecordSemanticWork.completionOutcome, "provider_outcome_unknown"),
    ),
  ));

  const work = reflectionRecordSemanticWork;
  const reasons = await db.select({ code: work.failureCode, detail: work.failureDetail, total: count() })
    .from(work).where(and(eq(work.state, "quarantined"), or(
      eq(work.failureCode, "authority_unavailable"),
      and(eq(work.failureCode, "candidate_unavailable"), eq(work.failureDetail, "candidate_selection_invalid")),
    ))).groupBy(work.failureCode, work.failureDetail);
  const quarantinedByReason = { invalidSelection: 0, missingAuthority: 0 };
  for (const reason of reasons) {
    if (reason.code === "authority_unavailable") quarantinedByReason.missingAuthority += reason.total;
    else quarantinedByReason.invalidSelection += reason.total;
  }
  return {
    providerSucceededResultMissing,
    providerOutcomeUnknown: unproven,
    quarantinedByReason,
    resumedFromSavedProposal: Number(resume?.count ?? 0),
  };
}
