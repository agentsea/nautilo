import {
  claudeConnectionAccountSchema,
  claudeConnectionCatalogSchema,
  claudeConnectionRuntimeSchema,
} from "@nautilo/types";
import type {
  ClaudeConnectionAccount,
  ClaudeConnectionCatalog,
  ClaudeConnectionRuntime,
  ClaudeConnectionSummary,
} from "@nautilo/types";
import {
  CLAUDE_EXECUTION_PROTOCOL_VERSION,
  type RelayClaudeConnectionDiscoveryResult,
} from "@nautilo/relay";

export type ClaudeConnectionContext = Readonly<{
  relayId: string;
  relaySessionId: string;
  desktopSessionId: string;
  pairingGenerationRef: string;
  selectedProtocolVersion: number;
  capabilityRevision: number;
}>;

/** A deliberately small current-session projection for ordinary Task admission. */
export type ClaudeExecutionModel = Readonly<{
  profileRef: string;
  catalogModelId: string;
  selectedModel: string;
  displayName: string;
  description: string;
  selected: boolean;
}>;

export type ClaudeExecutionAdmission = Readonly<{
  profileRef: string;
  catalogModelId: string;
  selectedModel: string;
  scope: ClaudeConnectionContext;
}>;

export type StoredClaudeConnection = Readonly<{
  profileRef: string;
  enabled: boolean;
  selectedModel: string | null;
  runtime: ClaudeConnectionRuntime | null;
  account: ClaudeConnectionAccount | null;
  catalog: ClaudeConnectionCatalog | null;
  observationRevision: number;
  observedAt: Date | null;
}>;

export interface ClaudeConnectionControllerDeps {
  readonly getConnection: (userId: string) => Promise<StoredClaudeConnection>;
  readonly setEnabled: (userId: string, enabled: boolean) => Promise<StoredClaudeConnection>;
  readonly saveObservation: (input: {
    userId: string;
    runtime: ClaudeConnectionRuntime;
    account: ClaudeConnectionAccount;
    catalog: ClaudeConnectionCatalog;
  }) => Promise<StoredClaudeConnection | undefined>;
  readonly selectModel: (input: { userId: string; model: string | null; expectedObservationRevision: number }) => Promise<StoredClaudeConnection | undefined>;
  readonly listContexts: (userId: string) => Promise<readonly ClaudeConnectionContext[]>;
  /**
   * Read-only v18 execution capability lookup. It is optional while existing
   * discovery-only controller callers migrate; absence fails closed.
   */
  readonly getExecutionSession?: (relayId: string, userId: string) => ClaudeConnectionContext | null;
  readonly requestDiscovery: (input: { relayId: string; userId: string; profileRef: string }) => Promise<RelayClaudeConnectionDiscoveryResult>;
  readonly onContext: (listener: (relayId: string, userId: string, context: ClaudeConnectionContext | null) => void) => () => void;
}

type FreshObservation = Readonly<{ context: ClaudeConnectionContext; profileRef: string; observationRevision: number }>;
type ExecutionEligibleRow = StoredClaudeConnection & {
  readonly runtime: Extract<ClaudeConnectionRuntime, { state: "ready" }>;
  readonly account: Extract<ClaudeConnectionAccount, { state: "connected" }>;
  readonly catalog: Extract<ClaudeConnectionCatalog, { state: "complete" }>;
};
type ExecutionEligibleConnection = Readonly<{ row: ExecutionEligibleRow; context: ClaudeConnectionContext }>;

/**
 * Owns only the server-side discovery projection. Relay command correlation
 * remains in RelayRegistry; this controller fences a result again against the
 * current owner/context before persistence so a late Desktop cannot win.
 */
export class ClaudeConnectionController {
  readonly #deps: ClaudeConnectionControllerDeps;
  readonly #contexts = new Map<string, Map<string, ClaudeConnectionContext>>();
  readonly #generation = new Map<string, number>();
  readonly #inFlight = new Map<string, Readonly<{ generation: number; context: ClaudeConnectionContext; profileRef: string; promise: Promise<void> }>>();
  readonly #fresh = new Map<string, FreshObservation>();
  readonly #unsubscribe: () => void;

