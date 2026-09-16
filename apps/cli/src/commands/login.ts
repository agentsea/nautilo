import type { CommandModule } from "yargs";
import { NautiloApiClient, type CliSessionV1Payload } from "@nautilo/api-client";
import {
  detectHeadless,
  openUrlInDefaultBrowserChecked,
  normalizeDeviceAuthorizationInstruction,
  refreshAccessToken,
  runDeviceFlow,
  runLoopbackPkce,
  saveCliSessionForActiveProfile,
} from "@nautilo/cli-auth";
import { cliSessionFromWhoami, tokenExpiryMs } from "../lib/build-cli-session.ts";
import {
  apiClientOptionsFor,
  buildAuthHeaders,
  readActiveProfileName,
  transportFetch,
  type ResolvedServer,
} from "../lib/profile-aware-server.ts";
import {
  AuthenticatedAdminClientError,
  assertSafeLogtoIssuer,
  resolveHumanServer,
  sessionTargetBindingFor,
  type HumanResolvedServer,
} from "../lib/authenticated-admin-client.ts";
import {
  writeServerAdminError,
  writeServerAdminSuccess,
  type ServerAdminFormat,
} from "../lib/server-admin-output.ts";

type LoginMode = "browser" | "device";

class PendingPasswordChangeError extends Error {
  constructor() {
    super("pending_password_change");
    this.name = "PendingPasswordChangeError";
  }
}

class LoginFlowError extends Error {
  constructor(
    readonly code: "browser_unavailable" | "login_cancelled" | "login_timeout" | "callback_unavailable",
    readonly publicMessage: string,
  ) {
    super(code);
    this.name = "LoginFlowError";
  }
}

function stableLoginFlowError(error: unknown): LoginFlowError | null {
  if (error instanceof LoginFlowError) return error;
  const message = error instanceof Error ? error.message : "";
  if (/browser launch failed/i.test(message)) {
    return new LoginFlowError(
      "browser_unavailable",
      "No browser could be opened. Run nautilo login --remote for device sign-in.",
    );
  }
  if (/oauth error:\s*access_denied|aborted|shut down/i.test(message)) {
    return new LoginFlowError(
      "login_cancelled",
      "Sign-in was cancelled. No CLI session was saved.",
    );
  }
  if (/callback timeout/i.test(message)) {
    return new LoginFlowError(
      "login_timeout",
      "Sign-in timed out. Retry, or run nautilo login --remote.",
    );
  }
  if (/eaddrinuse|failed to bind/i.test(message)) {
    return new LoginFlowError(
      "callback_unavailable",
      "The local sign-in callback could not start. Retry, or run nautilo login --remote.",
    );
  }
  return null;
}

/** Used by yargs `.check()` and unit tests — rejects any `--password` argv key. */
export function loginPasswordArgvCheck(argv: Record<string, unknown>): true {
  if (Object.prototype.hasOwnProperty.call(argv, "password")) {
    throw new Error(
      "Sign-in with `--password` is no longer supported. Use `nautilo login` (browser) or `nautilo login --remote` (device flow), or sign in from the Desktop app on a workstation.",
    );
  }
  return true;
}

export function parseMode(argv: Record<string, unknown>, env: NodeJS.ProcessEnv): LoginMode {
  if (argv["device"] === true) {
    process.stderr.write(
      "`--device` is deprecated; use `--remote` instead. The old flag still works for now.\n",
    );
    return "device";
  }
  if (argv["remote"] === true) return "device";
  if (detectHeadless(env).headless) return "device";
  return "browser";
}

async function fetchWhoamiWithTransport(
  transport: ResolvedServer,
  accessToken: string,
): Promise<{ sessionUserId?: string | undefined; mustChangePassword?: boolean | undefined }> {
  const headers = buildAuthHeaders(transport, accessToken);
  const res = await transportFetch(transport, "/api/auth/whoami", { headers });
  if (!res.ok) {
    throw new Error("identity_refresh_failed");
  }
  try {
    return (await res.json()) as { sessionUserId?: string | undefined; mustChangePassword?: boolean };
  } catch {
    throw new Error("identity_refresh_failed");
  }
}

function assertLoginInstance(transport: HumanResolvedServer, instanceId: string): void {
  if (transport.profileInstanceId !== undefined && transport.profileInstanceId !== instanceId) {
    throw new AuthenticatedAdminClientError("instance_mismatch");
  }
}

