/**
 * @nautilo/types — Tool catalog type definitions
 *
 * Shared between @nautilo/runtime (catalog implementation),
 * @nautilo/agent (tool metadata + registration), and
 * @nautilo/trust (policy bridging).
 */

import type { ToolConnectionRequirement } from "./connection-vault";

export const TOOL_CATEGORIES = [
  "communication",
  "knowledge",
  "documents",
  "files",
  "automation",
  "development",
  "research",
  "integrations",
  "computer",
  "devices",
  "media",
  "settings",
  "identity",
  "administration",
  "extensions",
  "help",
  "meta",
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export type ToolTrustTier = "admin" | "high" | "standard" | "guest";

export type ToolImpactLevel = "read-only" | "low" | "high" | "destructive";

export type ToolSource = "builtin" | "mcp" | "relay" | "plugin";

/**
 * D419 — whether a tool is bound eagerly or can be activated progressively.
 *
 * During the migration this is optional on catalog metadata so existing
 * registrations retain their current eager-binding behavior. Phase 2 will
 * require every registration to declare one explicitly.
 */
export type ToolExposure = "core" | "discoverable";

export type ToolExecutor = "cloud" | "relay" | "local";

/**
 * Optional, descriptive hints used to rank and annotate catalog discovery.
 * These hints never affect eligibility, activation, or authorization.
 */
export interface ToolDiscoveryMetadata {
  /** This real tool is the preferred workflow for reviewable document edits. */
  preferredReviewWorkflow?: boolean | undefined;
}

/**
 * Declarative start/status relationship for an asynchronously completed tool.
 * This is discovery metadata only; executors do not poll or schedule work from
 * it. Connected-app providers sign this mapping with their operation contract.
 */
export interface ToolAsyncLifecycle {
  startActionId: string;
  statusActionId: string;
  statusInput: Readonly<Record<string, string>>;
}

/** Modalities used to determine whether a tool can be offered to a model. */
export type ToolModelCapability = "image" | "file";

/**
 * D419 — opt-in inputs for resolving a progressively exposed tool set.
 *
 * `toolNameWhitelist`, when present (including an empty array), is a hard
 * ceiling. Activation and intent selection can only narrow within that set.
 * Omitting it does not itself opt a caller into progressive exposure.
 */
export interface ProgressiveToolResolverOptions {
  /** Opaque context forwarded to selected tool factories by the catalog. */
  context?: Record<string, unknown> | undefined;
  /** Actor authorization decisions keyed by tool name. */
  toolPolicy?: Readonly<Record<string, string>> | undefined;
  /** Capabilities advertised by the actor's connected relay. */
  relayCapabilities?: Readonly<Record<string, boolean>> | undefined;
  /** Namespace ids the actor is allowed to read. */
  readableNamespaces?: readonly string[] | undefined;
  /** Modalities supported by the active model. */
  activeModelCapabilities?: readonly ToolModelCapability[] | undefined;
  /** Explicit hard ceiling on names that may be exposed. */
  toolNameWhitelist?: readonly string[] | undefined;
  /** Names explicitly activated during the current turn. */
  activatedToolNames?: readonly string[] | undefined;
  /** Optional names supplied by the selected intent pack. */
  intentPackToolNames?: readonly string[] | undefined;
  /** Skip relay liveness checks for post-model defense-in-depth checks. */
  skipRelayLiveCheck?: boolean | undefined;
  /** Server-admitted Full encryption policy. Omission preserves ordinary exposure. */
  fullEncryptionOnly?: boolean | undefined;
}

export type ToolApprovalLevel = "prove_it" | "confirm" | "standing";

export type ToolResultScanPolicy = "always" | "on-suspicious" | "never";

/** M079 — hybrid tools read LLM-declared `sensitivity` at approval time. */
export type ToolApprovalMode = "static" | "hybrid";

export type ToolHealthStatus = "connected" | "disconnected" | "error";

/**
 * Metadata for a single tool in the catalog.
 *
 * Does NOT hold the tool implementation (factory) — that lives in
 * @nautilo/agent alongside the LangChain tool definitions. The catalog
 * in @nautilo/runtime links entries to factories via name.
 */
export interface ToolCatalogEntry {
  name: string;
  description: string;
  source: ToolSource;
  /** D419 — omitted until a registration has migrated to explicit exposure. */
  exposure?: ToolExposure | undefined;
  /** The stable primary user-intent category used for catalogue organization. */
  category: ToolCategory;
  /**
   * Additional user-intent categories that may discover this tool.
   * Descriptive only: aliases never change exposure, authorization, approval,
   * executor selection, or invocation eligibility.
   */
  discoveryCategories?: readonly ToolCategory[] | undefined;
  trustTier: ToolTrustTier;
  impact: ToolImpactLevel;
  /** Explicitly reviewed for protected inputs, outputs, and pre-effect execution. */
  fullEncryptionSupport?: "supported" | undefined;
  executor: ToolExecutor;
  requiresApproval: boolean;
  approvalLevel?: ToolApprovalLevel | undefined;
  /** M079 — omitted means static (impact-only) approval. */
  approvalMode?: ToolApprovalMode | undefined;
  /**
   * Actor-facing capability required by the trust policy. This remains
   * separate from `relayCapabilities`, which describes the connected local
   * executor and is not an actor permission.
   */
  requiredCapabilities: string[];
  /** Additional capabilities required only for argument-selected sub-actions. */
  conditionalCapabilities?: readonly string[] | undefined;
  /** Capabilities that must be advertised by the connected relay executor. */
  relayCapabilities?: readonly string[] | undefined;
  /**
   * D069 — model-side modality requirements. When set, the catalog
   * filter excludes this tool from any actor whose active chat model
   * does not advertise every required `ModelInputModality`. Distinct
   * from both actor `requiredCapabilities` and relay `relayCapabilities`.
   * Empty / undefined means "no model
   * gate"; the tool can be picked by any model. Reserve slot — no
   * built-in tool consumes this today (`file:read` does its own
   * per-call gating because text reads always work; only the
   * multimodal sub-path needs the active-model check). Future tools
   * that hard-require vision (e.g. an "interpret_chart" tool) should
   * declare it here so they never get offered to text-only models.
   */
  requiredModelCapabilities?: readonly ToolModelCapability[] | undefined;
  enabled: boolean;
  tags: string[];
  resultScanPolicy: ToolResultScanPolicy;
  /**
   * D336 — how the content scanner treats invisible/zero-width/bidi-control
   * Unicode in this tool's results. `"block"` (default) = any invisible char
   * blocks the whole payload (prompt-injection defense). `"strip"` = remove the
   * invisible chars and keep the visible content; prompt-injection TEXT patterns
   * still apply. Use `"strip"` for tools whose results are live web content
   * (browser_* embedded-app tools) where invisible Unicode is benign and
   * ubiquitous, so blocking would make the tool unusable.
   */
  scanInvisibleUnicode?: "strip" | "block" | undefined;
  health: ToolHealthStatus;
  sourceServer?: string | undefined;
  guidance?: string | undefined;
  /** Non-authoritative discovery ranking and guidance hints. */
  discovery?: ToolDiscoveryMetadata | undefined;
  connections?: readonly ToolConnectionRequirement[] | undefined;
  /**
   * Connected-app tools are eligible only when this exact provider is present
   * in the server-stamped Human×Namespace snapshot carried in ToolContext.
   * This is a resolver gate, not a capability or model-controlled argument.
   */
  connectedAppProviderId?: string | undefined;
  /** Signed async start/status metadata, when this operation starts a job. */
  asyncLifecycle?: ToolAsyncLifecycle | undefined;
  /**
   * D384 C6 — Namespace scope for tool visibility. `null`/`undefined` means
   * global (visible to any actor). When set, the actor-filter (`getFiltered`)
   * hides this tool unless the requesting actor's `readableNamespaces`
   * (human-subset rule) includes it. MCP tools carry their server's namespace;
   * built-ins are global. No per-agent axis — namespace only (see M048/M127).
   */
  namespaceId?: string | null | undefined;
  /**
   * D384 Phase 5 — for a relay-hosted (local-tier) MCP tool, the relayId that
   * hosts it; null/undefined for server-tier/built-in tools. Used to route
   * dispatch to the owning relay.
   */
  hostedBy?: string | null | undefined;
}

/**
 * Filter for querying the catalog. All fields optional — omitted fields
 * are not filtered on.
 */
export interface ToolQueryFilter {
  category?: ToolCategory | undefined;
  tag?: string | undefined;
  keyword?: string | undefined;
  source?: ToolSource | undefined;
  executor?: ToolExecutor | undefined;
  trustTier?: ToolTrustTier | undefined;
  enabled?: boolean | undefined;
}

/**
 * Snapshot of catalog statistics.
 */
export interface ToolCatalogStats {
  total: number;
  bySource: Record<ToolSource, number>;
  byCategory: Partial<Record<ToolCategory, number>>;
  byTier: Record<ToolTrustTier, number>;
  enabled: number;
  disabled: number;
}

/**
 * Trust tier ordering for comparison. Lower index = more restrictive.
 * A tool with tier "admin" requires the actor to have at least "admin" access.
 */
export const TRUST_TIER_ORDER: readonly ToolTrustTier[] = [
  "guest",
  "standard",
  "high",
  "admin",
] as const;
