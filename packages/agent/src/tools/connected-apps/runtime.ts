import type { ConnectedAppProviderId, ConnectedAppToolReceipt } from "@nautilo/types";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { causalHumanForExecution } from "../../runtime/causal-human-context";

export interface ConnectedAppToolScope {
  readonly userId: string;
  readonly namespaceId: string;
}

export interface ConnectedAppToolActor extends ConnectedAppToolScope {
  readonly causalHumanUserId: string;
  /** Existing resolved invocation authority; never synthesized by this tool. */
  readonly memoryAccessEnvelope: MemoryAccessEnvelope;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Connected-app authority is exact Human×Namespace authority. Scope-mode
 * memory has no single writable Namespace, so it is deliberately ineligible.
 */
export function connectedAppScopeFromContext(context: Record<string, unknown> | undefined): ConnectedAppToolScope | null {
  const userId = nonEmpty(context?.["userId"]) ?? nonEmpty(context?.["ownerId"]);
  const envelope = context?.["memoryAccessEnvelope"] as {
    memoryMode?: string;
    writableNamespaces?: unknown;
  } | null | undefined;
  const namespaceId = envelope?.memoryMode === "scope"
    ? null
    : Array.isArray(envelope?.writableNamespaces)
      ? nonEmpty(envelope.writableNamespaces[0])
      : null;
  return userId && namespaceId ? { userId, namespaceId } : null;
}

export function connectedAppActorFromContext(context: Record<string, unknown> | undefined): ConnectedAppToolActor | null {
  const scope = connectedAppScopeFromContext(context);
  const memoryAccessEnvelope = context?.["memoryAccessEnvelope"] as MemoryAccessEnvelope | null | undefined;
  return scope && memoryAccessEnvelope
    ? { ...scope, causalHumanUserId: causalHumanForExecution(
      typeof context?.["causalHumanUserId"] === "string" ? context["causalHumanUserId"] : "",
    ), memoryAccessEnvelope }
    : null;
}

export interface ConnectedAppActionRuntime {
  /** Refreshes the exact connected-provider snapshot before each model step. */
  eligibleProviderIds?(scope: ConnectedAppToolScope): Promise<readonly ConnectedAppProviderId[]>;
  execute(input: {
    readonly userId: string;
    readonly causalHumanUserId: string;
    readonly namespaceId: string;
    readonly memoryAccessEnvelope: MemoryAccessEnvelope;
    readonly providerId: ConnectedAppProviderId;
    readonly operationId: string;
    readonly effect: "read" | "write";
    readonly input: Record<string, unknown>;
    readonly signal?: AbortSignal | undefined;
  }): Promise<ConnectedAppToolReceipt>;
}

let runtime: ConnectedAppActionRuntime | null = null;

export function setConnectedAppActionRuntime(next: ConnectedAppActionRuntime | null): void {
  runtime = next;
}

export function getConnectedAppActionRuntime(): ConnectedAppActionRuntime | null {
  return runtime;
}

/**
 * A missing runtime, malformed context, or transient profile lookup failure
 * never grants a tool. Execution separately rechecks the profile immediately
 * before dispatch, so a disconnect racing after this snapshot also fails
 * closed.
 */
export async function connectedAppEligibleProviderIdsForContext(
  context: Record<string, unknown> | undefined,
): Promise<readonly ConnectedAppProviderId[]> {
  const scope = connectedAppScopeFromContext(context);
  const activeRuntime = runtime;
  if (!scope || !activeRuntime?.eligibleProviderIds) return [];
  try {
    return [...new Set((await activeRuntime.eligibleProviderIds(scope)).filter((id) =>
      typeof id === "string" && id.length > 0))].sort();
  } catch {
    return [];
  }
}
