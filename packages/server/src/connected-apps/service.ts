import type {
  ConnectedAppOauthAttemptRow,
  ConnectedAppProfileRow,
  ConnectedAppProviderConfigRow,
  ConnectedAppScope,
} from "@nautilo/db";
import type {
  ConnectedAppAccount,
  ConnectedAppDescriptor,
  ConnectedAppDisconnectResponse,
  ConnectedAppDriverKind,
  ConnectedAppOAuthAttemptResponse,
  ConnectedAppOAuthStartResponse,
  ConnectedAppProviderSetup,
  ConnectedAppProviderSetupRequest,
  ConnectedAppProviderId,
  ConnectedAppToolReceipt,
} from "@nautilo/types";
import {
  compileConnectedAppOperationAdmissions,
  type ConnectedAppOperationAdmission,
} from "@nautilo/agent";
import {
  hostedDriverBinding,
  HostedConnectedAppDriverError,
  OomolHostedConnectedAppDriver,
  type HostedOauthInspection,
} from "./hosted-driver";
import {
  LocalConnectedAppDriverError,
  OpenConnectorLocalConnectedAppDriver,
  type LocalOauthInspection,
} from "./local-driver";
import {
  type ConnectedAppArtifactImporter,
  ConnectedAppResultPresenter,
} from "./result-presentation";
import type { ResolvedConnectionProviderCatalog } from "./catalog";
import {
  ConnectedAppArtifactInputError,
  type ConnectedAppArtifactInputResolver,
  type ConnectedAppArtifactInputSource,
} from "./artifact-input";
import {
  type ConnectedAppProviderDefinition,
} from "./providers";
import { safelyRecordProviderCost } from "../costs/provider-cost-recorder";
import { warn } from "@nautilo/logger";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";
import { assertConnectedAppExecutionFunding } from "./funding-admission";

const HOSTED_CUSTODY = "Credentials managed by Nautilo Cloud through OOMOL.";
const LOCAL_CUSTODY = "Credentials remain in this server's OpenConnector runtime; Nautilo stores only restricted runtime access in its vault.";
const HOSTED_DISCONNECT_LIMITATION =
  "Disconnect is temporarily managed by Nautilo Cloud while the hosted SDK lacks exact-account removal.";

export interface ConnectedAppStore {
  getProfile(scope: ConnectedAppScope, providerId: string, driverKind: string): Promise<ConnectedAppProfileRow | null>;
  upsertProfile(input: Omit<ConnectedAppProfileRow, "id" | "createdAt" | "updatedAt" | "revision">): Promise<ConnectedAppProfileRow>;
  markUserProfilesState(
    userId: string,
    providerId: string,
    driverKind: string,
    status: "connected" | "reconnect_required" | "error",
    lastErrorCode: string | null,
  ): Promise<void>;
  deleteProfile(scope: ConnectedAppScope, providerId: string, driverKind: string): Promise<void>;
  getProviderConfig(providerId: string, driverKind: string): Promise<ConnectedAppProviderConfigRow | null>;
  upsertProviderConfig(
    input: Omit<ConnectedAppProviderConfigRow, "id" | "createdAt" | "updatedAt" | "revision">,
  ): Promise<ConnectedAppProviderConfigRow>;
  findActiveAttempt(scope: ConnectedAppScope, providerId: string, driverKind: string): Promise<ConnectedAppOauthAttemptRow | null>;
  expireAttempts(scope: ConnectedAppScope, providerId: string, driverKind: string): Promise<void>;
  insertAttempt(input: Omit<ConnectedAppOauthAttemptRow, "id" | "createdAt" | "updatedAt" | "completedAt">): Promise<ConnectedAppOauthAttemptRow>;
  getAttempt(scope: ConnectedAppScope, attemptId: string): Promise<ConnectedAppOauthAttemptRow | null>;
  finishAttempt(
    scope: ConnectedAppScope,
    attemptId: string,
    status: "connected" | "failed" | "expired",
    errorCode: string | null,
  ): Promise<boolean>;
}

export class ConnectedAppServiceError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "ConnectedAppServiceError";
  }
}

function accountFromRow(row: ConnectedAppProfileRow): ConnectedAppAccount {
  const kind = ["user", "bot", "service_account", "unknown"].includes(row.providerUserKind)
    ? row.providerUserKind as ConnectedAppAccount["kind"]
    : "unknown";
  const avatarUrl = row.accountAvatarUrl?.startsWith("https://") ? row.accountAvatarUrl : null;
  const email = row.accountEmail?.trim() || null;
  return {
    displayName: row.accountDisplayName?.trim() || null,
    username: row.accountUsername?.trim() || null,
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : null,
    avatarUrl,
    workspaceName: row.accountWorkspaceName?.trim() || null,
    kind,
  };
}

