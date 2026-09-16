import type {
  HostScope,
  ProfileLaunchScope,
  ProfileScope,
  RelayCodexCommandMessage,
  RelayCodexCommandResponseMessage,
  CodexStableErrorCode,
} from "@nautilo/relay";
import {
  CodexRelaySemanticAdapter,
  type CodexRelaySemanticScopes,
  type CodexSemanticResult,
  type RelayCodexSessionSnapshot,
} from "@nautilo/runtime";

const MAX_OPAQUE_BYTES = 512;
const DEFAULT_LOGIN_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ISSUED_LOGINS = 64;
const encoder = new TextEncoder();

export type CodexAdminControlError =
  | "CODEX_UNAVAILABLE"
  | "CODEX_STALE"
  | "CODEX_FORBIDDEN"
  | "CODEX_CONFLICT"
  | CodexStableErrorCode;

/** A stable error only. Never expose an upstream or transport error message. */
export class CodexAdminControlFailure extends Error {
  constructor(readonly code: CodexAdminControlError) {
    super(code);
    this.name = "CodexAdminControlFailure";
  }
}

/** Canonical host ownership facts, supplied by an authenticated server route. */
export type CodexAdminHostFacts = {
  readonly userId: string;
  readonly relayId: string;
};

/** Canonical persisted profile identity, supplied by an authenticated server route. */
export type CodexAdminProfileFacts = CodexAdminHostFacts & {
  readonly profileHandle: string;
  readonly profileGeneration: number;
  readonly accountGeneration: number;
};

/** The private v8+ relay-family seam. It is deliberately not a Tool port. */
export interface CodexAdminRelayPort {
  getCodexSession(relayId: string, userId: string): RelayCodexSessionSnapshot | null;
  sendCodexCommand(
    relayId: string,
    command: RelayCodexCommandMessage,
    options?: { readonly timeoutMs?: number },
  ): Promise<RelayCodexCommandResponseMessage>;
}

/** Server-only allocator; routes never choose handles or generations. */
export interface CodexAdminProfileIds {
  mint(input: CodexAdminHostFacts): {
    readonly profileHandle: string;
    readonly profileGeneration: number;
  };
}

/** Server-reviewed artifact selection; callers cannot provide a URL or path. */
export interface CodexReviewedRuntimeArtifactAuthority {
  selectInstallArtifact(input: CodexAdminHostFacts): Promise<{
    readonly artifactRef: string;
  }>;
}

export type CodexAdminControlPlaneOptions = {
  readonly relay: CodexAdminRelayPort;
  readonly profileIds: CodexAdminProfileIds;
  readonly artifacts: CodexReviewedRuntimeArtifactAuthority;
  /**
   * Cold runtime inspection may need to start the external launcher and load
   * its app-server schema. Every other operation deliberately keeps the
   * relay's normal timeout.
   */
  readonly runtimeInspectTimeoutMs?: number;
  readonly now?: () => Date;
  readonly loginTtlMs?: number;
  readonly maxIssuedLogins?: number;
};

type RelayAdminResult = CodexSemanticResult["result"];
type RuntimeResult = Extract<RelayAdminResult, { readonly kind: "runtime_status" }>;
type ProfileCreated = Extract<RelayAdminResult, {
  readonly kind: "profile_status";
  readonly state: "created";
}>;
type ProfileRemoved = Extract<RelayAdminResult, {
  readonly kind: "profile_status";
  readonly state: "removed";
}>;
type AccountStatus = Extract<RelayAdminResult, { readonly kind: "account_status" }>;
type LoginStarted = Extract<RelayAdminResult, { readonly kind: "login_started" }>;
type RateLimitsStatus = Extract<RelayAdminResult, { readonly kind: "rate_limits_status" }>;
type AccountUsageStatus = Extract<RelayAdminResult, { readonly kind: "account_usage_status" }>;
type ModelCatalogStatus = Extract<RelayAdminResult, { readonly kind: "model_catalog_status" }>;
type AccountSemanticResult = AccountStatus | RateLimitsStatus | AccountUsageStatus | ModelCatalogStatus;
export type CodexAdminModelCatalog = ModelCatalogStatus["value"] & {
  /** Nautilo's initial choice, selected only from the live returned catalog. */
  readonly preferredModelId: string | null;
};

const NAUTILO_CODEX_MODEL_PREFERENCE = Object.freeze([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
] as const);

