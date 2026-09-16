/**
 * M102 — loopback redirect + PKCE client for Logto OIDC (Native app flow).
 *
 * Lifts the loopback PKCE pattern from the Electron workbench
 * (`sign-in.ts`, `pkce.ts`, `loopback-server.ts`) into a pure Node module for
 * administrator CLI authentication. Binds the callback server only to `127.0.0.1`, uses
 * RFC 7636 S256 challenges, and exchanges the code at `/oidc/token` with
 * `resource` echoed from the authorize step (RFC 8707 / Logto).
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

const DEFAULT_SCOPES = [
  "openid",
  "offline_access",
  "profile",
  "email",
] as const;

const DEFAULT_LOOPBACK_TIMEOUT_MS = 5 * 60_000;

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Signed in</title>
<meta charset="utf-8"></head>
<body><p>Signed in — you can close this tab</p></body></html>`;

export interface LoopbackPkceArgs {
  endpoint: string;
  clientId: string;
  resource: string;
  scopes?: string[];
  extraParams?: Record<string, string>;
  abortSignal?: AbortSignal;
  /** Test seam: defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam: defaults to `openUrlInDefaultBrowser` from `./browser`. */
  openUrl?: (url: string) => void | Promise<void>;
  /** Fail immediately when the browser process cannot be launched. */
  browserLaunchRequired?: boolean;
  /** Test seam: override the loopback HTTP server (resolves on `/callback`). */
  startLoopback?: () => Promise<LoopbackHandle>;
  /** Passed through when using the default `startLoopbackServer` (loopback wait timeout). */
  timeoutMs?: number;
}

export interface LoopbackHandle {
  port: number;
  /** Always `127.0.0.1` — loopback bind invariant for tests and redirect URI. */
  address: string;
  awaitCallback: Promise<{ code: string; state: string }>;
  shutdown: () => void;
}

export interface LoopbackPkceResult {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn: number;
}

interface TokenJson {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(randomBytes(64));
  const codeChallenge = base64url(
    createHash("sha256").update(codeVerifier).digest(),
  );
  return { codeVerifier, codeChallenge };
}

export function generateState(): string {
  return base64url(randomBytes(32));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface StartLoopbackOptions {
  timeoutMs?: number;
}

export async function startLoopbackServer(
  opts: StartLoopbackOptions = {},
): Promise<LoopbackHandle> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOOPBACK_TIMEOUT_MS;

  let resolve!: (r: { code: string; state: string }) => void;
  let reject!: (e: Error) => void;
  const awaitCallback = new Promise<{ code: string; state: string }>(
    (res, rej) => {
      resolve = res;
      reject = rej;
    },
  );

  const server: Server = createServer((req, reply) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      reply.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      reply.end("Not the OAuth callback endpoint.");
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) {
      reply.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      reply.end(`<h1>Sign-in failed</h1><p>${escapeHtml(error)}</p>`);
      reject(new Error(`OAuth error: ${error}`));
      return;
    }
    if (!code || !state) {
      reply.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      reply.end("<h1>Bad callback</h1>");
      reject(new Error("Loopback callback missing code or state"));
      return;
    }
    reply.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    reply.end(SUCCESS_HTML);
    resolve({ code, state });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addressInfo = server.address();
  if (!addressInfo || typeof addressInfo === "string") {
    server.close();
    throw new Error("Loopback server failed to bind");
  }
  const port = addressInfo.port;
  const boundAddress = addressInfo.address;

  const timer = setTimeout(() => {
    reject(new Error(`Loopback callback timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  awaitCallback
    .finally(() => {
      clearTimeout(timer);
      server.close();
    })
    .catch(() => {
      /* rejection surfaced to the awaiting caller */
    });

  return {
    port,
    address: boundAddress,
    awaitCallback,
    shutdown: () => {
      clearTimeout(timer);
      server.close();
      reject(new Error("Loopback server shut down"));
    },
  };
}

async function raceCallbackOrAbort(
  loopback: LoopbackHandle,
  signal: AbortSignal | undefined,
): Promise<{ code: string; state: string }> {
  if (!signal) {
    return await loopback.awaitCallback;
  }
  if (signal.aborted) {
    loopback.shutdown();
    throw new Error("Loopback PKCE aborted");
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => {
      loopback.shutdown();
      reject(new Error("Loopback PKCE aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([loopback.awaitCallback, abortPromise]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export async function runLoopbackPkce(
  args: LoopbackPkceArgs,
): Promise<LoopbackPkceResult> {
  const pkce = generatePkcePair();
  const state = generateState();

  const startLoopback =
    args.startLoopback ??
    (() =>
      startLoopbackServer({
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      }));

  const loopback = await startLoopback();
  const redirectUri = `http://127.0.0.1:${loopback.port}/callback`;

  const authUrl = new URL(`${args.endpoint}/oidc/auth`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", args.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  const scopes = args.scopes ?? [...DEFAULT_SCOPES];
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("resource", args.resource);
  authUrl.searchParams.set("code_challenge", pkce.codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  // Logto OSS Native: `offline_access` refresh tokens require `prompt=consent`,
  // and `prompt=login` is needed to bypass Logto's sticky-SSO "you are already
  // signed in" landing page (otherwise the redirect to the loopback never fires
  // when a Logto cookie is present in the system browser). Mirrors Electron's
  // `apps/desktop/electron/auth/sign-in.ts` (M060 + M061). Callers may override
  // via `extraParams` merged last.
  authUrl.searchParams.set("prompt", "login consent");
  if (args.extraParams) {
    for (const [k, v] of Object.entries(args.extraParams)) {
      if (typeof v === "string" && v.length > 0) {
        authUrl.searchParams.set(k, v);
      }
    }
  }

  const openBrowser =
    args.openUrl ??
    (await import("./browser")).openUrlInDefaultBrowser;

  let captured: { code: string; state: string };
  try {
    try {
      await Promise.resolve(openBrowser(authUrl.toString()));
    } catch {
      if (args.browserLaunchRequired === true) {
        throw new Error("Browser launch failed");
      }
      /* best-effort for legacy/TUI callers */
    }
    captured = await raceCallbackOrAbort(loopback, args.abortSignal);
  } finally {
    loopback.shutdown();
  }

  if (captured.state !== state) {
    throw new Error(
      "OIDC state mismatch — possible CSRF; aborting sign-in",
    );
  }

  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const tokenRes = await fetchImpl(`${args.endpoint}/oidc/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: captured.code,
      redirect_uri: redirectUri,
      client_id: args.clientId,
      code_verifier: pkce.codeVerifier,
      resource: args.resource,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    throw new Error(`Logto token exchange failed: ${tokenRes.status} ${text}`);
  }

  const json = (await tokenRes.json()) as TokenJson;

  return {
    accessToken: json.access_token,
    expiresIn: json.expires_in,
    ...(json.refresh_token !== undefined
      ? { refreshToken: json.refresh_token }
      : {}),
    ...(json.id_token !== undefined ? { idToken: json.id_token } : {}),
  };
}
