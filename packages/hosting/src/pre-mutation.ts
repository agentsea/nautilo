import {
  HOSTING_CAPABILITIES,
  type CapabilityStatus,
  type CoreReadiness,
  type HostingCapability,
  type HostingNotice,
  type InfrastructureState,
} from "./types";

/** All V0 capabilities must be qualified before the product is useful-ready. */
export const CORE_HOSTING_CAPABILITIES = HOSTING_CAPABILITIES;

export interface PreMutationEvaluationInput {
  readonly infrastructure: InfrastructureState;
  readonly capabilities: readonly CapabilityStatus[];
  /** Explicit operator decision, never inferred from a confirmation shortcut. */
  readonly coreDegradedConsent: boolean;
}

export type PreMutationEvaluation =
  | {
      readonly outcome: "blocked";
      readonly infrastructure: InfrastructureState;
      readonly coreReadiness: "blocked";
      readonly capabilities: readonly CapabilityStatus[];
      readonly notices: readonly HostingNotice[];
      readonly coreDegradedConsent: false;
      readonly mutationAuthorized: false;
    }
  | {
      readonly outcome: "authorized";
      readonly infrastructure: InfrastructureState;
      readonly coreReadiness: Exclude<CoreReadiness, "blocked">;
      readonly capabilities: readonly CapabilityStatus[];
      readonly notices: readonly HostingNotice[];
      readonly coreDegradedConsent: boolean;
      readonly mutationAuthorized: true;
    };

function isCoreGap(status: CapabilityStatus): boolean {
  return status.experience === "unavailable" || status.experience === "invalid";
}

function optionalEnhancementNotice(status: CapabilityStatus): HostingNotice | null {
  const enhancement = status.enhancement;
  if (
    status.experience !== "baseline" ||
    enhancement === undefined ||
    enhancement.availability === "available"
  ) {
    return null;
  }

  return {
    severity: "warning",
    code: "hosting.optional-enhancement-unavailable",
    message: enhancement.impact,
    capability: status.capability,
    repairTarget: enhancement.repairTarget,
  };
}

function coreGapNotice(
  status: CapabilityStatus,
  severity: "blocking" | "warning",
): HostingNotice {
  return {
    severity,
    code: "hosting.core-capability-missing",
    message: status.impact,
    capability: status.capability,
    repairTarget: status.repairTarget,
  };
}

function indexCapabilities(
  capabilities: readonly CapabilityStatus[],
): ReadonlyMap<HostingCapability, CapabilityStatus> {
  return new Map(capabilities.map((status) => [status.capability, status]));
}

function duplicateCapabilities(
  capabilities: readonly CapabilityStatus[],
): readonly CapabilityStatus[] {
  const seen = new Set<HostingCapability>();
  return capabilities.filter((status) => {
    if (seen.has(status.capability)) {
      return true;
    }

    seen.add(status.capability);
    return false;
  });
}

/**
 * Evaluates the R39–R44 pre-mutation gate without knowing whether the caller
 * is a TTY wizard or JSON command. Notice records remain independent data;
 * this function derives readiness only from capability qualification and
 * explicit consent.
 */
export function evaluatePreMutation(
  input: PreMutationEvaluationInput,
): PreMutationEvaluation {
  const duplicates = duplicateCapabilities(input.capabilities);
  if (duplicates.length > 0) {
    return {
      outcome: "blocked",
      infrastructure: input.infrastructure,
      coreReadiness: "blocked",
      capabilities: input.capabilities,
      notices: duplicates.map((status): HostingNotice => ({
        severity: "blocking",
        code: "hosting.input-invalid",
        message: `Capability ${status.capability} was supplied more than once.`,
        capability: status.capability,
        repairTarget: { kind: "rerun-plan", capability: status.capability },
      })),
      coreDegradedConsent: false,
      mutationAuthorized: false,
    };
  }

  const capabilityIndex = indexCapabilities(input.capabilities);
  const coreGaps = CORE_HOSTING_CAPABILITIES.flatMap((capability) => {
    const status = capabilityIndex.get(capability);
    return status === undefined || isCoreGap(status) ? [status] : [];
  });
  const presentCoreGaps = coreGaps.filter(
    (status): status is CapabilityStatus => status !== undefined,
  );
  const missingCoreCapabilities = CORE_HOSTING_CAPABILITIES.filter(
    (capability) => !capabilityIndex.has(capability),
  );
  const hasCoreGap = presentCoreGaps.length > 0 || missingCoreCapabilities.length > 0;
  const coreGapSeverity = input.coreDegradedConsent ? "warning" : "blocking";
  const coreNotices = [
    ...presentCoreGaps.map((status) => coreGapNotice(status, coreGapSeverity)),
    ...missingCoreCapabilities.map((capability): HostingNotice => ({
      severity: coreGapSeverity,
      code: "hosting.core-capability-missing",
      message: `${capability} capability is not planned.`,
      capability,
      repairTarget: { kind: "rerun-plan", capability },
    })),
  ];
  const enhancementNotices = input.capabilities.flatMap((status) => {
    const notice = optionalEnhancementNotice(status);
    return notice === null ? [] : [notice];
  });
  const notices = [...coreNotices, ...enhancementNotices];

  if (hasCoreGap && !input.coreDegradedConsent) {
    return {
      outcome: "blocked",
      infrastructure: input.infrastructure,
      coreReadiness: "blocked",
      capabilities: input.capabilities,
      notices,
      coreDegradedConsent: false,
      mutationAuthorized: false,
    };
  }

  return {
    outcome: "authorized",
    infrastructure: input.infrastructure,
    coreReadiness: hasCoreGap ? "degraded" : "useful-ready",
    capabilities: input.capabilities,
    notices,
    coreDegradedConsent: input.coreDegradedConsent,
    mutationAuthorized: true,
  };
}
