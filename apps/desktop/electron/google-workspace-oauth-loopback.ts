/**
 * Nautilo-owned loopback completion for gog's state-checked two-step OAuth flow.
 *
 * The authorization code is never logged or returned to the renderer. gog remains
 * responsible for PKCE/state validation and token storage; Nautilo owns only the
 * loopback listener, browser handoff, and product-facing completion page.
 */
import { createServer, type Server, type ServerResponse } from "node:http";

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const GOG_COMMAND_TIMEOUT_MS = 45_000;

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  opts?: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export type NautiloGogAuthorizationResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "google_auth_cancelled"
        | "google_auth_timed_out"
        | "gog_auth_add_failed";
    };

export interface NautiloGogAuthorizationArgs {
  bin: string;
  email: string;
  services: string;
  onAuthorized: () => Promise<void>;
}

export interface NautiloGogAuthorizationDeps {
  execFileAsync: ExecFileAsync;
  openExternal: (url: string) => Promise<void>;
  callbackTimeoutMs?: number;
}

type PendingCallback = {
  callbackUrl: string;
  response: ServerResponse;
};

class CallbackFailure extends Error {
  constructor(
    readonly reason: "google_auth_cancelled" | "google_auth_timed_out" | "gog_auth_add_failed",
  ) {
    super(reason);
    this.name = "CallbackFailure";
  }
}

function page(title: string, heading: string, detail: string, tone: "success" | "error"): string {
  const accent = tone === "success" ? "#26734d" : "#a54432";
  const icon = tone === "success" ? "✓" : "!";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f3ef; color: #292521; }
      main { width: min(34rem, calc(100vw - 3rem)); padding: 2.5rem; border: 1px solid #d7d0c8; border-radius: 1rem; background: #fffdfa; box-shadow: 0 1rem 3rem rgb(48 39 31 / 10%); text-align: center; }
      .mark { width: 3rem; height: 3rem; margin: 0 auto 1.25rem; display: grid; place-items: center; border-radius: 999px; background: ${accent}; color: white; font-size: 1.5rem; font-weight: 700; }
      h1 { margin: 0; font-size: 1.6rem; }
      p { margin: .75rem 0 1.75rem; color: #68615a; line-height: 1.55; }
      a { display: inline-block; padding: .75rem 1rem; border-radius: .6rem; background: #2c2926; color: white; font-weight: 650; text-decoration: none; }
      small { display: block; margin-top: 1rem; color: #827a73; }
      @media (prefers-color-scheme: dark) {
        body { background: #171820; color: #f1eee9; }
        main { background: #20222d; border-color: #3b3e4d; box-shadow: none; }
        p, small { color: #b9b5af; }
        a { background: #f1eee9; color: #24211f; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="mark" aria-hidden="true">${icon}</div>
      <h1>${heading}</h1>
      <p>${detail}</p>
      <a href="nautilo://account">Return to Nautilo</a>
      <small>You can close this tab.</small>
    </main>
  </body>
</html>`;
}

const SUCCESS_PAGE = page(
  "Google account connected",
  "Google account connected",
  "Your Google account is ready to use in Nautilo.",
  "success",
);

const CANCELLED_PAGE = page(
  "Google connection cancelled",
  "Google connection cancelled",
  "Nothing was changed. Return to Nautilo when you are ready to try again.",
  "error",
);

const FAILURE_PAGE = page(
  "Google account not connected",
  "Google account not connected",
  "Nautilo could not finish the connection. Return to Nautilo and try again.",
  "error",
);

function sendHtml(response: ServerResponse, statusCode: number, html: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(html);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function parseAuthUrl(stdout: string, expectedRedirectUri: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { auth_url?: unknown };
    if (typeof parsed.auth_url !== "string") return null;
    const url = new URL(parsed.auth_url);
    if (url.protocol !== "https:" || url.hostname !== "accounts.google.com") return null;
    if (url.searchParams.get("redirect_uri") !== expectedRedirectUri) return null;
    if (!url.searchParams.get("state") || !url.searchParams.get("code_challenge")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function listenOnLoopback(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("loopback_address_unavailable"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/oauth2/callback`);
    });
  });
}

/**
 * Complete Google OAuth without exposing gog's terminal-oriented callback UI.
 * gog step 2 remains the authority for state/PKCE validation and token storage.
 */
export async function runNautiloGogAuthorization(
  args: NautiloGogAuthorizationArgs,
  deps: NautiloGogAuthorizationDeps,
): Promise<NautiloGogAuthorizationResult> {
  let settleCallback: ((callback: PendingCallback) => void) | null = null;
  let rejectCallback: ((error: Error) => void) | null = null;
  let callbackSettled = false;

  const callbackPromise = new Promise<PendingCallback>((resolve, reject) => {
    settleCallback = resolve;
    rejectCallback = reject;
  });

  let redirectUri = "";
  const server = createServer((request, response) => {
    if (request.method !== "GET" || !request.url || !redirectUri) {
      response.writeHead(404).end();
      return;
    }

    let callback: URL;
    try {
      callback = new URL(request.url, redirectUri);
    } catch {
      response.writeHead(400).end();
      return;
    }

    if (
      callback.origin !== new URL(redirectUri).origin
      || callback.pathname !== "/oauth2/callback"
    ) {
      response.writeHead(404).end();
      return;
    }
    if (callbackSettled) {
      response.writeHead(409).end();
      return;
    }
    callbackSettled = true;

    if (callback.searchParams.has("error")) {
      sendHtml(response, 200, CANCELLED_PAGE);
      rejectCallback?.(new CallbackFailure("google_auth_cancelled"));
      return;
    }

    if (!callback.searchParams.get("code") || !callback.searchParams.get("state")) {
      sendHtml(response, 400, FAILURE_PAGE);
      rejectCallback?.(new CallbackFailure("gog_auth_add_failed"));
      return;
    }

    settleCallback?.({ callbackUrl: callback.toString(), response });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;

  let pendingResponse: ServerResponse | null = null;
  const timeoutMs = deps.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    redirectUri = await listenOnLoopback(server);
    const commonArgs = [
      "auth",
      "add",
      args.email,
      "--services",
      args.services,
      "--force-consent",
      "--remote",
      "--redirect-uri",
      redirectUri,
      "--json",
      "--no-input",
    ] as const;

    const stepOne = await deps.execFileAsync(
      args.bin,
      [...commonArgs, "--step", "1"],
      { timeout: GOG_COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const authUrl = parseAuthUrl(stepOne.stdout, redirectUri);
    if (!authUrl) throw new CallbackFailure("gog_auth_add_failed");

    await deps.openExternal(authUrl);
    const timedCallback = Promise.race([
      callbackPromise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new CallbackFailure("google_auth_timed_out")),
          timeoutMs,
        );
      }),
    ]);
    const callback = await timedCallback;
    pendingResponse = callback.response;

    await deps.execFileAsync(
      args.bin,
      [...commonArgs, "--step", "2", "--auth-url", callback.callbackUrl],
      { timeout: GOG_COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    await args.onAuthorized();
    sendHtml(callback.response, 200, SUCCESS_PAGE);
    return { ok: true };
  } catch (error) {
    if (pendingResponse) sendHtml(pendingResponse, 500, FAILURE_PAGE);
    if (error instanceof CallbackFailure) return { ok: false, reason: error.reason };
    return { ok: false, reason: "gog_auth_add_failed" };
  } finally {
    if (timeout) clearTimeout(timeout);
    await closeServer(server);
  }
}
