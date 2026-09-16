import {
  canRelayExecuteBrowserResearchRead,
  canRelayExecuteBrowserResearchConsentRecovery,
  canRelayExecuteBrowserResearchSnapshotInspection,
  canRelayExecuteBrowserResearchSearch,
  parseRelayBrowserResearchReadRequest,
  parseRelayBrowserResearchReadResult,
  parseRelayBrowserResearchConsentRecoveryRequest,
  parseRelayBrowserResearchConsentRecoveryResult,
  parseRelayBrowserResearchSnapshotInspectionRequest,
  parseRelayBrowserResearchSnapshotInspectionResult,
  parseRelayBrowserResearchSearchRequest,
  parseRelayBrowserResearchSearchResult,
  type BrowserResearchSearchResult,
  type BrowserResearchConsentRecoveryResult,
  type RelayBrowserResearchConsentRecoveryRequest,
  type BrowserPageReadResult,
  type BrowserPageSnapshotInspectionRequest,
  type BrowserPageSnapshotInspectionResult,
  type RelayBrowserResearchReadRequest,
  type RelayBrowserResearchSnapshotInspectionRequest,
  type RelayBrowserResearchSearchRequest,
  type RelayCapabilities,
} from "@nautilo/relay";
import type { VerifiedOrdinaryOrigin } from "@nautilo/types";

