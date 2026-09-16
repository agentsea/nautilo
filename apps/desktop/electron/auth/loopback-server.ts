/**
 * M055 — one-shot HTTP server for the OIDC loopback redirect
 * (RFC 8252 §7.3).
 *
 * Critical security invariant: binds **only** to `127.0.0.1`. Binding
 * to `0.0.0.0` would expose the captured authorization code to anyone
 * on the local network — they could race the legitimate exchange and
 * mint tokens. The unit test exercises the bind address directly.
 *
 * Pure node:http; no Electron dependencies. Safe to unit-test by
 * actually starting the server on a random port.
 */
import { createServer, type Server } from "node:http";

export interface LoopbackResult {
  code: string;
  state: string;
}

export interface LoopbackHandle {
  /** OS-assigned ephemeral port. */
  port: number;
  /**
   * Bound IP address (always `127.0.0.1` — exposed for tests to
   * assert the security invariant directly).
   */
  address: string;
  /**
   * Resolves with the captured `code` + `state` on the first
   * `/callback` hit; rejects on `?error=...` callbacks, missing
   * params, or the 5-minute timeout.
   */
  awaitCallback: Promise<LoopbackResult>;
  shutdown: () => void;
}

export interface StartLoopbackOptions {
  /** Override for tests; defaults to 5 minutes. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Signed in</title>
<style>body { font-family: system-ui; text-align: center; padding: 4em; }</style></head>
<body><h1>\u2713 Signed in to Nautilo</h1><p>You can close this tab.</p></body></html>`;

export async function startLoopbackServer(
  options: StartLoopbackOptions = {},
): Promise<LoopbackHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let resolve!: (r: LoopbackResult) => void;
  let reject!: (e: Error) => void;
  const awaitCallback = new Promise<LoopbackResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });

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
      reply.end(
        `<h1>Sign-in failed</h1><p>${escapeHtml(error)}</p>`,
      );
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
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Loopback server failed to bind");
  }
  const port = address.port;
  const boundAddress = address.address;

  const timer = setTimeout(() => {
    reject(new Error(`Loopback callback timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  awaitCallback
    .finally(() => {
      clearTimeout(timer);
      server.close();
    })
    .catch(() => {
      /* swallow — handled by the awaiting caller */
    });

  return {
    port,
    address: boundAddress,
    awaitCallback,
    shutdown: () => {
      clearTimeout(timer);
      server.close();
      // Settle awaitCallback if it's still pending so callers
      // awaiting it (or `.catch`-ing for cleanup) don't hang
      // after explicit shutdown.
      reject(new Error("Loopback server shut down"));
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
