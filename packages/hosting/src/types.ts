/**
 * Stable product capabilities used by every hosting backend. A provider may
 * satisfy more than one capability, but provider identity and credentials do
 * not cross this package boundary.
 */
export const HOSTING_CAPABILITIES = [
  "chat",
  "embeddings",
  "search",
  "tts",
  "stt",
] as const;

export type HostingCapability = (typeof HOSTING_CAPABILITIES)[number];

/** Infrastructure lifecycle, independent from product readiness. */
export type InfrastructureState =
  | "planned"
  | "provisioning"
  | "claimable"
  | "failed";

/** Whether the product is usable, independent from host resource state. */
export type CoreReadiness = "blocked" | "degraded" | "useful-ready";

/** The user-visible experience level for one product capability. */
export type CapabilityExperience =
  | "unavailable"
  | "baseline"
  | "enhanced"
  | "invalid";

/** Presentation/decision severity; never a readiness axis. */
export type HostingNoticeSeverity = "info" | "warning" | "blocking" | "error";

/**
 * The two concrete V0 backends. Additional backends require an explicit
 * contract revision rather than silently accepting an arbitrary provider.
 */
export type HostingBackend = "railway" | "digitalocean-droplet";

/**
 * A desired resource in a plan. It has stable Nautilo identity but no provider
 * identity because it is valid before a provider create call has occurred.
 */
export interface HostingResourceIntent {
  readonly logicalName: string;
  readonly kind: string;
}

/** A non-secret, realized provider resource reference kept in a receipt. */
export interface HostingResourceReference {
  readonly kind: string;
  readonly id: string;
  readonly name?: string | undefined;
}

/** A non-secret action location that a UI can turn into a link or instruction. */
export interface HostingRepairTarget {
  readonly kind: "admin-providers" | "authenticated-provider-api" | "rerun-plan";
  readonly capability?: HostingCapability | undefined;
}

export type EnhancementProvider = "elevenlabs" | "tavily";
export type EnhancementAvailability = "absent" | "invalid" | "available";

/**
 * Optional-provider state is retained separately from a qualified baseline.
 * For example, TTS can be `baseline` while an absent ElevenLabs enhancement
 * remains a warning rather than a core failure.
 */
export interface CapabilityEnhancement {
  readonly provider: EnhancementProvider;
  readonly availability: EnhancementAvailability;
  readonly impact: string;
  readonly repairTarget: HostingRepairTarget;
}

/** Non-secret capability forecast/result for one stable capability. */
export interface CapabilityStatus {
  readonly capability: HostingCapability;
  readonly experience: CapabilityExperience;
  readonly impact: string;
  readonly repairTarget: HostingRepairTarget;
  readonly enhancement?: CapabilityEnhancement | undefined;
}

/** Stable, non-secret notice emitted beside all readiness axes. */
export interface HostingNotice {
  readonly severity: HostingNoticeSeverity;
  readonly code: HostingNoticeCode;
  readonly message: string;
  readonly capability?: HostingCapability | undefined;
  readonly resources?: readonly HostingResourceReference[] | undefined;
  readonly repairTarget?: HostingRepairTarget | undefined;
}

export type HostingNoticeCode =
  | "hosting.core-capability-missing"
  | "hosting.optional-enhancement-unavailable"
  | "hosting.input-invalid"
  | "hosting.release-invalid"
  | "hosting.cost-unavailable"
  | "hosting.confirmation-required"
  | "hosting.receipt-action-required"
  | "hosting.cancelled"
  | "hosting.authorization-required"
  | "hosting.operation-failed"
  | "hosting.resources-retained";

/**
 * Serializable forecast shared by future CLI, TTY, and JSON projections. It
 * intentionally contains desired and realized resource identity only—never a grant,
 * OAuth artifact, raw provider value, or other secret.
 */
export interface HostingPlan {
  readonly backend: HostingBackend;
  readonly infrastructure: InfrastructureState;
  readonly coreReadiness: CoreReadiness;
  readonly capabilities: readonly CapabilityStatus[];
  readonly notices: readonly HostingNotice[];
  /** Desired topology, valid before any provider resource ID exists. */
  readonly resourceIntents: readonly HostingResourceIntent[];
  /** Realized receipt-backed resources known when this plan was calculated. */
  readonly knownResources: readonly HostingResourceReference[];
  /** Explicit decision only; confirmation alone must not set this true. */
  readonly coreDegradedConsent: boolean;
  /** Whether this pre-mutation plan has no unresolved blocking condition. */
  readonly mutationAuthorized: boolean;
}

/** A plan that has passed the pre-mutation gate and can be reconciled. */
export type AuthorizedHostingPlan = HostingPlan & {
  readonly coreReadiness: Exclude<CoreReadiness, "blocked">;
  readonly mutationAuthorized: true;
};

/** Plan input deliberately excludes secrets and provider authorization state. */
export interface HostingPlanRequest {
  readonly backend: HostingBackend;
  readonly knownResources?: readonly HostingResourceReference[] | undefined;
}

/** Reconciliation compares an authorized desired plan against its known IDs. */
export interface HostingReconcileRequest {
  readonly backend: HostingBackend;
  readonly plan: AuthorizedHostingPlan;
}

export interface HostingInspectRequest {
  readonly backend: HostingBackend;
  readonly resources: readonly HostingResourceReference[];
}

export interface HostingDestroyRequest {
  readonly backend: HostingBackend;
  readonly resources: readonly HostingResourceReference[];
}

export interface HostingSnapshot {
  readonly backend: HostingBackend;
  readonly infrastructure: InfrastructureState;
  readonly coreReadiness: CoreReadiness;
  readonly capabilities: readonly CapabilityStatus[];
  readonly notices: readonly HostingNotice[];
  readonly resources: readonly HostingResourceReference[];
}

export type HostingPlanResult = {
  readonly operation: "plan";
  readonly plan: HostingPlan;
};

export type HostingReconcileResult = {
  readonly operation: "reconcile";
  readonly outcome: "reconciled" | "failed";
  readonly snapshot: HostingSnapshot;
};

export type HostingInspectResult = {
  readonly operation: "inspect";
  readonly snapshot: HostingSnapshot;
};

export type HostingDestroyResult = {
  readonly operation: "destroy";
  readonly outcome: "destroyed" | "failed";
  readonly remainingResources: readonly HostingResourceReference[];
  readonly notices: readonly HostingNotice[];
};

/**
 * The first concrete driver seam. Railway is the first implementation;
 * DigitalOcean Droplet must prove any later extension before this grows.
 */
export interface HostingDriver {
  readonly backend: HostingBackend;
  plan(request: HostingPlanRequest): Promise<HostingPlanResult>;
  reconcile(request: HostingReconcileRequest): Promise<HostingReconcileResult>;
  inspect(request: HostingInspectRequest): Promise<HostingInspectResult>;
  destroy(request: HostingDestroyRequest): Promise<HostingDestroyResult>;
}