export function selectPreferredCodexModelId(
  models: ModelCatalogStatus["value"]["models"],
): string | null {
  for (const preferredModel of NAUTILO_CODEX_MODEL_PREFERENCE) {
    const advertised = models.find((entry) => entry.model === preferredModel);
    if (advertised) return advertised.id;
  }
  return models.find((entry) => entry.isDefault)?.id ?? models[0]?.id ?? null;
}

type IssuedLogin = {
  readonly profileHandle: string;
  readonly profileGeneration: number;
  readonly accountGeneration: number;
  readonly runtimeGeneration: number;
  readonly childGeneration: number;
  readonly expiresAt: number;
};

/**
 * Server-private semantic control plane for Connections administration.
 *
 * It composes the one existing CodexRelaySemanticAdapter for parser,
 * envelope, command-id and response-correlation ownership. This layer owns
 * only server-canonical authority, profile/login lifecycle and safe results.
 * It intentionally does not own DB tombstone ordering or expose a Tool API.
 */
export class CodexAdminControlPlane {
  private readonly issuedLogins = new Map<string, IssuedLogin>();
  /**
   * A runtime probe is read-only. Coalesce only callers that observed the
   * same live host session and capability revision; a newly paired desktop or
   * capability update must always receive its own command and correlation.
   */
  private readonly inFlightRuntimeInspections = new Map<string, Promise<RuntimeResult>>();
  private readonly now: () => Date;
  private readonly loginTtlMs: number;
  private readonly maxIssuedLogins: number;

  constructor(private readonly options: CodexAdminControlPlaneOptions) {
    this.now = options.now ?? (() => new Date());
    this.loginTtlMs = options.loginTtlMs ?? DEFAULT_LOGIN_TTL_MS;
    this.maxIssuedLogins = options.maxIssuedLogins ?? DEFAULT_MAX_ISSUED_LOGINS;
    if (!safePositive(this.loginTtlMs) || !safePositive(this.maxIssuedLogins)) {
      throw new Error("invalid Codex admin login retention options");
    }
  }

  async inspectRuntime(input: CodexAdminHostFacts): Promise<RuntimeResult> {
    const scope = this.hostScope(input);
    const key = runtimeInspectionKey(input.userId, scope);
    const existing = this.inFlightRuntimeInspections.get(key);
    if (existing) return existing;

    const inspection = this.execute(input.relayId, {
      resolveHostScope: () => scope,
    }, { operation: "runtime_inspect" }).then((result) => expectResult(result, "runtime_status"));
    this.inFlightRuntimeInspections.set(key, inspection);
    const cleanup = () => {
      if (this.inFlightRuntimeInspections.get(key) === inspection) {
        this.inFlightRuntimeInspections.delete(key);
      }
    };
    void inspection.then(cleanup, cleanup);
    return inspection;
  }

  async installRuntime(input: CodexAdminHostFacts): Promise<RuntimeResult> {
    const artifact = await this.options.artifacts.selectInstallArtifact(input)
      .catch(() => { throw new CodexAdminControlFailure("CODEX_UNAVAILABLE"); });
    if (!opaque(artifact.artifactRef)) throw new CodexAdminControlFailure("CODEX_UNAVAILABLE");
    return this.hostRuntime(input, { operation: "runtime_install", artifactRef: artifact.artifactRef });
  }

  /** Cancels only the live host-status install; no browser ref is accepted. */
  async cancelRuntimeInstall(input: CodexAdminHostFacts): Promise<RuntimeResult> {
    const runtime = this.liveSession(input).status!.runtime;
    if (runtime?.state !== "installing" || !opaque(runtime.installRef ?? "")) {
      throw new CodexAdminControlFailure("CODEX_CONFLICT");
    }
    return this.hostRuntime(input, {
      operation: "runtime_cancel_install",
      installRef: runtime.installRef!,
    });
  }

  async activateRuntime(
    input: CodexAdminHostFacts & { readonly runtimeGeneration: number },
  ): Promise<RuntimeResult> {
    assertGeneration(input.runtimeGeneration);
    return this.hostRuntime(input, { operation: "runtime_activate", runtimeGeneration: input.runtimeGeneration });
  }

  async rollbackRuntime(input: CodexAdminHostFacts): Promise<RuntimeResult> {
    return this.hostRuntime(input, { operation: "runtime_rollback" });
  }

