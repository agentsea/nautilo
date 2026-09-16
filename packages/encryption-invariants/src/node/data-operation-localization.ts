import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Consumers already migrated in M321. This list expands as remaining D7
 * paths move; it intentionally does not exempt an entire UI or server layer. */
export const POLICY_FREE_DATA_OPERATION_CONSUMERS = Object.freeze([
  "packages/lattice-bridge/src/client/message/device-message-backfill-client.ts",
  "packages/lattice-bridge/src/client/message/message-backfill-worker.ts",
  "apps/workbench/src/adapters/message-backfill-scheduler.ts",
  "apps/workbench/src/pages/settings/sections/message-history-backfill-progress.tsx",
  "apps/workbench/src/pages/memory/memory-page.tsx",
  "apps/workbench/src/lib/room-message-edit.ts",
  "apps/workbench/src/lib/memory-read-operations.ts",
  "apps/workbench/src/adapters/room-message-operations.ts",
  "apps/workbench/src/lib/protected-human-memory-controller.ts",
  "apps/workbench/src/adapters/session-rehydrate.ts",
  "apps/workbench/src/adapters/room-history-row-access.ts",
  "apps/workbench/src/adapters/full-human-message-reconciliation.ts",
  "apps/workbench/src/adapters/protected-message-update.ts",
  "apps/workbench/src/modes/rooms/thread-drawer/thread-room-controller.ts",
  "apps/workbench/src/modes/rooms/thread-drawer/use-thread-room-controller.ts",
  "packages/agent/src/store/memory-store.ts",
  "packages/agent/src/tools/memory/search-memory.ts",
  "packages/agent/src/tools/memory/recall-records.ts",
  "packages/runtime/src/reflection/foreground-record-recall-adapter.ts",
  "packages/runtime/src/reflection/production-reflection-memory.ts",
  "packages/runtime/src/reflection/semantic-sleep-worker.ts",
  "packages/reflection/src/sleep/durable-executor.ts",
  "packages/server/src/reflection/protected-authority-composition.ts",
  "packages/runtime/src/conversation/live-shadow-agent-runtime-events.ts",
  "packages/runtime/src/executors/langgraph-executor.ts",
  "packages/runtime/src/executors/fork-langgraph-executor.ts",
  "packages/runtime/src/executors/persisting-processor.ts",
  "packages/runtime/src/stenographer/worker.ts",
  "packages/runtime/src/stenographer/protected-stenographer-background-coordinator.ts",
  "packages/server/src/background/stenographer-composition.ts",
] as const);

/** Exact Runtime policy-owning seam; consumer modules are never blanket-exempt. */
export const TRUSTED_RUNTIME_DATA_OPERATION_OWNER =
  "packages/runtime/src/conversation/live-shadow-agent-runtime.ts" as const;

/** Exact adapters allowed to carry the current policy binding into that owner. */
export const TRUSTED_RUNTIME_POLICY_BINDINGS = Object.freeze([
  "packages/runtime/src/conversation/live-shadow-turn-context.ts",
  "packages/server/src/routes/auth.ts",
] as const);

/** Exact Workbench modules that own representation delegation. */
export const TRUSTED_WORKBENCH_DATA_OPERATION_OWNERS = Object.freeze([
  "apps/workbench/src/lib/memory-read-operations.ts",
  "apps/workbench/src/adapters/room-message-operations.ts",
  "apps/workbench/src/adapters/room-history-row-access.ts",
] as const);

/** State-only seams may observe policy for admission, custody, or caching. */
export const TRUSTED_WORKBENCH_POLICY_STATE_SEAMS = Object.freeze([
  "apps/workbench/src/components/crypto-device-admission-gate.tsx",
  "apps/workbench/src/lib/encryption-data-operation-policy.ts",
] as const);

export const MAIN_RUNTIME_DATA_FACADE =
  "apps/workbench/src/adapters/nautilo-runtime.tsx" as const;

const FORBIDDEN_POLICY_DECISIONS = Object.freeze([
  /\bselectLiveEncryptionRepresentationPolicy\b/u,
  /\bselectLiveShadowEncryptionTransitionPolicy\b/u,
  /\ballowOrdinaryFallback\b/u,
  /\ballowOrdinaryLoader\b/u,
  /\ballowProtectedCrypto\b/u,
  /\ballowForwardRepair\b/u,
  /\ballowReverseRepair\b/u,
  /\bshadowPolicyMode\b/u,
  /encryptionTransition\.getPolicy\s*\(/u,
] as const);

const FORBIDDEN_MAIN_RUNTIME_BYPASSES = Object.freeze([
  /\bapiClient\.sendRoomMessage\s*\(/u,
  /\bapiClient\.getOlderRoomMessages\s*\(/u,
  /\bapiClient\.getRoomMessagesAround\s*\(/u,
] as const);

function executableSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n\r]*/gu, "");
}

export type DataOperationLocalizationViolation = Readonly<{
  path: string;
  token: string;
}>;

export async function findDataOperationLocalizationViolations(
  repositoryRoot: string,
  sources?: Readonly<Record<string, string>>,
): Promise<DataOperationLocalizationViolation[]> {
  const violations: DataOperationLocalizationViolation[] = [];
  for (const path of POLICY_FREE_DATA_OPERATION_CONSUMERS) {
    const source = sources?.[path] ?? await readFile(resolve(repositoryRoot, path), "utf8");
    for (const pattern of FORBIDDEN_POLICY_DECISIONS) {
      const match = source.match(pattern);
      if (match?.[0] !== undefined) violations.push({ path, token: match[0] });
    }
  }
  const runtimeSource = executableSource(
    sources?.[MAIN_RUNTIME_DATA_FACADE]
      ?? await readFile(resolve(repositoryRoot, MAIN_RUNTIME_DATA_FACADE), "utf8"),
  );
  for (const pattern of FORBIDDEN_MAIN_RUNTIME_BYPASSES) {
    const match = runtimeSource.match(pattern);
    if (match?.[0] !== undefined) {
      violations.push({ path: MAIN_RUNTIME_DATA_FACADE, token: match[0] });
    }
  }
  return violations;
}
