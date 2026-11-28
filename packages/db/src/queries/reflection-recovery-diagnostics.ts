import { and, asc, count, eq, gt, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import { parseMemoryOperationBinding, type MemoryOperationBinding } from "@nautilo/types";
import { getSharedDirectDb, type DirectDatabase } from "../config/direct-database";
import { llmUsageEvents } from "../schema/llm-usage";
import { reflectionRecordSemanticWork } from "../schema/reflection-records";

type ServiceBinding = Extract<MemoryOperationBinding, { kind: "service" }>;
type QueryDb = Pick<DirectDatabase, "select">;
type AcceptedBinding = (typeof reflectionRecordSemanticWork.$inferSelect)["acceptedModelBinding"];
const HELD_RECORD_PAGE_SIZE = 100;

export type ReflectionRecoveryDiagnostics = Readonly<{
  providerSucceededResultMissing: number;
  providerOutcomeUnknown: number;
  resumedFromSavedProposal: number;
  quarantinedByReason: { invalidSelection: number; missingAuthority: number; stalePlan: number; unavailableSource: number };
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

export function classifyReflectionHeldProviderAggregate(
  total: number,
  exactSettledSuccesses: number,
): "provider_succeeded_result_missing" | "provider_outcome_unknown" {
  return total > 0 && exactSettledSuccesses === total
    ? "provider_succeeded_result_missing"
    : "provider_outcome_unknown";
}

function diagnosticCount(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
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
  let unproven = 0;
  let providerSucceededResultMissing = 0;
  let afterRecordId: string | null = null;
  while (true) {
    const held: Array<{ recordId: string; binding: AcceptedBinding }> = await db.select({
      recordId: reflectionRecordSemanticWork.recordId,
      binding: reflectionRecordSemanticWork.acceptedModelBinding,
    }).from(reflectionRecordSemanticWork).where(and(
      eq(reflectionRecordSemanticWork.state, "complete"),
      eq(reflectionRecordSemanticWork.completionOutcome, "provider_outcome_unknown"),
      eq(reflectionRecordSemanticWork.acceptedModelBindingGeneration, reflectionRecordSemanticWork.generation),
      afterRecordId === null ? undefined : gt(reflectionRecordSemanticWork.recordId, afterRecordId),
    )).orderBy(asc(reflectionRecordSemanticWork.recordId))
      .limit(HELD_RECORD_PAGE_SIZE);
    const familyByBinding = new Map<string, { binding: ServiceBinding; count: number }>();
    for (const row of held) {
      const binding = serviceBinding(row.binding);
      if (binding === null) {
        unproven += 1;
        continue;
      }
      const key = JSON.stringify(binding);
      const family = familyByBinding.get(key) ?? { binding, count: 0 };
      family.count += 1;
      familyByBinding.set(key, family);
    }
    const families = [...familyByBinding.values()].map((family, index) => ({
      ...family,
      key: String(index),
      operationIds: [...new Set(input.operationIds(family.binding))],
    }));
    const evidenceFamilyKeys: string[] = [];
    const evidenceOperationIds: string[] = [];
    const evidenceModelIds: string[] = [];
    for (const family of families) {
      for (const operationId of family.operationIds) {
        evidenceFamilyKeys.push(family.key);
        evidenceOperationIds.push(operationId);
        evidenceModelIds.push(family.binding.modelId);
      }
    }
    const evidenceByFamily = new Map<string, { total: number; exactSettledSuccesses: number }>();
    if (evidenceOperationIds.length > 0) {
      const evidenceMap = sql`unnest(
        ${sql.param(evidenceFamilyKeys)}::text[],
        ${sql.param(evidenceOperationIds)}::text[],
        ${sql.param(evidenceModelIds)}::text[]
      ) AS reflection_evidence(family_key, operation_id, model_id)`;
      const familyKey = sql<string>`reflection_evidence.family_key`;
      const evidence = await db.select({
        familyKey,
        total: count(),
        exactSettledSuccesses: sql<number>`count(*) filter (where
          ${llmUsageEvents.model} = reflection_evidence.model_id
          AND ${llmUsageEvents.providerRequestId} IS NOT NULL
          AND ${llmUsageEvents.providerRequestId} <> ''
          AND ${llmUsageEvents.attemptOutcome} = 'succeeded'
        )`.mapWith(Number),
      }).from(llmUsageEvents).innerJoin(evidenceMap, and(
        eq(llmUsageEvents.callType, "room_reflection"),
        sql`${llmUsageEvents.metadata}->>'operationId' = reflection_evidence.operation_id`,
      )).groupBy(familyKey);
      for (const row of evidence) {
        evidenceByFamily.set(row.familyKey, {
          total: diagnosticCount(row.total),
          exactSettledSuccesses: diagnosticCount(row.exactSettledSuccesses),
        });
      }
    }
    for (const family of families) {
      const operationIds = family.operationIds;
      if (operationIds.length === 0) {
        unproven += family.count;
        continue;
      }
      const evidence = evidenceByFamily.get(family.key);
      const classification = classifyReflectionHeldProviderAggregate(
        evidence?.total ?? 0,
        evidence?.exactSettledSuccesses ?? 0,
      );
      if (classification === "provider_succeeded_result_missing") {
        providerSucceededResultMissing += family.count;
      } else {
        unproven += family.count;
      }
    }
    if (held.length < HELD_RECORD_PAGE_SIZE) break;
    const cursor = held.at(-1)?.recordId;
    if (cursor === undefined) break;
    afterRecordId = cursor;
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
  const [reasons] = await db.select({
    invalidSelection: sql<number>`count(*) filter (where ${and(
      eq(work.failureCode, "candidate_unavailable"),
      eq(work.failureDetail, "candidate_selection_invalid"),
    )})`.mapWith(Number),
    missingAuthority: sql<number>`count(*) filter (where ${eq(work.failureCode, "authority_unavailable")})`.mapWith(Number),
    stalePlan: sql<number>`count(*) filter (where ${and(
      eq(work.failureCode, "publication_unavailable"),
      eq(work.failureDetail, "publication_plan_stale"),
    )})`.mapWith(Number),
    unavailableSource: sql<number>`count(*) filter (where ${and(
      eq(work.failureCode, "publication_unavailable"),
      eq(work.failureDetail, "publication_source_unavailable"),
    )})`.mapWith(Number),
  }).from(work).where(eq(work.state, "quarantined"));
  const quarantinedByReason = {
    invalidSelection: diagnosticCount(reasons?.invalidSelection),
    missingAuthority: diagnosticCount(reasons?.missingAuthority),
    stalePlan: diagnosticCount(reasons?.stalePlan),
    unavailableSource: diagnosticCount(reasons?.unavailableSource),
  };
  return {
    providerSucceededResultMissing,
    providerOutcomeUnknown: unproven,
    quarantinedByReason,
    resumedFromSavedProposal: diagnosticCount(resume?.count),
  };
}
