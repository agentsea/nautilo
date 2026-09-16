/**
 * Unified tool registry for Nautilo.
 *
 * One entry per tool. Each entry holds metadata (trust tier, impact,
 * category), a factory function (creates LangChain StructuredTool instances),
 * and the description (from the factory, set at registration).
 *
 * This is the ONLY place tools are defined. There is no parallel registry.
 * Adding a tool = one register() call with everything.
 *
 * Design patterns:
 * - Hermes tools/registry.py — snapshot isolation, MCP collision rules,
 *   availability checks at query time
 * - OpenClaw tool-policy-pipeline.ts — labeled filtering for debuggability
 */

import type { StructuredTool } from "@langchain/core/tools";
import { log, debug, warn } from "@nautilo/logger";
import type {
  ToolApprovalMode,
  ToolCatalogEntry,
  ToolAsyncLifecycle,
  ToolCatalogStats,
  ToolCategory,
  ToolDiscoveryMetadata,
  ToolExposure,
  ProgressiveToolResolverOptions,
  ToolQueryFilter,
  ToolSource,
  ToolModelCapability,
  ToolTrustTier,
} from "@nautilo/types";
import { TRUST_TIER_ORDER as TIER_ORDER } from "@nautilo/types";

// -----------------------------------------------------------------------
// Tool context — opaque to the catalog. The caller passes whatever the
// tool factories need; the catalog forwards it without interpreting it.
// -----------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolContext = Record<string, any>;

export type ToolFactory = (context?: ToolContext) => StructuredTool;

// -----------------------------------------------------------------------
// Registration input — everything about a tool, in one place
// -----------------------------------------------------------------------

export interface ToolRegistration {
  /** Live server prerequisite; never grants actor authority or replaces dispatch checks. */
  isAvailable?: (() => boolean) | undefined;
  /** Safe actor-facing recovery shown only after ordinary tool authorization. */
  unavailableReason?: string | undefined;
  /** Turn-local prerequisite; only narrows availability, never grants authority. */
  unavailableInContext?: ((context?: ToolContext) => string | null) | undefined;
  name: string;
  factory: ToolFactory;
  category: ToolCategory;
  /** Descriptive search aliases; never used by policy or exposure filtering. */
  discoveryCategories?: readonly ToolCategory[];
  trustTier: ToolTrustTier;
  impact: ToolCatalogEntry["impact"];
  fullEncryptionSupport?: "supported" | undefined;
  /**
   * D419 — omitted during the migration to preserve eager binding for current
   * registrations. Dynamic registration boundaries will declare it explicitly.
   */
  exposure?: ToolExposure | undefined;
  tags?: string[];
  requiresApproval?: boolean;
  approvalLevel?: ToolCatalogEntry["approvalLevel"];
  approvalMode?: ToolApprovalMode | undefined;
  requiredCapabilities?: string[];
  /** Descriptive conditional gates; the tool boundary must enforce the branch. */
  conditionalCapabilities?: readonly string[];
  /** Runtime capabilities required from the connected relay, distinct from actor capabilities. */
  relayCapabilities?: readonly string[];
  /** D069 — model-side modality gate. See ToolCatalogEntry for semantics. */
  requiredModelCapabilities?: readonly ToolModelCapability[];
  resultScanPolicy?: ToolCatalogEntry["resultScanPolicy"];
  scanInvisibleUnicode?: ToolCatalogEntry["scanInvisibleUnicode"];
  executor?: ToolCatalogEntry["executor"];
  source?: ToolSource;
  sourceServer?: string;
  guidance?: string;
  /** Non-authoritative hints for ranking and annotating catalog discovery. */
  discovery?: ToolDiscoveryMetadata | undefined;
  connections?: ToolCatalogEntry["connections"];
  /** Exact connected-app provider required by the server-stamped tool context. */
  connectedAppProviderId?: string | undefined;
  /** Declarative start/status mapping; never an executor-side polling policy. */
  asyncLifecycle?: ToolAsyncLifecycle | undefined;
  /** D384 C6 — namespace scope; null/undefined = global (see ToolCatalogEntry). */
  namespaceId?: string | null;
  /** D384 Phase 5 — relayId that hosts this tool; null/undefined for server-tier/built-in. */
  hostedBy?: string | null;
}

// -----------------------------------------------------------------------
// Internal entry — registration + resolved description
// -----------------------------------------------------------------------

