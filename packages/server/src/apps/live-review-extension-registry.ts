import type { MiniAppManifest } from "./app-manifest";
import type { LiveDocumentReadCoverageFact } from "@nautilo/types";

/**
 * Trusted, boot-time policy for whether an active live app may lend its
 * operations to an immediate background Task. This is deliberately part of
 * the same extension that owns the live surface: manifests and agent input
 * can neither opt an app in nor widen its operation set.
 */
export type LiveTaskDelegationPolicy =
  | {
      readonly mode: "eligible";
      /** Exact manifest tool ids permitted for a delegated live session. */
      readonly liveToolIds: readonly string[];
    }
  | {
      readonly mode: "direct_only";
    };

export type LiveReviewExtension = {
  readonly appId: string;
  readonly liveToolIds: readonly string[];
  readonly taskDelegation: LiveTaskDelegationPolicy;
  readonly guidance?: string;
  readonly proposalToolId: string;
  readonly locatorToolId: string;
  locatorHandleForOperation(operation: unknown): string | null;
  resolveLocatorOperation(
    payload: unknown,
    operation: unknown,
  ): { ok: true; operation: unknown } | { ok: false; code: string; message: string };
  locatorPayloadFromResult(result: unknown):
    | { ok: true; payload: unknown; publicResult: Record<string, unknown> }
    | { ok: false; publicResult?: Record<string, unknown> };
  /**
   * Classifies a successful canonical read into non-authorizing structural
   * coverage. The app owns this because only it understands its document and
   * pagination semantics; generic routes merely record the returned fact.
   */
  readCoverageFactFromResult?(input: {
    canonicalContent: string;
    args: Readonly<Record<string, unknown>>;
    result: unknown;
  }): LiveDocumentReadCoverageFact | null;
  preflightProposal(
    canonicalContent: string,
    operations: unknown[],
  ):
    | { ok: true; operations: readonly unknown[]; operationMetadata: readonly unknown[] }
    | {
        ok: false;
        error: {
          code: string;
          operationIndex?: number;
          conflictingOperationIndexes?: number[];
          message: string;
        };
      };
};

export type LiveDirectMutationExtension = {
  readonly appId: string;
  readonly mode: "direct_mutation";
  readonly liveToolIds: readonly string[];
  readonly taskDelegation: LiveTaskDelegationPolicy;
  /** Subset permitted to receive host-only bound-write authority. */
  readonly directMutationToolIds: readonly string[];
  /** The trusted tool context supplies the opaque session token/version. */
  readonly hostOwnsSessionBinding?: boolean;
  /** Direct mutation keys are derived from the frozen binding and operation fingerprint. */
  readonly hostOwnsIdempotencyKey?: boolean;
  readonly guidance?: string;
  /** UI-only commands may coexist with ordinary snapshot document tools. */
  readonly allowSnapshotWrites?: boolean;
  readonly sessionCommands?: {
    readonly toolIds: readonly string[];
    parseCommand(value: unknown): unknown;
    parseResult(value: unknown): unknown;
  };
  /**
   * First-party-only semantic validation of a frozen direct-mutation request
   * against authoritative canonical bytes after an artifact version drift.
   * It may allow the exact original request or return bounded public conflict
   * evidence; it can never rewrite model-supplied arguments.
   */
  rebaseStaleDirectMutation?(input: {
    canonicalContent: string;
    frozenArgs: Readonly<Record<string, unknown>>;
  }):
    | { status: "allow_current_binding" }
    | {
        status: "semantic_conflict";
        conflicts: readonly {
          handle: string;
          propertyGroups: readonly string[];
        }[];
        conflictCount: number;
        omittedConflictCount: number;
      };
};

export type LiveAppSessionExtension = LiveReviewExtension | LiveDirectMutationExtension;

const extensions = new Map<string, LiveAppSessionExtension>();

export function registerFirstPartyLiveReviewExtension(extension: LiveAppSessionExtension): void {
  if (extensions.has(extension.appId)) throw new Error(`duplicate live review extension: ${extension.appId}`);
  extensions.set(extension.appId, extension);
}

/** Boot-time, first-party-only registry. Manifest data can request this service
 * but cannot add entries or choose executable code. */
export function getLiveReviewExtension(appId: string): LiveReviewExtension | null {
  const extension = extensions.get(appId);
  return extension && isProposalLiveReviewExtension(extension) ? extension : null;
}

export function getLiveAppSessionExtension(appId: string): LiveAppSessionExtension | null {
  return extensions.get(appId) ?? null;
}

/**
 * Returns the exact live manifest operations that a Task may inherit for this
 * registered app, or null when the app is unregistered, direct-only, or has
 * an invalid trusted declaration. Callers must still verify the raw session
 * binding before creation, dispatch, and every tool invocation.
 */
export function getLiveTaskDelegationToolIds(appId: string): readonly string[] | null {
  const extension = getLiveAppSessionExtension(appId);
  if (!extension || extension.taskDelegation.mode !== "eligible") return null;
  const toolIds = extension.taskDelegation.liveToolIds;
  if (
    toolIds.length === 0 ||
    new Set(toolIds).size !== toolIds.length ||
    toolIds.some((toolId) => !extension.liveToolIds.includes(toolId))
  ) return null;
  return Object.freeze([...toolIds]);
}

/** The host uses this closed, boot-time registry to protect every active live surface. */
export function getRegisteredLiveReviewAppIds(): readonly string[] {
  return [...extensions.values()].filter((extension) =>
    !isDirectMutationLiveReviewExtension(extension) || extension.allowSnapshotWrites !== true,
  ).map((extension) => extension.appId);
}

export function isProposalLiveReviewExtension(
  extension: LiveAppSessionExtension,
): extension is LiveReviewExtension {
  return "proposalToolId" in extension;
}

export function isDirectMutationLiveReviewExtension(
  extension: LiveAppSessionExtension,
): extension is LiveDirectMutationExtension {
  return "mode" in extension && extension.mode === "direct_mutation";
}

export function isLiveReviewEnabled(manifest: MiniAppManifest): boolean {
  return manifest.liveReview?.enabled === true && getLiveAppSessionExtension(manifest.id) !== null;
}
