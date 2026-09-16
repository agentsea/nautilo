/** Canonical virtual marker carried beside an exact real-Human audience. */
export interface EffectiveAudienceAlternative {
  readonly humanRefs: readonly string[];
  readonly includesPublicBoundary: boolean;
}

export interface AuthorityLeafAlternatives {
  /** Opaque call-local handle. Product source coordinates do not belong here. */
  readonly terminalAuthorityLeafHandle: string;
  readonly alternatives: readonly EffectiveAudienceAlternative[];
}

export interface AuthorityAlgebraMetrics {
  readonly inputLeafCount: number;
  readonly inputAlternativeCount: number;
  readonly normalizedLeafAlternativeCount: number;
  readonly intermediatePeakAlternativeCount: number;
  readonly finalAlternativeCount: number;
  readonly dominancePrunedCount: number;
  readonly emptyIntersectionCount: number;
  readonly operations: number;
  readonly checkpointBytes: number;
}

export type AuthorityAlgebraUnavailableReason =
  | "no_authority_leaves"
  | "no_effective_audience";

export type AuthorityAlgebraResult =
  | {
      readonly status: "paused";
      /**
       * Sensitive logical state. A protected adapter must seal it before any
       * durable persistence; it is never content-free relational metadata.
       */
      readonly continuation: string;
      readonly metrics: AuthorityAlgebraMetrics;
    }
  | {
      readonly status: "complete";
      readonly outcome:
        | {
            readonly kind: "available";
            readonly alternatives: readonly EffectiveAudienceAlternative[];
          }
        | {
            readonly kind: "unavailable";
            readonly reason: AuthorityAlgebraUnavailableReason;
          };
      readonly metrics: AuthorityAlgebraMetrics;
    };

export type AuthorityRepresentationDisposition =
  | { readonly kind: "representable" }
  | {
      readonly kind: "unavailable";
      readonly reason: "representation_capacity_exceeded";
      readonly measuredAlternativeCount: number;
    };

export interface AuthorityAlgebraBudget {
  /** Bounds one invocation. Pauses never truncate the canonical result. */
  readonly maxOperations: number;
}

export type AuthorityEligibilityUnavailableReason = "not_eligible";

export interface AuthorityEligibilityRequest {
  readonly recordRef: string;
  readonly invocationAudience: EffectiveAudienceAlternative;
}

export type AuthorityEligibilityResult =
  | { readonly status: "eligible" }
  | {
      readonly status: "unavailable";
      readonly reason: AuthorityEligibilityUnavailableReason;
    };

export interface AuthorityEligibilityPort {
  check(input: AuthorityEligibilityRequest): Promise<AuthorityEligibilityResult>;
}

export type AuthorityAlgebraErrorCode =
  | "invalid_input"
  | "invalid_budget"
  | "invalid_checkpoint"
  | "checkpoint_mismatch";

export class AuthorityAlgebraError extends Error {
  readonly code: AuthorityAlgebraErrorCode;

  constructor(code: AuthorityAlgebraErrorCode, message: string) {
    super(message);
    this.name = "AuthorityAlgebraError";
    this.code = code;
  }
}
