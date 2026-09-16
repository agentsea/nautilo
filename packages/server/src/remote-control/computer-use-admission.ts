import { createHash } from "node:crypto";
import { RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION } from "@nautilo/relay";
import {
  deriveComputerUseInvocationId,
  isSupportedComputerUseToolName,
  type PostModelDeps,
} from "@nautilo/agent";
import {
  MAX_DESKTOP_AUTOMATION_GRANT_GENERATION,
  parseDesktopAutomationOpaqueId,
  type DesktopAutomationProvider,
  type DesktopAutomationProvenance,
  type DesktopAutomationRouteBinding,
  type VerifiedLocalElectronOrigin,
} from "@nautilo/types";

/** The redacted grant projection a live Relay may advertise to the server. */
export interface ActiveComputerUseGrantSnapshot {
  readonly enabled: true;
  readonly agentId: string;
  readonly installationEpoch: string;
  readonly grantGeneration: number;
  readonly provider: DesktopAutomationProvider;
  readonly providerGeneration: string;
}

/**
 * A live-relay adapter owns how this is populated. The resolver accepts no
 * advisory client state: it is intentionally an exact current snapshot.
 */
export interface ComputerUseLiveRelaySnapshot {
  readonly relayId: string;
  readonly userId: string;
  /** Server-private raw token-row generation, used only for origin matching. */
  readonly pairingGeneration: string;
  /** One-way reference safe for the relay invocation envelope. */
  readonly pairingGenerationRef: string;
  readonly desktopSessionId: string;
  /** Current Relay capability, re-attested by Electron before it advertises. */
  readonly canControlDesktop: boolean;
  readonly desktopAutomation: ActiveComputerUseGrantSnapshot | null;
}

export interface ComputerUseLiveRelayRegistry {
  snapshotForUser(userId: string): readonly ComputerUseLiveRelaySnapshot[];
}

/**
 * The sole server adapter from post-model requests to D516's pure admission
 * resolvers. Keeping this mapping here lets production and the second-gate
 * regression exercise the same origin narrowing and live-authority checks.
 */
export function createComputerUsePostModelAdmissionResolvers(input: {
  readonly hasCurrentDesktopAutomationAuthority: (
    userId: string,
    agentId: string,
  ) => Promise<boolean>;
  readonly registry: ComputerUseLiveRelayRegistry;
}): {
  readonly resolveComputerUseAdmission: Required<PostModelDeps>["resolveComputerUseAdmission"];
  readonly resolveComputerUseRootGrant: Required<PostModelDeps>["resolveComputerUseRootGrant"];
} {
  return {
    resolveComputerUseAdmission: async (request) => {
      if (!(await input.hasCurrentDesktopAutomationAuthority(request.userId, request.agentId))) {
        return { status: "denied", reason: "desktop automation authority is not current" };
      }
      const origin = request.verifiedOrdinaryOrigin;
      return resolveComputerUseAdmission({
        userId: request.userId,
        actorId: request.actorId,
        causalHumanUserId: request.causalHumanUserId,
        agentId: request.agentId,
        trustedExecutionEntrypoint: request.trustedExecutionEntrypoint,
        // Missing/non-local origin is an ordinary `needs_user` provenance
        // outcome below, never an approval prompt. Only a verified current
        // Electron origin can be positive authority.
        verifiedOrdinaryOrigin: origin?.kind === "local_electron" ? origin : null,
        desktopAutomationProvenance: request.desktopAutomationProvenance,
        desktopAutomationRouteBinding: request.desktopAutomationRouteBinding,
        toolName: request.toolCall.name,
        toolCallId: request.toolCall.id,
        toolArgs: request.toolCall.args,
      }, input.registry);
    },
    resolveComputerUseRootGrant: async (request) => {
      const origin = request.verifiedOrdinaryOrigin;
      if (!origin || origin.kind !== "local_electron") {
        return { status: "denied", reason: "desktop automation requires the current local Desktop" };
      }
      if (!(await input.hasCurrentDesktopAutomationAuthority(request.userId, request.agentId))) {
        return { status: "denied", reason: "desktop automation authority is not current" };
      }
      return resolveComputerUseRootGrant({
        userId: request.userId,
        actorId: request.actorId,
        causalHumanUserId: request.causalHumanUserId,
        agentId: request.agentId,
        trustedExecutionEntrypoint: request.trustedExecutionEntrypoint,
        verifiedOrdinaryOrigin: origin,
      }, input.registry);
    },
  };
}

