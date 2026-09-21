import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { markManagedGatewayOutcomeUnknown } from "@nautilo/agent";
import type { DirectDatabase } from "@nautilo/db";

import {
  DURABLE_SLEEP_MAX_WORK_ITEMS_PER_RUN,
  DurableSleepProviderOutcomeUnknownError,
  ORGANIZER_BATCH_MAX_ITEMS,
  type DurableSleepClaim,
  type DurableSleepSemanticPort,
} from "@nautilo/reflection";

import {
  REFLECTION_SEMANTIC_RUNTIME_POLICY_V1,
  classifyReflectionModelInvocationFailure,
  createProductionReflectionMemoryRuntime,
  resolveOrganizerPublicationLegacyLeaf,
  resolveOrganizerPublicationLegacyLeafOutcome,
} from "../../src/reflection/production-reflection-memory";

interface TestProductClient {
  unsafe(statement: string): Promise<readonly unknown[]>;
  begin(
    isolation: string,
    use: (transaction: TestProductClient) => Promise<unknown>,
  ): Promise<unknown>;
}

function productDb(): DirectDatabase {
  const client: TestProductClient = {
    unsafe(statement: string) {
      return Promise.resolve(statement.includes("current_user")
        ? [{ current_role: "nautilo", session_role: "nautilo" }]
        : []);
    },
    begin(
      _isolation: string,
      use: (transaction: TestProductClient) => Promise<unknown>,
    ) {
      return use(client);
    },
  };
  // Test-only postgres-js shape; production verifies the role before use.
  return { $client: client } as unknown as DirectDatabase;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(predicate()).toBeTrue();
}

