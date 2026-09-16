/**
 * The only Human-bearer construction path for signed server administration.
 *
 * It deliberately verifies the selected endpoint and instance before exposing
 * an API client to a domain command. Bootstrap transport credentials remain
 * transport-only and never displace a Human bearer.
 */
import {
  CliSessionFileModeError,
  CliSessionSecurityError,
  CliSessionWriteConflictError,
  NautiloApiClient,
  loadCliSession,
  migrateLegacySessionFile,
  resolveCliServerUrl,
  saveCliSessionIfRevisionMatches,
  validateCliSessionProfileName,
  whoamiResponseSchema,
  type CliSessionPathOpts,
  type CliSessionV1Payload,
} from "@nautilo/api-client";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { refreshAccessToken, type RefreshOutcome } from "@nautilo/cli-auth";
import {
  apiClientOptionsFor,
  buildAuthHeaders,
  readActiveProfileName,
  transportFetch,
  type ResolvedServer,
} from "./profile-aware-server.ts";
import { resolveTransportEndpoint } from "./api-client.ts";
import { loadProfile } from "./profile-schema.ts";

const REFRESH_WINDOW_MS = 60_000;

export type AuthenticatedAdminErrorCode =
  | "login_required"
  | "session_expired"
  | "refresh_revoked"
  | "refresh_transient"
  | "session_rotation_conflict"
  | "session_persistence_failed"
  | "target_mismatch"
  | "instance_mismatch"
  | "transport_unreachable"
  | "capability_denied"
  | "password_change_required"
  | "invalid_server_response";

const ERROR_MESSAGES: Record<AuthenticatedAdminErrorCode, string> = {
  login_required: "Sign in is required. Run nautilo login.",
  session_expired: "The saved session cannot be refreshed. Run nautilo login.",
  refresh_revoked: "The saved session was revoked. Run nautilo login.",
  refresh_transient: "Session refresh could not be completed. The saved session was left unchanged; retry later.",
  session_rotation_conflict: "The saved session changed in another process. Retry the command.",
  session_persistence_failed: "The CLI session could not be safely persisted; inspect the session store before retrying.",
  target_mismatch: "The saved session belongs to a different server target. Select the matching profile or sign in again.",
  instance_mismatch: "The selected profile or saved session does not match the verified server identity.",
  transport_unreachable: "The selected server could not be reached.",
  capability_denied: "The signed-in Human is not permitted to use this server capability.",
  password_change_required: "Change the temporary password before using server administration commands. Run nautilo change-password.",
  invalid_server_response: "The selected server returned an invalid identity response.",
};

/** Stable, redacted failure for command adapters and JSON envelopes. */
export class AuthenticatedAdminClientError extends Error {
  readonly code: AuthenticatedAdminErrorCode;

  constructor(code: AuthenticatedAdminErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AuthenticatedAdminClientError";
    this.code = code;
  }
}

export type AuthenticatedWhoami = ReturnType<typeof whoamiResponseSchema.parse>;

export type HumanResolvedServer = ResolvedServer & {
  profileInstanceId?: string;
};

export type AuthenticatedAdminClient = {
  api: NautiloApiClient;
  identity: Pick<CliSessionV1Payload, "instanceId" | "handle" | "displayName" | "externalId" | "actorRole"> & {
    expiresAt: number;
  };
  transport: HumanResolvedServer;
  profileName?: string;
  whoami: AuthenticatedWhoami;
};

type SessionStore = {
  load: (opts?: CliSessionPathOpts) => Promise<CliSessionV1Payload | null>;
  migrateLegacy: (profile: string) => Promise<boolean>;
  compareAndSwap: (
    expectedRevision: string | undefined,
    replacement: CliSessionV1Payload,
    opts?: CliSessionPathOpts,
  ) => Promise<boolean>;
};

export type AuthenticatedAdminClientDependencies = {
  resolveServer?: (input: { serverFlag?: string | undefined }) => Promise<HumanResolvedServer>;
  readActiveProfileName?: () => string | undefined;
  profileInstanceId?: (profileName: string) => string | undefined;
  sessions?: Partial<SessionStore>;
  refresh?: (input: {
    endpoint: string;
    appId: string;
    refreshToken: string;
    resource: string;
  }) => Promise<RefreshOutcome>;
  createApiClient?: (transport: ResolvedServer) => NautiloApiClient;
  fetchWhoami?: (
    transport: ResolvedServer,
    accessToken: string,
  ) => Promise<AuthenticatedWhoami>;
  now?: () => number;
};

function normalizeHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function targetsMatch(session: CliSessionV1Payload, transport: ResolvedServer): boolean {
  if (transport.unixSocketPath !== undefined) {
    return session.targetBinding?.kind === "unix-socket";
  }
  const resolved = normalizeHttpOrigin(transport.baseUrl);
  if (!resolved) return false;
  if (session.targetBinding?.kind === "http-origin") return session.targetBinding.value === resolved;
  // A legacy HTTP URL is an exact origin, but it cannot be used to select a
  // refresh client family. The refresh gate below requires new metadata.
  return normalizeHttpOrigin(session.serverUrl) === resolved;
}

function defaultProfileInstanceId(profileName: string): string | undefined {
  const home = process.env["HOME"];
  if (!home || home.trim() === "") return undefined;
  try {
    return loadProfile(profileName, home).instance_id;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a Human endpoint without ever reading a profile bootstrap bearer.
 * Bootstrap credentials remain setup/lifecycle-only and are intentionally not
 * represented in this authenticated-command transport.
 */
function assertHumanHttpEndpoint(baseUrl: string): void {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new AuthenticatedAdminClientError("target_mismatch");
  }
  if (url.protocol === "https:") return;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "http:" || !loopback) {
    throw new AuthenticatedAdminClientError("target_mismatch");
  }
}

/** Logto token endpoints are HTTPS, except an explicitly loopback HTTP IdP. */
export function assertSafeLogtoIssuer(issuer: string): void {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new AuthenticatedAdminClientError("session_expired");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new AuthenticatedAdminClientError("session_expired");
  }
  if (url.protocol === "https:") return;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "http:" || !loopback) throw new AuthenticatedAdminClientError("session_expired");
}

export async function resolveHumanServer(input: { serverFlag?: string | undefined }): Promise<HumanResolvedServer> {
  const profileName = readActiveProfileName();
  const home = process.env["HOME"];
  let selectedProfile: ReturnType<typeof loadProfile> | undefined;
  if (profileName) {
    validateCliSessionProfileName(profileName);
    if (!home || home.trim() === "") throw new AuthenticatedAdminClientError("target_mismatch");
    selectedProfile = loadProfile(profileName, home);
  }
  if (input.serverFlag?.trim()) {
    assertHumanHttpEndpoint(input.serverFlag.trim());
    return {
      baseUrl: input.serverFlag.trim(),
      source: "flag",
      ...(selectedProfile?.instance_id ? { profileInstanceId: selectedProfile.instance_id } : {}),
    };
  }
  const envUrl = process.env["NAUTILO_SERVER_URL"]?.trim();
  if (envUrl) {
    assertHumanHttpEndpoint(envUrl);
    return {
      baseUrl: envUrl,
      source: "env",
      ...(selectedProfile?.instance_id ? { profileInstanceId: selectedProfile.instance_id } : {}),
    };
  }

  if (profileName && home?.trim() && selectedProfile) {
    const profile = selectedProfile;
    const endpoint = await resolveTransportEndpoint(profile, home);
    const result: HumanResolvedServer = {
      baseUrl: endpoint.baseUrl,
      source: "profile",
      ...(endpoint.unixSocketPath ? { unixSocketPath: endpoint.unixSocketPath } : {}),
      ...(profile.instance_id ? { profileInstanceId: profile.instance_id } : {}),
    };
    if (!result.unixSocketPath) assertHumanHttpEndpoint(result.baseUrl);
    return result;
  }
  const baseUrl = resolveCliServerUrl({ serverFlag: undefined });
  assertHumanHttpEndpoint(baseUrl);
  return {
    baseUrl,
    source: "default",
    ...(selectedProfile?.instance_id ? { profileInstanceId: selectedProfile.instance_id } : {}),
  };
}

/** Exact target proof persisted at login. Unix sockets use realpath, never a guessed path. */
export async function sessionTargetBindingFor(
  transport: HumanResolvedServer,
): Promise<NonNullable<CliSessionV1Payload["targetBinding"]>> {
  if (transport.unixSocketPath !== undefined) {
    if (!isAbsolute(transport.unixSocketPath)) {
      throw new AuthenticatedAdminClientError("target_mismatch");
    }
    try {
      const entry = await lstat(transport.unixSocketPath);
      if (entry.isSymbolicLink() || !entry.isSocket()) {
        throw new AuthenticatedAdminClientError("target_mismatch");
      }
      // macOS cannot `realpath()` a socket node itself. Resolve the parent
      // directory after rejecting a socket symlink, then append its basename.
      return {
        kind: "unix-socket",
        value: join(await realpath(dirname(transport.unixSocketPath)), basename(transport.unixSocketPath)),
      };
    } catch (error) {
      if (error instanceof AuthenticatedAdminClientError) throw error;
      throw new AuthenticatedAdminClientError("transport_unreachable");
    }
  }
  assertHumanHttpEndpoint(transport.baseUrl);
  const value = normalizeHttpOrigin(transport.baseUrl);
  if (!value) throw new AuthenticatedAdminClientError("target_mismatch");
  return { kind: "http-origin", value };
}