export interface ComputerUseAdmissionInput {
  readonly userId: string;
  readonly actorId: string;
  readonly causalHumanUserId: string;
  readonly agentId: string;
  readonly trustedExecutionEntrypoint: string | null | undefined;
  readonly verifiedOrdinaryOrigin: VerifiedLocalElectronOrigin | null | undefined;
  readonly desktopAutomationProvenance: DesktopAutomationProvenance | null | undefined;
  readonly desktopAutomationRouteBinding: DesktopAutomationRouteBinding | null | undefined;
  readonly toolName: string;
  readonly toolCallId: string | undefined;
  readonly toolArgs: Record<string, unknown>;
}

export interface ComputerUseRootGrantInput {
  readonly userId: string;
  readonly actorId: string;
  readonly causalHumanUserId: string;
  readonly agentId: string;
  readonly trustedExecutionEntrypoint: string | null | undefined;
  readonly verifiedOrdinaryOrigin: VerifiedLocalElectronOrigin | null | undefined;
}

export type ComputerUseRootGrantResult =
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

export type ComputerUseAdmissionResult =
  | { readonly status: "admitted"; readonly binding: ComputerUseInvocationBinding }
  | {
      readonly status: "needs_user";
      readonly reason: "foreground_human_run_required" | "foreground_human_provenance_required";
      /** Content-free pointer to the exact call retained in the transcript. */
      readonly intent: {
        readonly toolName: string;
        readonly toolCallId: string;
      };
    }
  | { readonly status: "denied"; readonly reason: string };

const deny = (reason: string): ComputerUseAdmissionResult => ({ status: "denied", reason });

function needsUser(
  toolName: string,
  toolCallId: string,
  reason: "foreground_human_run_required" | "foreground_human_provenance_required",
): ComputerUseAdmissionResult {
  // Do not echo `toolArgs`: a future typed-text action must not be duplicated
  // into a failure result or lifecycle surface.
  return {
    status: "needs_user",
    reason,
    intent: {
      toolName,
      toolCallId,
    },
  };
}

function sameOpaqueId(left: string, right: string): boolean {
  return parseDesktopAutomationOpaqueId(left) !== null && left === right;
}

function hasExactLiveBinding(
  snapshot: ComputerUseLiveRelaySnapshot,
  origin: VerifiedLocalElectronOrigin,
): boolean {
  return snapshot.relayId === origin.relayId
    && snapshot.userId === origin.userId
    && snapshot.pairingGeneration === origin.pairingGeneration
    && snapshot.desktopSessionId === origin.desktopSessionId;
}

/** Fresh-root grant lookup. Runtime, not this resolver, mints run/lineage ids. */
function resolveComputerUseRootGrant(
  input: ComputerUseRootGrantInput,
  registry: ComputerUseLiveRelayRegistry,
): ComputerUseRootGrantResult {
  if (input.trustedExecutionEntrypoint !== "foreground.main") {
    return { status: "denied", reason: "desktop automation is limited to a trusted foreground Human run" };
  }
  const origin = input.verifiedOrdinaryOrigin;
  if (
    !origin
    || !sameOpaqueId(input.actorId, origin.actorId)
    || !sameOpaqueId(input.userId, input.causalHumanUserId)
    || !sameOpaqueId(input.userId, origin.userId)
    || parseDesktopAutomationOpaqueId(input.agentId) === null
  ) {
    return { status: "denied", reason: "desktop automation speaker provenance is not current" };
  }
  const matches = registry.snapshotForUser(input.userId)
    .filter((snapshot) => hasExactLiveBinding(snapshot, origin));
  if (matches.length !== 1) {
    return { status: "denied", reason: "the authorized desktop is unavailable or ambiguous" };
  }
  const live = matches[0]!;
  const grant = live.desktopAutomation;
  if (
    live.canControlDesktop !== true
    || grant?.enabled !== true
    || !sameOpaqueId(input.agentId, grant.agentId)
    || parseDesktopAutomationOpaqueId(grant.installationEpoch) === null
    || grant.provider !== "cua"
    || parseDesktopAutomationOpaqueId(grant.providerGeneration) === null
    || !Number.isSafeInteger(grant.grantGeneration)
    || grant.grantGeneration < 1
    || grant.grantGeneration > MAX_DESKTOP_AUTOMATION_GRANT_GENERATION
  ) {
    return { status: "denied", reason: "the desktop automation grant is not current" };
  }
  return {
    status: "admitted",
    originHumanId: input.userId,
    originAgentId: input.agentId,
    installationEpoch: grant.installationEpoch,
    grantGeneration: grant.grantGeneration,
    provider: grant.provider,
    providerGeneration: grant.providerGeneration,
  };
}

/**
 * Stable context shared by related semantic calls in one admitted foreground
 * graph run.
 */