  public constructor(deps: ClaudeConnectionControllerDeps) {
    this.#deps = deps;
    this.#unsubscribe = deps.onContext((relayId, userId, context) => {
      const contexts = this.#contexts.get(userId) ?? new Map<string, ClaudeConnectionContext>();
      if (context === null) contexts.delete(relayId);
      else contexts.set(relayId, context);
      if (contexts.size === 0) this.#contexts.delete(userId);
      else this.#contexts.set(userId, contexts);
      this.#invalidate(userId);
      this.#releaseUserIfIdle(userId);
      void this.#autoDiscover(userId).catch(() => undefined);
    });
  }

  public close(): void { this.#unsubscribe(); this.#contexts.clear(); this.#generation.clear(); this.#inFlight.clear(); this.#fresh.clear(); }
  /** Test seam for bounded owner-state retention. */
  public trackedOwnerCountForTest(): number { return new Set([...this.#contexts.keys(), ...this.#generation.keys(), ...this.#fresh.keys()]).size; }

  public async summary(userId: string, relayHint?: string): Promise<ClaudeConnectionSummary> {
    const row = await this.#deps.getConnection(userId);
    const context = await this.#resolveContext(userId, relayHint);
    if (context !== null && !this.#isFresh(userId, row, context)) await this.#discover(userId, row, context);
    return this.#project(userId, await this.#deps.getConnection(userId), await this.#resolveContext(userId, relayHint));
  }

  public async setEnabled(userId: string, enabled: boolean, relayHint?: string): Promise<ClaudeConnectionSummary> {
    const row = await this.#deps.setEnabled(userId, enabled);
    return this.#project(userId, row, await this.#resolveContext(userId, relayHint));
  }

  public async checkAgain(userId: string, relayHint?: string): Promise<ClaudeConnectionSummary> {
    const row = await this.#deps.getConnection(userId);
    const context = await this.#resolveContext(userId, relayHint);
    if (context !== null) await this.#discover(userId, row, context);
    return this.#project(userId, await this.#deps.getConnection(userId), await this.#resolveContext(userId, relayHint));
  }

  public async selectModel(userId: string, modelId: string | null, relayHint?: string): Promise<ClaudeConnectionSummary | null> {
    const row = await this.#deps.getConnection(userId);
    const context = await this.#resolveContext(userId, relayHint);
    if (context === null || !this.#isFresh(userId, row, context) || row.catalog?.state !== "complete") return null;
    let canonical: string | null = null;
    if (modelId !== null) {
      const candidate = row.catalog.models.find((model) => model.id === modelId);
      if (!candidate) return null;
      canonical = candidate.resolvedModel ?? candidate.id;
    }
    const updated = await this.#deps.selectModel({ userId, model: canonical, expectedObservationRevision: row.observationRevision });
    return updated ? this.#project(userId, updated, await this.#resolveContext(userId, relayHint)) : null;
  }

  /**
   * The model picker sees only the current, execution-eligible catalog. It
   * deliberately does not project account, discovery, or relay identity.
   */
  public async listExecutionModels(userId: string): Promise<readonly ClaudeExecutionModel[]> {
    const eligible = await this.#executionEligible(userId);
    if (eligible === null) return EMPTY_EXECUTION_MODELS;
    return Object.freeze(eligible.row.catalog.models.map((model) => Object.freeze({
      profileRef: eligible.row.profileRef,
      catalogModelId: model.id,
      selectedModel: model.resolvedModel ?? model.id,
      displayName: model.displayName,
      description: model.description,
      selected: (model.resolvedModel ?? model.id) === eligible.row.selectedModel,
    })));
  }

  /**
   * Rechecks the one fresh discovery row and its live v18 execution session
   * immediately before an ordinary Task is created. This makes no writes and
   * never opens a relay execution.
   */
  public async admitExecution(
    userId: string,
    input: Readonly<{ profileRef: string; catalogModelId: string; selectedModel: string }>,
  ): Promise<ClaudeExecutionAdmission | null> {
    const requested = captureExecutionSelection(input);
    if (requested === null) return null;
    const eligible = await this.#executionEligible(userId);
    if (eligible === null || eligible.row.profileRef !== requested.profileRef || eligible.row.selectedModel !== requested.selectedModel) return null;
    const model = eligible.row.catalog.models.find((candidate) => candidate.id === requested.catalogModelId);
    if (!model || (model.resolvedModel ?? model.id) !== requested.selectedModel) return null;
    return Object.freeze({
      profileRef: requested.profileRef,
      catalogModelId: requested.catalogModelId,
      selectedModel: requested.selectedModel,
      scope: freezeContext(eligible.context),
    });
  }

  async #syncContexts(userId: string): Promise<void> {
    const next = new Map((await this.#deps.listContexts(userId)).map((context) => [context.relayId, context]));
    const previous = this.#contexts.get(userId);
    if (!sameContextMap(previous, next)) {
      if (next.size === 0) this.#contexts.delete(userId);
      else this.#contexts.set(userId, next);
      this.#invalidate(userId);
      this.#releaseUserIfIdle(userId);
    }
  }

  async #resolveContext(userId: string, relayHint?: string): Promise<ClaudeConnectionContext | null> {
    await this.#syncContexts(userId);
    return this.#currentContext(userId, relayHint);
  }

  #currentContext(userId: string, relayHint?: string): ClaudeConnectionContext | null {
    const contexts = this.#contexts.get(userId);
    if (!contexts) return null;
    if (relayHint !== undefined) return contexts.get(relayHint) ?? null;
    return contexts.size === 1 ? contexts.values().next().value ?? null : null;
  }

  async #autoDiscover(userId: string): Promise<void> {
    const row = await this.#deps.getConnection(userId);
    const context = await this.#resolveContext(userId);
    if (context !== null) await this.#discover(userId, row, context);
  }

  #discoveryKey(userId: string, relayId: string): string { return JSON.stringify([userId, relayId]); }

  #discover(userId: string, row: StoredClaudeConnection, context: ClaudeConnectionContext): Promise<void> {
    const generation = this.#generation.get(userId) ?? 0;
    const key = this.#discoveryKey(userId, context.relayId);
    const existing = this.#inFlight.get(key);
    if (existing && existing.generation === generation && sameContext(existing.context, context) && existing.profileRef === row.profileRef) return existing.promise;
    const promise = Promise.resolve().then(() => this.#runDiscovery(userId, row, context, generation, key));
    this.#inFlight.set(key, { generation, context, profileRef: row.profileRef, promise });
    return promise;
  }

  async #runDiscovery(userId: string, row: StoredClaudeConnection, context: ClaudeConnectionContext, generation: number, key: string): Promise<void> {
    try {
      const result = await this.#deps.requestDiscovery({ relayId: context.relayId, userId, profileRef: row.profileRef });
      const latest = await this.#resolveContext(userId, context.relayId);
      if (
        this.#generation.get(userId) !== generation ||
        latest === null || !sameContext(latest, context) ||
        !sameContextScope(result.scope, context) ||
        result.profileRef !== row.profileRef
      ) return;
      const runtime = claudeConnectionRuntimeSchema.safeParse(safeRuntime(result.runtime));
      const account = claudeConnectionAccountSchema.safeParse(safeAccount(result.account));
      const catalog = claudeConnectionCatalogSchema.safeParse(safeCatalog(result.catalog));
      if (!runtime.success || !account.success || !catalog.success) return;
      const saved = await this.#deps.saveObservation({
        userId,
        runtime: runtime.data,
        account: account.data,
        catalog: catalog.data,
      });
      const freshContext = await this.#resolveContext(userId, context.relayId);
      if (saved && this.#generation.get(userId) === generation && sameContext(freshContext, context)) {
        this.#fresh.set(userId, { context, profileRef: row.profileRef, observationRevision: saved.observationRevision });
      }
    } catch {
      // Relay transport owns its bounded failure. Retained observations remain explicitly stale.
    } finally {
      if (this.#inFlight.get(key)?.generation === generation) this.#inFlight.delete(key);
      this.#releaseUserIfIdle(userId);
    }
  }

  #invalidate(userId: string, dropFresh = true): void {
    this.#generation.set(userId, (this.#generation.get(userId) ?? 0) + 1);
    if (dropFresh) this.#fresh.delete(userId);
  }

  #releaseUserIfIdle(userId: string): void {
    if (this.#contexts.has(userId) || this.#fresh.has(userId)) return;
    const prefix = JSON.stringify([userId]).slice(0, -1);
    if ([...this.#inFlight.keys()].some((key) => key.startsWith(prefix))) return;
    this.#generation.delete(userId);
  }

  #isFresh(userId: string, row: StoredClaudeConnection, context: ClaudeConnectionContext | null): boolean {
    const fresh = this.#fresh.get(userId);
    return context !== null && fresh !== undefined && fresh.profileRef === row.profileRef && fresh.observationRevision === row.observationRevision && sameContext(fresh.context, context);
  }

  /** Final read fence shared by model listing and Task admission. */
  async #executionEligible(userId: string): Promise<ExecutionEligibleConnection | null> {
    try {
      await this.#syncContexts(userId);
      // The stored-row read is last: no further await occurs before its
      // current context/session fence is checked.
      const row = await this.#deps.getConnection(userId);
      const context = this.#currentContext(userId);
      if (!isExecutionEligibleRow(row) || context === null || context.selectedProtocolVersion < CLAUDE_EXECUTION_PROTOCOL_VERSION || !this.#isFresh(userId, row, context)) return null;
      const getExecutionSession = this.#deps.getExecutionSession;
      if (!getExecutionSession) return null;
      const session = getExecutionSession.call(this.#deps, context.relayId, userId);
      if (session === null || !sameContext(session, context) || session.selectedProtocolVersion < CLAUDE_EXECUTION_PROTOCOL_VERSION) return null;
      return Object.freeze({ row, context: freezeContext(context) });
    } catch {
      return null;
    }
  }

  #project(userId: string, row: StoredClaudeConnection, context: ClaudeConnectionContext | null): ClaudeConnectionSummary {
    const isFresh = this.#isFresh(userId, row, context);
    const runtime = normalizeStoredRuntime(row.runtime);
    const pending = context !== null && (() => {
      const value = this.#inFlight.get(this.#discoveryKey(userId, context.relayId));
      return value !== undefined && value.profileRef === row.profileRef && sameContext(value.context, context);
    })();
    const selectedModelAdmitted = isFresh && runtime?.state === "ready" && runtime.executionQualified && row.account?.state === "connected" && row.catalog?.state === "complete" && row.selectedModel !== null && row.catalog.models.some((model) => (model.resolvedModel ?? model.id) === row.selectedModel);
    return {
      enabled: row.enabled,
      selectedModel: row.selectedModel,
      selectedModelAdmitted,
      runtime: runtime ?? { state: "unavailable" },
      account: row.account ?? { state: "unavailable" },
      catalog: row.catalog ?? { state: "unavailable", complete: false, models: [] },
      connectionState: !row.enabled ? "disabled" : pending ? "reconnecting" : isFresh && runtime?.state === "ready" && runtime.executionQualified && row.account?.state === "connected" ? "connected" : "unavailable",
      observedAt: row.observedAt?.toISOString() ?? null,
      observationStale: !isFresh,
    };
  }
}

function normalizeStoredRuntime(runtime: ClaudeConnectionRuntime | null): ClaudeConnectionRuntime | null {
  if (runtime?.state !== "ready") return runtime;
  return { state: "ready", version: runtime.version, executionQualified: runtime.executionQualified === true };
}

const EMPTY_EXECUTION_MODELS: readonly ClaudeExecutionModel[] = Object.freeze([]);

function isExecutionEligibleRow(row: StoredClaudeConnection): row is ExecutionEligibleRow {
  return row.enabled
    && row.runtime?.state === "ready"
    && row.runtime.executionQualified === true
    && row.account?.state === "connected"
    && row.catalog?.state === "complete"
    && row.catalog.complete === true;
}

function captureExecutionSelection(value: Readonly<{ profileRef: string; catalogModelId: string; selectedModel: string }>): Readonly<{ profileRef: string; catalogModelId: string; selectedModel: string }> | null {
  try {
    const profileRef = value.profileRef;
    const catalogModelId = value.catalogModelId;
    const selectedModel = value.selectedModel;
    if (!isBoundedExecutionText(profileRef) || !isBoundedExecutionText(catalogModelId) || !isBoundedExecutionText(selectedModel)) return null;
    return Object.freeze({ profileRef, catalogModelId, selectedModel });
  } catch {
    return null;
  }
}

function isBoundedExecutionText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && new TextEncoder().encode(value).byteLength <= 320;
}

