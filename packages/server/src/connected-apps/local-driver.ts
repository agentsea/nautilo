import { createHash } from "node:crypto";
import { ConnectorError, OpenConnector } from "@oomol-lab/connector";
import type { ConnectedAppAccount, ConnectedAppProviderId } from "@nautilo/types";
import type { ConnectedAppProfileRow, ConnectedAppProviderConfigRow, ConnectedAppScope } from "@nautilo/db";
import {
  OpenConnectorAdminClient,
  OpenConnectorAdminError,
  normalizeOpenConnectorOrigin,
  type OpenConnectorConnection,
} from "./openconnector-admin-client";

const CONNECTED_APP_VAULT_AGENT_ID = "nautilo-connected-app-driver";

export type DriverSecretRef = {
  readonly id: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly field: "openconnector-admin" | `${string}-runtime`;
};

export interface ConnectedAppSecretStore {
  store(input: {
    value: string;
    namespaceId: string;
    agentId: string;
    authoredByUserId: string;
    field: DriverSecretRef["field"];
  }): Promise<DriverSecretRef>;
  read(ref: DriverSecretRef): Promise<string | null>;
  delete(ref: DriverSecretRef): Promise<void>;
}

export class LocalConnectedAppDriverError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly reconnectRequired = false,
    readonly outcomeUnknown = false,
  ) {
    super(code);
    this.name = "LocalConnectedAppDriverError";
  }
}

function safeError(error: unknown): LocalConnectedAppDriverError {
  if (error instanceof LocalConnectedAppDriverError) return error;
  if (error instanceof OpenConnectorAdminError) {
    return new LocalConnectedAppDriverError(
      error.code,
      error.status || 502,
      ["connection_not_found", "unauthorized"].includes(error.code),
    );
  }
  if (error instanceof ConnectorError) {
    const reconnectRequired = [
      "connected_account_not_found",
      "credential_expired",
      "oauth_refresh_unavailable",
      "oauth_token_expired",
      "unauthorized",
    ].includes(error.code);
    return new LocalConnectedAppDriverError(
      reconnectRequired ? error.code : "openconnector_error",
      error.status || 502,
      reconnectRequired,
    );
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new LocalConnectedAppDriverError("request_cancelled", 499);
  }
  return new LocalConnectedAppDriverError("openconnector_error", 502);
}

function aliasForUser(providerId: ConnectedAppProviderId, userId: string): string {
  return createHash("sha256").update(`${userId}:${providerId}`).digest("hex");
}

function tokenName(providerId: ConnectedAppProviderId, userId: string): string {
  return `Nautilo ${providerId} ${createHash("sha256").update(userId).digest("hex")}`;
}

function vaultAgentId(userId: string): string {
  return `${CONNECTED_APP_VAULT_AGENT_ID}-${createHash("sha256").update(userId).digest("hex")}`;
}

function runtimeField(providerId: ConnectedAppProviderId): `${string}-runtime` {
  return `${providerId}-runtime`;
}

function adminRef(config: ConnectedAppProviderConfigRow): DriverSecretRef | null {
  return config.adminCredentialRefId && config.adminCredentialNamespaceId && config.adminCredentialAgentId
    ? {
        id: config.adminCredentialRefId,
        namespaceId: config.adminCredentialNamespaceId,
        agentId: config.adminCredentialAgentId,
        field: "openconnector-admin",
      }
    : null;
}

function profileRef(profile: ConnectedAppProfileRow): DriverSecretRef | null {
  return profile.driverCredentialRefId && profile.driverCredentialNamespaceId && profile.driverCredentialAgentId
    ? {
        id: profile.driverCredentialRefId,
        namespaceId: profile.driverCredentialNamespaceId,
        agentId: profile.driverCredentialAgentId,
        field: runtimeField(profile.providerId),
      }
    : null;
}