function deriveComputerUseContextId(
  provenance: DesktopAutomationProvenance,
  routeBinding: DesktopAutomationRouteBinding,
): string {
  const transcript = JSON.stringify([
    "nautilo-computer-use-context-v2",
    provenance.originHumanId,
    provenance.originRunId,
    provenance.originAgentId,
    provenance.lineageId,
    provenance.installationEpoch,
    provenance.grantGeneration,
    routeBinding.provider,
    routeBinding.providerGeneration,
    routeBinding.grantGeneration,
    "foreground-root",
  ]);
  return `cuc_${createHash("sha256").update(transcript, "utf8").digest("base64url")}`;
}

/**
 * D516's pure admission core. It has no generic approval outcome: a semantic
 * computer call is either admitted with an exact Electron-enforceable binding
 * or forbidden. Auto-Approve deliberately has no input here.
 */
function resolveComputerUseAdmission(
  input: ComputerUseAdmissionInput,
  registry: ComputerUseLiveRelayRegistry,
): ComputerUseAdmissionResult {
  if (!isSupportedComputerUseToolName(input.toolName)) {
    return deny("unsupported semantic computer tool");
  }
  if (!input.toolCallId || parseDesktopAutomationOpaqueId(input.toolCallId) === null) {
    return deny("semantic computer call has no exact server correlation id");
  }
  const provenance = input.desktopAutomationProvenance;
  const routeBinding = input.desktopAutomationRouteBinding;
  if (!provenance) {
    return needsUser(input.toolName, input.toolCallId, "foreground_human_provenance_required");
  }
  if (!routeBinding || routeBinding.grantGeneration !== provenance.grantGeneration) {
    return deny("desktop automation authority is absent");
  }
  if (input.trustedExecutionEntrypoint !== "foreground.main") {
    return needsUser(input.toolName, input.toolCallId, "foreground_human_run_required");
  }
  const origin = input.verifiedOrdinaryOrigin;
  if (!origin) {
    return needsUser(input.toolName, input.toolCallId, "foreground_human_provenance_required");
  }
  if (
    !sameOpaqueId(input.actorId, origin.actorId)
    || !sameOpaqueId(input.userId, input.causalHumanUserId)
    || !sameOpaqueId(input.userId, origin.userId)
    || !sameOpaqueId(input.userId, provenance.originHumanId)
  ) {
    return needsUser(input.toolName, input.toolCallId, "foreground_human_provenance_required");
  }
  if (!sameOpaqueId(input.agentId, provenance.originAgentId)) {
    return deny("desktop automation Agent provenance is not current");
  }
  const liveMatches = registry.snapshotForUser(input.userId)
    .filter((snapshot) => hasExactLiveBinding(snapshot, origin));
  // Exact identity must have exactly one current live holder; any ambiguity is
  // split-brain and cannot be resolved by the model or a server preference.
  if (liveMatches.length !== 1) {
    return deny("the authorized desktop is unavailable or ambiguous");
  }
  const live = liveMatches[0]!;
  const grant = live.desktopAutomation;
  if (
    live.canControlDesktop !== true
    || !grant
    || grant.enabled !== true
    || !sameOpaqueId(input.agentId, grant.agentId)
    || parseDesktopAutomationOpaqueId(live.pairingGenerationRef) === null
    || !sameOpaqueId(provenance.installationEpoch, grant.installationEpoch)
    || provenance.grantGeneration !== grant.grantGeneration
    || routeBinding.provider !== grant.provider
    || !sameOpaqueId(routeBinding.providerGeneration, grant.providerGeneration)
  ) {
    return deny("the desktop automation grant is no longer current");
  }
  const computerUseContextId = deriveComputerUseContextId(provenance, routeBinding);
  const computerUseInvocationId = deriveComputerUseInvocationId(computerUseContextId, {
    id: input.toolCallId,
    name: input.toolName,
    args: input.toolArgs,
  });
  if (computerUseInvocationId === null) {
    return deny("semantic computer arguments are invalid or unsupported");
  }
  return {
    status: "admitted",
    binding: {
      version: RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION,
      computerUseContextId,
      computerUseInvocationId,
      relayId: live.relayId,
      pairingGeneration: live.pairingGenerationRef,
      desktopSessionId: live.desktopSessionId,
      originHumanId: provenance.originHumanId,
      originRunId: provenance.originRunId,
      originAgentId: provenance.originAgentId,
      lineageId: provenance.lineageId,
      installationEpoch: provenance.installationEpoch,
      grantGeneration: provenance.grantGeneration,
      provider: routeBinding.provider,
      providerGeneration: routeBinding.providerGeneration,
    },
  };
}