async function loginBrowserFlow(
  transport: HumanResolvedServer,
  abortSignal: AbortSignal,
): Promise<CliSessionV1Payload> {
  const api = new NautiloApiClient(transport.baseUrl, apiClientOptionsFor(transport));
  const health = await api.getHealth();
  const endpoint = health.logtoEndpoint;
  const clientId = health.logtoTuiLoopbackAppId;
  const resource = health.logtoResource;
  if (!endpoint || !clientId || !resource) {
    throw new Error(
      "Server has no Logto loopback PKCE app configured. Use `nautilo login --remote` (device flow).",
    );
  }
  assertSafeLogtoIssuer(endpoint);
  const pkce = await runLoopbackPkce({
    endpoint,
    clientId,
    resource,
    abortSignal,
    openUrl: openUrlInDefaultBrowserChecked,
    browserLaunchRequired: true,
  });
  const accessToken = pkce.accessToken;
  api.setToken(accessToken);

  const w = await fetchWhoamiWithTransport(transport, accessToken);
  if (!w.sessionUserId) {
    api.setToken(null);
    throw new Error("Browser sign-in failed identity refresh.");
  }
  const expiresAt = tokenExpiryMs(accessToken, Math.max(60_000, pkce.expiresIn * 1000));
  const session = await cliSessionFromWhoami(
    api,
    transport.baseUrl,
    accessToken,
    pkce.refreshToken,
    expiresAt,
    "device",
    await sessionTargetBindingFor(transport),
    { flow: "browser_loopback", issuer: endpoint, clientId, resource },
  );
  assertLoginInstance(transport, session.instanceId);
  await saveCliSessionForActiveProfile(session);
  if (w.mustChangePassword === true) throw new PendingPasswordChangeError();
  return session;
}

/**
 * Complete the ordinary interactive browser login without writing a command
 * result. Consuming commands use this only before their first mutation, then
 * rebuild the authenticated client from the newly persisted session.
 */
