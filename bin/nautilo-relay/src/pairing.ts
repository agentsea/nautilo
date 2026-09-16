import { hostname } from "node:os";

import {
  refreshAccessToken,
  normalizeDeviceAuthorizationInstruction,
  revokeRefreshToken,
  runDeviceFlow,
  type DeviceFlowEvent,
  type RefreshOutcome,
  type RevokeArgs,
} from "@nautilo/cli-auth";

import type { RelayCredentialStore, RelayStoredCredential } from "./credential-store";
import { normalizeRelayServerUrl } from "./bootstrap";

const RELAY_TOKEN_RE = /^rty_[A-Za-z0-9_-]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RelayHealthDiscovery {
  readonly logtoEndpoint?: unknown;
  readonly logtoTuiAppId?: unknown;
  readonly logtoResource?: unknown;
  readonly relayPairingContractVersion?: unknown;
}

interface RelayWhoamiResponse {
  readonly sessionUserId?: unknown;
}

interface RelayPairResponse {
  readonly relayToken?: unknown;
  readonly pairingContractVersion?: unknown;
}

export interface RelayPairingDependencies {
  readonly fetch: typeof fetch;
  readonly runDeviceFlow: (args: {
    endpoint: string;
    appId: string;
    resource: string;
    signal?: AbortSignal;
  }) => AsyncGenerator<DeviceFlowEvent>;
  readonly refreshAccessToken: (args: {
    endpoint: string;
    appId: string;
    refreshToken: string;
    resource: string;
  }) => Promise<RefreshOutcome>;
  readonly revokeRefreshToken: (args: RevokeArgs) => Promise<void>;
  readonly writeInstruction: (message: string) => void;
  readonly deviceLabel: () => string;
}

const defaultDependencies: RelayPairingDependencies = {
  fetch: globalThis.fetch.bind(globalThis),
  runDeviceFlow,
  refreshAccessToken,
  revokeRefreshToken,
  writeInstruction: (message) => process.stdout.write(message),
  deviceLabel: () => {
    const machine = hostname().trim();
    return machine.length > 0 ? `Nautilo Relay on ${machine}` : "Nautilo Relay";
  },
};

export class RelayPairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayPairingError";
  }
}

function hasTerminalControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/** Credentials may use HTTPS, or plaintext HTTP only on the local loopback. */
export function assertSafeRelayHttpEndpoint(raw: string, label = "server"): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RelayPairingError(`The ${label} endpoint is invalid`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new RelayPairingError(`The ${label} endpoint is invalid`);
  }
  if (url.protocol === "https:") return url;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "http:" || !loopback) {
    throw new RelayPairingError(`The ${label} endpoint must use HTTPS or loopback HTTP`);
  }
  return url;
}

export function normalizeDevicePairingInstruction(
  issuer: string,
  verificationUri: string,
  userCode: string,
): { readonly verificationUri: string; readonly userCode: string } {
  assertSafeRelayHttpEndpoint(issuer, "identity provider");
  try {
    return normalizeDeviceAuthorizationInstruction(issuer, verificationUri, userCode);
  } catch {
    throw new RelayPairingError("The identity provider returned an unsafe device instruction");
  }
}

async function jsonResponse<T>(response: Response, publicError: string): Promise<T> {
  if (!response.ok) throw new RelayPairingError(publicError);
  try {
    return await response.json() as T;
  } catch {
    throw new RelayPairingError(publicError);
  }
}