  async removeRuntime(
    input: CodexAdminHostFacts & { readonly runtimeGeneration: number },
  ): Promise<RuntimeResult> {
    assertGeneration(input.runtimeGeneration);
    const result = await this.hostRuntime(input, { operation: "runtime_remove", runtimeGeneration: input.runtimeGeneration });
    this.issuedLogins.clear();
    return result;
  }

  async createProfile(input: CodexAdminHostFacts): Promise<ProfileCreated> {
    const identity = this.options.profileIds.mint(input);
    if (!opaque(identity.profileHandle)) throw new CodexAdminControlFailure("CODEX_UNAVAILABLE");
    assertGeneration(identity.profileGeneration);
    const result = await this.execute(input.relayId, {
      resolveHostScope: () => this.hostScope(input),
    }, {
      operation: "profile_create",
      profileHandle: identity.profileHandle,
      profileGeneration: identity.profileGeneration,
    });
    const created = expectResult(result, "profile_status", "created") as ProfileCreated;
    if (
      created.profileHandle !== identity.profileHandle ||
      created.profileGeneration !== identity.profileGeneration
    ) {
      throw new CodexAdminControlFailure("CODEX_STALE");
    }
    return created;
  }

  /** DB tombstone/row ordering remains the route-level coordinator's work. */
  async removeProfile(input: CodexAdminProfileFacts): Promise<ProfileRemoved> {
    // A previous removal attempt may already have installed the controller's
    // permanent `draining` gate. Removal retries are the only operation that
    // may reuse that exact generation: all account/start operations continue
    // to fail closed while it is draining.
    const launch = await this.profileLaunchScope(input, { allowDraining: true });
    const result = await this.execute(input.relayId, {
      resolveHostScope: () => this.hostScope(input),
      resolveProfileLaunchScope: () => launch,
    }, {
      operation: "profile_remove",
      profileHandle: input.profileHandle,
      profileGeneration: input.profileGeneration,
    });
    this.dropIssuedLoginsForProfile(input);
    return expectResult(result, "profile_status", "removed") as ProfileRemoved;
  }

  async startAccountLogin(input: CodexAdminProfileFacts): Promise<LoginStarted> {
    const scope = await this.profileScope(input);
    const result = await this.accountResult(input.relayId, scope, { operation: "account_login_start" });
    const login = expectResult(result, "login_started");
    if (!opaque(login.loginRef)) throw new CodexAdminControlFailure("CODEX_STALE");
    this.pruneIssuedLogins();
    while (this.issuedLogins.size >= this.maxIssuedLogins) {
      const oldest = this.issuedLogins.keys().next().value;
      if (oldest === undefined) break;
      this.issuedLogins.delete(oldest);
    }
    this.issuedLogins.set(login.loginRef, { ...identityFrom(scope), expiresAt: this.now().getTime() + this.loginTtlMs });
    return login;
  }

  async cancelAccountLogin(input: CodexAdminProfileFacts, loginRef: string): Promise<AccountStatus> {
    if (!opaque(loginRef)) throw new CodexAdminControlFailure("CODEX_FORBIDDEN");
    this.pruneIssuedLogins();
    const scope = await this.profileScope(input);
    const issued = this.issuedLogins.get(loginRef);
    if (!issued || !sameIssuedLogin(issued, scope)) throw new CodexAdminControlFailure("CODEX_STALE");
    const result = await this.accountResult(input.relayId, scope, { operation: "account_login_cancel", loginRef });
    this.issuedLogins.delete(loginRef);
    return expectResult(result, "account_status");
  }

  async readAccount(input: CodexAdminProfileFacts): Promise<AccountStatus> {
    const result = await this.account(input, { operation: "account_read" });
    return expectResult(result, "account_status");
  }

  async readRateLimits(input: CodexAdminProfileFacts): Promise<RateLimitsStatus["value"]> {
    const result = await this.account(input, { operation: "account_rate_limits_read" });
    return expectResult(result, "rate_limits_status").value;
  }

  async readUsage(input: CodexAdminProfileFacts): Promise<AccountUsageStatus["value"]> {
    const result = await this.account(input, { operation: "account_usage_read" });
    return expectResult(result, "account_usage_status").value;
  }

  async listModels(input: CodexAdminProfileFacts): Promise<CodexAdminModelCatalog> {
    const result = await this.account(input, { operation: "model_list" });
    const value = expectResult(result, "model_catalog_status").value;
    return {
      ...value,
      preferredModelId: selectPreferredCodexModelId(value.models),
    };
  }

