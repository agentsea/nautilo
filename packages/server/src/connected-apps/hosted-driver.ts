import { createHash } from "node:crypto";
import {
  ConnectorError,
  ProjectConnector,
  type ConnectedAccountProfile,
  type ConnectionRequest,
} from "@oomol-lab/connector";
import {
  ConnectedAppAccountSchema,
  type ConnectedAppAccount,
  type ConnectedAppProviderId,
} from "@nautilo/types";

const SAFE_CONNECTOR_CODES = new Set([
  "app_not_found",
  "app_not_ready",
  "client_network_error",
  "client_timeout",
  "client_wait_timeout",
  "connected_account_not_found",
  "connection_account_conflict",
  "connection_request_not_found",
  "credential_expired",
  "invalid_input",
  "not_found",
  "oauth_refresh_unavailable",
  "oauth_token_expired",
  "provider_config_not_found",
  "rate_limited",
  "unauthorized",
]);

export class HostedConnectedAppDriverError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly reconnectRequired = false,
    readonly outcomeUnknown = false,
  ) {
    super(code);
    this.name = "HostedConnectedAppDriverError";
  }
}

export type HostedDriverBinding = {
  readonly providerId: ConnectedAppProviderId;
  readonly userId: string;
  readonly namespaceId: string;
  readonly externalUserId: string;
  readonly connectionName: string;
};

export type HostedOauthStart = {
  readonly requestId: string;
  readonly providerConfigId: string;
  readonly connectionName: string;
  readonly authorizationUrl: string;
  readonly expiresAt: Date;
};

export type HostedOauthInspection =
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
    };

function opaqueId(kind: "user" | "namespace", value: string): string {
  return `nautilo-${kind}-${createHash("sha256").update(value).digest("base64url")}`;
}

/** Hosted aliases are lowercase-only; full SHA-256 hex preserves every digest bit within 64 chars. */
function hostedConnectionName(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hostedDriverBinding(userId: string, namespaceId: string): HostedDriverBinding;
export function hostedDriverBinding(
  providerId: ConnectedAppProviderId,
  userId: string,
  namespaceId: string,
): HostedDriverBinding;
export function hostedDriverBinding(
  providerIdOrUserId: string,
  userIdOrNamespaceId: string,
  namespaceId?: string,
): HostedDriverBinding {
  const providerId = namespaceId ? providerIdOrUserId : "notion";
  const userId = namespaceId ? userIdOrNamespaceId : providerIdOrUserId;
  const resolvedNamespaceId = namespaceId ?? userIdOrNamespaceId;
  return {
    providerId,
    userId,
    namespaceId: resolvedNamespaceId,
    externalUserId: opaqueId("user", userId),
    connectionName: hostedConnectionName(`${userId}:${resolvedNamespaceId}:${providerId}`),
  };
}

function safeError(error: unknown): HostedConnectedAppDriverError {
  if (error instanceof HostedConnectedAppDriverError) return error;
  if (error instanceof ConnectorError) {
    const code = SAFE_CONNECTOR_CODES.has(error.code) ? error.code : "provider_error";
    const reconnectRequired = error.status === 409 || [
      "connected_account_not_found",
      "connection_account_conflict",
      "credential_expired",
      "oauth_refresh_unavailable",
      "oauth_token_expired",
      "unauthorized",
    ].includes(code);
    return new HostedConnectedAppDriverError(code, error.status, reconnectRequired);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new HostedConnectedAppDriverError("request_cancelled", 0);
  }
  return new HostedConnectedAppDriverError("provider_error", 0);
}

function account(profile: ConnectedAccountProfile): ConnectedAppAccount {
  const kind = ["user", "bot", "service_account", "unknown"].includes(profile.profile.kind)
    ? profile.profile.kind as ConnectedAppAccount["kind"]
    : "unknown";
  const avatarUrl = profile.profile.avatarUrl?.startsWith("https://")
    ? profile.profile.avatarUrl
    : null;
  const workspaceName = typeof profile.profile.metadata["workspaceName"] === "string"
    ? profile.profile.metadata["workspaceName"].trim() || null
    : null;
  return ConnectedAppAccountSchema.parse({
    displayName: profile.profile.displayName?.trim() || null,
    username: profile.profile.username?.trim() || null,
    email: profile.profile.email?.trim() || null,
    avatarUrl,
    workspaceName,
    kind,
  });
}

function workspaceIdentity(profile: ConnectedAccountProfile, providerId: ConnectedAppProviderId): string {
  const workspaceId = profile.profile.metadata["workspaceId"];
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new HostedConnectedAppDriverError("connection_identity_incomplete", 502);
  }
  return createHash("sha256").update(`${providerId}-workspace:${workspaceId}`).digest("base64url");
}

function callOptions(signal?: AbortSignal): { retries: 0; signal?: AbortSignal } {
  return signal ? { retries: 0, signal } : { retries: 0 };
}

function validateRequest(
  request: ConnectionRequest,
  expected: HostedDriverBinding & { readonly requestId?: string; readonly providerConfigId?: string },
): void {
  if (
    (expected.requestId !== undefined && request.id !== expected.requestId) ||
    request.externalUserId !== expected.externalUserId ||
    request.service !== expected.providerId ||
    request.connectionName !== expected.connectionName ||
    (expected.providerConfigId !== undefined && request.providerConfigId !== expected.providerConfigId) ||
    request.providerConfigId.length === 0
  ) {
    throw new HostedConnectedAppDriverError("connection_identity_mismatch", 409);
  }
}