function safeServiceError(error: unknown): ConnectedAppServiceError {
  if (error instanceof ConnectedAppServiceError) return error;
  if (error instanceof ServerProviderCredentialsDeniedError) {
    return new ConnectedAppServiceError(error.code, 403);
  }
  if (error instanceof ConnectedAppArtifactInputError) {
    return new ConnectedAppServiceError(error.code, error.status);
  }
  if (error instanceof HostedConnectedAppDriverError || error instanceof LocalConnectedAppDriverError) {
    return new ConnectedAppServiceError(error.code, error.status || 502);
  }
  return new ConnectedAppServiceError("connected_app_error", 500);
}

function verifiedReturnUri(publicBaseUrl: string): string {
  let base: URL;
  try { base = new URL(publicBaseUrl); } catch {
    throw new ConnectedAppServiceError("public_base_url_invalid", 503);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && loopback))
    || base.username || base.password || base.search || base.hash) {
    throw new ConnectedAppServiceError("public_base_url_invalid", 503);
  }
  return new URL("/connections/oauth/complete", base).toString();
}

function descriptor(input: {
  provider: ConnectedAppProviderDefinition;
  profile: ConnectedAppProfileRow | null;
  attempt: ConnectedAppOauthAttemptRow | null;
  driverKind: ConnectedAppDriverKind;
  providerReady: boolean;
  setupStatus: ConnectedAppDescriptor["providerSetupStatus"];
  canManageSetup: boolean;
}): ConnectedAppDescriptor {
  const profileStatus = input.profile && ["connected", "reconnect_required", "error"].includes(input.profile.status)
    ? input.profile.status as ConnectedAppDescriptor["status"] : null;
  return {
    id: input.provider.id,
    displayName: input.provider.displayName,
    description: input.provider.description,
    searchTerms: [...input.provider.searchTerms],
    iconUrl: input.provider.iconUrl,
    shortMark: input.provider.shortMark,
    sortOrder: input.provider.sortOrder,
    lifecycle: input.provider.lifecycle,
    providerSetupUrl: input.provider.setupUrl,
    acceptsAdminToken: input.provider.acceptsAdminToken,
    experimental: input.provider.lifecycle === "pilot",
    defaultEnabled: input.provider.defaultEnabled,
    driverKind: input.driverKind,
    providerReady: input.providerReady,
    providerSetupStatus: input.setupStatus,
    canManageProviderSetup: input.canManageSetup,
    status: profileStatus ?? (input.attempt ? "connecting" : "not_connected"),
    attemptId: input.attempt?.id ?? null,
    account: input.profile ? accountFromRow(input.profile) : null,
    capabilities: [...input.provider.capabilities],
    custodyLabel: input.driverKind === "oomol_hosted" ? HOSTED_CUSTODY : LOCAL_CUSTODY,
    limitation: input.driverKind === "oomol_hosted" && input.profile ? HOSTED_DISCONNECT_LIMITATION : null,
    lastErrorCode: input.profile?.lastErrorCode ?? null,
    revision: input.profile?.revision ?? null,
  };
}

type Inspection = HostedOauthInspection | LocalOauthInspection;

export interface ConnectedAppServiceDependencies {
  readonly assertExecutionFunding?: typeof assertConnectedAppExecutionFunding;
  readonly recordProviderCost?: typeof safelyRecordProviderCost;
}

export class ConnectedAppService {
  private readonly inspectionFlights = new Map<string, Promise<ConnectedAppOAuthAttemptResponse>>();
  private readonly admissions: readonly ConnectedAppOperationAdmission[];

  constructor(
    private readonly store: ConnectedAppStore,
    private readonly catalog: ResolvedConnectionProviderCatalog,
    private readonly publicBaseUrl: string,
    private readonly hostedDriver: OomolHostedConnectedAppDriver | null,
    private readonly activeDriverKind: "oomol_hosted" | "openconnector_local" = "oomol_hosted",
    private readonly localDriver: OpenConnectorLocalConnectedAppDriver | null = null,
    private readonly provider: ConnectedAppProviderDefinition,
    private readonly resultPresenter: ConnectedAppResultPresenter | null = null,
    private readonly dependencies: ConnectedAppServiceDependencies = {},
  ) {
    const contract = catalog.catalog.providers.find((candidate) => candidate.id === provider.id);
    if (!contract) throw new ConnectedAppServiceError("connected_app_provider_not_found", 404);
    this.admissions = compileConnectedAppOperationAdmissions([contract]);
  }