  async logoutAccount(input: CodexAdminProfileFacts): Promise<AccountStatus> {
    const result = await this.account(input, { operation: "account_logout" });
    this.dropIssuedLoginsForProfile(input);
    return expectResult(result, "account_status");
  }

  private async hostRuntime(
    input: CodexAdminHostFacts,
    operation:
      | { readonly operation: "runtime_inspect" }
      | { readonly operation: "runtime_install"; readonly artifactRef: string }
      | { readonly operation: "runtime_cancel_install"; readonly installRef: string }
      | { readonly operation: "runtime_activate"; readonly runtimeGeneration: number }
      | { readonly operation: "runtime_rollback" }
      | { readonly operation: "runtime_remove"; readonly runtimeGeneration: number },
  ): Promise<RuntimeResult> {
    const result = await this.execute(input.relayId, {
      resolveHostScope: () => this.hostScope(input),
    }, operation);
    return expectResult(result, "runtime_status");
  }

  private async account(
    input: CodexAdminProfileFacts,
    operation:
      | { readonly operation: "account_read" }
      | { readonly operation: "account_rate_limits_read" }
      | { readonly operation: "account_usage_read" }
      | { readonly operation: "model_list" }
      | { readonly operation: "account_logout" },
  ): Promise<AccountSemanticResult> {
    const scope = await this.profileScope(input);
    const result = await this.accountResult(input.relayId, scope, operation);
    if (result.kind !== "account_status" && result.kind !== "rate_limits_status" && result.kind !== "account_usage_status" && result.kind !== "model_catalog_status") {
      throw new CodexAdminControlFailure("CODEX_STALE");
    }
    return result;
  }

  private async accountResult(
    relayId: string,
    scope: ProfileScope,
    operation:
      | { readonly operation: "account_login_start" }
      | { readonly operation: "account_login_cancel"; readonly loginRef: string }
      | { readonly operation: "account_read" }
      | { readonly operation: "account_rate_limits_read" }
      | { readonly operation: "account_usage_read" }
      | { readonly operation: "model_list" }
      | { readonly operation: "account_logout" },
  ): Promise<RelayAdminResult> {
    return this.execute(relayId, {
      resolveHostScope: () => hostFromProfile(scope),
      resolveProfileLaunchScope: () => launchFromProfile(scope),
      resolveProfileScope: () => scope,
    }, operation);
  }

  private async profileScope(input: CodexAdminProfileFacts): Promise<ProfileScope> {
    const launch = await this.profileLaunchScope(input);
    const ensured = await this.execute(input.relayId, {
      resolveHostScope: () => hostFromProfile(launch),
      resolveProfileLaunchScope: () => launch,
    }, { operation: "ensure_profile_child", posture: "default" });
    if (ensured.kind !== "child_ready" || !safeGeneration(ensured.childGeneration)) {
      throw new CodexAdminControlFailure("CODEX_STALE");
    }
    return Object.freeze({ ...launch, childGeneration: ensured.childGeneration });
  }

  private async execute(
    relayId: string,
    scopes: CodexRelaySemanticScopes,
    operation: unknown,
  ): Promise<RelayAdminResult & { readonly childGeneration?: number }> {
    const adapter = new CodexRelaySemanticAdapter({
      scopes,
      sendCommand: (destination, command) => this.sendCommand(destination, command),
    });
    let result: CodexSemanticResult;
    try {
      result = await adapter.execute(relayId, operation);
    } catch (error) {
      throw new CodexAdminControlFailure(sanitizeTransportError(error));
    }
    if (result.status === "rejected") {
      const rejected = result.result;
      throw new CodexAdminControlFailure(
        rejected.kind === "rejected" ? sanitizeRejected(rejected.code) : "CODEX_STALE",
      );
    }
    return {
      ...result.result,
      ...(result.childGeneration === undefined ? {} : { childGeneration: result.childGeneration }),
    };
  }

  private async sendCommand(
    relayId: string,
    command: RelayCodexCommandMessage,
  ): Promise<RelayCodexCommandResponseMessage> {
    if (command.command.kind !== "runtime_inspect" || this.options.runtimeInspectTimeoutMs === undefined) {
      return this.options.relay.sendCodexCommand(relayId, command);
    }
    return this.options.relay.sendCodexCommand(relayId, command, {
      timeoutMs: this.options.runtimeInspectTimeoutMs,
    });
  }