function freezeContext(context: ClaudeConnectionContext): ClaudeConnectionContext {
  return Object.freeze({
    relayId: context.relayId,
    relaySessionId: context.relaySessionId,
    desktopSessionId: context.desktopSessionId,
    pairingGenerationRef: context.pairingGenerationRef,
    selectedProtocolVersion: context.selectedProtocolVersion,
    capabilityRevision: context.capabilityRevision,
  });
}

function sameContext(left: ClaudeConnectionContext | null, right: ClaudeConnectionContext): boolean {
  return left !== null && left.relayId === right.relayId && left.relaySessionId === right.relaySessionId &&
    left.desktopSessionId === right.desktopSessionId && left.pairingGenerationRef === right.pairingGenerationRef &&
    left.selectedProtocolVersion === right.selectedProtocolVersion && left.capabilityRevision === right.capabilityRevision;
}
function sameContextScope(left: RelayClaudeConnectionDiscoveryResult["scope"], right: ClaudeConnectionContext): boolean {
  return sameContext(left, right);
}
function sameContextMap(left: Map<string, ClaudeConnectionContext> | undefined, right: Map<string, ClaudeConnectionContext>): boolean {
  if (left?.size !== right.size) return false;
  return [...right].every(([relayId, context]) => sameContext(left?.get(relayId) ?? null, context));
}

