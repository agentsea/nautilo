import { createHash } from "node:crypto";
import type { ToolCall } from "@langchain/core/messages/tool";
import { RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION } from "@nautilo/relay";
import type {
  DesktopAutomationProvider,
  DesktopAutomationProvenance,
  VerifiedOrdinaryOrigin,
} from "@nautilo/types";
import {
  computerUseHostToolDefinition,
  resolveComputerUseHostToolRequest,
} from "../config/computer-use-catalogue/host-tool-admission";
import type { TrustedExecutionEntrypoint } from "../agent/state";
import {
  MAX_DESKTOP_AUTOMATION_GRANT_GENERATION,
  parseDesktopAutomationOpaqueId,
} from "@nautilo/types";

/**
 * D516 — semantic computer-use admission is deliberately separate from the
 * generic approval machinery. These are the only names reserved for the
 * computer-use protocol; an unknown `computer_*` name is denied by the
 * caller rather than falling into a generic approval path.
 */
export function isComputerUseToolName(toolName: string): boolean {
  return /^computer_[a-z0-9_]+$/.test(toolName);
}

export function isSupportedComputerUseToolName(toolName: string): boolean {
  return computerUseHostToolDefinition(toolName) !== null;
}

/** Server-owned request canonicalization. Relay and Desktop never parse tool semantics. */
function canonicalizeComputerUseToolArgs(toolName: string, args: unknown): string | null {
  const hostRequest = resolveComputerUseHostToolRequest(toolName, args);
  return hostRequest === null ? null : JSON.stringify(hostRequest.arguments);
}

/** Exact active-catalogue request for the generic Host lane. */
export function resolveComputerUseHostInvocationRequest(toolName: string, args: unknown) {
  return resolveComputerUseHostToolRequest(toolName, args);
}

/** Exact server-to-Electron binding. This is opaque to the model. */
export interface ComputerUseInvocationBinding {
  readonly version: typeof RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION;
  readonly computerUseContextId: string;
  readonly computerUseInvocationId: string;
  readonly relayId: string;
  /** Hashed pairing-generation reference; never the raw token-row id. */
  readonly pairingGeneration: string;
  readonly desktopSessionId: string;
  readonly originHumanId: string;
  readonly originRunId: string;
  readonly originAgentId: string;
  readonly lineageId: string;
  readonly installationEpoch: string;
  readonly grantGeneration: number;
  readonly provider: DesktopAutomationProvider;
  readonly providerGeneration: string;
}

const COMPUTER_USE_INVOCATION_BINDING_KEYS = [
  "computerUseContextId",
  "computerUseInvocationId",
  "desktopSessionId",
  "grantGeneration",
  "installationEpoch",
  "lineageId",
  "originAgentId",
  "originHumanId",
  "originRunId",
  "pairingGeneration",
  "provider",
  "providerGeneration",
  "relayId",
  "version",
] as const;

/** Strict checkpoint parser: a widened or malformed binding is no authority. */
export function parseComputerUseInvocationBinding(
  value: unknown,
): ComputerUseInvocationBinding | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.getOwnPropertyNames(record).sort();
  if (
    Object.getOwnPropertySymbols(record).length !== 0
    || record["version"] !== RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION
    || keys.length !== COMPUTER_USE_INVOCATION_BINDING_KEYS.length
    || !keys.every((key, index) => key === COMPUTER_USE_INVOCATION_BINDING_KEYS[index])
  ) return null;
  const opaqueKeys = [
    "computerUseContextId",
    "computerUseInvocationId",
    "desktopSessionId",
    "installationEpoch",
    "lineageId",
    "originAgentId",
    "originHumanId",
    "originRunId",
    "pairingGeneration",
    "providerGeneration",
    "relayId",
  ] as const;
  if (opaqueKeys.some((key) => parseDesktopAutomationOpaqueId(record[key]) === null)) return null;
  const grantGeneration = record["grantGeneration"];
  if (
    typeof grantGeneration !== "number"
    || !Number.isSafeInteger(grantGeneration)
    || grantGeneration < 1
    || grantGeneration > MAX_DESKTOP_AUTOMATION_GRANT_GENERATION
    || record["provider"] !== "cua"
  ) return null;
  return Object.freeze({
    version: RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION,
    computerUseContextId: record["computerUseContextId"] as string,
    computerUseInvocationId: record["computerUseInvocationId"] as string,
    relayId: record["relayId"] as string,
    pairingGeneration: record["pairingGeneration"] as string,
    desktopSessionId: record["desktopSessionId"] as string,
    originHumanId: record["originHumanId"] as string,
    originRunId: record["originRunId"] as string,
    originAgentId: record["originAgentId"] as string,
    lineageId: record["lineageId"] as string,
    installationEpoch: record["installationEpoch"] as string,
    grantGeneration,
    provider: record["provider"],
    providerGeneration: record["providerGeneration"] as string,
  });
}

