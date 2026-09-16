import { afterEach, beforeEach, expect, test } from "bun:test";
import yargs from "yargs/yargs";
import { ApiError } from "@nautilo/api-client";
import { EMPTY_REFLECTION_SEMANTIC_LATENCY } from "@nautilo/types";
import { createServerSettingsModule } from "../../src/commands/server-settings.ts";
import type { AuthenticatedAdminClient } from "../../src/lib/authenticated-admin-client.ts";

let stdout = "";
let original: typeof process.stdout.write;
beforeEach(() => {
  stdout = "";
  original = process.stdout.write;
  process.stdout.write = ((value: string | Uint8Array) => {
    stdout += typeof value === "string" ? value : Buffer.from(value).toString();
    return true;
  }) as typeof process.stdout.write;
});
afterEach(() => { process.stdout.write = original; process.exitCode = undefined; });

function client(capabilities = ["read_server_settings", "manage_server_settings"]): AuthenticatedAdminClient {
  const models = { defaultChatModel: "openai/gpt-5", conductorModel: "", stenographerModel: "", reflectionModel: "", fallbackChain: [], reasoningOutput: {} };
  const context = { recentConversationLimit: 50, minimumFullTurns: 2, maxRoomContextPercent: 60, stenographerPriorConversationLimit: 10, passiveRecallEnabled: true, reflectionSleepEnabled: false };
  const profile = { name: "Test server", description: null, descriptionVisibility: "members" as const, icon: { kind: "preset" as const, id: "server-default" } };
  return {
    whoami: { capabilities, sessionUserId: "user-1" },
    transport: { baseUrl: "http://127.0.0.1:4801", source: "profile" },
    api: {
      admin: {
        serverModels: { get: async () => models, set: async (patch: object) => ({ ...models, ...patch }) },
        serverContext: { get: async () => context, set: async (patch: object) => ({ ...context, ...patch }) },
        stenographerStatus: {
          get: async () => ({
            generatedAt: "2026-08-12T10:00:00.000Z", window: { since: "2026-08-11T10:00:00.000Z", until: "2026-08-12T10:00:00.000Z" }, health: "healthy",
            current: { eligibleRooms: 1, caughtUpRooms: 1, accumulatingRooms: 0, processingRooms: 0, retryingRooms: 0, dueRooms: 0, staleLeases: 0, oldestOverdueMs: 0, rebuildingRooms: 0, historicalPendingRooms: 0, historicalCompletedRooms: 0 },
            last24h: { completedExtractionBatches: 1, extractionBatchesWithErrors: 0, retriedExtractionBatches: 0, zeroEventExtractionBatches: 0, eventsWritten: 1, extractionDurationP50Ms: 1, extractionDurationP95Ms: 1 },
            journal: { projectedBodyCodePointsP50: 1, projectedBodyCodePointsP95: 1, projectedBodyCodePointsMax: 1 },
            compaction: { awaitingRooms: 0, processingRooms: 0, retryingRooms: 0, staleLeases: 0, oldestOverdueMs: 0, lastCompletedAt: null }, recentFailures: [],
          }),
          getProtection: async () => ({
            dtoVersion: 1 as const,
            generatedAt: "2026-08-12T10:00:00.000Z",
            window: { since: "2026-08-11T10:00:00.000Z", until: "2026-08-12T10:00:00.000Z" },
            queue: {
              current: { awaitingRecipient: "0", waitingForDevice: "2", grantReady: "1", claimed: "0", running: "0", publicationReconciliation: "0", oldestWaitingAt: "2026-08-12T09:00:00.000Z" },
              last24h: { protectedCompleted: "3", outputRepairCompleted: "4", cancelled: "0", terminalFailures: "0" },
            },
            authorityWait: { extractionRooms: "5", compactionRooms: "6", oldestAt: null },
            plaintextFallback: {
              missingProtection: { extractionBatches: "7", compactionRollups: "8", oldestAt: "2026-08-12T08:00:00.000Z" },
              last24h: { extraction: { device: "9", authority: "10" }, compaction: { device: "11", authority: "12" } },
            },
          }),
        },
        reflectionStatus: { get: async () => ({
          generatedAt: "2026-08-12T10:00:00.000Z", window: { since: "2026-08-11T10:00:00.000Z", until: "2026-08-12T10:00:00.000Z" }, health: "healthy",
          scheduler: {
            state: "cooldown", pauseReason: null, recoveryIntervalMs: 15_000,
            nextEligiblePollAt: "2026-08-12T10:00:15.000Z", lastPoll: null,
            window: { polls: 1, admitted: 0, completed: 0, created: 0 },
            backlog: { size: 0, oldestAgeMs: 0 },
            latency: EMPTY_REFLECTION_SEMANTIC_LATENCY,
            amplification: "normal",
          },
          current: { totalRecords: 2, backlog: 0, due: 0, claimed: 0, checkpointed: 0, deferred: 0, complete: 2, quarantined: 0, recoveryEligible: 0, maximumRecoveryRound: 0, staleLeases: 0, oldestOverdueMs: 0, maximumAttempts: 1, currentParentViolations: 0 },
          stages: { authorityProjection: 0, searchProjection: 0, organization: 2 },
          projections: { availableRecords: 2, current: 2, pending: 0, incompatible: 0 },
          last24h: { completedWork: 2, syntheticParentsCreated: 1 }, lastCompletedAt: "2026-08-12T09:00:00.000Z", nextRecoveryAt: null, currentFailures: [],
        }) },
      },
      getServerProfile: async () => profile,
      updateServerProfile: async (patch: object) => ({ ...profile, ...patch }),
    },
  } as unknown as AuthenticatedAdminClient;
}

