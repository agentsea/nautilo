import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type MemoryEncryptionBoundary =
  | "schema"
  | "store"
  | "embedding"
  | "agent_tool"
  | "human_api"
  | "client_dto"
  | "client_custody"
  | "background"
  | "portability"
  | "scope_authority";

export type MemoryEncryptionDuty =
  | "plaintext_read"
  | "plaintext_write"
  | "protected_read"
  | "protected_write"
  | "metadata_only"
  | "model_invoke"
  | "wire_contract"
  | "authority_resolution";

export type MemoryEncryptionImplementationState =
  | "legacy_only"
  | "protected"
  | "typed_unavailable";

export type MemoryEncryptionImplementationAnchor = Readonly<{
  readonly sourcePath: string;
  readonly anchor: string;
}>;

export type MemoryEncryptionSurface = Readonly<{
  readonly id: string;
  readonly sourcePath: string;
  readonly anchor: string;
  readonly boundary: MemoryEncryptionBoundary;
  readonly duties: readonly MemoryEncryptionDuty[];
  /**
   * Honest protected-mode state, independent of the surface's duties:
   * legacy-only has no protected branch; protected has a concrete protected
   * implementation; typed-unavailable fails closed instead of falling back.
   */
  readonly implementationState: MemoryEncryptionImplementationState;
  /** Static semantic anchors proving non-legacy implementation claims. */
  readonly implementationAnchors: readonly MemoryEncryptionImplementationAnchor[];
}>;

type MemoryEncryptionSurfaceDefinition = Omit<
  MemoryEncryptionSurface,
  "implementationState" | "implementationAnchors"
>;

const legacySurface = <T extends MemoryEncryptionSurfaceDefinition>(value: T) => ({
  ...value,
  implementationState: "legacy_only" as const,
  implementationAnchors: Object.freeze([]),
});

const protectedSurface = <T extends MemoryEncryptionSurfaceDefinition>(
  value: T,
  implementationAnchors: readonly MemoryEncryptionImplementationAnchor[],
) => ({
  ...value,
  implementationState: "protected" as const,
  implementationAnchors: Object.freeze([...implementationAnchors]),
});

const unavailableSurface = <T extends MemoryEncryptionSurfaceDefinition>(
  value: T,
  implementationAnchors: readonly MemoryEncryptionImplementationAnchor[],
) => ({
  ...value,
  implementationState: "typed_unavailable" as const,
  implementationAnchors: Object.freeze([...implementationAnchors]),
});

/**
 * Executable Wave 12 inventory of every known Memory content boundary.
 *
 * This is intentionally semantic rather than a filename glob. The validator
 * makes source movement explicit, while the repository writer/DTO inventories
 * remain the broader omission alarms for newly introduced surfaces.
 */
