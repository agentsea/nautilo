import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  findDataOperationLocalizationViolations,
  POLICY_FREE_DATA_OPERATION_CONSUMERS,
  MAIN_RUNTIME_DATA_FACADE,
  TRUSTED_RUNTIME_DATA_OPERATION_OWNER,
  TRUSTED_RUNTIME_POLICY_BINDINGS,
  TRUSTED_WORKBENCH_DATA_OPERATION_OWNERS,
  TRUSTED_WORKBENCH_POLICY_STATE_SEAMS,
} from "../../src/node/data-operation-localization";

const unusedRepositoryRoot = "/source-injected-localization-test";

describe("M321 policy-hiding data-operation localization", () => {
  test("localizes Runtime policy authority to exact owner and binding adapters", () => {
    expect(TRUSTED_RUNTIME_DATA_OPERATION_OWNER).toBe(
      "packages/runtime/src/conversation/live-shadow-agent-runtime.ts",
    );
    expect(TRUSTED_RUNTIME_POLICY_BINDINGS).toEqual([
      "packages/runtime/src/conversation/live-shadow-turn-context.ts",
      "packages/server/src/routes/auth.ts",
    ]);
    for (const consumer of [
      "packages/lattice-bridge/src/client/message/device-message-backfill-client.ts",
      "packages/lattice-bridge/src/client/message/message-backfill-worker.ts",
      "apps/workbench/src/adapters/message-backfill-scheduler.ts",
      "apps/workbench/src/pages/settings/sections/message-history-backfill-progress.tsx",
      "packages/runtime/src/conversation/live-shadow-agent-runtime-events.ts",
      "packages/runtime/src/executors/langgraph-executor.ts",
      "packages/runtime/src/executors/fork-langgraph-executor.ts",
      "packages/runtime/src/executors/persisting-processor.ts",
    ] as const) {
      expect(POLICY_FREE_DATA_OPERATION_CONSUMERS.includes(consumer)).toBe(true);
    }
  });

  test("names exact Workbench owners and state-only policy seams", () => {
    expect(TRUSTED_WORKBENCH_DATA_OPERATION_OWNERS).toEqual([
      "apps/workbench/src/lib/memory-read-operations.ts",
      "apps/workbench/src/adapters/room-message-operations.ts",
      "apps/workbench/src/adapters/room-history-row-access.ts",
    ]);
    expect(TRUSTED_WORKBENCH_POLICY_STATE_SEAMS).toEqual([
      "apps/workbench/src/components/crypto-device-admission-gate.tsx",
      "apps/workbench/src/lib/encryption-data-operation-policy.ts",
    ]);
  });

  test("detects a representation selector reintroduced into a migrated consumer", async () => {
    const sources = Object.fromEntries(POLICY_FREE_DATA_OPERATION_CONSUMERS.map((path) => [
      path,
      path.endsWith("room-message-edit.ts")
        ? "selectLiveEncryptionRepresentationPolicy(policy);"
        : "export {};",
    ]));
    sources[MAIN_RUNTIME_DATA_FACADE] = "export {};";
    expect(await findDataOperationLocalizationViolations(
      unusedRepositoryRoot,
      sources,
    )).toEqual([{
      path: "apps/workbench/src/lib/room-message-edit.ts",
      token: "selectLiveEncryptionRepresentationPolicy",
    }]);
  });

  test("detects raw Room API calls that bypass the main Runtime facade", async () => {
    const sources = Object.fromEntries(POLICY_FREE_DATA_OPERATION_CONSUMERS.map((path) => [
      path,
      "export {};",
    ]));
    sources[MAIN_RUNTIME_DATA_FACADE] = `
      // apiClient.sendRoomMessage("comment-only", body);
      await apiClient.getOlderRoomMessages({ roomId });
    `;
    expect(await findDataOperationLocalizationViolations(
      unusedRepositoryRoot,
      sources,
    )).toEqual([{
      path: MAIN_RUNTIME_DATA_FACADE,
      token: "apiClient.getOlderRoomMessages(",
    }]);
  });

  test("reads the Runtime facade from disk when only consumer sources are injected", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-operation-localization-"));
    const facade = join(root, MAIN_RUNTIME_DATA_FACADE);
    const sources = Object.fromEntries(POLICY_FREE_DATA_OPERATION_CONSUMERS.map((path) => [
      path,
      "export {};",
    ]));
    try {
      await mkdir(dirname(facade), { recursive: true });
      await writeFile(facade, `
        // apiClient.sendRoomMessage("comment-only", body);
        await apiClient.getRoomMessagesAround({ roomId, messageId });
      `);
      expect(await findDataOperationLocalizationViolations(root, sources)).toEqual([{
        path: MAIN_RUNTIME_DATA_FACADE,
        token: "apiClient.getRoomMessagesAround(",
      }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