async function run(args: string[], admin = client()): Promise<void> {
  await yargs(args).exitProcess(false).command(createServerSettingsModule({ authenticate: async () => admin })).strict().parseAsync();
}

test("model and context reads return canonical server state", async () => {
  await run(["settings", "models", "show", "--format", "json"]);
  expect(JSON.parse(stdout)).toMatchObject({ data: { current: { defaultChatModel: "openai/gpt-5" }, source: "server" } });
  stdout = "";
  await run(["settings", "context", "show", "--format", "json"]);
  expect(JSON.parse(stdout)).toMatchObject({ data: { current: { maxRoomContextPercent: 60 } } });
});

test("mutations require confirmation before write", async () => {
  let writes = 0;
  const admin = client();
  (admin.api.admin.serverModels as unknown as { set(): Promise<unknown> }).set = async () => { writes += 1; return {}; };
  await run(["settings", "models", "set", "--default-chat-model", "openai/gpt-5", "--format", "json"], admin);
  expect(writes).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ error: { code: "confirmation_required" } });
});

test("Stenographer and profile reads are bounded and selected-server explicit", async () => {
  await run(["settings", "stenographer", "--format", "json"]);
  expect(JSON.parse(stdout)).toMatchObject({
    data: {
      status: { health: "healthy" },
      protectionStatus: {
        queue: { last24h: { protectedCompleted: "3", outputRepairCompleted: "4" } },
        plaintextFallback: {
          missingProtection: { extractionBatches: "7", compactionRollups: "8" },
        },
      },
      protectionStatusUnavailable: false,
      recentFailureLimit: 5,
    },
  });
  stdout = "";
  await run(["settings", "stenographer", "--format", "human"]);
  expect(stdout).toContain("waiting device:2");
  expect(stdout).toContain("encrypted 24h: 3");
  expect(stdout).toContain("repaired 24h:  4");
  expect(stdout).toContain("missing:       7 extraction, 8 compaction");
  stdout = "";
  await run(["settings", "profile", "show", "--format", "json"]);
  expect(JSON.parse(stdout)).toMatchObject({ data: { selectedServer: "http://127.0.0.1:4801", current: { name: "Test server" } } });
});

test("Stenographer preserves legacy health when an older server lacks protection status", async () => {
  const admin = client();
  (admin.api.admin.stenographerStatus as unknown as {
    getProtection(): Promise<never>;
  }).getProtection = async () => {
    throw new ApiError(404, "not found");
  };

  await run(["settings", "stenographer", "--format", "human"], admin);

  expect(process.exitCode).toBe(0);
  expect(stdout).toContain("health:       healthy");
  expect(stdout).toContain("protection:   protection status unavailable");
});

test("Reflection health read is bounded", async () => {
  await run(["settings", "reflection", "--format", "json"]);
  expect(JSON.parse(stdout)).toMatchObject({
    data: { status: { health: "healthy", current: { totalRecords: 2 } }, currentFailureLimit: 5 },
  });
  stdout = "";
  await run(["settings", "reflection", "--format", "human"]);
  expect(stdout).toContain("scheduler:    cooldown");
});

test("capability denial happens before settings I/O", async () => {
  let reads = 0;
  const admin = client([]);
  (admin.api.admin.serverModels as unknown as { get(): Promise<unknown> }).get = async () => { reads += 1; return {}; };
  await run(["settings", "models", "show", "--format", "json"], admin);
  expect(reads).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ error: { code: "capability_denied" } });
});
