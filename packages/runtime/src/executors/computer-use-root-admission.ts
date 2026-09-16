import { randomUUID } from "node:crypto";
import {
  DESKTOP_AUTOMATION_ROUTE_BINDING_VERSION,
  parseDesktopAutomationOpaqueId,
  parseDesktopAutomationProvenance,
  parseDesktopAutomationRouteBinding,
  type DesktopAutomationProvider,
  type DesktopAutomationProvenance,
  type DesktopAutomationRouteBinding,
  type VerifiedOrdinaryOrigin,
} from "@nautilo/types";
type ComputerUseRootGrantResolver = (request: {
  readonly userId: string;
  readonly actorId: string;
  readonly causalHumanUserId: string;
  readonly agentId: string;
  readonly trustedExecutionEntrypoint: "foreground.main";
  readonly verifiedOrdinaryOrigin: VerifiedOrdinaryOrigin | null;
}) =>
  | {
      readonly status: "admitted";
      readonly originHumanId: string;
      readonly originAgentId: string;
      readonly installationEpoch: string;
      readonly grantGeneration: number;
      readonly provider: DesktopAutomationProvider;
      readonly providerGeneration: string;
    }
  | { readonly status: "denied"; readonly reason: string }
  | Promise<
      | {
          readonly status: "admitted";
          readonly originHumanId: string;
          readonly originAgentId: string;
          readonly installationEpoch: string;
          readonly grantGeneration: number;
          readonly provider: DesktopAutomationProvider;
          readonly providerGeneration: string;
        }
      | { readonly status: "denied"; readonly reason: string }
    >;

export interface FreshComputerUseRootAdmissionInput {
  readonly userId: string;
  readonly actorId: string;
  readonly causalHumanUserId: string;
  readonly agentId: string;
  readonly trustedExecutionEntrypoint: "foreground.main" | "foreground.fork" | "foreground.task_report_back" | "background.task" | "foreground.subagent" | null;
  readonly verifiedOrdinaryOrigin: VerifiedOrdinaryOrigin | null;
}

export interface FreshComputerUseRootAdmissionDependencies {
  readonly resolveGrant?: ComputerUseRootGrantResolver | undefined;
  readonly createOpaqueId?: (() => string) | undefined;
}

export interface FreshComputerUseRootAdmission {
  readonly provenance: DesktopAutomationProvenance;
  readonly routeBinding: DesktopAutomationRouteBinding;
}

/**
 * Mint root-only desktop provenance from one server-owned live-grant decision.
 * No request/checkpoint provenance is accepted, and a denial/error is simply
 * absent authority so ordinary foreground turns remain byte-for-byte usable.
 */
export async function admitFreshComputerUseRoot(
  input: FreshComputerUseRootAdmissionInput,
  dependencies: FreshComputerUseRootAdmissionDependencies,
): Promise<FreshComputerUseRootAdmission | null> {
  const resolveGrant = dependencies.resolveGrant;
  if (
    !resolveGrant
    || input.trustedExecutionEntrypoint !== "foreground.main"
    || input.verifiedOrdinaryOrigin?.kind !== "local_electron"
    || parseDesktopAutomationOpaqueId(input.userId) === null
    || parseDesktopAutomationOpaqueId(input.actorId) === null
    || input.verifiedOrdinaryOrigin.actorId !== input.actorId
    || input.causalHumanUserId !== input.userId
    || input.verifiedOrdinaryOrigin.userId !== input.userId
    || parseDesktopAutomationOpaqueId(input.agentId) === null
  ) return null;

  let decision: Awaited<ReturnType<ComputerUseRootGrantResolver>>;
  try {
    decision = await resolveGrant({
      userId: input.userId,
      actorId: input.actorId,
      causalHumanUserId: input.causalHumanUserId,
      agentId: input.agentId,
      trustedExecutionEntrypoint: input.trustedExecutionEntrypoint,
      verifiedOrdinaryOrigin: input.verifiedOrdinaryOrigin,
    });
  } catch {
    return null;
  }
  if (
    decision.status !== "admitted"
    || decision.originHumanId !== input.userId
    || decision.originAgentId !== input.agentId
  ) return null;

  const createOpaqueId = dependencies.createOpaqueId ?? (() => randomUUID());
  let originRunId: string;
  let lineageId: string;
  try {
    originRunId = `computer-run:${createOpaqueId()}`;
    lineageId = `computer-lineage:${createOpaqueId()}`;
  } catch {
    return null;
  }
  const provenance = parseDesktopAutomationProvenance({
    originHumanId: decision.originHumanId,
    originRunId,
    originAgentId: decision.originAgentId,
    lineageId,
    installationEpoch: decision.installationEpoch,
    grantGeneration: decision.grantGeneration,
  });
  const routeBinding = parseDesktopAutomationRouteBinding({
    version: DESKTOP_AUTOMATION_ROUTE_BINDING_VERSION,
    provider: decision.provider,
    providerGeneration: decision.providerGeneration,
    grantGeneration: decision.grantGeneration,
  });
  return provenance === null || routeBinding === null ? null : { provenance, routeBinding };
}