describe("production Reflection semantic policy", () => {
  test("turns managed Gateway uncertainty into a terminal durable outcome", () => {
    const classified = classifyReflectionModelInvocationFailure(
      markManagedGatewayOutcomeUnknown(new Error("upstream response lost")),
      "openrouter:test/model",
    );

    expect(classified).toBeInstanceOf(DurableSleepProviderOutcomeUnknownError);
  });

  test("binds one supplied data-operation pair into the existing worker", async () => {
    const claim: DurableSleepClaim = {
      logicalObjectRef: "logical:record:bound",
      generation: 1,
      recordRef: "record:bound",
      changeReason: "created",
      stage: "authority_projection",
      leaseToken: "lease:record:bound:1",
    };
    let bindCalls = 0;
    let claimCalls = 0;
    let authorityCalls = 0;
    let checkpointCalls = 0;
    const maintenanceLimits: number[] = [];
    let capturedOrdinary: DurableSleepSemanticPort | undefined;
    let capturedPreparedInvoke: DurableSleepSemanticPort["invokeOrganizerBatch"];
    const runtime = await createProductionReflectionMemoryRuntime({
      db: productDb(),
      selection: {
        selectedRepresentation: "ordinary",
        migrationGeneration: 1,
      },
      commitmentKey: new Uint8Array(32).fill(7),
      maintenanceGate: { isAcceptingWork: async () => true },
      resolveStageAdmission: async () => ({
        maximumStage: "authority_projection",
      }),
      resolveModelId: () => "test:no-model",
      bindSemanticDataOperations({ work, ordinary, invokePreparedOrganizerBatch }) {
        bindCalls += 1;
        capturedOrdinary = ordinary;
        capturedPreparedInvoke = invokePreparedOrganizerBatch;
        const boundWork = new Proxy(work, {
          get(target, property, receiver) {
            if (property === "claimNext") return async () => {
              claimCalls += 1;
              return claimCalls === 1
                ? { status: "claimed" as const, claim }
                : { status: "empty" as const };
            };
            if (property === "checkpoint") return async () => {
              checkpointCalls += 1;
              return { status: "accepted" as const };
            };
            const value: unknown = Reflect.get(target, property, receiver);
            // Proxy preserves the concrete port's method receiver.
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const boundSemantic = new Proxy(ordinary, {
          get(target, property, receiver) {
            if (property === "ensureAuthority") return async () => {
              authorityCalls += 1;
              return { status: "ready" as const };
            };
            const value: unknown = Reflect.get(target, property, receiver);
            // Proxy preserves the concrete port's method receiver.
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return {
          work: boundWork,
          semantic: boundSemantic,
          maintain: async ({ limit }) => { maintenanceLimits.push(limit); },
        };
      },
    });

    expect(bindCalls).toBe(1);
    expect(capturedOrdinary).toBeDefined();
    expect(capturedPreparedInvoke).toBeFunction();
    runtime.worker.start();
    try {
      await waitFor(() => checkpointCalls === 1);
      expect(claimCalls).toBe(2);
      expect(authorityCalls).toBe(1);
      expect(maintenanceLimits).toEqual([DURABLE_SLEEP_MAX_WORK_ITEMS_PER_RUN]);
    } finally {
      await runtime.worker.stop();
    }
  });

  test("keeps the ordinary factory path when no data-operation binder is supplied", async () => {
    const runtime = await createProductionReflectionMemoryRuntime({
      db: productDb(),
      selection: {
        selectedRepresentation: "ordinary",
        migrationGeneration: 1,
      },
      commitmentKey: new Uint8Array(32).fill(8),
      maintenanceGate: { isAcceptingWork: async () => false },
      resolveModelId: () => "test:no-model",
    });
    expect(runtime.worker.getHealth().state).toBe("disabled");
  });

  test("prepared invocation binding is metadata-only", () => {
    const source = readFileSync(
      new URL("../../src/reflection/production-reflection-memory.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("const invokePreparedOrganizerBatch");
    const end = source.indexOf("const invokeForRecord", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const prepared = source.slice(start, end);
    expect(prepared).toContain("semanticWork.isClaimCurrent(claim)");
    expect(prepared).toContain("bindings.invocation.resolve(claim.recordRef)");
    expect(prepared).not.toContain("repository.read");
  });

  test("binds body-free structural Record search through the production authority-filtered selector", () => {
    const source = readFileSync(
      new URL("../../src/reflection/production-reflection-memory.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("async searchStructural(request)");
    expect(source).toContain("(await recordSearchFor(request)).searchStructural(request)");
  });

  test("authority-only bootstrap returns before organization repair admission", () => {
    const source = readFileSync(
      new URL("../../src/reflection/production-reflection-memory.ts", import.meta.url),
      "utf8",
    );
    const stageGate = source.indexOf(
      'pageInput.stageAdmission.maximumStage !== "organization"',
    );
    const candidateRecovery = source.indexOf("recoverCandidatePolicyQuarantinesPage");
    expect(stageGate).toBeGreaterThan(-1);
    expect(candidateRecovery).toBeGreaterThan(stageGate);
    expect(source.slice(stageGate, candidateRecovery)).toContain(
      "return semanticWork.bootstrapPage(bootstrapInput)",
    );
  });

  test("uses the executor-owned durable work-item ceiling", () => {
    expect(REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.budget.maxWorkItems).toBe(
      DURABLE_SLEEP_MAX_WORK_ITEMS_PER_RUN,
    );
  });

  test("reserves one possible publication for every item in a full model batch", () => {
    expect(REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.budget.hierarchy.maxCreatedRecords).toBe(
      ORGANIZER_BATCH_MAX_ITEMS,
    );
  });

  test("uses a bounded fast catch-up interval below the idle scan interval", () => {
    expect(REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.catchUpIntervalMilliseconds).toBe(2_000);
    expect(REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.catchUpIntervalMilliseconds).toBeLessThan(
      REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.scanIntervalMilliseconds,
    );
  });

  test("allows a slow Reflection batch sixty seconds within the independent poll watchdog", () => {
    expect(
      REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.modelInvocation.maximumElapsedMilliseconds,
    ).toBe(60_000);
  });

  test("keeps legacy same-Room publication single-leaf", () => {
    expect(resolveOrganizerPublicationLegacyLeaf({
      terminalAuthorityLeafHandles: ["namespace:a", "namespace:b"],
      hasExactPublicationPlan: false,
    })).toBeNull();
  });

  test("allows multi-leaf publication only through an exact cross-Room plan", () => {
    expect(resolveOrganizerPublicationLegacyLeaf({
      terminalAuthorityLeafHandles: ["namespace:a", "namespace:b"],
      hasExactPublicationPlan: true,
    })).toBe("namespace:a");
    expect(resolveOrganizerPublicationLegacyLeaf({
      terminalAuthorityLeafHandles: [],
      hasExactPublicationPlan: true,
    })).toBeNull();
  });

  test("classifies the legacy leaf guard without exposing authority coordinates", () => {
    expect(resolveOrganizerPublicationLegacyLeafOutcome({
      terminalAuthorityLeafHandles: ["namespace:a", "namespace:b"],
      hasExactPublicationPlan: false,
    })).toEqual({
      status: "unavailable",
      failureDetail: "publication_legacy_leaf_unavailable",
    });
  });
});
