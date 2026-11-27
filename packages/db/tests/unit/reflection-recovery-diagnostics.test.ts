import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  classifyReflectionHeldProviderAggregate,
  classifyReflectionHeldProviderEvidence,
  readReflectionRecoveryDiagnostics,
} from "../../src/queries/reflection-recovery-diagnostics";
import type { MemoryOperationBinding } from "@nautilo/types";

const settled = {
  fundingKind: "service" as const,
  payerHumanId: null,
  providerRoute: "surplus" as const,
  model: "anthropic:test",
  actualCostUsd: "0.01",
  providerRequestId: "provider-request",
  attemptOutcome: "succeeded" as const,
  costState: "actual" as const,
  recoveryState: null,
};

describe("Reflection recovery diagnostics", () => {
  test("calls a terminal hold result-missing only for exact settled success-only wires", () => {
    expect(classifyReflectionHeldProviderEvidence([settled], "anthropic:test"))
      .toBe("provider_succeeded_result_missing");
    expect(classifyReflectionHeldProviderEvidence([], "anthropic:test"))
      .toBe("provider_outcome_unknown");
    expect(classifyReflectionHeldProviderEvidence([
      { ...settled, attemptOutcome: null },
    ], "anthropic:test")).toBe("provider_outcome_unknown");
    expect(classifyReflectionHeldProviderEvidence([
      { ...settled, model: "another:model" },
    ], "anthropic:test")).toBe("provider_outcome_unknown");
    expect(classifyReflectionHeldProviderEvidence([
      settled,
      { ...settled, attemptOutcome: "failed", providerRequestId: null },
    ], "anthropic:test")).toBe("provider_outcome_unknown");
  });

  test("accepts identifiable historical direct successes independent of spend certainty", () => {
    const directEstimated = {
      ...settled,
      fundingKind: "personal",
      providerRoute: "direct",
      actualCostUsd: null,
      costState: "estimated",
      recoveryState: "estimated",
    };
    expect(classifyReflectionHeldProviderEvidence([directEstimated], "anthropic:test"))
      .toBe("provider_succeeded_result_missing");
  });

  test("classifies aggregate all-wire evidence without materializing attempt rows", () => {
    expect(classifyReflectionHeldProviderAggregate(2, 2))
      .toBe("provider_succeeded_result_missing");
    expect(classifyReflectionHeldProviderAggregate(0, 0)).toBe("provider_outcome_unknown");
    expect(classifyReflectionHeldProviderAggregate(2, 1)).toBe("provider_outcome_unknown");
    expect(classifyReflectionHeldProviderAggregate(1, 2)).toBe("provider_outcome_unknown");
  });

  test("pages held families, preserves canonical and legacy IDs, and aggregates bounded exact counts", async () => {
    type Binding = Extract<MemoryOperationBinding, { kind: "service" }>;
    const binding = (character: string, modelId: string): Binding => ({
      version: 1,
      kind: "service",
      role: "memoryReflection",
      modelId,
      inputCommitment: `hmac-sha256:${character.repeat(43)}`,
    });
    const canonical = binding("A", "openai:canonical");
    const legacy = binding("B", "anthropic:legacy");
    const ambiguous = binding("C", "venice:ambiguous");
    const absent = binding("D", "openai:absent");
    const largeIds = Array.from({ length: 65_535 }, (_, index) => `legacy-large:${index}`);
    const observedArrays: string[][] = [];
    const limits: number[] = [];
    const groupCounts: Record<string, number> = {};
    const heldPredicates: SQL[] = [];
    let heldCalls = 0;
    const evidence = [
      { familyKey: "0", total: 2, exactSettledSuccesses: 2 },
      { familyKey: "1", total: 1, exactSettledSuccesses: 1 },
      { familyKey: "2", total: 2, exactSettledSuccesses: 1 },
    ];
    let row = 0;
    const heldRows = [
      ...Array.from({ length: 3 }, () => ({ recordId: String(row++).padStart(3, "0"), binding: canonical })),
      ...Array.from({ length: 2 }, () => ({ recordId: String(row++).padStart(3, "0"), binding: legacy })),
      ...Array.from({ length: 5 }, () => ({ recordId: String(row++).padStart(3, "0"), binding: ambiguous })),
      ...Array.from({ length: 6 }, () => ({ recordId: String(row++).padStart(3, "0"), binding: absent })),
      ...Array.from({ length: 4 }, () => ({
        recordId: String(row++).padStart(3, "0"),
        binding: { kind: "service", modelId: "legacy-without-commitment" },
      })),
      { recordId: String(row++).padStart(3, "0"), binding: null },
      ...Array.from({ length: 79 }, () => ({
        recordId: String(row++).padStart(3, "0"), binding: null,
      })),
    ];
    const selections: string[][] = [];
    const db = {
      select(fields: Record<string, unknown>) {
        const keys = Object.keys(fields);
        selections.push(keys);
        const kind = keys.includes("binding") ? "held"
          : keys.includes("exactSettledSuccesses") ? "evidence"
          : keys.includes("invalidSelection") ? "reasons" : "resume";
        let predicate: SQL | undefined;
        let joined: SQL | undefined;
        const chain = {
          from() { return chain; },
          where(value: SQL | undefined) {
            predicate = value;
            if (kind === "held" && value) heldPredicates.push(value);
            return chain;
          },
          innerJoin(value: SQL, condition: SQL | undefined) { joined = value; predicate = condition; return chain; },
          groupBy() { groupCounts[kind] = (groupCounts[kind] ?? 0) + 1; return chain; },
          orderBy() { return chain; },
          limit(value: number) { limits.push(value); return chain; },
          then(resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) {
            try {
              if (kind === "held") {
                const rows = heldCalls === 0 ? heldRows : [];
                heldCalls += 1;
                return Promise.resolve(rows).then(resolve, reject);
              }
              if (kind === "evidence") {
                if (!joined || !predicate) throw new Error("missing evidence join");
                const params = new PgDialect().sqlToQuery(joined).params;
                const arrays = params.filter((value): value is string[] => Array.isArray(value));
                if (arrays.length !== 3) throw new Error("missing evidence array parameters");
                observedArrays.push(...arrays);
                return Promise.resolve(evidence).then(resolve, reject);
              }
              if (kind === "reasons") return Promise.resolve([{
                invalidSelection: 7, missingAuthority: 8, stalePlan: 9, unavailableSource: 10,
              }]).then(resolve, reject);
              return Promise.resolve([{ count: 11 }]).then(resolve, reject);
            } catch (error) {
              return Promise.reject(error instanceof Error ? error : new Error(String(error)))
                .then(resolve, reject);
            }
          },
        };
        return chain;
      },
    } as unknown as NonNullable<Parameters<typeof readReflectionRecoveryDiagnostics>[1]>;

    const result = await readReflectionRecoveryDiagnostics({
      since: new Date("2026-11-26T00:00:00Z"),
      until: new Date("2026-11-27T00:00:00Z"),
      operationIds: current => current.inputCommitment === canonical.inputCommitment
        ? ["reflection:canonical:primary", "reflection:canonical:repair"]
        : current.inputCommitment === legacy.inputCommitment
          ? ["legacy-reflection-operation"]
          : current.inputCommitment === ambiguous.inputCommitment ? largeIds : [],
    }, db);

    expect(result).toEqual({
      providerSucceededResultMissing: 5,
      providerOutcomeUnknown: 95,
      resumedFromSavedProposal: 11,
      quarantinedByReason: {
        invalidSelection: 7, missingAuthority: 8, stalePlan: 9, unavailableSource: 10,
      },
    });
    expect(limits).toEqual([100, 100]);
    const secondHeldPage = new PgDialect().sqlToQuery(heldPredicates[1]!);
    expect(secondHeldPage.sql).toContain('"reflection_record_semantic_work"."record_id" >');
    expect(secondHeldPage.params).toContain("099");
    const operationIds = observedArrays.find(values => values.includes("reflection:canonical:primary"));
    expect(operationIds?.slice(0, 3)).toEqual([
      "reflection:canonical:primary", "reflection:canonical:repair",
      "legacy-reflection-operation",
    ]);
    expect(operationIds).toHaveLength(65_538);
    expect(operationIds?.at(-1)).toBe("legacy-large:65534");
    expect(groupCounts).toEqual({ evidence: 1 });
    expect(selections.filter(keys => keys.includes("exactSettledSuccesses"))).toHaveLength(1);
    expect(selections.filter(keys => keys.includes("invalidSelection"))).toHaveLength(1);
  });
});