interface CatalogEntry extends ToolCatalogEntry {
  isAvailable?: (() => boolean) | undefined;
  unavailableReason?: string | undefined;
  unavailableInContext?: ((context?: ToolContext) => string | null) | undefined;
  factory: ToolFactory;
}

/** Internal fail-closed marker; never a public or grantable capability. */
const UNREGISTERED_TOOL_CAPABILITY = "__unregistered_tool_forbidden__";

/** Validation switches for staged catalog-contract migrations. */
export interface ToolCatalogValidationOptions {
  /**
   * D419 Phase 2 CI: reject registrations that have not declared an exposure.
   * Disabled by default while built-in registrations migrate.
   */
  requireExposure?: boolean;
}

// -----------------------------------------------------------------------
// Snapshot — frozen result of getFiltered / getToolsForActor
// -----------------------------------------------------------------------

interface ExclusionReason {
  tool: string;
  reason: string;
}

export interface CatalogSnapshot {
  readonly generation: number;
  readonly entries: readonly ToolCatalogEntry[];
  readonly exclusions: readonly ExclusionReason[];
}

export interface ProgressiveToolResolution {
  /** Tools that passed normal eligibility checks before exposure selection. */
  readonly eligible: CatalogSnapshot;
  /** Selected, model-compatible metadata ready to expose to the model. */
  readonly snapshot: CatalogSnapshot;
  /** Fresh tool instances corresponding exactly to `snapshot.entries`. */
  readonly tools: readonly StructuredTool[];
  readonly counts: Readonly<{
    eligible: number;
    exposed: number;
    instantiated: number;
  }>;
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function toMetadata(entry: CatalogEntry): ToolCatalogEntry {
  return {
    name: entry.name,
    description: entry.description,
    source: entry.source,
    exposure: entry.exposure,
    category: entry.category,
    discoveryCategories: entry.discoveryCategories,
    trustTier: entry.trustTier,
    impact: entry.impact,
    fullEncryptionSupport: entry.fullEncryptionSupport,
    executor: entry.executor,
    requiresApproval: entry.requiresApproval,
    approvalLevel: entry.approvalLevel,
    approvalMode: entry.approvalMode,
    requiredCapabilities: entry.requiredCapabilities,
    conditionalCapabilities: entry.conditionalCapabilities,
    relayCapabilities: entry.relayCapabilities,
    requiredModelCapabilities: entry.requiredModelCapabilities,
    enabled: entry.enabled,
    tags: entry.tags,
    resultScanPolicy: entry.resultScanPolicy,
    scanInvisibleUnicode: entry.scanInvisibleUnicode,
    health: entry.health,
    sourceServer: entry.sourceServer,
    guidance: entry.guidance,
    discovery: entry.discovery,
    connections: entry.connections,
    connectedAppProviderId: entry.connectedAppProviderId,
    asyncLifecycle: entry.asyncLifecycle,
    namespaceId: entry.namespaceId,
    hostedBy: entry.hostedBy,
  };
}

function resolveProgressiveSnapshot(
  eligible: CatalogSnapshot,
  options: ProgressiveToolResolverOptions,
): CatalogSnapshot {
  const selectedNames = new Set([
    ...(options.activatedToolNames ?? []),
    ...(options.intentPackToolNames ?? []),
  ]);
  const whitelist = options.toolNameWhitelist === undefined
    ? undefined
    : new Set(options.toolNameWhitelist);
  const modelCapabilities = new Set(options.activeModelCapabilities ?? []);
  const entries: ToolCatalogEntry[] = [];
  const exclusions: ExclusionReason[] = [...eligible.exclusions];

  for (const entry of eligible.entries) {
    if (options.fullEncryptionOnly === true && entry.fullEncryptionSupport !== "supported") {
      exclusions.push({ tool: entry.name, reason: "unsupported while Full encryption is active" });
      continue;
    }
    const selected = entry.exposure === "core" || selectedNames.has(entry.name);
    if (!selected) {
      exclusions.push({ tool: entry.name, reason: "not selected for progressive exposure" });
      continue;
    }
    if (whitelist && !whitelist.has(entry.name)) {
      exclusions.push({ tool: entry.name, reason: "not in explicit tool whitelist" });
      continue;
    }
    const missingModelCapability = entry.requiredModelCapabilities?.find(
      (capability) => !modelCapabilities.has(capability),
    );
    if (missingModelCapability) {
      exclusions.push({
        tool: entry.name,
        reason: `requires model capability "${missingModelCapability}" not available`,
      });
      continue;
    }
    entries.push(entry);
  }

  return Object.freeze({
    generation: eligible.generation,
    entries: Object.freeze(entries),
    exclusions: Object.freeze(exclusions),
  });
}

// -----------------------------------------------------------------------
// The catalog
// -----------------------------------------------------------------------

export class ToolCatalog {
  private entries = new Map<string, CatalogEntry>();
  private generation = 0;