  get providerId(): ConnectedAppProviderId {
    return this.provider.id;
  }

  get usesHostedDriver(): boolean {
    return this.activeDriverKind === "oomol_hosted";
  }

  /**
   * Snapshot eligibility for model-tool projection. This is intentionally a
   * read of the same exact scope used again by execute(); it does not infer
   * access from provider-wide setup or another Human's profile.
   */
  async isConnected(scope: ConnectedAppScope): Promise<boolean> {
    try {
      this.assertCallable();
      if (this.activeDriverKind === "oomol_hosted") {
        if (!this.hostedDriver) return false;
      } else {
        const config = await this.providerConfig();
        if (!this.localDriver || config?.status !== "ready") return false;
      }
      return (await this.profileForScope(scope))?.status === "connected";
    } catch {
      return false;
    }
  }

  private providerConfig(): Promise<ConnectedAppProviderConfigRow | null> {
    return this.store.getProviderConfig(this.provider.id, "openconnector_local");
  }

  private assertCallable(): void {
    if (this.provider.lifecycle === "disabled" || this.provider.lifecycle === "withdrawn") {
      throw new ConnectedAppServiceError("connected_app_provider_unavailable", 409);
    }
    if (!this.provider.supportedDrivers.includes(this.activeDriverKind)) {
      throw new ConnectedAppServiceError("connected_app_driver_not_supported", 409);
    }
  }

  private async profileForScope(scope: ConnectedAppScope): Promise<ConnectedAppProfileRow | null> {
    return this.store.getProfile(scope, this.provider.id, this.activeDriverKind);
  }

  async list(scope: ConnectedAppScope, options: { canManageConnectionProviders?: boolean } = {}): Promise<ConnectedAppDescriptor[]> {
    if (!this.catalog.catalog.providers.some((provider) => provider.id === this.provider.id)) return [];
    const [profile, attempt, config] = await Promise.all([
      this.provider.lifecycle === "withdrawn"
        ? this.store.getProfile(scope, this.provider.id, this.activeDriverKind)
        : this.profileForScope(scope),
      this.store.findActiveAttempt(scope, this.provider.id, this.activeDriverKind),
      this.activeDriverKind === "openconnector_local" ? this.providerConfig() : Promise.resolve(null),
    ]);
    if (this.provider.lifecycle === "withdrawn" && !profile && !attempt && !config) return [];
    const localStatus = config?.status === "ready" ? "ready" : config?.status === "error" ? "error" : "setup_required";
    const active = this.provider.lifecycle === "pilot" || this.provider.lifecycle === "available";
    return [descriptor({
      provider: this.provider,
      profile,
      attempt,
      driverKind: this.activeDriverKind,
      providerReady: active && (this.activeDriverKind === "oomol_hosted"
        ? this.hostedDriver !== null : this.localDriver !== null && localStatus === "ready"),
      setupStatus: this.activeDriverKind === "oomol_hosted" ? "managed" : localStatus,
      canManageSetup: active && this.activeDriverKind === "openconnector_local"
        && options.canManageConnectionProviders === true,
    })];
  }

  async getProviderSetup(): Promise<ConnectedAppProviderSetup> {
    this.assertCallable();
    const driver = this.localDriver;
    if (this.activeDriverKind !== "openconnector_local" || !driver) {
      throw new ConnectedAppServiceError("connected_app_setup_not_available", 409);
    }
    const config = await this.providerConfig();
    return {
      providerId: this.provider.id,
      driverKind: "openconnector_local",
      status: config?.status === "ready" ? "ready" : config?.status === "error" ? "error" : "setup_required",
      callbackUrl: driver.callbackUrl(),
      oauthScopes: [...this.provider.oauthScopes],
      clientId: config?.clientId ?? null,
      adminAuthenticationConfigured: Boolean(config?.adminCredentialRefId),
      lastErrorCode: config?.lastErrorCode ?? null,
      lastVerifiedAt: config?.lastVerifiedAt?.toISOString() ?? null,
    };
  }