async function* responseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.byteLength > 0) yield value;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export type LocalOauthInspection =
  | { readonly status: "connecting"; readonly authorizationUrl: string; readonly expiresAt: Date }
  | { readonly status: "failed" | "expired"; readonly errorCode: string }
  | {
      readonly status: "connected";
      readonly connectedAccountId: string;
      readonly providerConfigId: string;
      readonly connectionName: string;
      readonly providerUserId: string;
      readonly workspaceIdentity: string;
      readonly account: ConnectedAppAccount;
      readonly driverCredentialRef: DriverSecretRef;
      readonly driverCredentialRecordId: string;
    };

export class OpenConnectorLocalConnectedAppDriver {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly secrets: ConnectedAppSecretStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = normalizeOpenConnectorOrigin(baseUrl);
  }

  callbackUrl(): string {
    return new URL("/oauth/callback", this.baseUrl).toString();
  }

  async readTransitFile(input: {
    fileId: string;
    signal?: AbortSignal;
  }): Promise<{ chunks: AsyncIterable<Uint8Array> }> {
    if (!/^[a-f0-9]{32}(?:\.[a-z0-9]{1,16})?$/u.test(input.fileId)) {
      throw new LocalConnectedAppDriverError("connected_app_transit_file_invalid", 404);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(
        new URL(`/api/files/${encodeURIComponent(input.fileId)}`, this.baseUrl),
        {
          method: "GET",
          redirect: "error",
          credentials: "omit",
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
    } catch (error) {
      throw safeError(error);
    }
    if (!response.ok || !response.body) {
      throw new LocalConnectedAppDriverError("connected_app_transit_file_unavailable", 502);
    }
    return { chunks: responseChunks(response.body) };
  }

  async stageTransitFile(input: {
    config: ConnectedAppProviderConfigRow;
    name: string;
    mimeType: string;
    sizeBytes: number;
    chunks: AsyncIterable<Uint8Array>;
    signal?: AbortSignal;
  }): Promise<{ fileId: string; name: string; mimeType: string; sizeBytes: number }> {
    try {
      const staged = await (await this.admin(input.config)).uploadTransitFile({
        name: input.name,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        chunks: input.chunks,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (staged.sizeBytes !== input.sizeBytes) {
        await (await this.admin(input.config)).deleteTransitFile(staged.fileId, input.signal).catch(() => undefined);
        throw new LocalConnectedAppDriverError("connected_app_artifact_changed", 409);
      }
      return {
        fileId: staged.fileId,
        name: staged.name,
        mimeType: staged.mimeType,
        sizeBytes: staged.sizeBytes,
      };
    } catch (error) {
      throw safeError(error);
    }
  }

  async deleteTransitFile(input: {
    config: ConnectedAppProviderConfigRow;
    fileId: string;
    signal?: AbortSignal;
  }): Promise<boolean> {
    try {
      return await (await this.admin(input.config)).deleteTransitFile(input.fileId, input.signal);
    } catch (error) {
      throw safeError(error);
    }
  }

  private async admin(config: ConnectedAppProviderConfigRow): Promise<OpenConnectorAdminClient> {
    const ref = adminRef(config);
    const token = ref ? await this.secrets.read(ref) : null;
    if (ref && !token) throw new LocalConnectedAppDriverError("openconnector_admin_credential_missing", 503);
    return new OpenConnectorAdminClient(this.baseUrl, token, this.fetchImpl);
  }

  async configure(input: {
    providerId: ConnectedAppProviderId;
    allowedActions: readonly string[];
    schemaSha256: Readonly<Record<string, string>>;
    requestedScopes?: readonly string[];
    scope: ConnectedAppScope;
    existing: ConnectedAppProviderConfigRow | null;
    clientId?: string;
    clientSecret?: string;
    adminToken?: string;
    signal?: AbortSignal;
  }): Promise<{
    adminCredentialRef: DriverSecretRef | null;
    callbackUrl: string;
    clientId: string;
  }> {
    let priorRef = input.existing ? adminRef(input.existing) : null;
    const priorToken = priorRef ? await this.secrets.read(priorRef) : null;
    const token = input.adminToken ?? priorToken;
    const hostname = new URL(this.baseUrl).hostname;
    const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname);
    if (!loopback && !token) {
      throw new LocalConnectedAppDriverError("openconnector_remote_admin_token_required", 400);
    }
    if (priorRef && !priorToken && input.adminToken === undefined) {
      throw new LocalConnectedAppDriverError("openconnector_admin_credential_missing", 503);
    }
    try {
      const verified = await new OpenConnectorAdminClient(this.baseUrl, token, this.fetchImpl)
        .verifyProvider(
          input.providerId,
          input.allowedActions,
          input.schemaSha256,
          input.clientId && input.clientSecret
          ? {
              clientId: input.clientId,
              clientSecret: input.clientSecret,
              ...(input.requestedScopes && input.requestedScopes.length > 0
                ? { requestedScopes: input.requestedScopes }
                : {}),
            }
          : null, input.signal);
      if (input.adminToken !== undefined) {
        const nextRef = await this.secrets.store({
          value: input.adminToken,
          namespaceId: input.scope.namespaceId,
          agentId: vaultAgentId(input.scope.userId),
          authoredByUserId: input.scope.userId,
          field: "openconnector-admin",
        });
        if (priorRef && priorRef.id !== nextRef.id) await this.secrets.delete(priorRef);
        priorRef = nextRef;
      }
      return { adminCredentialRef: priorRef, callbackUrl: verified.callbackUrl, clientId: verified.clientId };
    } catch (error) {
      throw safeError(error);
    }
  }

  async startOauth(
    providerId: ConnectedAppProviderId,
    scope: ConnectedAppScope,
    config: ConnectedAppProviderConfigRow,
    signal?: AbortSignal,
  ): Promise<{
    requestId: string;
    providerConfigId: string;
    connectionName: string;
    authorizationUrl: string;
    expiresAt: Date;
  }> {
    try {
      const connectionName = aliasForUser(providerId, scope.userId);
      const started = await (await this.admin(config)).startAuthorization(providerId, connectionName, signal);
      return {
        requestId: started.state,
        providerConfigId: config.id,
        connectionName,
        authorizationUrl: started.authorizationUrl,
        expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
      };
    } catch (error) {
      throw safeError(error);
    }
  }

  async inspectOauth(input: {
    providerId: ConnectedAppProviderId;
    allowedActions: readonly string[];
    scope: ConnectedAppScope;
    config: ConnectedAppProviderConfigRow;
    connectionName: string;
    authorizationUrl: string;
    expiresAt: Date;
    signal?: AbortSignal;
  }): Promise<LocalOauthInspection> {
    if (input.expiresAt <= new Date()) {
      return { status: "expired", errorCode: "connection_request_expired" };
    }
    try {
      const admin = await this.admin(input.config);
      const connection = (await admin.listConnections(input.providerId, input.signal))
        .find((candidate) => candidate.connectionName === input.connectionName);
      if (!connection) {
        return {
          status: "connecting",
          authorizationUrl: input.authorizationUrl,
          expiresAt: input.expiresAt,
        };
      }
      const created = await admin.createRestrictedRuntimeToken({
        name: tokenName(input.providerId, input.scope.userId),
        connectionId: connection.id,
        allowedActions: input.allowedActions,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const credentialRef = await this.secrets.store({
        value: created.token,
        namespaceId: input.scope.namespaceId,
        agentId: vaultAgentId(input.scope.userId),
        authoredByUserId: input.scope.userId,
        field: runtimeField(input.providerId),
      });
      return this.connectedInspection(input.providerId, connection, input.config, credentialRef, created.recordId);
    } catch (error) {
      throw safeError(error);
    }
  }

  private connectedInspection(
    providerId: ConnectedAppProviderId,
    connection: OpenConnectorConnection,
    config: ConnectedAppProviderConfigRow,
    credentialRef: DriverSecretRef,
    credentialRecordId: string,
  ): Extract<LocalOauthInspection, { status: "connected" }> {
    return {
      status: "connected",
      connectedAccountId: connection.id,
      providerConfigId: config.id,
      connectionName: connection.connectionName,
      providerUserId: connection.profile.accountId,
      workspaceIdentity: createHash("sha256")
        .update(`${providerId}:${connection.id}:${connection.profile.accountId}`).digest("base64url"),
      account: {
        displayName: connection.profile.displayName,
        username: null,
        email: null,
        avatarUrl: null,
        workspaceName: null,
        kind: "unknown",
      },
      driverCredentialRef: credentialRef,
      driverCredentialRecordId: credentialRecordId,
    };
  }

  async execute(input: {
    providerId: ConnectedAppProviderId;
    effect: "read" | "write";
    profile: ConnectedAppProfileRow;
    operationId: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<{ data: unknown; executionId: string }> {
    const ref = profileRef(input.profile);
    if (!ref) throw new LocalConnectedAppDriverError("openconnector_runtime_credential_missing", 503, true);
    const runtimeToken = await this.secrets.read(ref);
    if (!runtimeToken) throw new LocalConnectedAppDriverError("openconnector_runtime_credential_missing", 503, true);
    const client = new OpenConnector({
      baseUrl: this.baseUrl,
      runtimeToken,
      connectionName: input.profile.connectionName,
      // Exact connected-app operations may stream ordinary artifacts for as
      // long as the caller permits. The SDK's 30-second convenience deadline
      // is not an operation or payload policy; zero disables only that client
      // timer while preserving the caller's AbortSignal.
      timeoutMs: 0,
      maxRetries: 0,
      fetch: this.fetchImpl,
    });
    try {
      const apps = await client.apps.listByService(input.providerId, {
        retries: 0,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const exact = apps.find((app) => app.id === input.profile.connectedAccountId
        && (app.connectionName === input.profile.connectionName || app["alias"] === input.profile.connectionName));
      if (!exact) throw new LocalConnectedAppDriverError("connection_identity_mismatch", 409, true);
      const result = await client.executeRaw(input.operationId, input.args, {
        retries: 0,
        connectionName: input.profile.connectionName,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!result.executionId) throw new LocalConnectedAppDriverError("connected_app_receipt_invalid", 502);
      return { data: result.data, executionId: result.executionId };
    } catch (error) {
      if (error instanceof TypeError) {
        throw new LocalConnectedAppDriverError(
          input.effect === "write"
            ? "connected_app_write_outcome_unknown_do_not_retry"
            : "openconnector_unreachable",
          502,
          false,
          input.effect === "write",
        );
      }
      throw safeError(error);
    }
  }

  async disconnect(input: {
    providerId: ConnectedAppProviderId;
    profile: ConnectedAppProfileRow;
    config: ConnectedAppProviderConfigRow;
    signal?: AbortSignal;
  }): Promise<void> {
    try {
      const admin = await this.admin(input.config);
      if (input.profile.driverCredentialRecordId) {
        await admin.revokeRuntimeToken(input.profile.driverCredentialRecordId, input.signal)
          .catch((error) => {
            if (!(error instanceof OpenConnectorAdminError && error.code === "runtime_token_not_found")) throw error;
          });
      }
      await admin.disconnect(input.providerId, input.profile.connectionName, input.signal)
        .catch((error) => {
          if (!(error instanceof OpenConnectorAdminError && error.code === "connection_not_found")) throw error;
        });
      const ref = profileRef(input.profile);
      if (ref) await this.secrets.delete(ref);
    } catch (error) {
      throw safeError(error);
    }
  }
}
