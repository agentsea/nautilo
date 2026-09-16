import { describe, expect, test } from "bun:test";
import { requiredV2Scenarios } from "../../playground/v2-scenarios.ts";
import { v2ProviderMatrix } from "../../src/testing/v2-matrix.ts";

const DEFAULT_SEEDS = [225_101, 225_202] as const;
const DEFAULT_ITERATIONS = 4;
const MAX_HEAP_GROWTH_BYTES = 256 * 1024 * 1024;
const OPERATION_IDS = [3, 5, 9, 10, 13, 6, 14, 15, 18, 24] as const;

function positiveInteger(label: string, raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function selectedSeeds(): readonly number[] {
  const exact = positiveInteger(
    "M225_CHURN_SEED",
    process.env["M225_CHURN_SEED"],
  );
  return exact === null ? DEFAULT_SEEDS : [exact];
}

function selectedIterations(): number {
  return positiveInteger(
    "M225_CHURN_ITERATIONS",
    process.env["M225_CHURN_ITERATIONS"],
  ) ?? DEFAULT_ITERATIONS;
}

function shuffledOperations(seed: number): number[] {
  const result = [...OPERATION_IDS];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const selected = state % (index + 1);
    [result[index], result[selected]] = [result[selected]!, result[index]!];
  }
  return result;
}

function replayCommand(
  provider: string,
  seed: number,
): string {
  return `M225_CHURN_PROVIDER=${provider} M225_CHURN_SEED=${seed} `
    + "M225_CHURN_ITERATIONS=1 "
    + "bun test --timeout 60000 tests/soak/v2-churn.soak.test.ts";
}

const requestedProvider = process.env["M225_CHURN_PROVIDER"];
const providers = requestedProvider === undefined
  ? v2ProviderMatrix
  : v2ProviderMatrix.filter((provider) => provider.id === requestedProvider);
if (providers.length === 0) {
  throw new RangeError(
    `M225_CHURN_PROVIDER must be one of ${v2ProviderMatrix.map(
      (provider) => provider.id,
    ).join(", ")}`,
  );
}

describe("v2 deterministic bounded cross-subsystem churn", () => {
  for (const provider of providers) {
    test(
      `${provider.id} combines membership, device, authorization, grant, object, and recovery churn`,
      async () => {
        const startedAt = performance.now();
        const heapStart = process.memoryUsage().heapUsed;
        let heapPeak = heapStart;
        let assertions = 0;
        let providerTransitions = 0;
        let completedOperations = 0;
        const seeds = selectedSeeds();
        const iterations = selectedIterations();

        for (const seed of seeds) {
          for (let iteration = 0; iteration < iterations; iteration += 1) {
            const orderedIds = shuffledOperations(seed + iteration);
            for (const scenarioId of orderedIds) {
              const scenario = requiredV2Scenarios[scenarioId - 1];
              if (!scenario || scenario.id !== scenarioId) {
                throw new Error(`missing churn scenario ${scenarioId}`);
              }
              try {
                const result = await scenario.run(provider, {
                  seedOffset: seed * 1_000 + iteration * 37 + scenarioId,
                });
                assertions += result.assertions;
                providerTransitions += result.providerTransitions;
                completedOperations += 1;
                heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
              } catch (error) {
                const replay = replayCommand(provider.id, seed);
                throw new Error(
                  `v2 churn failed provider=${provider.id} seed=${seed} `
                  + `iteration=${iteration} scenario=${scenarioId}; `
                  + `replay: ${replay}`,
                  { cause: error },
                );
              }
            }
          }
        }

        const heapEnd = process.memoryUsage().heapUsed;
        const summary = {
          lane: "lattice-v2-churn",
          provider: provider.id,
          seeds,
          iterationsPerSeed: iterations,
          operationIds: OPERATION_IDS,
          completedOperations,
          assertions,
          providerTransitions,
          durationMs: Number((performance.now() - startedAt).toFixed(2)),
          heapStart,
          heapPeak,
          heapEnd,
          heapGrowth: heapEnd - heapStart,
          maximumHeapGrowthBytes: MAX_HEAP_GROWTH_BYTES,
          replayTemplate:
            replayCommand(provider.id, seeds[0] ?? DEFAULT_SEEDS[0]),
        };
        console.log(JSON.stringify(summary));

        expect(completedOperations).toBe(
          seeds.length * iterations * OPERATION_IDS.length,
        );
        expect(assertions).toBeGreaterThan(completedOperations);
        expect(providerTransitions).toBeGreaterThanOrEqual(
          completedOperations,
        );
        expect(heapPeak - heapStart).toBeLessThanOrEqual(
          MAX_HEAP_GROWTH_BYTES,
        );
      },
      60_000,
    );
  }
});
