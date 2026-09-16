/** D448 trusted target selection and execution router.
 *
 * Model input never chooses a root, Workspace storage directory, relay, or
 * grant. Current Folder is selected only from the trusted turn binding and is
 * pinned to a focused desktop relay; Workspace is logical/DB-backed only.
 */
import * as path from "node:path";
import {
  APPLY_PATCH_PROTOCOL_VERSION,
  type RelayLocalApplyPatchRequest,
  type RelayLocalApplyPatchResult,
  type RelaySandboxProfile,
} from "@nautilo/relay";
import { resolveServerPosture } from "@nautilo/config";
import { isNamespaceMemoryEnvelope, type MemoryAccessEnvelope } from "@nautilo/trust";
import type { ResolvedFocusedResource } from "@nautilo/types";
import type { ToolRelayRegistry } from "../../nodes/tools";
import type { ApplyPatchExecutionPort, ApplyPatchToolContext } from "./apply-patch-tool";
import { isOpenInWriter, LiveReviewTargetResolutionError } from "../file/live-review-write-guard";
import {
  type ApplyPatchError,
  type ApplyPatchPreflightSummary,
  type ApplyPatchResult,
  type ApplyPatchTrustedContext,
} from "./contract";
import { preflightApplyPatch } from "./preflight";
import { buildRelaySandboxProfile } from "../../relay/sandbox-profile-builder";
import { getRequiredOrdinaryHostContext } from "../../runtime/ordinary-host-dispatch-context";

// Current Folder binding uses the established typed local-file transport,
// which predates the optional v8 apply-patch runtime.
const CURRENT_FOLDER_RELAY_PROTOCOL_VERSION = 4;

export type ApplyPatchRouterContext = Readonly<{
  ownerId: string;
  actorRole: string;
  agentId: string;
  turnId: string;
  roomId: string;
  memoryAccessEnvelope: MemoryAccessEnvelope | null;
  currentFolder: string;
  /** Server-validated Electron identity, bound to Current Folder at ingress. */
  currentFolderRelayId?: string;
  focusedResources: readonly ResolvedFocusedResource[];
}>;

export type ApplyPatchRouterDependencies = Readonly<{
  relayRegistry: ToolRelayRegistry | null;
}>;

type Target =
  | { readonly ok: true; readonly context: Extract<ApplyPatchTrustedContext, { zone: "current" }> }
  | { readonly ok: false; readonly error: ApplyPatchError };

type ApplyPatchTargetSelector = "current" | "workspace";

function failure(
  code: ApplyPatchError["code"],
  message: string,
  retryable = false,
): { readonly ok: false; readonly error: ApplyPatchError } {
  return { ok: false, error: { code, message, retryable } };
}

function canonicalAbsolute(value: string): string | null {
  if (!value || !path.isAbsolute(value) || value.includes("\0")) return null;
  const normalized = path.normalize(value);
  return normalized !== value ? null : normalized;
}