function validateProfile(
  profile: ConnectedAccountProfile,
  expected: HostedDriverBinding,
  connectedAccountId: string,
): void {
  if (
    profile.connectedAccountId !== connectedAccountId ||
    profile.externalUserId !== expected.externalUserId ||
    profile.service !== expected.providerId ||
    !profile.profile.id
  ) {
    throw new HostedConnectedAppDriverError("connection_identity_mismatch", 409);
  }
}

export class OomolHostedConnectedAppDriver {
  readonly #project: ProjectConnector;

  constructor(projectApiKey: string, options: { fetch?: typeof fetch } = {}) {
    if (!/^oo_proj_[A-Za-z0-9_-]{20,}$/u.test(projectApiKey)) {
      throw new HostedConnectedAppDriverError("hosted_driver_not_configured", 503);
    }
    this.#project = new ProjectConnector({
      apiKey: projectApiKey,
      maxRetries: 0,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async startOauth(
    binding: HostedDriverBinding,
    returnUri: string,
    signal?: AbortSignal,
  ): Promise<HostedOauthStart> {
    try {
      const request = await this.#project.connect.oauth(binding.externalUserId, {
        service: binding.providerId,
        connectionName: binding.connectionName,
        returnUri,
      }, callOptions(signal));
      validateRequest(request, binding);
      if (
        request.status !== "initiated" ||
        request.connectedAccountId !== null ||
        request.errorCode !== null ||
        request.errorMessage !== null ||
        !request.authorizationUrl.startsWith("https://") ||
        Date.parse(request.expiresAt) <= Date.now()
      ) {
        throw new HostedConnectedAppDriverError("connection_request_invalid", 502);
      }
      return {
        requestId: request.id,
        providerConfigId: request.providerConfigId,
        connectionName: binding.connectionName,
        authorizationUrl: request.authorizationUrl,
        expiresAt: new Date(request.expiresAt),
      };
    } catch (error) {
      throw safeError(error);
    }
  }

  async inspectOauth(
    binding: HostedDriverBinding,
    expected: { readonly requestId: string; readonly providerConfigId: string },
    signal?: AbortSignal,
  ): Promise<HostedOauthInspection> {
    try {
      const request = await this.#project.getConnectionRequest(expected.requestId, callOptions(signal));
      validateRequest(request, { ...binding, ...expected });
      if (request.status === "initiated") {
        if (!request.authorizationUrl.startsWith("https://") || Date.parse(request.expiresAt) <= Date.now()) {
          return { status: "expired", errorCode: "connection_request_expired" };
        }
        return {
          status: "connecting",
          authorizationUrl: request.authorizationUrl,
          expiresAt: new Date(request.expiresAt),
        };
      }
      if (request.status === "failed") {
        return {
          status: "failed",
          errorCode: request.errorCode && SAFE_CONNECTOR_CODES.has(request.errorCode)
            ? request.errorCode
            : "connection_request_failed",
        };
      }
      if (request.status === "expired") {
        return { status: "expired", errorCode: "connection_request_expired" };
      }
      if (request.status !== "connected" || !request.connectedAccountId) {
        throw new HostedConnectedAppDriverError("connection_request_invalid", 502);
      }
      const profile = await this.#project.getUserProfile(request.connectedAccountId, callOptions(signal));
      validateProfile(profile, binding, request.connectedAccountId);
      return {
        status: "connected",
        connectedAccountId: request.connectedAccountId,
        providerConfigId: request.providerConfigId,
        connectionName: binding.connectionName,
        providerUserId: profile.profile.id,
        workspaceIdentity: workspaceIdentity(profile, binding.providerId),
        account: account(profile),
      };
    } catch (error) {
      throw safeError(error);
    }
  }

  async execute(input: {
    readonly binding: HostedDriverBinding;
    readonly connectedAccountId: string;
    readonly providerConfigId: string;
    readonly workspaceIdentity: string;
    readonly operationId: string;
    readonly args: Record<string, unknown>;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{ executionId: string; data: unknown }> {
    // Identity is proven before dispatch so failures here cannot be mistaken for write outcomes.
    try {
      const profile = await this.#project.getUserProfile(
        input.connectedAccountId,
        callOptions(input.signal),
      );
      validateProfile(profile, input.binding, input.connectedAccountId);
      if (workspaceIdentity(profile, input.binding.providerId) !== input.workspaceIdentity) {
        throw new HostedConnectedAppDriverError("connection_identity_mismatch", 409);
      }
    } catch (error) {
      throw safeError(error);
    }

    // Once dispatch begins, a transport/SDK failure cannot prove that a provider write did not land.
    try {
      const result = await this.#project.executeRaw(
        input.binding.externalUserId,
        input.operationId,
        input.args,
        {
          providerConfigId: input.providerConfigId,
          connectedAccountId: input.connectedAccountId,
          ...callOptions(input.signal),
        },
      );
      if (!result.executionId) {
        throw new HostedConnectedAppDriverError("execution_receipt_invalid", 502, false, true);
      }
      return { executionId: result.executionId, data: result.data };
    } catch (error) {
      const safe = safeError(error);
      if (safe.outcomeUnknown) throw safe;
      throw new HostedConnectedAppDriverError(
        safe.code,
        safe.status,
        safe.reconnectRequired,
        true,
      );
    }
  }
}