/** Narrow server-only registry seam for the exact background Browser reader. */
export interface BrowserResearchExecutionRegistry {
  getCapabilities(relayId: string): RelayCapabilities | null | undefined;
  getProtocolVersion?(relayId: string): number | null | undefined;
  getUserId?(relayId: string): string | null | undefined;
  browserResearchReadDispatch?(
    relayId: string,
    actorId: string,
    request: RelayBrowserResearchReadRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<BrowserPageReadResult>;
  browserResearchSnapshotInspectionDispatch?(
    relayId: string,
    actorId: string,
    request: RelayBrowserResearchSnapshotInspectionRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<BrowserPageSnapshotInspectionResult>;
  browserResearchConsentRecoveryDispatch?(
    relayId: string,
    actorId: string,
    request: RelayBrowserResearchConsentRecoveryRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<BrowserResearchConsentRecoveryResult>;
  browserResearchSearchDispatch?(
    relayId: string,
    actorId: string,
    request: RelayBrowserResearchSearchRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<BrowserResearchSearchResult>;
}

export type BrowserResearchExecutionResult =
  | { readonly category: "success"; readonly result: BrowserPageReadResult }
  | { readonly category: "unavailable" | "unsupported" | "lost" | "cancelled" | "alternate" | "expired" | "consent_wall" | "error" };

export type BrowserResearchSnapshotInspectionExecutionResult =
  | { readonly category: "success"; readonly result: BrowserPageSnapshotInspectionResult }
  | { readonly category: "unavailable" | "unsupported" | "lost" | "cancelled" | "expired" | "evicted" | "snapshot_unavailable" | "invalid_offset" | "resource_limit" | "error" };

/** Trusted execution capability handed only to the invocation-time tool factory. */
export interface BrowserResearchExecutionPort {
  read(input: BrowserResearchExecutionReadInput): Promise<BrowserResearchExecutionResult>;
  /** Optional for compatibility with injected pre-v13 test/adaptor ports. */
  inspectSnapshot?(input: BrowserResearchSnapshotInspectionExecutionInput): Promise<BrowserResearchSnapshotInspectionExecutionResult>;
  recoverConsent?(input: { readonly consentRecovery: RelayBrowserResearchConsentRecoveryRequest["consentRecovery"]; readonly signal?: AbortSignal }): Promise<BrowserResearchConsentRecoveryExecutionResult>;
  search?(input: { readonly query: string; readonly maxResults: number; readonly signal?: AbortSignal }): Promise<BrowserResearchSearchExecutionResult>;
}

export type BrowserResearchConsentRecoveryExecutionResult =
  | { readonly category: "success"; readonly result: BrowserResearchConsentRecoveryResult }
  | { readonly category: "unavailable" | "unsupported" | "lost" | "cancelled" | "expired" | "error" };

export type BrowserResearchSearchExecutionResult =
  | { readonly category: "success"; readonly result: BrowserResearchSearchResult }
  | { readonly category: "unavailable" | "unsupported" | "lost" | "cancelled" | "error" };

export type BrowserResearchExecutionReadInput = Readonly<
  | {
      url: string;
      maxChars?: number;
      challengeBehavior?: "intervene" | "defer";
      consentActions?: readonly string[];
      signal?: AbortSignal;
    }
  | {
      continuation: {
        version: 1;
        reference: string;
        offsetCharacters: number;
        mode: "page" | "remainder";
      };
      maxChars?: number;
      signal?: AbortSignal;
    }
>;

export type BrowserResearchSnapshotInspectionExecutionInput = Readonly<{
  snapshot: BrowserPageSnapshotInspectionRequest;
  signal?: AbortSignal;
}>;

export interface BrowserResearchExecutionContext {
  readonly ownerId: string;
  readonly actorRole: string;
  readonly verifiedOrdinaryOrigin: VerifiedOrdinaryOrigin | null | undefined;
  readonly relayRegistry: BrowserResearchExecutionRegistry | null;
  readonly toolCallId: string;
  readonly laneKey: string;
  readonly turnId?: string | undefined;
  readonly authorAgentId?: string | undefined;
}

function hasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Builds D504's narrow, exact-relay execution port. The verified local
 * Electron origin chooses the relay once; this code never discovers or falls
 * back to another host.
 */
export function createBrowserResearchExecutionPort(
  context: BrowserResearchExecutionContext,
): BrowserResearchExecutionPort {
  return {
    async recoverConsent(input): Promise<BrowserResearchConsentRecoveryExecutionResult> {
      if (hasAborted(input.signal)) return { category: "cancelled" };
      if (context.actorRole === "guest" || context.ownerId.length === 0) return { category: "unavailable" };
      const origin = context.verifiedOrdinaryOrigin;
      if (!origin || origin.kind !== "local_electron" || origin.userId !== context.ownerId) return { category: "unsupported" };
      const registry = context.relayRegistry;
      if (!registry || !origin.relayId) return { category: "unavailable" };
      const registeredUserId = registry.getUserId?.(origin.relayId);
      if (registeredUserId === null || registeredUserId === undefined) return { category: "lost" };
      if (registeredUserId !== context.ownerId) return { category: "unavailable" };
      const capabilities = registry.getCapabilities(origin.relayId);
      const protocolVersion = registry.getProtocolVersion?.(origin.relayId);
      if (!capabilities || protocolVersion === null || protocolVersion === undefined ||
        !canRelayExecuteBrowserResearchConsentRecovery(protocolVersion, capabilities) ||
        typeof registry.browserResearchConsentRecoveryDispatch !== "function") return { category: "unsupported" };
      const parsedRequest = parseRelayBrowserResearchConsentRecoveryRequest({
        consentRecovery: input.consentRecovery,
        toolCallId: context.toolCallId,
        laneKey: context.laneKey,
        ...(context.turnId ? { turnId: context.turnId } : {}),
        ...(context.authorAgentId ? { authorAgentId: context.authorAgentId } : {}),
      });
      if (!parsedRequest.ok) return { category: "error" };
      try {
        const result = await registry.browserResearchConsentRecoveryDispatch(
          origin.relayId, context.ownerId, parsedRequest.request,
          { timeoutMs: 60_000, ...(input.signal ? { signal: input.signal } : {}) },
        );
        if (hasAborted(input.signal)) return { category: "cancelled" };
        const parsedResult = parseRelayBrowserResearchConsentRecoveryResult(result);
        return parsedResult.ok ? { category: "success", result: parsedResult.result } : { category: "error" };
      } catch (error) {
        if (hasAborted(input.signal) || isAbortError(error)) return { category: "cancelled" };
        const code = (error as { browserResearchConsentRecoveryErrorCode?: unknown }).browserResearchConsentRecoveryErrorCode;
        if (code === "expired") return { category: "expired" };
        if (code === "operation_failed" || code === "invalid_result") return { category: "error" };
        if (code === "runtime_unavailable" || code === "transport_failed") return { category: "lost" };
        return { category: "error" };
      }
    },
    async search(input): Promise<BrowserResearchSearchExecutionResult> {
      if (hasAborted(input.signal)) return { category: "cancelled" };
      if (context.actorRole === "guest" || context.ownerId.length === 0) return { category: "unavailable" };
      const origin = context.verifiedOrdinaryOrigin;
      if (!origin || origin.kind !== "local_electron" || origin.userId !== context.ownerId) return { category: "unavailable" };
      const registry = context.relayRegistry;
      if (!registry || !origin.relayId) return { category: "unavailable" };
      const registeredUserId = registry.getUserId?.(origin.relayId);
      if (registeredUserId === null || registeredUserId === undefined) return { category: "lost" };
      if (registeredUserId !== context.ownerId) return { category: "unavailable" };
      const capabilities = registry.getCapabilities(origin.relayId);
      const protocolVersion = registry.getProtocolVersion?.(origin.relayId);
      if (!capabilities || protocolVersion === null || protocolVersion === undefined ||
        !canRelayExecuteBrowserResearchSearch(protocolVersion, capabilities) ||
        typeof registry.browserResearchSearchDispatch !== "function") return { category: "unsupported" };
      const parsedRequest = parseRelayBrowserResearchSearchRequest({
        provider: "duckduckgo_html",
        query: input.query,
        maxResults: input.maxResults,
        toolCallId: context.toolCallId,
        laneKey: context.laneKey,
        ...(context.turnId ? { turnId: context.turnId } : {}),
        ...(context.authorAgentId ? { authorAgentId: context.authorAgentId } : {}),
      });
      if (!parsedRequest.ok) return { category: "error" };
      try {
        const result = await registry.browserResearchSearchDispatch(origin.relayId, context.ownerId, parsedRequest.request, {
          timeoutMs: 60_000,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (hasAborted(input.signal)) return { category: "cancelled" };
        const parsedResult = parseRelayBrowserResearchSearchResult(result);
        return parsedResult.ok ? { category: "success", result: parsedResult.result } : { category: "error" };
      } catch (error) {
        if (hasAborted(input.signal) || isAbortError(error)) return { category: "cancelled" };
        const code = (error as { browserResearchSearchErrorCode?: unknown }).browserResearchSearchErrorCode;
        if (code === "runtime_unavailable" || code === "transport_failed") return { category: "lost" };
        if (code === "cancelled") return { category: "cancelled" };
        return { category: "error" };
      }
    },
    async inspectSnapshot(input): Promise<BrowserResearchSnapshotInspectionExecutionResult> {
      if (hasAborted(input.signal)) return { category: "cancelled" };
      if (context.actorRole === "guest" || context.ownerId.length === 0) return { category: "unavailable" };
      const origin = context.verifiedOrdinaryOrigin;
      if (!origin) return { category: "unavailable" };
      if (origin.kind !== "local_electron") return { category: "unsupported" };
      if (origin.userId !== context.ownerId) return { category: "unavailable" };
      const registry = context.relayRegistry;
      if (!registry || !origin.relayId) return { category: "unavailable" };
      const registeredUserId = registry.getUserId?.(origin.relayId);
      if (registeredUserId === null || registeredUserId === undefined) return { category: "lost" };
      if (registeredUserId !== context.ownerId) return { category: "unavailable" };
      const capabilities = registry.getCapabilities(origin.relayId);
      const protocolVersion = registry.getProtocolVersion?.(origin.relayId);
      if (!capabilities || protocolVersion === null || protocolVersion === undefined ||
        !canRelayExecuteBrowserResearchSnapshotInspection(protocolVersion, capabilities) ||
        typeof registry.browserResearchSnapshotInspectionDispatch !== "function") return { category: "unsupported" };
      const parsedRequest = parseRelayBrowserResearchSnapshotInspectionRequest({
        snapshot: input.snapshot,
        toolCallId: context.toolCallId,
        laneKey: context.laneKey,
        ...(context.turnId ? { turnId: context.turnId } : {}),
        ...(context.authorAgentId ? { authorAgentId: context.authorAgentId } : {}),
      });
      if (!parsedRequest.ok) return { category: "error" };
      try {
        const result = await registry.browserResearchSnapshotInspectionDispatch(
          origin.relayId,
          context.ownerId,
          parsedRequest.request,
          { timeoutMs: 30_000, ...(input.signal ? { signal: input.signal } : {}) },
        );
        if (hasAborted(input.signal)) return { category: "cancelled" };
        const parsedResult = parseRelayBrowserResearchSnapshotInspectionResult(result);
        return parsedResult.ok ? { category: "success", result: parsedResult.result } : { category: "error" };
      } catch (error) {
        if (hasAborted(input.signal) || isAbortError(error)) return { category: "cancelled" };
        const code = (error as { browserResearchSnapshotInspectionErrorCode?: unknown })
          .browserResearchSnapshotInspectionErrorCode;
        if (code === "runtime_unavailable" || code === "transport_failed") return { category: "lost" };
        if (code === "expired" || code === "evicted" || code === "invalid_offset" || code === "resource_limit") return { category: code };
        if (code === "unavailable") return { category: "snapshot_unavailable" };
        return { category: "error" };
      }
    },
    async read(input): Promise<BrowserResearchExecutionResult> {
      if (hasAborted(input.signal)) return { category: "cancelled" };
      if (context.actorRole === "guest" || context.ownerId.length === 0) {
        return { category: "unavailable" };
      }

      const origin = context.verifiedOrdinaryOrigin;
      if (!origin) return { category: "unavailable" };
      if (origin.kind !== "local_electron") return { category: "unsupported" };
      if (origin.userId !== context.ownerId) return { category: "unavailable" };

      const registry = context.relayRegistry;
      if (!registry) return { category: "unavailable" };
      const relayId = origin.relayId;
      if (relayId.length === 0) return { category: "unavailable" };
      const registeredUserId = registry.getUserId?.(relayId);
      if (registeredUserId === null || registeredUserId === undefined) return { category: "lost" };
      if (registeredUserId !== context.ownerId) return { category: "unavailable" };

      const capabilities = registry.getCapabilities(relayId);
      if (capabilities === null || capabilities === undefined) return { category: "lost" };
      if ("consentActions" in input && input.consentActions?.length && capabilities.canReplayResearchConsent !== true) {
        return { category: "unsupported" };
      }
      const protocolVersion = registry.getProtocolVersion?.(relayId);
      if (protocolVersion === null || protocolVersion === undefined ||
          !canRelayExecuteBrowserResearchRead(protocolVersion, capabilities) ||
          typeof registry.browserResearchReadDispatch !== "function") {
        return { category: "unsupported" };
      }

      const invocationIdentity = {
        toolCallId: context.toolCallId,
        laneKey: context.laneKey,
        ...(context.turnId ? { turnId: context.turnId } : {}),
        ...(context.authorAgentId ? { authorAgentId: context.authorAgentId } : {}),
      };
      const parsedRequest = parseRelayBrowserResearchReadRequest("continuation" in input
        ? {
            continuation: input.continuation,
            ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
            ...invocationIdentity,
          }
        : {
            url: input.url,
            ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
            ...(input.challengeBehavior === "defer" && capabilities.canDeferResearchChallenges === true
              ? { challengeBehavior: "defer" }
              : {}),
            ...(input.consentActions?.length ? { consentActions: input.consentActions } : {}),
            ...invocationIdentity,
          });
      if (!parsedRequest.ok) return { category: "error" };
      if (hasAborted(input.signal)) return { category: "cancelled" };

      try {
        const result = await registry.browserResearchReadDispatch(relayId, context.ownerId, parsedRequest.request, {
          timeoutMs: 11 * 60_000,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (hasAborted(input.signal)) return { category: "cancelled" };
        const parsedResult = parseRelayBrowserResearchReadResult(result);
        return parsedResult.ok
          ? { category: "success", result: parsedResult.result }
          : { category: "error" };
      } catch (error) {
        if (hasAborted(input.signal) || isAbortError(error)) return { category: "cancelled" };
        const code = (error as { browserResearchReadErrorCode?: unknown })
          .browserResearchReadErrorCode;
        if (code === "runtime_unavailable" || code === "transport_failed") {
          return { category: "lost" };
        }
        if (code === "cancelled") return { category: "cancelled" };
        if (code === "alternate") return { category: "alternate" };
        if (code === "expired") return { category: "expired" };
        if (code === "consent_wall") return { category: "consent_wall" };
        return { category: "error" };
      }
    },
  };
}