export async function pairStandaloneRelay(input: {
  readonly store: RelayCredentialStore;
  readonly signal?: AbortSignal;
  readonly dependencies?: Partial<RelayPairingDependencies>;
}): Promise<RelayStoredCredential> {
  const dependencies: RelayPairingDependencies = {
    ...defaultDependencies,
    ...input.dependencies,
  };
  const serverUrl = normalizeRelayServerUrl(input.store.serverUrl);
  assertSafeRelayHttpEndpoint(serverUrl);
  const identity = await input.store.getOrCreatePairingIdentity();

  const health = await jsonResponse<RelayHealthDiscovery>(
    await dependencies.fetch(`${serverUrl}/health`, {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }),
    "Relay pairing discovery failed",
  );
  if (
    typeof health.logtoEndpoint !== "string" ||
    typeof health.logtoTuiAppId !== "string" ||
    typeof health.logtoResource !== "string" ||
    health.logtoEndpoint.length === 0 ||
    health.logtoTuiAppId.length === 0 ||
    health.logtoResource.length === 0 ||
    health.relayPairingContractVersion !== 2
  ) {
    throw new RelayPairingError("This server does not support standalone Relay pairing");
  }
  assertSafeRelayHttpEndpoint(health.logtoEndpoint, "identity provider");

  let accessToken: string | null = null;
  let refreshTokenToRevoke: string | null = null;
  try {
    for await (const event of dependencies.runDeviceFlow({
      endpoint: health.logtoEndpoint,
      appId: health.logtoTuiAppId,
      resource: health.logtoResource,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })) {
      if (event.type === "code") {
        const instruction = normalizeDevicePairingInstruction(
          health.logtoEndpoint,
          event.data.verification_uri_complete ?? event.data.verification_uri,
          event.data.user_code,
        );
        dependencies.writeInstruction(
          `Open: ${instruction.verificationUri}\nCode: ${instruction.userCode}\n`,
        );
      } else if (event.type === "success") {
        refreshTokenToRevoke = event.data.refresh_token;
        const upgraded = await dependencies.refreshAccessToken({
          endpoint: health.logtoEndpoint,
          appId: health.logtoTuiAppId,
          refreshToken: event.data.refresh_token,
          resource: health.logtoResource,
        });
        if (upgraded.kind !== "ok") {
          throw new RelayPairingError("Relay sign-in could not obtain server authority");
        }
        accessToken = upgraded.tokens.access_token;
        refreshTokenToRevoke = upgraded.tokens.refresh_token;
        break;
      } else if (event.type === "error") {
        throw new RelayPairingError(
          event.recoverable
            ? "Relay sign-in did not complete; retry pairing"
            : "Relay sign-in was rejected",
        );
      }
    }

    if (input.signal?.aborted) throw new RelayPairingError("Relay pairing was cancelled");
    if (accessToken === null) throw new RelayPairingError("Relay sign-in did not complete");

    const authorization = { authorization: `Bearer ${accessToken}` };
    const whoami = await jsonResponse<RelayWhoamiResponse>(
      await dependencies.fetch(`${serverUrl}/api/auth/whoami`, {
        headers: authorization,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }),
      "Relay sign-in identity validation failed",
    );
    if (
      typeof whoami.sessionUserId !== "string" ||
      !UUID_RE.test(whoami.sessionUserId)
    ) {
      throw new RelayPairingError("Relay sign-in identity validation failed");
    }

    const pairResponse = await jsonResponse<RelayPairResponse>(
      // Hostname is display-only and never authority. Still bound it before
      // sending so a malformed local hostname cannot inject server UI text.
      await dependencies.fetch(`${serverUrl}/api/relay/pair`, {
        method: "POST",
        headers: {
          ...authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deviceLabel: (() => {
            const label = dependencies.deviceLabel().trim();
            if (
              label.length === 0 ||
              label.length > 200 ||
              hasTerminalControlCharacters(label)
            ) return "Nautilo Relay";
            return label;
          })(),
          installationId: identity.installationId,
          capabilities: { profile: "desktop-agent" },
        }),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }),
      "The server could not pair this Relay",
    );
    if (
      pairResponse.pairingContractVersion !== 2 ||
      typeof pairResponse.relayToken !== "string" ||
      !RELAY_TOKEN_RE.test(pairResponse.relayToken)
    ) {
      throw new RelayPairingError("The server returned an invalid Relay credential");
    }

    const credential: RelayStoredCredential = {
      ...identity,
      userId: whoami.sessionUserId,
      relayToken: pairResponse.relayToken,
    };
    await input.store.save(credential);
    return credential;
  } catch (error) {
    if (error instanceof RelayPairingError) throw error;
    if (input.signal?.aborted) throw new RelayPairingError("Relay pairing was cancelled");
    throw new RelayPairingError("Relay pairing failed");
  } finally {
    if (refreshTokenToRevoke !== null) {
      try {
        await dependencies.revokeRefreshToken({
          endpoint: health.logtoEndpoint,
          appId: health.logtoTuiAppId,
          refreshToken: refreshTokenToRevoke,
        });
      } catch {
        // The production implementation is best-effort and never throws.
        // Preserve that contract for injected adapters too: cleanup cannot
        // turn a successfully stored Relay credential into a false failure.
      }
    }
  }
}