export async function loginForAdminCommand(input: { serverFlag?: string }): Promise<void> {
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const transport = await resolveHumanServer(input);
    await loginBrowserFlow(transport, abortController.signal);
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

async function loginDeviceFlow(
  transport: HumanResolvedServer,
  format: ServerAdminFormat,
  abortSignal: AbortSignal,
): Promise<CliSessionV1Payload> {
  // Drive RFC 8628 directly against Logto. Endpoint / app id / resource come
  // from the Nautilo server's public /health bundle — same wiring as browser
  // PKCE above.
  const api = new NautiloApiClient(transport.baseUrl, apiClientOptionsFor(transport));
  const health = await api.getHealth();
  const endpoint = health.logtoEndpoint;
  const appId = health.logtoTuiAppId;
  const resource = health.logtoResource;
  if (!endpoint || !appId || !resource) {
    throw new Error(
      "Server has no Logto device-flow app configured. Use `nautilo login` (browser PKCE) on a workstation.",
    );
  }
  assertSafeLogtoIssuer(endpoint);

  let tokens: { access_token: string; refresh_token: string; expires_in: number } | null = null;
  for await (const event of runDeviceFlow({ endpoint, appId, resource, signal: abortSignal })) {
    if (event.type === "code") {
      const instructionData = normalizeDeviceAuthorizationInstruction(
        endpoint,
        event.data.verification_uri_complete ?? event.data.verification_uri,
        event.data.user_code,
      );
      const instruction = `Open: ${instructionData.verificationUri}\nCode: ${instructionData.userCode}\n`;
      // JSON is a one-document automation contract. Device interaction is
      // intentionally an operator instruction on stderr, never a preliminary
      // JSON success document that would make stdout ambiguous on late error.
      if (format === "json") process.stderr.write(instruction);
      else process.stdout.write(instruction);
    } else if (event.type === "success") {
      tokens = event.data;
      break;
    } else if (event.type === "error") {
      if (/cancelled/i.test(event.message)) {
        throw new LoginFlowError(
          "login_cancelled",
          "Sign-in was cancelled. No CLI session was saved.",
        );
      }
      if (/expired/i.test(event.message)) {
        throw new LoginFlowError(
          "login_timeout",
          "Sign-in timed out. Retry, or run nautilo login --remote.",
        );
      }
      throw new Error("device_authorization_failed");
    }
  }
  if (abortSignal.aborted) {
    throw new LoginFlowError(
      "login_cancelled",
      "Sign-in was cancelled. No CLI session was saved.",
    );
  }
  if (!tokens) {
    throw new Error("Device sign-in did not complete.");
  }

  // Logto OSS issues an OPAQUE access_token from the device-code grant
  // (per RFC 8628; the token is bound to `/oidc/me` only). Our trust
  // preHandler requires a JWT bearer with `aud = <LOGTO_RESOURCE>`. The
  // canonical mint path is an immediate refresh-grant with `resource=...`,
  // which returns a JWT-bearer access_token bound to the Nautilo API.
  // The legacy-named device client first yields an opaque token; refresh it
  // immediately into the resource-bound JWT required by Nautilo's API.
  const upgraded = await refreshAccessToken({
    endpoint,
    appId,
    refreshToken: tokens.refresh_token,
    resource,
  });
  if (upgraded.kind !== "ok") {
    throw new Error("device_token_upgrade_failed");
  }
  tokens = {
    access_token: upgraded.tokens.access_token,
    refresh_token: upgraded.tokens.refresh_token,
    expires_in: upgraded.tokens.expires_in,
  };

  api.setToken(tokens.access_token);

  const w = await fetchWhoamiWithTransport(transport, tokens.access_token);
  if (!w.sessionUserId) {
    api.setToken(null);
    throw new Error("Device sign-in failed identity refresh.");
  }
  const expiresAt = tokenExpiryMs(
    tokens.access_token,
    Math.max(60_000, tokens.expires_in * 1000),
  );
  const session = await cliSessionFromWhoami(
    api,
    transport.baseUrl,
    tokens.access_token,
    tokens.refresh_token,
    expiresAt,
    "device",
    await sessionTargetBindingFor(transport),
    { flow: "device", issuer: endpoint, clientId: appId, resource },
  );
  assertLoginInstance(transport, session.instanceId);
  await saveCliSessionForActiveProfile(session);
  if (w.mustChangePassword === true) throw new PendingPasswordChangeError();
  return session;
}

export const loginModule: CommandModule = {
  command: "login",
  describe: "Sign in via browser (default) or device flow (`--remote` / auto when headless).",
  builder: (yargs) =>
    yargs
      .check((argv) => loginPasswordArgvCheck(argv as Record<string, unknown>))
      .option("server", {
        type: "string",
        describe: "Server URL (overrides NAUTILO_SERVER_URL and active profile)",
      })
      .option("remote", {
        type: "boolean",
        default: false,
        describe: "Force device flow (prints URL + code). Auto-enabled when headless.",
      })
      .option("format", {
        type: "string",
        choices: ["human", "json"] as const,
        default: "human",
        describe: "Output format",
      })
      .option("device", {
        type: "boolean",
        default: false,
        hidden: true,
        describe: "Deprecated alias for --remote",
      }),
  handler: async (argv) => {
    process.exitCode = undefined;
    const format: ServerAdminFormat = argv["format"] === "json" ? "json" : "human";
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const transport = await resolveHumanServer({
        serverFlag: argv["server"] as string | undefined,
      });
      const mode = parseMode(argv as Record<string, unknown>, process.env);
      const session = mode === "device"
        ? await loginDeviceFlow(transport, format, abortController.signal)
        : await loginBrowserFlow(transport, abortController.signal);
      const profile = readActiveProfileName();
      writeServerAdminSuccess(
        format,
        {
          ...(profile ? { profile } : {}),
          instanceId: session.instanceId,
          server: transport.baseUrl,
          handle: session.handle,
          displayName: session.displayName,
          ...(session.actorRole ? { actorRole: session.actorRole } : {}),
          expiresAt: session.expiresAt,
        },
        [`Signed in as ${session.handle} (role: ${session.actorRole ?? "?"}).`],
      );
      process.exitCode = 0;
    } catch (e) {
      if (e instanceof PendingPasswordChangeError) {
        writeServerAdminError(
          format,
          "password_change_required",
          "A restricted CLI session was saved. Run nautilo change-password from an interactive terminal before using other commands.",
        );
        process.exitCode = 2;
        return;
      }
      const flowError = stableLoginFlowError(e);
      if (flowError !== null) {
        writeServerAdminError(format, flowError.code, flowError.publicMessage);
      } else if (e instanceof AuthenticatedAdminClientError) {
        writeServerAdminError(format, e.code, e.message);
      } else {
        writeServerAdminError(
          format,
          "login_failed",
          "Sign-in could not complete. Retry, or use nautilo login --remote.",
        );
      }
      process.exitCode = 2;
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  },
};