  async configureProvider(scope: ConnectedAppScope, request: ConnectedAppProviderSetupRequest, signal?: AbortSignal): Promise<ConnectedAppProviderSetup> {
    this.assertCallable();
    const driver = this.localDriver;
    if (this.activeDriverKind !== "openconnector_local" || !driver) {
      throw new ConnectedAppServiceError("connected_app_setup_not_available", 409);
    }
    const existing = await this.providerConfig();
    try {
      const result = await driver.configure({
        providerId: this.provider.id,
        allowedActions: this.provider.admittedActionIds,
        schemaSha256: this.provider.schemaSha256,
        requestedScopes: this.provider.oauthScopes,
        scope,
        existing,
        ...(request.clientId !== undefined ? { clientId: request.clientId } : {}),
        ...(request.clientSecret !== undefined ? { clientSecret: request.clientSecret } : {}),
        ...(request.adminToken !== undefined ? { adminToken: request.adminToken } : {}),
        ...(signal ? { signal } : {}),
      });
      await this.store.upsertProviderConfig({
        providerId: this.provider.id,
        driverKind: "openconnector_local",
        status: "ready",
        clientId: result.clientId,
        adminCredentialRefId: result.adminCredentialRef?.id ?? null,
        adminCredentialNamespaceId: result.adminCredentialRef?.namespaceId ?? null,
        adminCredentialAgentId: result.adminCredentialRef?.agentId ?? null,
        lastErrorCode: null,
        lastVerifiedAt: new Date(),
      });
      return this.getProviderSetup();
    } catch (error) {
      const safe = safeServiceError(error);
      await this.store.upsertProviderConfig({
        providerId: this.provider.id,
        driverKind: "openconnector_local",
        status: "error",
        clientId: request.clientId ?? existing?.clientId ?? null,
        adminCredentialRefId: existing?.adminCredentialRefId ?? null,
        adminCredentialNamespaceId: existing?.adminCredentialNamespaceId ?? null,
        adminCredentialAgentId: existing?.adminCredentialAgentId ?? null,
        lastErrorCode: safe.code,
        lastVerifiedAt: existing?.lastVerifiedAt ?? null,
      });
      throw safe;
    }
  }

  async startOauth(scope: ConnectedAppScope, signal?: AbortSignal): Promise<ConnectedAppOAuthStartResponse> {
    this.assertCallable();
    if ((await this.profileForScope(scope))?.status === "connected") {
      throw new ConnectedAppServiceError("connected_app_already_connected", 409);
    }
    if (await this.store.findActiveAttempt(scope, this.provider.id, this.activeDriverKind)) {
      throw new ConnectedAppServiceError("connected_app_authorization_in_progress", 409);
    }
    await this.store.expireAttempts(scope, this.provider.id, this.activeDriverKind);
    try {
      const started = this.activeDriverKind === "oomol_hosted"
        ? await this.startHostedOauth(scope, signal) : await this.startLocalOauth(scope, signal);
      const attempt = await this.store.insertAttempt({
        userId: scope.userId,
        namespaceId: scope.namespaceId,
        providerId: this.provider.id,
        driverKind: this.activeDriverKind,
        connectionRequestId: started.requestId,
        providerConfigId: started.providerConfigId,
        connectionName: started.connectionName,
        status: "connecting",
        errorCode: null,
        expiresAt: started.expiresAt,
      });
      return {
        status: "authorization_required",
        providerId: this.provider.id,
        attemptId: attempt.id,
        authorizationUrl: started.authorizationUrl,
        expiresAt: started.expiresAt.toISOString(),
      };
    } catch (error) {
      const safe = safeServiceError(error);
      if (
        this.activeDriverKind === "openconnector_local"
        && safe.code === "oauth_client_not_configured"
      ) {
        const existing = await this.providerConfig();
        if (existing) {
          await this.store.upsertProviderConfig({
            providerId: existing.providerId,
            driverKind: existing.driverKind,
            status: "error",
            clientId: existing.clientId,
            adminCredentialRefId: existing.adminCredentialRefId,
            adminCredentialNamespaceId: existing.adminCredentialNamespaceId,
            adminCredentialAgentId: existing.adminCredentialAgentId,
            lastErrorCode: safe.code,
            lastVerifiedAt: existing.lastVerifiedAt,
          });
        }
      }
      throw safe;
    }
  }

  private async startHostedOauth(scope: ConnectedAppScope, signal?: AbortSignal) {
    if (!this.hostedDriver) throw new ConnectedAppServiceError("hosted_driver_not_configured", 503);
    return this.hostedDriver.startOauth(
      hostedDriverBinding(this.provider.id, scope.userId, scope.namespaceId),
      verifiedReturnUri(this.publicBaseUrl),
      signal,
    );
  }