export const MEMORY_ENCRYPTION_SURFACES = Object.freeze([
  protectedSurface({ id: "memory.schema.row", sourcePath: "packages/db/src/schema/memories.ts", anchor: "export const memories = pgTable", boundary: "schema", duties: ["plaintext_read", "plaintext_write", "protected_read", "protected_write", "metadata_only"] }, [{ sourcePath: "packages/db/src/schema/memories.ts", anchor: "memories_crypto_mapping_revision_coherent" }, { sourcePath: "packages/db/src/schema/memories.ts", anchor: "Legacy plaintext remains authoritative while global" }]),
  legacySurface({ id: "memory.schema.namespaces", sourcePath: "packages/db/src/schema/memory-namespaces.ts", anchor: "export const memoryNamespaces = pgTable", boundary: "schema", duties: ["metadata_only", "authority_resolution"] }),
  legacySurface({ id: "memory.schema.scopes", sourcePath: "packages/db/src/schema/memory-scopes.ts", anchor: "export const memoryScopes = pgTable", boundary: "schema", duties: ["metadata_only", "authority_resolution"] }),
  legacySurface({ id: "memory.schema.agent_scope", sourcePath: "packages/db/src/schema/agent-scopes.ts", anchor: "export const agentScopes = pgTable", boundary: "schema", duties: ["metadata_only", "authority_resolution"] }),
  legacySurface({ id: "memory.store.namespace", sourcePath: "packages/agent/src/store/memory-store.ts", anchor: "export async function saveMemory", boundary: "store", duties: ["plaintext_read", "plaintext_write", "protected_read", "protected_write"] }),
  legacySurface({ id: "memory.store.scope", sourcePath: "packages/agent/src/store/scope-memory-store.ts", anchor: "export async function saveScopeMemory", boundary: "store", duties: ["plaintext_read", "plaintext_write", "protected_read", "protected_write", "authority_resolution"] }),
  legacySurface({ id: "memory.store.projection", sourcePath: "packages/agent/src/store/memory-store.ts", anchor: "export async function executeAtomicProjectionMemory", boundary: "store", duties: ["plaintext_read", "plaintext_write", "protected_read", "protected_write", "authority_resolution"] }),
  legacySurface({ id: "memory.store.prompt_brief", sourcePath: "packages/agent/src/store/memory-store.ts", anchor: "export async function getPromptBrief", boundary: "store", duties: ["plaintext_read", "protected_read"] }),
  legacySurface({ id: "memory.embedding", sourcePath: "packages/agent/src/store/embeddings.ts", anchor: "export async function embedTexts", boundary: "embedding", duties: ["plaintext_read", "model_invoke", "metadata_only"] }),
  protectedSurface({ id: "memory.tool.manage", sourcePath: "packages/agent/src/tools/memory/manage-memory.ts", anchor: "export function createManageMemoryTool", boundary: "agent_tool", duties: ["plaintext_read", "plaintext_write", "protected_read", "protected_write"] }, [{ sourcePath: "packages/agent/src/tools/memory/manage-memory.ts", anchor: "if (context?.protectedMemoryRepository)" }, { sourcePath: "packages/agent/src/tools/memory/manage-memory.ts", anchor: "context.protectedMemoryRepository.save({" }]),
  protectedSurface({ id: "memory.tool.search", sourcePath: "packages/agent/src/tools/memory/search-memory.ts", anchor: "export function createSearchMemoryTool", boundary: "agent_tool", duties: ["plaintext_read", "protected_read", "model_invoke"] }, [{ sourcePath: "packages/agent/src/tools/memory/search-memory.ts", anchor: "if (protectedSearch)" }, { sourcePath: "packages/agent/src/tools/memory/search-memory.ts", anchor: "await protectedSearch.search({" }]),
  protectedSurface({ id: "memory.tool.share", sourcePath: "packages/agent/src/tools/memory/share-memory.ts", anchor: "export function createShareMemoryTool", boundary: "agent_tool", duties: ["plaintext_read", "protected_read", "protected_write", "authority_resolution"] }, [{ sourcePath: "packages/agent/src/tools/memory/share-memory.ts", anchor: "if (context?.protectedMemoryAccessPort)" }, { sourcePath: "packages/agent/src/tools/memory/share-memory.ts", anchor: "context.protectedMemoryAccessPort.change({" }]),
  protectedSurface({ id: "memory.tool.projection", sourcePath: "packages/agent/src/tools/memory/projection-sharing.ts", anchor: "export async function executeTrustedProjection", boundary: "agent_tool", duties: ["plaintext_read", "plaintext_write", "protected_read", "protected_write", "authority_resolution"] }, [{ sourcePath: "packages/agent/src/tools/memory/projection-sharing.ts", anchor: "prepared = await port.prepare({" }, { sourcePath: "packages/agent/src/tools/memory/projection-sharing.ts", anchor: "const result = await protectedPort.publish({" }]),
  protectedSurface({ id: "memory.tool.scope_create", sourcePath: "packages/agent/src/tools/memory/create-scope.ts", anchor: "export function createCreateScopeTool", boundary: "scope_authority", duties: ["authority_resolution", "metadata_only"] }, [{ sourcePath: "packages/agent/src/tools/memory/create-scope.ts", anchor: "if (ctx?.protectedMemoryScopeLifecyclePort)" }, { sourcePath: "packages/agent/src/tools/memory/create-scope.ts", anchor: "ctx.protectedMemoryScopeLifecyclePort.create({" }]),
  protectedSurface({ id: "memory.tool.scope_seed", sourcePath: "packages/agent/src/tools/memory/add-memory-to-scope.ts", anchor: "export function createAddMemoryToScopeTool", boundary: "scope_authority", duties: ["plaintext_read", "protected_read", "authority_resolution"] }, [{ sourcePath: "packages/agent/src/tools/memory/add-memory-to-scope.ts", anchor: "if (ctx?.protectedMemoryScopeLifecyclePort)" }, { sourcePath: "packages/agent/src/tools/memory/add-memory-to-scope.ts", anchor: "ctx.protectedMemoryScopeLifecyclePort.attachSeed({" }]),
  protectedSurface({ id: "memory.tool.scope_close", sourcePath: "packages/agent/src/tools/memory/close-scope.ts", anchor: "export function createCloseScopeTool", boundary: "scope_authority", duties: ["plaintext_read", "plaintext_write", "protected_read", "protected_write", "authority_resolution"] }, [{ sourcePath: "packages/agent/src/tools/memory/close-scope.ts", anchor: "if (ctx?.protectedMemoryScopeLifecyclePort)" }, { sourcePath: "packages/agent/src/tools/memory/close-scope.ts", anchor: "ctx.protectedMemoryScopeLifecyclePort.close({" }]),
  legacySurface({ id: "memory.scope.envelope", sourcePath: "packages/trust/src/types.ts", anchor: "export type ScopeMemoryEnvelope", boundary: "scope_authority", duties: ["authority_resolution", "metadata_only"] }),
  legacySurface({ id: "memory.scope.subagent", sourcePath: "packages/agent/src/subagents/scope-subagent/run.ts", anchor: "export function runScopeSubagentUntilPause", boundary: "scope_authority", duties: ["authority_resolution", "protected_read", "protected_write"] }),
  legacySurface({ id: "memory.scope.task_dispatch", sourcePath: "packages/runtime/src/tasks/dispatch-task-run.ts", anchor: "satisfies ScopeMemoryEnvelope", boundary: "scope_authority", duties: ["authority_resolution", "protected_read", "protected_write"] }),
  protectedSurface({ id: "memory.api.server", sourcePath: "packages/server/src/routes/memory.ts", anchor: "export function memoryRoutes", boundary: "human_api", duties: ["plaintext_read", "plaintext_write", "protected_read", "protected_write", "wire_contract"] }, [{ sourcePath: "packages/server/src/routes/memory.ts", anchor: "resolveCurrentProtectedMemoryRoutePorts({" }, { sourcePath: "packages/server/src/routes/protected-memory-composition.ts", anchor: "export async function resolveCurrentProtectedMemoryRoutePorts(" }, { sourcePath: "packages/server/src/routes/memory.ts", anchor: "protectedRequest.ports.list({" }]),
  protectedSurface({ id: "memory.api.client", sourcePath: "packages/api-client/src/client.ts", anchor: "async listMemories", boundary: "client_dto", duties: ["wire_contract", "protected_read", "protected_write"] }, [{ sourcePath: "packages/api-client/src/client.ts", anchor: "async listProtectedMemories(" }, { sourcePath: "packages/api-client/src/client.ts", anchor: "schema: protectedMemoryListRouteResponseV1Schema" }]),
  protectedSurface({ id: "memory.client.exact_access", sourcePath: "packages/lattice-bridge/src/client/memory/authorized-human-memory-client.ts", anchor: "export function createAuthorizedHumanMemoryClient", boundary: "client_custody", duties: ["protected_read", "protected_write", "wire_contract", "authority_resolution"] }, [{ sourcePath: "packages/lattice-bridge/src/client-vault/profile-v3.ts", anchor: "export function createClientProfileObjectAccessAnchorPort" }, { sourcePath: "packages/lattice-bridge/src/client/memory/vault-human-memory-device-content.ts", anchor: "export function createVaultAuthorizedHumanMemoryDeviceContentPort" }, { sourcePath: "packages/lattice-bridge/src/client/memory/prepared-mutation-journal.ts", anchor: "export function createPreparedMutationJournal" }, { sourcePath: "packages/lattice-bridge/src/client/memory/browser-prepared-mutation-journal-vault.ts", anchor: "export function createBrowserPreparedMutationJournalVault" }, { sourcePath: "packages/lattice-bridge/src/client/electron/index.ts", anchor: "export function createElectronPreparedMutationJournalVault" }]),
  protectedSurface({ id: "memory.api.protected_mutations", sourcePath: "packages/server/src/routes/protected-memory-routes.ts", anchor: "export function protectedMemoryRoutes", boundary: "human_api", duties: ["protected_read", "protected_write", "wire_contract", "authority_resolution"] }, [{ sourcePath: "packages/server/src/routes/protected-memory-composition.ts", anchor: "export function createProtectedMemoryTestShadowComposition" }, { sourcePath: "packages/lattice-bridge/src/server/memory/human-memory-protected-route-ports.ts", anchor: "export function createHumanMemoryProtectedRoutePorts" }, { sourcePath: "packages/lattice-bridge/src/server/memory/postgres-human-memory-protected-product-route.ts", anchor: "export function createPostgresHumanMemoryProtectedProductRoutePort" }, { sourcePath: "packages/lattice-bridge/src/server/memory/postgres-human-memory-exact-access-product.ts", anchor: "export class PostgresHumanMemoryExactAccessProduct" }]),
  legacySurface({ id: "memory.api.types", sourcePath: "packages/api-client/src/types.ts", anchor: "export interface MemoryListItem", boundary: "client_dto", duties: ["wire_contract"] }),
  legacySurface({ id: "memory.api.workbench_facade", sourcePath: "apps/workbench/src/lib/memory-api.ts", anchor: "export type {", boundary: "client_dto", duties: ["wire_contract", "plaintext_read", "plaintext_write"] }),
  legacySurface({ id: "memory.api.workbench_page", sourcePath: "apps/workbench/src/pages/memory/memory-page.tsx", anchor: "export function MemoryPage", boundary: "human_api", duties: ["plaintext_read", "plaintext_write", "protected_read", "protected_write"] }),
  legacySurface({ id: "memory.background.main", sourcePath: "packages/runtime/src/executors/langgraph-executor.ts", anchor: "await memoryReviewAdmission(memoryAccessEnvelope, langgraphThreadId,", boundary: "background", duties: ["metadata_only"] }),
  legacySurface({ id: "memory.background.fork", sourcePath: "packages/runtime/src/executors/fork-langgraph-executor.ts", anchor: "await memoryReviewAdmission(memoryAccessEnvelope, checkpointThreadId,", boundary: "background", duties: ["metadata_only"] }),
  legacySurface({ id: "memory.background.reviewer", sourcePath: "packages/agent/src/memory/background-reviewer.ts", anchor: "export async function prepareMemoryReview", boundary: "background", duties: ["plaintext_read", "model_invoke"] }),
  legacySurface({ id: "memory.background.worker", sourcePath: "packages/runtime/src/memory-review/worker.ts", anchor: "await runBackgroundAttempt<BackgroundAttemptObservation[\"outcome\"]>({", boundary: "background", duties: ["plaintext_read", "plaintext_write", "model_invoke", "authority_resolution"] }),
  legacySurface({ id: "memory.background.publication", sourcePath: "packages/agent/src/memory/memory-review-publication.ts", anchor: "export async function publishPreparedMemoryReview", boundary: "background", duties: ["plaintext_write", "authority_resolution"] }),
  protectedSurface({ id: "memory.background.protected_reviewer", sourcePath: "packages/agent/src/memory/protected-background-memory-review.ts", anchor: "export async function runProtectedBackgroundMemoryReview", boundary: "background", duties: ["protected_read", "protected_write", "model_invoke", "authority_resolution"] }, [{ sourcePath: "packages/agent/src/memory/protected-background-memory-review.ts", anchor: "createProtectedBackgroundMemoryStaging({" }, { sourcePath: "packages/lattice-bridge/src/memory/agent-background-memory-work.ts", anchor: "export interface ProtectedAgentBackgroundMemoryWorkPort" }]),
  legacySurface({ id: "memory.background.exit_flush", sourcePath: "packages/agent/src/memory/exit-flush.ts", anchor: "export async function runExitFlush", boundary: "background", duties: ["plaintext_read", "plaintext_write", "protected_read", "protected_write", "model_invoke"] }),
  protectedSurface({ id: "memory.background.protected_exit_flush", sourcePath: "packages/runtime/src/protected-execution/background-authorization/protected-agent-memory-background-entrypoints.ts", anchor: "export function enqueueProtectedAgentMemoryExitFlush", boundary: "background", duties: ["protected_read", "protected_write", "authority_resolution"] }, [{ sourcePath: "packages/runtime/src/protected-execution/background-authorization/protected-agent-memory-background-entrypoints.ts", anchor: "entrypointId: \"memory.exit_flush\"" }, { sourcePath: "packages/runtime/src/protected-execution/background-authorization/protected-agent-memory-background.ts", anchor: "ProtectedAgentMemoryBackgroundCoordinator" }]),
  protectedSurface({ id: "memory.background.adapter", sourcePath: "packages/runtime/src/protected-execution/background-authorization/protected-agent-memory-background.ts", anchor: "export class ProtectedAgentMemoryBackgroundCoordinator", boundary: "background", duties: ["protected_read", "protected_write", "authority_resolution"] }, [{ sourcePath: "packages/runtime/src/protected-execution/background-authorization/protected-agent-memory-background.ts", anchor: "const terminal = await this.options.terminal.execute({" }]),
  unavailableSurface({ id: "memory.portability.server", sourcePath: "packages/server/src/routes/profile-bundle.ts", anchor: "async function defaultListPrivateMemoryRecords", boundary: "portability", duties: ["plaintext_read", "plaintext_write", "protected_read", "protected_write", "wire_contract"] }, [{ sourcePath: "packages/server/src/routes/profile-bundle.ts", anchor: "crypto_object_id: memories.cryptoObjectId" }, { sourcePath: "packages/server/src/routes/profile-bundle.ts", anchor: ".where(and(eq(memories.id, candidate.id), isNull(memories.cryptoObjectId)))" }, { sourcePath: "packages/server/src/routes/profile-bundle.ts", anchor: "privateMemoryRecords.some(isProtectedMemoryLegacyPlaceholder)" }, { sourcePath: "packages/server/src/routes/profile-bundle.ts", anchor: "protected_memory_portability_unavailable" }]),
  legacySurface({ id: "memory.portability.client", sourcePath: "packages/api-client/src/client.ts", anchor: "export interface ProfileBundleExportResponse", boundary: "portability", duties: ["plaintext_read", "plaintext_write", "protected_read", "protected_write", "wire_contract"] }),
] as const);