  /**
   * Register a tool. This is the ONLY way tools enter the system.
   *
   * The factory is called once immediately to extract the description.
   * Subsequent calls to getToolsForActor() create fresh instances with
   * the actor's context.
   *
   * Collision rules:
   * - Same name + same source → replace (re-registration)
   * - Builtin exists + external source (mcp/relay/plugin) → REJECT
   * - MCP + MCP from different servers → allow overwrite
   */
  register(reg: ToolRegistration): boolean {
    const source = reg.source ?? "builtin";
    const existing = this.entries.get(reg.name);

    if (existing && existing.source !== source) {
      const externalSources: Set<string> = new Set(["mcp", "relay", "plugin"]);
      if (existing.source === "builtin" && externalSources.has(source)) {
        warn(
          `[catalog] Registration REJECTED: ${source} tool "${reg.name}" would shadow built-in tool.`,
        );
        return false;
      }
    }

    // Create one instance to extract the authoritative description
    const instance = reg.factory();
    const description = instance.description;
    if (!description) {
      throw new Error(
        `[catalog] Tool "${reg.name}" factory produced no description. ` +
          `Every tool must define a description in its DynamicStructuredTool.`,
      );
    }

    const entry: CatalogEntry = {
      name: reg.name,
      description,
      source,
      exposure: reg.exposure,
      category: reg.category,
      discoveryCategories: [...new Set(reg.discoveryCategories ?? [])]
        .filter((category) => category !== reg.category),
      trustTier: reg.trustTier,
      impact: reg.impact,
      fullEncryptionSupport: reg.fullEncryptionSupport,
      executor: reg.executor ?? "cloud",
      requiresApproval: reg.requiresApproval ?? false,
      approvalLevel: reg.approvalLevel,
      approvalMode: reg.approvalMode,
      requiredCapabilities: reg.requiredCapabilities ?? [],
      conditionalCapabilities: reg.conditionalCapabilities,
      relayCapabilities: reg.relayCapabilities,
      requiredModelCapabilities: reg.requiredModelCapabilities,
      enabled: true,
      tags: reg.tags ?? [],
      resultScanPolicy: reg.resultScanPolicy ?? "never",
      scanInvisibleUnicode: reg.scanInvisibleUnicode,
      health: "connected",
      sourceServer: reg.sourceServer,
      guidance: reg.guidance,
      discovery: reg.discovery,
      connections: reg.connections ?? [],
      connectedAppProviderId: reg.connectedAppProviderId,
      asyncLifecycle: reg.asyncLifecycle,
      namespaceId: reg.namespaceId ?? null,
      hostedBy: reg.hostedBy ?? null,
      factory: reg.factory,
      isAvailable: reg.isAvailable,
      unavailableInContext: reg.unavailableInContext,
      unavailableReason: reg.unavailableReason,
    };

    this.entries.set(reg.name, entry);
    this.generation++;

    debug(
      `[catalog] Registered: ${reg.name} (${source}, ${reg.trustTier}, ${reg.impact})`,
    );
    return true;
  }

  /** Remove a tool. */
  unregister(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry) return false;

    this.entries.delete(name);
    this.generation++;

    if (entry.sourceServer) {
      const remaining = [...this.entries.values()].filter(
        (e) => e.sourceServer === entry.sourceServer,
      );
      if (remaining.length === 0) {
        debug(`[catalog] Last tool from server "${entry.sourceServer}" removed`);
      }
    }

    debug(`[catalog] Unregistered: ${name}`);
    return true;
  }

  /** Remove all tools from a specific MCP/relay server. */
  unregisterByServer(serverName: string): number {
    const toRemove = [...this.entries.values()]
      .filter((e) => e.sourceServer === serverName)
      .map((e) => e.name);
    for (const name of toRemove) this.entries.delete(name);
    if (toRemove.length > 0) {
      this.generation++;
      debug(`[catalog] Unregistered ${toRemove.length} tools from server "${serverName}"`);
    }
    return toRemove.length;
  }