/** Recompute the server-derived exact semantic request identity at dispatch. */
export function deriveComputerUseInvocationId(
  computerUseContextId: string,
  toolCall: Pick<ToolCall, "id" | "name" | "args">,
): string | null {
  if (
    parseDesktopAutomationOpaqueId(computerUseContextId) === null
    || !toolCall.id
    || parseDesktopAutomationOpaqueId(toolCall.id) === null
    || !isSupportedComputerUseToolName(toolCall.name)
  ) return null;
  const canonicalArgs = canonicalizeComputerUseToolArgs(toolCall.name, toolCall.args);
  if (canonicalArgs === null) return null;
  const digest = createHash("sha256")
    .update(JSON.stringify([1, computerUseContextId, toolCall.id, toolCall.name, canonicalArgs]))
    .digest("base64url");
  return `computer-invocation:${digest}`;
}

export function parseComputerUseInvocationBindings(
  value: unknown,
): Readonly<Record<string, ComputerUseInvocationBinding>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return Object.freeze({});
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  if (Object.getOwnPropertySymbols(record).length !== 0 || entries.length > 128) return Object.freeze({});
  const parsed: Record<string, ComputerUseInvocationBinding> = {};
  for (const [toolCallId, binding] of entries) {
    if (parseDesktopAutomationOpaqueId(toolCallId) === null) return Object.freeze({});
    const exact = parseComputerUseInvocationBinding(binding);
    if (exact === null) return Object.freeze({});
    parsed[toolCallId] = exact;
  }
  return Object.freeze(parsed);
}

export interface ComputerUseRootGrantRequest {
  readonly userId: string;
  readonly actorId: string;
  readonly causalHumanUserId: string;
  readonly agentId: string;
  readonly trustedExecutionEntrypoint: "foreground.main";
  readonly verifiedOrdinaryOrigin: VerifiedOrdinaryOrigin | null;
}

/**
 * A detached or differently-originated run cannot borrow a standing Desktop
 * grant. This is deliberately a result, not an approval request: the caller
 * must begin a new eligible foreground Human run before it may reissue the
 * original tool call.
 *
 * The original AIMessage remains the sole holder of semantic arguments. A
 * `needs_user` response carries its exact call identity and tool name, but
 * never mirrors raw arguments (which may later include typed text).
 */
export interface ComputerUseNeedsUserIntent {
  /** Signed-catalogue model name retained only as call identity, not semantics. */
  readonly toolName: string;
  readonly toolCallId: string;
}

export interface ComputerUseNeedsUserDecision {
  readonly status: "needs_user";
  readonly reason: "foreground_human_run_required" | "foreground_human_provenance_required";
  readonly intent: ComputerUseNeedsUserIntent;
}

export type ComputerUseRootGrantDecision =
  | {
      readonly status: "admitted";
      readonly originHumanId: string;
      readonly originAgentId: string;
      readonly installationEpoch: string;
      readonly grantGeneration: number;
      readonly provider: DesktopAutomationProvider;
      readonly providerGeneration: string;
    }
  | { readonly status: "denied"; readonly reason: string };

/** Server-owned live-relay port used only at fresh foreground ingress. */
export type ComputerUseRootGrantResolver = (
  request: ComputerUseRootGrantRequest,
) => ComputerUseRootGrantDecision | Promise<ComputerUseRootGrantDecision>;

/** Server-only evidence supplied to a semantic computer-use resolver. */
export interface ComputerUseAdmissionRequest {
  readonly userId: string;
  readonly actorId: string;
  readonly causalHumanUserId: string;
  readonly agentId: string;
  readonly trustedExecutionEntrypoint: TrustedExecutionEntrypoint | null | undefined;
  readonly verifiedOrdinaryOrigin: VerifiedOrdinaryOrigin | null | undefined;
  readonly desktopAutomationProvenance: DesktopAutomationProvenance | null | undefined;
  readonly desktopAutomationRouteBinding: import("@nautilo/types").DesktopAutomationRouteBinding | null | undefined;
  readonly toolCall: ToolCall;
}

export type ComputerUseAdmissionDecision =
  | { readonly status: "admitted"; readonly binding: ComputerUseInvocationBinding }
  | ComputerUseNeedsUserDecision
  | { readonly status: "denied"; readonly reason: string };

/**
 * Server-owned port. The agent runtime never reads relay state, durable
 * receipts, or pairing persistence itself.
 */
export type ComputerUseAdmissionResolver = (
  request: ComputerUseAdmissionRequest,
) => ComputerUseAdmissionDecision | Promise<ComputerUseAdmissionDecision>;