  private hostScope(input: CodexAdminHostFacts): HostScope {
    const session = this.liveSession(input);
    return Object.freeze({
      relayId: session.relayId,
      relaySessionId: session.relaySessionId,
      desktopSessionId: session.desktopSessionId,
      pairingGenerationRef: session.pairingGenerationRef,
      selectedProtocolVersion: session.selectedProtocolVersion,
      capabilityRevision: session.capabilityRevision,
    });
  }

  private liveSession(input: CodexAdminHostFacts): RelayCodexSessionSnapshot {
    if (!opaque(input.userId) || !opaque(input.relayId)) throw new CodexAdminControlFailure("CODEX_FORBIDDEN");
    const session = this.options.relay.getCodexSession(input.relayId, input.userId);
    if (!session) throw new CodexAdminControlFailure("CODEX_UNAVAILABLE");
    if (
      session.relayId !== input.relayId || session.userId !== input.userId ||
      !opaque(session.relaySessionId) || !opaque(session.desktopSessionId) ||
      !opaque(session.pairingGenerationRef) || !safeGeneration(session.selectedProtocolVersion) ||
      !safeGeneration(session.capabilityRevision) || !session.status
    ) throw new CodexAdminControlFailure("CODEX_STALE");
    return session;
  }

  private async profileLaunchScope(
    input: CodexAdminProfileFacts,
    options: { readonly allowDraining?: boolean } = {},
  ): Promise<ProfileLaunchScope> {
    assertProfileFacts(input);
    let session = this.liveSession(input);
    let status = session.status!;
    if (
      !safeGeneration(status.runtimeGeneration) ||
      status.runtime?.state !== "ready"
    ) {
      // The desktop controller is intentionally process-local. After a cold
      // Electron restart, lazily inspect the already enabled connection so it
      // can revalidate and restore its selected compatible runtime before any
      // profile/account operation. The host publishes the refreshed exact
      // session status before acknowledging inspection; re-read it rather
      // than trusting the semantic result alone.
      await this.inspectRuntime(input);
      session = this.liveSession(input);
      status = session.status!;
    }
    const runtimeGeneration = status.runtimeGeneration;
    const profile = status.profiles?.find((item) => item.profileHandle === input.profileHandle);
    if (
      !safeGeneration(runtimeGeneration) || status.runtime?.state !== "ready"
    ) throw new CodexAdminControlFailure("CODEX_STALE");
    if (profile) {
      if (
        profile.profileGeneration !== input.profileGeneration ||
        profile.accountGeneration !== input.accountGeneration ||
        (profile.state === "draining" && !options.allowDraining)
      ) throw new CodexAdminControlFailure("CODEX_STALE");
    } else {
      // The server row outlives an Electron controller by design. Reattach
      // that exact persisted identity to a fresh controller before launching
      // its child; profile_create is idempotent for the same generation and
      // opens the existing desktop-only profile home without moving secrets
      // through the relay or server.
      const created = expectResult(await this.execute(input.relayId, {
        resolveHostScope: () => this.hostScope(input),
      }, {
        operation: "profile_create",
        profileHandle: input.profileHandle,
        profileGeneration: input.profileGeneration,
      }), "profile_status", "created");
      if (
        created.profileHandle !== input.profileHandle ||
        created.profileGeneration !== input.profileGeneration
      ) throw new CodexAdminControlFailure("CODEX_STALE");
    }
    return Object.freeze({
      ...this.hostScope(input), profileHandle: input.profileHandle,
      profileGeneration: input.profileGeneration, accountGeneration: input.accountGeneration, runtimeGeneration,
    });
  }

  private pruneIssuedLogins(): void {
    const now = this.now().getTime();
    for (const [ref, issued] of this.issuedLogins) {
      if (issued.expiresAt <= now) this.issuedLogins.delete(ref);
    }
  }

  private dropIssuedLoginsForProfile(input: CodexAdminProfileFacts): void {
    for (const [ref, issued] of this.issuedLogins) {
      if (issued.profileHandle === input.profileHandle && issued.profileGeneration === input.profileGeneration && issued.accountGeneration === input.accountGeneration) {
        this.issuedLogins.delete(ref);
      }
    }
  }
}