  /**
   * Replace one server-owned contribution as a single visible generation.
   *
   * Registration factories and collision checks run against a private staged
   * copy. A rejected registration therefore leaves the live catalogue exactly
   * as it was instead of exposing a partially removed or partially refreshed
   * tool surface.
   */
  replaceServerContribution(
    serverName: string,
    newRegistrations: readonly ToolRegistration[],
  ): void {
    const names = new Set<string>();
    for (const registration of newRegistrations) {
      if (registration.sourceServer !== serverName) {
        throw new Error(
          `[catalog] Replacement for server "${serverName}" contains tool "${registration.name}" with mismatched sourceServer.`,
        );
      }
      if (names.has(registration.name)) {
        throw new Error(
          `[catalog] Replacement for server "${serverName}" contains duplicate tool "${registration.name}".`,
        );
      }
      names.add(registration.name);
    }

    const staged = new ToolCatalog();
    staged.entries = new Map(this.entries);
    staged.generation = this.generation;
    staged.unregisterByServer(serverName);

    for (const registration of newRegistrations) {
      if (staged.entries.has(registration.name)) {
        throw new Error(
          `[catalog] Replacement for server "${serverName}" would overwrite tool "${registration.name}" owned by another contribution.`,
        );
      }
      if (!staged.register(registration)) {
        throw new Error(
          `[catalog] Replacement for server "${serverName}" rejected tool "${registration.name}".`,
        );
      }
    }

    this.entries = staged.entries;
    this.generation++;
    log(`[catalog] Replaced server "${serverName}": ${newRegistrations.length} tools`);
  }

  /** Look up metadata for a tool (frozen copy, no factory exposed). */
  get(name: string): Readonly<ToolCatalogEntry> | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    return Object.freeze(toMetadata(entry));
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * Return a registration-owned safe recovery only while its live server
   * prerequisite is absent. Callers must complete actor authorization before
   * presenting this text; this probe never grants invocation eligibility.
   */
  private getUnavailableReason(name: string, context?: ToolContext): string | null {
    const entry = this.entries.get(name);
    if (!entry) return null;
    if (entry.isAvailable && !entry.isAvailable()) {
      return entry.unavailableReason ?? "This tool's server prerequisite is unavailable.";
    }
    return entry.unavailableInContext?.(context) ?? null;
  }

  /**
   * Return recovery text only when the live prerequisite is the sole reason
   * this exact actor/exposure projection omits the tool. This is a
   * metadata-only diagnostic: it never instantiates the unavailable tool.
   */
  getUnavailableReasonForExposure(
    name: string,
    options: ProgressiveToolResolverOptions = {},
  ): string | null {
    const unavailableReason = this.getUnavailableReason(name, options.context);
    if (unavailableReason === null) return null;
    const filterOptions = {
      ...(options.skipRelayLiveCheck !== undefined
        ? { skipRelayLiveCheck: options.skipRelayLiveCheck }
        : {}),
      ...(options.readableNamespaces !== undefined
        ? { readableNamespaces: options.readableNamespaces }
        : {}),
      ...(options.context !== undefined ? { context: options.context } : {}),
    };
    const eligible = this.getFilteredInternal(
      options.toolPolicy,
      options.relayCapabilities,
      filterOptions,
      name,
    );
    return resolveProgressiveSnapshot(eligible, options).entries.some((entry) => entry.name === name)
      ? unavailableReason
      : null;
  }