  private async startLocalOauth(scope: ConnectedAppScope, signal?: AbortSignal) {
    if (!this.localDriver) throw new ConnectedAppServiceError("openconnector_driver_not_configured", 503);
    const config = await this.providerConfig();
    if (!config || config.status !== "ready") throw new ConnectedAppServiceError("connected_app_provider_setup_required", 409);
    return this.localDriver.startOauth(this.provider.id, scope, config, signal);
  }

  async inspectAttempt(scope: ConnectedAppScope, attemptId: string, signal?: AbortSignal): Promise<ConnectedAppOAuthAttemptResponse> {
    const flightKey = `${scope.userId}:${scope.namespaceId}:${attemptId}`;
    const existingFlight = this.inspectionFlights.get(flightKey);
    if (existingFlight) return existingFlight;
    const flight = this.inspectAttemptOnce(scope, attemptId, signal);
    this.inspectionFlights.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      if (this.inspectionFlights.get(flightKey) === flight) this.inspectionFlights.delete(flightKey);
    }
  }

  async cancelAttempt(
    scope: ConnectedAppScope,
    attemptId: string,
  ): Promise<ConnectedAppOAuthAttemptResponse> {
    const flightKey = `${scope.userId}:${scope.namespaceId}:${attemptId}`;
    const inspection = this.inspectionFlights.get(flightKey);
    if (inspection) await inspection.catch(() => undefined);
    const attempt = await this.store.getAttempt(scope, attemptId);
    if (!attempt || attempt.providerId !== this.provider.id || attempt.driverKind !== this.activeDriverKind) {
      throw new ConnectedAppServiceError("connected_app_attempt_not_found", 404);
    }
    if (attempt.status === "connecting") {
      await this.store.finishAttempt(
        scope,
        attempt.id,
        "failed",
        "authorization_restarted",
      );
    }
    const current = await this.store.getAttempt(scope, attemptId);
    if (!current) throw new ConnectedAppServiceError("connected_app_attempt_not_found", 404);
    let status: "connected" | "failed" | "expired";
    switch (current.status) {
      case "connected":
      case "failed":
      case "expired":
        status = current.status;
        break;
      case "connecting":
        throw new ConnectedAppServiceError("connected_app_attempt_cancel_conflict", 409);
      default:
        throw new ConnectedAppServiceError("connection_request_invalid", 502);
    }
    const profile = current.status === "connected"
      ? await this.store.getProfile(scope, this.provider.id, this.activeDriverKind)
      : null;
    return {
      status,
      providerId: this.provider.id,
      account: profile ? accountFromRow(profile) : null,
      errorCode: current.errorCode,
    };
  }

  private async inspectAttemptOnce(scope: ConnectedAppScope, attemptId: string, signal?: AbortSignal): Promise<ConnectedAppOAuthAttemptResponse> {
    const attempt = await this.store.getAttempt(scope, attemptId);
    if (!attempt || attempt.providerId !== this.provider.id || attempt.driverKind !== this.activeDriverKind) {
      throw new ConnectedAppServiceError("connected_app_attempt_not_found", 404);
    }
    if (attempt.status !== "connecting") {
      const profile = attempt.status === "connected" ? await this.store.getProfile(scope, this.provider.id, this.activeDriverKind) : null;
      return {
        status: attempt.status as "connected" | "failed" | "expired",
        providerId: this.provider.id,
        account: profile ? accountFromRow(profile) : null,
        errorCode: attempt.errorCode,
      };
    }
    try {
      const inspected = this.activeDriverKind === "oomol_hosted"
        ? await this.inspectHosted(scope, attempt, signal) : await this.inspectLocal(scope, attempt, signal);
      return this.finishInspection(scope, attempt, inspected);
    } catch (error) { throw safeServiceError(error); }
  }

  private async inspectHosted(scope: ConnectedAppScope, attempt: ConnectedAppOauthAttemptRow, signal?: AbortSignal) {
    if (!this.hostedDriver) throw new ConnectedAppServiceError("hosted_driver_not_configured", 503);
    return this.hostedDriver.inspectOauth(hostedDriverBinding(this.provider.id, scope.userId, scope.namespaceId), {
      requestId: attempt.connectionRequestId,
      providerConfigId: attempt.providerConfigId,
    }, signal);
  }

  private async inspectLocal(scope: ConnectedAppScope, attempt: ConnectedAppOauthAttemptRow, signal?: AbortSignal) {
    if (!this.localDriver) throw new ConnectedAppServiceError("openconnector_driver_not_configured", 503);
    const config = await this.providerConfig();
    if (!config || config.status !== "ready" || config.id !== attempt.providerConfigId) {
      throw new ConnectedAppServiceError("connected_app_provider_setup_changed", 409);
    }
    return this.localDriver.inspectOauth({
      providerId: this.provider.id,
      allowedActions: this.provider.admittedActionIds,
      scope,
      config,
      connectionName: attempt.connectionName,
      authorizationUrl: this.localDriver.callbackUrl(),
      expiresAt: attempt.expiresAt,
      ...(signal ? { signal } : {}),
    });
  }

  private async finishInspection(scope: ConnectedAppScope, attempt: ConnectedAppOauthAttemptRow, inspected: Inspection): Promise<ConnectedAppOAuthAttemptResponse> {
    if (inspected.status === "connecting") return { status: "connecting", providerId: this.provider.id, account: null, errorCode: null };
    if (inspected.status === "failed" || inspected.status === "expired") {
      await this.store.finishAttempt(scope, attempt.id, inspected.status, inspected.errorCode);
      return { status: inspected.status, providerId: this.provider.id, account: null, errorCode: inspected.errorCode };
    }
    if (inspected.status !== "connected") throw new ConnectedAppServiceError("connection_request_invalid", 502);
    const now = new Date();
    const local = "driverCredentialRef" in inspected ? inspected : null;
    const profile = await this.store.upsertProfile({
      userId: scope.userId,
      namespaceId: scope.namespaceId,
      providerId: this.provider.id,
      driverKind: this.activeDriverKind,
      status: "connected",
      connectedAccountId: inspected.connectedAccountId,
      providerConfigId: inspected.providerConfigId,
      connectionName: inspected.connectionName,
      providerUserId: inspected.providerUserId,
      providerWorkspaceIdentity: inspected.workspaceIdentity,
      providerUserKind: inspected.account.kind,
      accountUsername: inspected.account.username,
      accountDisplayName: inspected.account.displayName,
      accountEmail: inspected.account.email,
      accountAvatarUrl: inspected.account.avatarUrl,
      accountWorkspaceName: inspected.account.workspaceName,
      driverCredentialRefId: local?.driverCredentialRef.id ?? null,
      driverCredentialNamespaceId: local?.driverCredentialRef.namespaceId ?? null,
      driverCredentialAgentId: local?.driverCredentialRef.agentId ?? null,
      driverCredentialRecordId: local?.driverCredentialRecordId ?? null,
      lastErrorCode: null,
      connectedAt: now,
      lastVerifiedAt: now,
    });
    await this.store.finishAttempt(scope, attempt.id, "connected", null);
    return { status: "connected", providerId: this.provider.id, account: accountFromRow(profile), errorCode: null };
  }

  async disconnect(scope: ConnectedAppScope, signal?: AbortSignal): Promise<ConnectedAppDisconnectResponse> {
    if (this.activeDriverKind !== "openconnector_local" || !this.localDriver) {
      throw new ConnectedAppServiceError("connected_app_disconnect_not_supported", 409);
    }
    const [profile, config] = await Promise.all([this.profileForScope(scope), this.providerConfig()]);
    if (!profile) return { status: "disconnected", providerId: this.provider.id };
    if (!config || config.status !== "ready") throw new ConnectedAppServiceError("connected_app_provider_setup_required", 409);
    try {
      await this.localDriver.disconnect({ providerId: this.provider.id, profile, config, ...(signal ? { signal } : {}) });
      await this.store.deleteProfile(scope, this.provider.id, this.activeDriverKind);
      return { status: "disconnected", providerId: this.provider.id };
    } catch (error) { throw safeServiceError(error); }
  }

  async execute(input: {
    readonly scope: ConnectedAppScope;
    readonly causalHumanUserId?: string | undefined;
    readonly operationId: string;
    readonly effect: "read" | "write";
    readonly args: Record<string, unknown>;
    readonly artifactImporter?: ConnectedAppArtifactImporter | undefined;
    readonly artifactInputResolver?: ConnectedAppArtifactInputResolver | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<ConnectedAppToolReceipt> {
    this.assertCallable();
    const admission = this.admissions.find((candidate) =>
      candidate.providerId === this.provider.id && candidate.sourceActionId === input.operationId);
    if (!admission || admission.effect !== input.effect) throw new ConnectedAppServiceError("connected_app_operation_not_admitted", 403);
    const parsed = admission.inputSchema.safeParse(input.args);
    if (!parsed.success) throw new ConnectedAppServiceError("connected_app_input_invalid", 400);
    const profile = await this.profileForScope(input.scope);
    if (!profile || profile.status !== "connected") throw new ConnectedAppServiceError("connected_app_not_connected", 409);
    let artifactSource: ConnectedAppArtifactInputSource | null = null;
    let stagedFileId: string | null = null;
    let stagedConfig: ConnectedAppProviderConfigRow | null = null;
    try {
      let driverArgs = parsed.data;
      if (admission.artifactInput) {
        if (this.activeDriverKind !== "openconnector_local" || !this.localDriver || !input.artifactInputResolver) {
          throw new ConnectedAppServiceError("connected_app_artifact_input_unavailable", 409);
        }
        const artifactPath = parsed.data[admission.artifactInput.modelField];
        if (typeof artifactPath !== "string" || artifactPath.length === 0) {
          throw new ConnectedAppServiceError("connected_app_artifact_input_invalid", 400);
        }
        stagedConfig = await this.providerConfig();
        if (!stagedConfig || stagedConfig.status !== "ready") {
          throw new ConnectedAppServiceError("connected_app_provider_setup_required", 409);
        }
        artifactSource = await input.artifactInputResolver({
          artifactPath,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const staged = await this.localDriver.stageTransitFile({
          config: stagedConfig,
          name: artifactSource.name,
          mimeType: artifactSource.mimeType,
          sizeBytes: artifactSource.sizeBytes,
          chunks: artifactSource.chunks,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        stagedFileId = staged.fileId;
        await artifactSource.verify();
        driverArgs = { ...parsed.data };
        delete driverArgs[admission.artifactInput.modelField];
        driverArgs[admission.artifactInput.providerField] = {
          fileId: staged.fileId,
          name: staged.name,
          mimeType: staged.mimeType,
        };
      }
      const result = await this.executeDriver(
        input.scope,
        input.causalHumanUserId ?? "",
        profile,
        input.operationId,
        driverArgs,
        input.signal,
      );
      const parsedOutput = admission.outputSchema.safeParse(result.data);
      if (!parsedOutput.success) {
        if (input.effect === "write" && admission.reconciliationOperationId) {
          await this.store.markUserProfilesState(input.scope.userId, this.provider.id, this.activeDriverKind, "connected", null);
          return {
            providerId: this.provider.id,
            operationId: input.operationId,
            executionId: result.executionId,
            profileId: profile.id,
            effect: input.effect,
            reconciliation: { status: "unconfirmed", operationId: admission.reconciliationOperationId, executionId: null, errorCode: "connected_app_output_schema_drift" },
            result: result.data,
          };
        }
        throw new ConnectedAppServiceError("connected_app_output_schema_drift", 502);
      }
      let reconciliation: ConnectedAppToolReceipt["reconciliation"] = null;
      if (admission.reconciliationOperationId) {
        const reconciliationInput = admission.reconciliationInput?.(parsedOutput.data) ?? null;
        if (!reconciliationInput) {
          // The write returned, but the signed receipt mapping cannot identify
          // the created/changed object. Preserve that uncertain outcome for the
          // Human and never imply that a blind retry is safe.
          reconciliation = {
            status: "unconfirmed",
            operationId: admission.reconciliationOperationId,
            executionId: null,
            errorCode: "connected_app_receipt_invalid",
          };
        } else {
          try {
            const reconciled = await this.executeDriver(
              input.scope,
              input.causalHumanUserId ?? "",
              profile,
              admission.reconciliationOperationId,
              reconciliationInput,
              input.signal,
            );
            const reconcileAdmission = this.admissions.find((candidate) =>
              candidate.providerId === this.provider.id
              && candidate.sourceActionId === admission.reconciliationOperationId);
            const parsedReconciliation = reconcileAdmission?.outputSchema.safeParse(reconciled.data);
            const confirmed = parsedReconciliation?.success === true
              && (admission.reconciliationConfirms?.(parsedOutput.data, parsedReconciliation.data) ?? true);
            reconciliation = confirmed
              ? { status: "confirmed", operationId: admission.reconciliationOperationId, executionId: reconciled.executionId, errorCode: null }
              : { status: "unconfirmed", operationId: admission.reconciliationOperationId, executionId: null, errorCode: "connected_app_output_schema_drift" };
          } catch (error) {
            reconciliation = { status: "unconfirmed", operationId: admission.reconciliationOperationId, executionId: null, errorCode: safeServiceError(error).code };
          }
        }
      }
      await this.store.markUserProfilesState(input.scope.userId, this.provider.id, this.activeDriverKind, "connected", null);
      const projected = admission.resultPresentation && this.resultPresenter
        ? await this.resultPresenter.project({
            scope: input.scope,
            providerId: this.provider.id,
            executionId: result.executionId,
            result: parsedOutput.data,
            contract: admission.resultPresentation,
            ...(input.artifactImporter ? { artifactImporter: input.artifactImporter } : {}),
            ...(this.activeDriverKind === "openconnector_local" && this.localDriver
              ? {
                  transitFileReader: ({ fileId, signal }: { fileId: string; signal?: AbortSignal | undefined }) =>
                    this.localDriver!.readTransitFile({ fileId, ...(signal ? { signal } : {}) }),
                  transitFileDisposer: async ({ fileId }: { fileId: string }) => {
                    try {
                      const config = await this.providerConfig();
                      const deleted = config?.status === "ready"
                        ? await this.localDriver!.deleteTransitFile({ config, fileId })
                        : false;
                      if (!deleted) warn("[connected-apps] inbound transient result cleanup failed");
                    } catch {
                      warn("[connected-apps] inbound transient result cleanup failed");
                    }
                  },
                }
              : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          })
        : { result: parsedOutput.data, presentation: null };
      return {
        providerId: this.provider.id,
        operationId: input.operationId,
        executionId: result.executionId,
        profileId: profile.id,
        effect: input.effect,
        reconciliation,
        ...(projected.presentation ? { presentation: projected.presentation } : {}),
        result: projected.result,
      };
    } catch (error) {
      const driverError = error instanceof HostedConnectedAppDriverError || error instanceof LocalConnectedAppDriverError ? error : null;
      if (driverError?.reconnectRequired) {
        await this.store.markUserProfilesState(input.scope.userId, this.provider.id, this.activeDriverKind, "reconnect_required", driverError.code);
      }
      if (input.effect === "write" && driverError?.outcomeUnknown) {
        throw new ConnectedAppServiceError("connected_app_write_outcome_unknown_do_not_retry", 502);
      }
      throw safeServiceError(error);
    } finally {
      if (stagedFileId && stagedConfig && this.localDriver) {
        await this.localDriver.deleteTransitFile({ config: stagedConfig, fileId: stagedFileId })
          .catch(() => warn("[connected-apps] transient artifact input cleanup failed"));
      }
      await artifactSource?.close().catch(() => undefined);
    }
  }

  private async executeDriver(
    scope: ConnectedAppScope,
    causalHumanUserId: string,
    profile: ConnectedAppProfileRow,
    operationId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; executionId: string }> {
    if (this.activeDriverKind === "openconnector_local") {
      if (!this.localDriver) throw new ConnectedAppServiceError("openconnector_driver_not_configured", 503);
      const admission = this.admissions.find((candidate) =>
        candidate.providerId === this.provider.id && candidate.sourceActionId === operationId);
      if (!admission) throw new ConnectedAppServiceError("connected_app_operation_not_admitted", 403);
      return this.localDriver.execute({
        providerId: this.provider.id,
        effect: admission.effect,
        profile,
        operationId,
        args,
        ...(signal ? { signal } : {}),
      });
    }
    if (!this.hostedDriver) throw new ConnectedAppServiceError("hosted_driver_not_configured", 503);
    await (this.dependencies.assertExecutionFunding
      ?? assertConnectedAppExecutionFunding)({
        hosted: true,
        causalHumanUserId,
      });
    const result = await this.hostedDriver.execute({
      binding: hostedDriverBinding(this.provider.id, scope.userId, scope.namespaceId),
      connectedAccountId: profile.connectedAccountId,
      providerConfigId: profile.providerConfigId,
      workspaceIdentity: profile.providerWorkspaceIdentity,
      operationId,
      args,
      signal,
    });
    await (this.dependencies.recordProviderCost ?? safelyRecordProviderCost)({
      identity: `oomol:connected-app:${result.executionId}`,
      userId: causalHumanUserId,
      provider: "oomol",
      operation: "connected_app_execute",
      evidenceState: "unknown",
    });
    return result;
  }
}