function expectResult<Kind extends RelayAdminResult["kind"], State extends string | undefined = undefined>(
  result: RelayAdminResult,
  kind: Kind,
  state?: State,
): Extract<RelayAdminResult, { readonly kind: Kind }> {
  if (result.kind !== kind || (state !== undefined && (result as { state?: string }).state !== state)) {
    throw new CodexAdminControlFailure("CODEX_STALE");
  }
  return result as Extract<RelayAdminResult, { readonly kind: Kind }>;
}

function hostFromProfile(scope: ProfileLaunchScope | ProfileScope): HostScope {
  const { profileHandle: _profileHandle, profileGeneration: _profileGeneration, accountGeneration: _accountGeneration, runtimeGeneration: _runtimeGeneration, ...host } = scope;
  return host;
}

function runtimeInspectionKey(userId: string, scope: HostScope): string {
  return [
    userId,
    scope.relayId,
    scope.relaySessionId,
    scope.desktopSessionId,
    scope.pairingGenerationRef,
    scope.selectedProtocolVersion,
    scope.capabilityRevision,
  ].join("\u0000");
}

function launchFromProfile(scope: ProfileScope): ProfileLaunchScope {
  const { childGeneration: _childGeneration, ...launch } = scope;
  return launch;
}

function identityFrom(scope: ProfileScope): Omit<IssuedLogin, "expiresAt"> {
  return {
    profileHandle: scope.profileHandle, profileGeneration: scope.profileGeneration,
    accountGeneration: scope.accountGeneration, runtimeGeneration: scope.runtimeGeneration,
    childGeneration: scope.childGeneration,
  };
}

function assertProfileFacts(input: CodexAdminProfileFacts): void {
  if (!opaque(input.profileHandle)) throw new CodexAdminControlFailure("CODEX_FORBIDDEN");
  assertGeneration(input.profileGeneration);
  assertGeneration(input.accountGeneration);
}

function assertGeneration(value: number): void {
  if (!safeGeneration(value)) throw new CodexAdminControlFailure("CODEX_FORBIDDEN");
}

function safeGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safePositive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function opaque(value: string): boolean {
  return value.trim().length > 0 && encoder.encode(value).byteLength <= MAX_OPAQUE_BYTES;
}

function sameIssuedLogin(issued: IssuedLogin, scope: ProfileScope): boolean {
  return issued.profileHandle === scope.profileHandle && issued.profileGeneration === scope.profileGeneration &&
    issued.accountGeneration === scope.accountGeneration && issued.runtimeGeneration === scope.runtimeGeneration &&
    issued.childGeneration === scope.childGeneration;
}

function sanitizeTransportError(error: unknown): CodexAdminControlError {
  const message = error instanceof Error ? error.message : "";
  return message === "CODEX_RELAY_UNAVAILABLE" ? "CODEX_RELAY_UNAVAILABLE"
    : message === "CODEX_CONTEXT_STALE" ? "CODEX_CONTEXT_STALE"
      : message === "CODEX_CONTEXT_INVALID" ? "CODEX_CONTEXT_INVALID"
        : message === "CODEX_CORRELATION_REPLAY" ? "CODEX_CORRELATION_REPLAY"
          : message === "CODEX_QUEUE_FULL" ? "CODEX_QUEUE_FULL"
            : message === "CODEX_TIMEOUT" ? "CODEX_TIMEOUT"
              : message === "CODEX_FRAME_INVALID" ? "CODEX_STALE"
                : "CODEX_UNAVAILABLE";
}

function sanitizeRejected(code: string): CodexAdminControlError {
  const allowed: readonly CodexAdminControlError[] = [
    "CODEX_RELAY_UNAVAILABLE", "CODEX_CAPABILITY_UNAVAILABLE", "CODEX_CONTEXT_INVALID",
    "CODEX_CONTEXT_STALE", "CODEX_PROFILE_UNAVAILABLE", "CODEX_RUNTIME_UNAVAILABLE",
    "CODEX_RUNTIME_INCOMPATIBLE", "CODEX_CHILD_START_FAILED", "CODEX_CHILD_CRASHED",
    "CODEX_CHILD_DRAINING", "CODEX_QUEUE_FULL", "CODEX_TIMEOUT", "CODEX_CANCELLED",
    "CODEX_GENERATION_STALE", "CODEX_CORRELATION_REPLAY", "CODEX_UNCERTAIN_SIDE_EFFECT",
  ];
  return allowed.includes(code as CodexAdminControlError)
    ? code as CodexAdminControlError
    : "CODEX_UNAVAILABLE";
}