  get size(): number {
    return this.entries.size;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  // ---------------------------------------------------------------------
  // Query (metadata only, no trust filtering)
  // ---------------------------------------------------------------------

  query(filter: ToolQueryFilter): ToolCatalogEntry[] {
    const results: ToolCatalogEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.isAvailable && !entry.isAvailable()) continue;
      if (filter.enabled !== undefined && entry.enabled !== filter.enabled) continue;
      if (
        filter.category &&
        entry.category !== filter.category &&
        !entry.discoveryCategories?.includes(filter.category)
      ) continue;
      if (filter.source && entry.source !== filter.source) continue;
      if (filter.executor && entry.executor !== filter.executor) continue;
      if (filter.trustTier && entry.trustTier !== filter.trustTier) continue;
      if (filter.tag && !entry.tags.includes(filter.tag)) continue;
      if (filter.keyword) {
        const kw = filter.keyword.toLowerCase();
        if (!entry.name.toLowerCase().includes(kw) && !entry.description.toLowerCase().includes(kw)) continue;
      }
      results.push(toMetadata(entry));
    }
    return results.sort((a, b) =>
      a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category),
    );
  }

  // ---------------------------------------------------------------------
  // Filtered metadata snapshot (no instantiation)
  // ---------------------------------------------------------------------

  getFiltered(
    toolPolicy?: Readonly<Record<string, string>>  ,
    relayCapabilities?: Readonly<Record<string, boolean>>  ,
    options?: {
      /**
       * Defense-in-depth filter for post-model pre-flight: verify actor-tier +
       * toolPolicy + whitelist only — skip live relay capability checks (those
       * belong at dispatch time in nodes/tools.ts).
       */
      skipRelayLiveCheck?: boolean;
      /**
       * D384 C6 — the requesting actor's readable namespace ids (human-subset
       * rule). When provided, namespace-scoped tools (`entry.namespaceId != null`)
       * are hidden unless their namespace is in this set. Global tools
       * (`namespaceId` null/undefined) are always visible. When omitted, NO
       * namespace filtering is applied (backward-compatible default).
       */
      readableNamespaces?: readonly string[];
      /** Opaque server-stamped context used by contextual eligibility gates. */
      context?: ToolContext | undefined;
    },
  ): CatalogSnapshot {
    return this.getFilteredInternal(toolPolicy, relayCapabilities, options);
  }

  private getFilteredInternal(
    toolPolicy?: Readonly<Record<string, string>>,
    relayCapabilities?: Readonly<Record<string, boolean>>,
    options?: {
      skipRelayLiveCheck?: boolean;
      readableNamespaces?: readonly string[];
      context?: ToolContext | undefined;
    },
    ignoreUnavailableName?: string,
  ): CatalogSnapshot {
    const included: ToolCatalogEntry[] = [];
    const exclusions: ExclusionReason[] = [];
    const readableNamespaces = options?.readableNamespaces;
    const connectedAppProviderIds = new Set(
      Array.isArray(options?.context?.["connectedAppProviderIds"])
        ? options.context["connectedAppProviderIds"].filter((value): value is string =>
          typeof value === "string" && value.length > 0)
        : [],
    );

    for (const entry of this.entries.values()) {
      if (entry.name !== ignoreUnavailableName && entry.isAvailable && !entry.isAvailable()) { exclusions.push({ tool: entry.name, reason: "server prerequisite unavailable" }); continue; }
      if (entry.name !== ignoreUnavailableName && entry.unavailableInContext?.(options?.context) != null) {
        exclusions.push({ tool: entry.name, reason: "turn prerequisite unavailable" });
        continue;
      }
      if (!entry.enabled) { exclusions.push({ tool: entry.name, reason: "disabled by owner" }); continue; }
      if (entry.health === "disconnected" || entry.health === "error") { exclusions.push({ tool: entry.name, reason: `health=${entry.health}` }); continue; }

      if (readableNamespaces && entry.namespaceId != null && !readableNamespaces.includes(entry.namespaceId)) {
        exclusions.push({ tool: entry.name, reason: `namespace "${entry.namespaceId}" not readable by actor` });
        continue;
      }

      if (
        entry.connectedAppProviderId !== undefined &&
        !connectedAppProviderIds.has(entry.connectedAppProviderId)
      ) {
        exclusions.push({ tool: entry.name, reason: `connected app provider "${entry.connectedAppProviderId}" is not connected in this Human×Namespace` });
        continue;
      }

      if (toolPolicy) {
        const access = toolPolicy[entry.name];
        if (access === "forbidden") { exclusions.push({ tool: entry.name, reason: "forbidden by actor toolPolicy" }); continue; }
      }

      if (!options?.skipRelayLiveCheck && entry.executor === "relay") {
        if (!relayCapabilities) { exclusions.push({ tool: entry.name, reason: "requires relay but no relay connected" }); continue; }
        const requiredRelayCapabilities = entry.relayCapabilities ?? entry.requiredCapabilities;
        const missingCap = requiredRelayCapabilities.find((cap) => !relayCapabilities[cap]);
        if (missingCap) { exclusions.push({ tool: entry.name, reason: `requires relay capability "${missingCap}" not available` }); continue; }
      }

      // Some server-executed tools are entrypoints to a bounded local
      // capability rather than relay RPCs themselves. An explicit
      // `relayCapabilities` declaration remains a live-exposure gate for
      // those tools too; entries without one retain the existing cloud path.
      if (
        !options?.skipRelayLiveCheck
        && entry.executor !== "relay"
        && entry.relayCapabilities !== undefined
      ) {
        const missingCap = entry.relayCapabilities.find((cap) => !relayCapabilities?.[cap]);
        if (missingCap) { exclusions.push({ tool: entry.name, reason: `requires relay capability "${missingCap}" not available` }); continue; }
      }

      included.push(toMetadata(entry));
    }

    if (exclusions.length > 0) {
      debug(
        `[catalog] getFiltered: ${included.length} included, ${exclusions.length} excluded — ` +
          exclusions.map((e) => `${e.tool}: ${e.reason}`).join("; "),
      );
    }

    return Object.freeze({
      generation: this.generation,
      entries: Object.freeze([...included]),
      exclusions: Object.freeze([...exclusions]),
    });
  }

  /**
   * D419 — resolve the opt-in progressive tool set for an actor.
   *
   * Authorization, health, relay, and namespace eligibility are always
   * evaluated first. Exposure selection can only narrow that eligible set:
   * core tools plus explicitly activated and intent-pack names, constrained
   * by an explicit whitelist when supplied. Required model capabilities are a
   * final gate, so activation can never bypass normal authorization.
   */
  resolveProgressiveTools(
    options: ProgressiveToolResolverOptions = {},
  ): ProgressiveToolResolution {
    const filterOptions = {
      ...(options.skipRelayLiveCheck !== undefined
        ? { skipRelayLiveCheck: options.skipRelayLiveCheck }
        : {}),
      ...(options.readableNamespaces !== undefined
        ? { readableNamespaces: options.readableNamespaces }
        : {}),
      ...(options.context !== undefined ? { context: options.context } : {}),
    };
    const eligible = this.getFiltered(
      options.toolPolicy,
      options.relayCapabilities,
      filterOptions,
    );
    const snapshot = resolveProgressiveSnapshot(eligible, options);
    const allowedNames = new Set(snapshot.entries.map((entry) => entry.name));
    const tools: StructuredTool[] = [];
    for (const [name, entry] of this.entries) {
      if (allowedNames.has(name)) tools.push(entry.factory(options.context));
    }

    debug(
      `[catalog] resolveProgressiveTools: ${eligible.entries.length} eligible, ` +
        `${snapshot.entries.length} exposed, ${tools.length} instantiated`,
    );
    return Object.freeze({
      eligible,
      snapshot,
      tools: Object.freeze(tools),
      counts: Object.freeze({
        eligible: eligible.entries.length,
        exposed: snapshot.entries.length,
        instantiated: tools.length,
      }),
    });
  }

  // ---------------------------------------------------------------------
  // THE main API — get runnable tools for an actor
  // ---------------------------------------------------------------------

  /**
   * One call. Returns StructuredTool[] ready to bind to the model.
   * Filters by trust tier + policy + health + relay, then creates
   * fresh instances from factories with the actor's context.
   */
  getToolsForActor(
    context?: ToolContext,
    toolPolicy?: Readonly<Record<string, string>>,
    relayCapabilities?: Readonly<Record<string, boolean>>,
    /** M084 — when set (including `[]`), only these tool names are instantiated */
    toolNameWhitelist?: readonly string[],
    options?: {
      /**
       * Defense-in-depth filter for post-model pre-flight: verify actor-tier +
       * toolPolicy + whitelist only — skip live relay capability checks (those
       * belong at dispatch time in nodes/tools.ts).
       */
      skipRelayLiveCheck?: boolean;
      /** D384 C6 — actor's readable namespace ids; see `getFiltered`. */
      readableNamespaces?: readonly string[];
    },
  ): StructuredTool[] {
    const snapshot = this.getFiltered(toolPolicy, relayCapabilities, {
      ...options,
      ...(context === undefined ? {} : { context }),
    });
    const allowedNames = new Set(snapshot.entries.map((e) => e.name));

    const tools: StructuredTool[] = [];
    for (const [name, entry] of this.entries) {
      if (!allowedNames.has(name)) continue;
      if (toolNameWhitelist !== undefined && !toolNameWhitelist.includes(name)) {
        continue;
      }
      tools.push(entry.factory(context));
    }

    debug(
      `[catalog] getToolsForActor: ${tools.length} tools instantiated`,
    );
    return tools;
  }

  // ---------------------------------------------------------------------
  // Reconciliation for MCP notifications/tools/list_changed
  // ---------------------------------------------------------------------

  refresh(serverName: string, newRegistrations: ToolRegistration[]): void {
    const existing = [...this.entries.values()].filter((e) => e.sourceServer === serverName);
    const existingNames = new Set(existing.map((e) => e.name));
    const newNames = new Set(newRegistrations.map((e) => e.name));
    let removed = false;

    for (const name of existingNames) {
      if (!newNames.has(name)) {
        this.entries.delete(name);
        removed = true;
        debug(`[catalog] refresh("${serverName}"): removed ${name}`);
      }
    }
    // A refresh to an empty list has no subsequent register() call to advance
    // the generation. Advance it here so cached progressive snapshots cannot
    // retain schemas or factories for tools that disappeared upstream.
    if (removed) this.generation++;
    for (const reg of newRegistrations) this.register(reg);

    log(`[catalog] refresh("${serverName}"): ${newRegistrations.length} tools`);
  }

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------

  listCategories(): ToolCategory[] {
    const cats = new Set<ToolCategory>();
    for (const entry of this.entries.values()) cats.add(entry.category);
    return [...cats].sort();
  }

  getStats(): ToolCatalogStats {
    const bySource: Record<ToolSource, number> = { builtin: 0, mcp: 0, relay: 0, plugin: 0 };
    const byCategory: Partial<Record<ToolCategory, number>> = {};
    const byTier: Record<ToolTrustTier, number> = { admin: 0, high: 0, standard: 0, guest: 0 };
    let enabled = 0, disabled = 0;

    for (const entry of this.entries.values()) {
      bySource[entry.source]++;
      byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
      byTier[entry.trustTier]++;
      if (entry.enabled) enabled++; else disabled++;
    }

    return { total: this.entries.size, bySource, byCategory, byTier, enabled, disabled };
  }

  validate(options: ToolCatalogValidationOptions = {}): void {
    const errors: string[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.name) errors.push("Entry with empty name");
      if (!entry.description) errors.push(`${entry.name}: empty description`);
      if (!TIER_ORDER.includes(entry.trustTier)) errors.push(`${entry.name}: invalid trustTier "${entry.trustTier}"`);
      if (!entry.factory) errors.push(`${entry.name}: no factory`);
      if (options.requireExposure && entry.exposure === undefined) {
        errors.push(`${entry.name}: missing exposure`);
      }
      for (const conn of entry.connections ?? []) {
        if (!conn.service.trim()) errors.push(`${entry.name}: Connection service is empty`);
        if (!conn.field.trim()) errors.push(`${entry.name}: Connection field is empty`);
        if (!conn.displayLabel.trim()) errors.push(`${entry.name}: Connection displayLabel is empty`);
      }
    }
    if (errors.length > 0) {
      throw new Error(`[catalog] Validation failed (${errors.length} errors):\n${errors.join("\n")}`);
    }
    log(`[catalog] Validated: ${this.entries.size} tools, 0 errors`);
  }

  /**
   * Get impact and capability info for a tool — used by post_model
   * for defense-in-depth checks. Replaces TOOL_POLICIES lookups.
   */
  getToolPolicy(name: string): {
    impact: string;
    requiredCapability: string | null;
    requiresApproval: boolean;
    approvalLevel?: ToolCatalogEntry["approvalLevel"] | undefined;
    approvalMode?: ToolApprovalMode | undefined;
  } {
    const entry = this.entries.get(name);
    if (!entry) {
      return {
        impact: "destructive",
        requiredCapability: UNREGISTERED_TOOL_CAPABILITY,
        requiresApproval: true,
        approvalLevel: "prove_it",
      };
    }
    const requiredCapability = entry.requiredCapabilities.length > 0
      ? entry.requiredCapabilities[0]!
      : null;
    return {
      impact: entry.impact,
      requiredCapability,
      requiresApproval: entry.requiresApproval,
      approvalLevel: entry.approvalLevel,
      approvalMode: entry.approvalMode,
    };
  }
}