export function validateMemoryEncryptionInventory(
  repositoryRoot: string,
  surfaces: readonly MemoryEncryptionSurface[] = MEMORY_ENCRYPTION_SURFACES,
): readonly string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const item of surfaces) {
    if (ids.has(item.id)) errors.push(`duplicate Memory encryption surface id: ${item.id}`);
    ids.add(item.id);
    const path = resolve(repositoryRoot, item.sourcePath);
    if (!existsSync(path)) {
      errors.push(`missing Memory encryption source: ${item.sourcePath}`);
      continue;
    }
    if (!readFileSync(path, "utf8").includes(item.anchor)) {
      errors.push(`missing Memory encryption anchor: ${item.sourcePath}#${item.anchor}`);
    }
    if (
      item.implementationState !== "legacy_only"
      && item.implementationAnchors.length === 0
    ) {
      errors.push(
        `${item.implementationState === "protected" ? "protected" : "typed-unavailable"} Memory surface has no implementation anchor: ${item.id}`,
      );
    }
    for (const implementation of item.implementationAnchors) {
      const implementationPath = resolve(repositoryRoot, implementation.sourcePath);
      if (!existsSync(implementationPath)) {
        errors.push(`missing Memory implementation source: ${implementation.sourcePath}`);
        continue;
      }
      if (!readFileSync(implementationPath, "utf8").includes(implementation.anchor)) {
        errors.push(
          `missing Memory implementation anchor: ${implementation.sourcePath}#${implementation.anchor}`,
        );
      }
    }
  }
  return errors.sort();
}