async function defaultFetchWhoami(
  transport: HumanResolvedServer,
  accessToken: string,
): Promise<AuthenticatedWhoami> {
  let response: Response;
  try {
    response = await transportFetch(transport, "/api/auth/whoami", {
      headers: buildAuthHeaders(transport, accessToken),
    });
  } catch {
    throw new AuthenticatedAdminClientError("transport_unreachable");
  }
  if (response.status === 401) throw new AuthenticatedAdminClientError("session_expired");
  if (response.status === 403) throw new AuthenticatedAdminClientError("capability_denied");
  if (!response.ok) throw new AuthenticatedAdminClientError("transport_unreachable");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AuthenticatedAdminClientError("invalid_server_response");
  }
  const parsed = whoamiResponseSchema.safeParse(body);
  if (!parsed.success) throw new AuthenticatedAdminClientError("invalid_server_response");
  return parsed.data;
}

function profileOpts(profileName: string | undefined): CliSessionPathOpts | undefined {
  return profileName ? { profile: profileName } : undefined;
}

/**
 * Resolve a selected profile/session into a target- and instance-bound Human
 * API client. It never sends a domain request until refresh/CAS and fresh
 * whoami verification have both succeeded.
 */
async function createAuthenticatedHumanClient(
  input: { serverFlag?: string | undefined } = {},
  dependencies: AuthenticatedAdminClientDependencies = {},
  allowRestrictedPasswordChange = false,
): Promise<AuthenticatedAdminClient> {
  const resolve = dependencies.resolveServer ?? resolveHumanServer;
  const profileName = (dependencies.readActiveProfileName ?? readActiveProfileName)();
  const sessions: SessionStore = {
    load: dependencies.sessions?.load ?? loadCliSession,
    migrateLegacy: dependencies.sessions?.migrateLegacy ?? migrateLegacySessionFile,
    compareAndSwap:
      dependencies.sessions?.compareAndSwap ?? saveCliSessionIfRevisionMatches,
  };
  const now = dependencies.now ?? Date.now;
  let transport: HumanResolvedServer;
  try {
    transport = await resolve(input);
  } catch (error) {
    if (error instanceof AuthenticatedAdminClientError) throw error;
    throw new AuthenticatedAdminClientError("transport_unreachable");
  }

  let stored: CliSessionV1Payload | null;
  try {
    if (profileName) await sessions.migrateLegacy(profileName);
    stored = await sessions.load(profileOpts(profileName));
  } catch {
    throw new AuthenticatedAdminClientError("session_persistence_failed");
  }
  if (!stored) throw new AuthenticatedAdminClientError("login_required");
  if (!targetsMatch(stored, transport)) {
    throw new AuthenticatedAdminClientError("target_mismatch");
  }
  if (transport.unixSocketPath !== undefined) {
    const binding = await sessionTargetBindingFor(transport);
    if (stored.targetBinding?.kind !== "unix-socket" || stored.targetBinding.value !== binding.value) {
      throw new AuthenticatedAdminClientError("target_mismatch");
    }
  }
  const profileInstanceId = transport.profileInstanceId ?? (profileName
    ? (dependencies.profileInstanceId ?? defaultProfileInstanceId)(profileName)
    : undefined);
  if (profileInstanceId !== undefined && stored.instanceId !== profileInstanceId) {
    throw new AuthenticatedAdminClientError("instance_mismatch");
  }

  let session = stored;
  const api = (dependencies.createApiClient ?? defaultCreateApiClient)(transport);
  const rotateSession = async (): Promise<CliSessionV1Payload> => {
    if (!session.refreshToken || !session.authBinding || !session.revision || !session.targetBinding) {
      throw new AuthenticatedAdminClientError("session_expired");
    }
    assertSafeLogtoIssuer(session.authBinding.issuer);
    let outcome: RefreshOutcome;
    try {
      outcome = await (dependencies.refresh ?? refreshAccessToken)({
        endpoint: session.authBinding.issuer,
        appId: session.authBinding.clientId,
        refreshToken: session.refreshToken,
        resource: session.authBinding.resource,
      });
    } catch {
      throw new AuthenticatedAdminClientError("refresh_transient");
    }
    if (outcome.kind === "invalid_grant") {
      throw new AuthenticatedAdminClientError("refresh_revoked");
    }
    if (outcome.kind === "transient") {
      throw new AuthenticatedAdminClientError("refresh_transient");
    }
    const replacement: CliSessionV1Payload = {
      ...session,
      accessToken: outcome.tokens.access_token,
      refreshToken: outcome.tokens.refresh_token,
      expiresAt: now() + outcome.tokens.expires_in * 1000,
      obtainedAt: now(),
    };
    let rotated: boolean;
    try {
      rotated = await sessions.compareAndSwap(
        session.revision,
        replacement,
        profileOpts(profileName),
      );
    } catch (error) {
      if (error instanceof CliSessionWriteConflictError) {
        throw new AuthenticatedAdminClientError("session_rotation_conflict");
      }
      if (error instanceof CliSessionSecurityError || error instanceof CliSessionFileModeError) {
        throw new AuthenticatedAdminClientError("session_persistence_failed");
      }
      throw new AuthenticatedAdminClientError("session_persistence_failed");
    }
    if (!rotated) {
      throw new AuthenticatedAdminClientError("session_rotation_conflict");
    }
    return replacement;
  };

  let proactivelyRefreshed = false;
  if (session.expiresAt <= now() + REFRESH_WINDOW_MS) {
    session = await rotateSession();
    proactivelyRefreshed = true;
  }

  const fetchFreshWhoami = async (): Promise<AuthenticatedWhoami> => {
    try {
      if (dependencies.fetchWhoami) {
        return await dependencies.fetchWhoami(transport, session.accessToken);
      }
      return await defaultFetchWhoami(transport, session.accessToken);
    } catch (error) {
      if (error instanceof AuthenticatedAdminClientError) throw error;
      throw new AuthenticatedAdminClientError("transport_unreachable");
    }
  };
  let whoami: AuthenticatedWhoami;
  try {
    whoami = await fetchFreshWhoami();
  } catch (error) {
    if (error instanceof AuthenticatedAdminClientError && error.code === "session_expired" && !proactivelyRefreshed) {
      session = await rotateSession();
      whoami = await fetchFreshWhoami();
    } else if (error instanceof AuthenticatedAdminClientError) {
      throw error;
    } else {
      throw new AuthenticatedAdminClientError("transport_unreachable");
    }
  }
  if (!whoami.sessionUserId) {
    throw new AuthenticatedAdminClientError("session_expired");
  }
  if (
    !whoami.instanceId ||
    whoami.instanceId !== session.instanceId ||
    (profileInstanceId !== undefined && whoami.instanceId !== profileInstanceId)
  ) {
    throw new AuthenticatedAdminClientError("instance_mismatch");
  }
  if (whoami.mustChangePassword && !allowRestrictedPasswordChange) {
    throw new AuthenticatedAdminClientError("password_change_required");
  }

  api.setToken(session.accessToken);
  return {
    api,
    identity: {
      instanceId: session.instanceId,
      handle: session.handle,
      displayName: session.displayName,
      externalId: session.externalId,
      ...(session.actorRole ? { actorRole: session.actorRole } : {}),
      expiresAt: session.expiresAt,
    },
    transport,
    ...(profileName ? { profileName } : {}),
    whoami,
  };
}

export async function createAuthenticatedAdminClient(
  input: { serverFlag?: string | undefined } = {},
  dependencies: AuthenticatedAdminClientDependencies = {},
): Promise<AuthenticatedAdminClient> {
  return createAuthenticatedHumanClient(input, dependencies, false);
}

export type RestrictedPasswordChangeClient = Pick<
  AuthenticatedAdminClient,
  "api" | "transport" | "profileName" | "whoami"
>;

export async function createRestrictedPasswordChangeClient(
  input: { serverFlag?: string | undefined } = {},
  dependencies: AuthenticatedAdminClientDependencies = {},
): Promise<RestrictedPasswordChangeClient> {
  const client = await createAuthenticatedHumanClient(input, dependencies, true);
  return {
    api: client.api,
    transport: client.transport,
    ...(client.profileName ? { profileName: client.profileName } : {}),
    whoami: client.whoami,
  };
}

function defaultCreateApiClient(transport: ResolvedServer): NautiloApiClient {
  return new NautiloApiClient(transport.baseUrl, apiClientOptionsFor(transport));
}
