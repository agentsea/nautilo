import type {
  AuthorityEligibilityPort,
  AuthorityEligibilityRequest,
  AuthorityEligibilityResult,
  EffectiveAudienceAlternative,
} from "@nautilo/reflection/authority";
import { invocationAudienceIsEligible } from "@nautilo/reflection/authority";

import type {
  AuthorityProjectionStorePort,
  RecordAccessAudiencePort,
} from "./authority-contracts";

export class ProjectedAuthorityEligibility implements AuthorityEligibilityPort {
  readonly #projections: AuthorityProjectionStorePort;
  readonly #accessAudiences: RecordAccessAudiencePort;

  constructor(input: Readonly<{
    projections: AuthorityProjectionStorePort;
    accessAudiences: RecordAccessAudiencePort;
  }>) {
    this.#projections = input.projections;
    this.#accessAudiences = input.accessAudiences;
  }

  async check(input: AuthorityEligibilityRequest): Promise<AuthorityEligibilityResult> {
    const current = await this.#projections.readCurrent(input.recordRef);
    if (current === null) return { status: "unavailable", reason: "not_eligible" };
    const blocked = await this.#projections.isImmediatelyBlocked({
      recordRef: input.recordRef,
      terminalAuthorityLeafHandles: current.terminalAuthorityLeafHandles,
    });
    if (blocked !== null) return { status: "unavailable", reason: "not_eligible" };
    if (
      current.recordLifecycle === "sunset"
      || current.recordDisposition !== "available"
      || current.processingState === "unavailable"
      || current.processingState === "purged"
    ) return { status: "unavailable", reason: "not_eligible" };

    const logical: EffectiveAudienceAlternative[] = [];
    // A representable generation is capped at 256 alternatives. Consume the
    // complete set through one batch-shaped call so an ineligible result never
    // exposes count-dependent call/continuation behavior to the semantic path.
    const resolved = await this.#accessAudiences.readExactSet(
      current.alternatives.map((alternative) => alternative.accessNamespaceId),
    );
    if (resolved.status === "unavailable") {
      return { status: "unavailable", reason: "not_eligible" };
    }
    if (resolved.audiences.length !== current.alternatives.length) {
      return { status: "unavailable", reason: "not_eligible" };
    }
    for (const [index, alternative] of current.alternatives.entries()) {
      const humanRefs = resolved.audiences[index];
      if (humanRefs === undefined) return { status: "unavailable", reason: "not_eligible" };
      logical.push({
        humanRefs,
        includesPublicBoundary: alternative.includesPublicBoundary,
      });
    }
    if (invocationAudienceIsEligible(input.invocationAudience, logical)) {
      return { status: "eligible" };
    }
    return { status: "unavailable", reason: "not_eligible" };
  }
}