function within(root: string, candidate: string): boolean {
  return root === path.parse(root).root
    ? candidate.startsWith(root)
    : candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Return the one trusted relay bound to this Current Folder. A focused local
 * file pins its originating relay; otherwise the sole paired qualifying
 * Desktop is the binding. Ambiguity never falls back to another target or to
 * Workspace.
 */
function relayCanApplyPatch(
  registry: ToolRelayRegistry,
  relayId: string,
  ownerId: string,
): boolean {
  const capabilities = registry.getCapabilities(relayId);
  return registry.getUserId?.(relayId) === ownerId &&
    (registry.getProtocolVersion?.(relayId) ?? 0) >= APPLY_PATCH_PROTOCOL_VERSION &&
    capabilities?.profile === "desktop-agent" &&
    capabilities.applyPatchExecution === true &&
    typeof registry.applyPatchDispatch === "function";
}

/**
 * Current Folder identity is independent of the optional apply-patch runtime.
 * A paired Desktop that can serve typed local files is the binding candidate;
 * after that identity is established, a missing packaged runtime is reported
 * as `runtime_unavailable`, never as an ambiguous/stale folder.
 */
function relayCanBindCurrentFolder(
  registry: ToolRelayRegistry,
  relayId: string,
  ownerId: string,
): boolean {
  const capabilities = registry.getCapabilities(relayId);
  return registry.getUserId?.(relayId) === ownerId &&
    (registry.getProtocolVersion?.(relayId) ?? 0) >= CURRENT_FOLDER_RELAY_PROTOCOL_VERSION &&
    capabilities?.profile === "desktop-agent" &&
    capabilities.localFileExecution === true;
}

function pinnedCurrentRelay(
  context: ApplyPatchRouterContext,
  root: string,
  registry: ToolRelayRegistry | null,
): string | null {
  const relays = new Set<string>();
  for (const resource of context.focusedResources) {
    if (resource.kind !== "local-file" || resource.toolTarget?.zone !== "current") continue;
    const locator = resource.locator as { relayId?: unknown; path?: unknown } | null;
    if (typeof locator?.relayId !== "string" || typeof locator.path !== "string") continue;
    const focusedPath = canonicalAbsolute(locator.path);
    if (focusedPath !== null && within(root, focusedPath)) relays.add(locator.relayId);
  }
  if (!registry) return null;
  // Focused resources are independently validated bindings. They must agree
  // with each other and with an explicit Current Folder identity; never guess.
  if (context.currentFolderRelayId) {
    if (!relayCanBindCurrentFolder(registry, context.currentFolderRelayId, context.ownerId)) return null;
    return relays.size === 0 || (relays.size === 1 && relays.has(context.currentFolderRelayId))
      ? context.currentFolderRelayId
      : null;
  }
  if (relays.size > 0) {
    const relayId = relays.size === 1 ? [...relays][0]! : null;
    return relayId !== null && relayCanBindCurrentFolder(registry, relayId, context.ownerId)
      ? relayId
      : null;
  }

  // A selected Current Folder is normal Desktop authority even when the user
  // has not attached or focused an individual file. Pin that turn to the sole
  // paired Desktop that can serve local files, independently of whether its
  // optional apply-patch runtime is available. Multiple qualifying Desktops
  // remain ambiguous and fail closed; a focused local-file ref above
  // disambiguates.
  const candidates = registry
    .findByCapabilityForUser("localFileExecution", context.ownerId)
    .filter((relayId) => relayCanBindCurrentFolder(registry, relayId, context.ownerId));
  return candidates.length === 1 ? candidates[0]! : null;
}

function selectCurrentFolderTarget(
  context: ApplyPatchRouterContext,
  dependencies: Pick<ApplyPatchRouterDependencies, "relayRegistry">,
): Target | null {
  if (context.currentFolder.length === 0) return null;
  const root = canonicalAbsolute(context.currentFolder);
  if (root === null) return failure("stale_context", "The bound Current Folder is no longer a canonical absolute folder.");
  const registry = dependencies.relayRegistry;
  const relayId = pinnedCurrentRelay(context, root, registry);
  if (relayId === null) {
    return failure("stale_context", "The bound Current Folder has no single pinned desktop relay.", true);
  }
  if (!registry || !relayCanApplyPatch(registry, relayId, context.ownerId)) {
    return failure("runtime_unavailable", "The pinned Current Folder relay cannot execute apply_patch.", true);
  }
  return { ok: true, context: { zone: "current", root, agentId: context.agentId, turnId: context.turnId, relayId } };
}

function unsupportedWorkspaceTarget(): Target {
  return failure(
    "unsupported_target",
    "Not supported for Workspace artifacts. Please use file.str_replace for contextual edits, file.insert for line insertion, file.write for new or complete replacement, and file.move/file.delete for structural changes.",
  );
}

/**
 * Deterministic target matrix over captured trusted turn state. The model may
 * select only a zone label; it cannot carry a root, relay, room, grant, or
 * artifact authority. Explicit labels never fall back. With no label, one
 * eligible target is selected, while two targets require an explicit choice.
 */
export function selectApplyPatchTarget(
  context: ApplyPatchRouterContext,
  dependencies: Pick<ApplyPatchRouterDependencies, "relayRegistry">,
  requestedTarget?: ApplyPatchTargetSelector,
): Target {
  // Keep the public selector for compatibility and return actionable guidance.
  // This denial happens before patch parsing, namespace authorization, artifact
  // lookup, storage materialization, or native-runtime resolution.
  if (requestedTarget === "workspace") return unsupportedWorkspaceTarget();
  if (context.actorRole === "guest" || !context.ownerId || !context.agentId || !context.turnId) {
    return failure("missing_context", "apply_patch is unavailable for this actor context.");
  }
  if (requestedTarget === "current") {
    const current = selectCurrentFolderTarget(context, dependencies);
    return current ?? failure("missing_context", "apply_patch requires a bound Current Folder.");
  }
  const current = selectCurrentFolderTarget(context, dependencies);
  if (current?.ok) return current;
  // Preserve concrete Current Folder denials. Workspace presence must never
  // turn a stale or unavailable local binding into a server-side fallback.
  if (current && !current.ok) return current;
  if (isNamespaceMemoryEnvelope(context.memoryAccessEnvelope)) {
    return unsupportedWorkspaceTarget();
  }
  return failure("missing_context", "apply_patch requires a bound Current Folder.");
}

/**
 * These are lexical candidates only. The injected live-review guard resolves
 * each through the already pinned relay before it queries Writer sessions;
 * this router deliberately adds no containment or filesystem policy.
 */
function currentFolderApplyPatchCandidatePaths(
  root: string,
  preflight: ApplyPatchPreflightSummary,
): readonly string[] {
  const paths = new Set<string>();
  for (const operation of preflight.operations) {
    if (operation.operation === "move") paths.add(path.resolve(root, operation.fromPath));
    paths.add(path.resolve(root, operation.path));
  }
  return [...paths];
}

function bindRelayResultToTurn(input: {
  result: RelayLocalApplyPatchResult;
  context: Extract<ApplyPatchTrustedContext, { zone: "current" }>;
}): ApplyPatchResult | { readonly ok: false; readonly error: ApplyPatchError } {
  if (input.result.turnId !== input.context.turnId) return failure("stale_context", "The pinned relay returned a result for another turn.");
  // InMemoryRelayRegistry parses this strict public-result mirror and Desktop
  // reconciliation has already attached revisions and redacted local paths.
  // Do not parse the patch or normalize it again here: redacted/absolute
  // presentation paths intentionally no longer equal raw patch-relative paths.
  return input.result as ApplyPatchResult;
}

/** Construct the execution port used by every catalog factory site. */
export function createApplyPatchExecutionRouter(
  context: ApplyPatchRouterContext,
  dependencies: ApplyPatchRouterDependencies,
): ApplyPatchExecutionPort {
  return {
    execute: async ({ patch, target: requestedTarget }) => {
      const requiredHost = getRequiredOrdinaryHostContext();
      const executionContext = requiredHost?.currentFolderRoot
        ? {
            ...context,
            currentFolder: requiredHost.currentFolderRoot,
            currentFolderRelayId: requiredHost.relayId,
          }
        : context;
      const target = selectApplyPatchTarget(executionContext, dependencies, requestedTarget);
      if (!target.ok) return target;
      // One shared parser result derives the read-only Writer-session
      // candidates before Desktop resolves Current Folder authority locally.
      const preflight = preflightApplyPatch(patch);
      if (!preflight.ok) return preflight;
      let writerTargetOpen: boolean | null;
      try {
        writerTargetOpen = await isOpenInWriter({
          surface: "currentFolder",
          ownerId: executionContext.ownerId,
          relayId: target.context.relayId,
          candidatePaths: currentFolderApplyPatchCandidatePaths(target.context.root, preflight.summary),
        });
      } catch (error) {
        if (error instanceof LiveReviewTargetResolutionError) {
          return error.code === "local_target_forbidden"
            ? failure("denied_path", "The patch destination is outside the authorized local roots or could not be resolved within them. Use the intended path in Current Folder. For a Workspace report, use file with zone workspace.")
            : failure("runtime_unavailable", "The selected Desktop connection is unavailable for checking the patch destination.", true);
        }
        return failure("runtime_unavailable", "Writer-session authority is unavailable for apply_patch.", true);
      }
      if (writerTargetOpen === null) {
        return failure("runtime_unavailable", "Writer-session authority is unavailable for apply_patch.", true);
      }
      if (writerTargetOpen) {
        return failure(
          "human_edit_conflict",
          "A target has an active human edit. Reread the current document and construct a new patch; do not resend this patch.",
          false,
        );
      }
      const registry = dependencies.relayRegistry;
      if (!registry?.applyPatchDispatch) {
        return failure("runtime_unavailable", "The pinned Current Folder relay cannot dispatch apply_patch.", true);
      }
      const request: RelayLocalApplyPatchRequest = {
        operation: {
          kind: "apply_patch",
          version: 1,
          patch,
          // Agent identity is graph-authenticated state, never grant scope or
          // model-authored request data. Desktop uses it for revision rows.
          routing: { zone: "current", turnId: target.context.turnId, agentId: context.agentId },
        },
        // Assertion only. Desktop compares this with Electron main's live
        // selection and derives the actual filesystem root locally.
        expectedCurrentFolder: target.context.root,
      };
      const relayCapabilities = registry.getCapabilities(target.context.relayId);
      const sandboxProfile: RelaySandboxProfile | null = relayCapabilities == null
        ? null
        : buildRelaySandboxProfile({
            posture: resolveServerPosture(),
            relayCaps: relayCapabilities,
            currentFolder: target.context.root,
            extraWritablePaths: [],
            extraNetworkAllowRules: [],
          });
      if (sandboxProfile === null) {
        return failure(
          "runtime_unavailable",
          "The pinned Current Folder relay has no valid sandbox envelope for apply_patch.",
          true,
        );
      }
      try {
        const result = await registry.applyPatchDispatch(target.context.relayId, request, {
          sandboxProfile,
          ...(requiredHost?.requiredRelaySessionId !== undefined
            ? {
                requiredRelaySessionId: requiredHost.requiredRelaySessionId,
                requiredDesktopSessionId: requiredHost.requiredDesktopSessionId,
                requiredPairingGeneration: requiredHost.requiredPairingGeneration,
              }
            : {}),
        });
        return bindRelayResultToTurn({ result, context: target.context });
      } catch (error) {
        const stableCode = (error as { applyPatchErrorCode?: unknown }).applyPatchErrorCode;
        const failureReason = (error as { applyPatchFailureReason?: unknown }).applyPatchFailureReason;
        if (stableCode === "stale_context" || stableCode === "denied_path" ||
            stableCode === "human_edit_conflict" ||
            stableCode === "reapply_required" ||
            stableCode === "runtime_unavailable" || stableCode === "parse_error" || stableCode === "invalid_request") {
          return failure(
            stableCode,
            stableCode === "reapply_required" || stableCode === "human_edit_conflict"
              ? stableCode === "human_edit_conflict"
                ? "A document has an active human edit. Reread the current document and construct a new patch; do not resend this patch."
                : "The document changed while apply_patch was prepared. Reread the current document and construct a new patch; do not resend this patch."
              : stableCode === "stale_context" && failureReason === "stale_current_folder"
                ? "The Current Folder changed while apply_patch was prepared. Retry against the newly selected folder."
                : "The pinned Current Folder relay rejected apply_patch.",
            stableCode === "runtime_unavailable",
          );
        }
        return failure("runtime_unavailable", "The pinned Current Folder relay could not execute apply_patch.", true);
      }
    },
  };
}

/** Narrow helper used by pre-model, agent, and tools catalog factory contexts. */
export function buildApplyPatchToolContext(
  context: ApplyPatchRouterContext,
  dependencies: ApplyPatchRouterDependencies,
): ApplyPatchToolContext {
  return { applyPatchExecutionPort: createApplyPatchExecutionRouter(context, dependencies) };
}