function safeRuntime(value: RelayClaudeConnectionDiscoveryResult["runtime"]): ClaudeConnectionRuntime {
  return value.state === "ready" ? { state: "ready", version: value.version, executionQualified: value.executionQualified }
    : value.state === "unavailable" ? { state: "unavailable" }
      : value.version === undefined ? { state: value.state } : { state: value.state, version: value.version };
}
function safeAccount(value: RelayClaudeConnectionDiscoveryResult["account"]): ClaudeConnectionAccount {
  if (value.state !== "connected") return { state: value.state };
  return {
    state: "connected",
    ...(value.email === undefined ? {} : { email: value.email }),
    ...(value.organization === undefined ? {} : { organization: value.organization }),
    ...(value.subscriptionType === undefined ? {} : { subscriptionType: value.subscriptionType }),
    ...(value.tokenSource !== undefined || value.apiKeySource !== undefined ? { credentialsAvailable: true } : {}),
    ...(value.apiProvider === undefined ? {} : { apiProvider: value.apiProvider }),
  };
}
function safeCatalog(value: RelayClaudeConnectionDiscoveryResult["catalog"]): ClaudeConnectionCatalog {
  const models = value.models.map((model) => ({
    id: model.id,
    ...(model.resolvedModel === undefined ? {} : { resolvedModel: model.resolvedModel }),
    displayName: model.displayName,
    description: model.description,
    ...(model.supportedEffortLevels === undefined ? {} : { supportedEffortLevels: [...model.supportedEffortLevels] }),
    ...(model.supportsEffort === undefined ? {} : { supportsEffort: model.supportsEffort }),
    ...(model.supportsAdaptiveThinking === undefined ? {} : { supportsAdaptiveThinking: model.supportsAdaptiveThinking }),
    ...(model.supportsFastMode === undefined ? {} : { supportsFastMode: model.supportsFastMode }),
    ...(model.supportsAutoMode === undefined ? {} : { supportsAutoMode: model.supportsAutoMode }),
  }));
  return value.state === "complete" ? { state: "complete", complete: true, models }
    : value.state === "incomplete" ? { state: "incomplete", complete: false, models }
      : { state: "unavailable", complete: false, models: [] };
}
