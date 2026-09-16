import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { buildSshArgs, shellQuote } from "./remote-exec.ts";
import { buildContainerBunFetchArgs } from "./container-bun-fetch.ts";
import type { SshProfile } from "./types.ts";

// D427 (Wave 4 task 4.x) — remote runtime-acceptance + health-poll transport.
//
// The shared runtime-acceptance gate (`runRuntimeAcceptance` in @nautilo/db)
// and the ComposeDriver deploy/restore/releaseApply health polls historically
// reached a remote target through `globalThis.fetch` on the operator's PUBLIC
// DNS resolution of the profile's public URL. On a split-DNS upgrade (v1 live
// at 192.0.2.40, public DNS pointing v2 at 198.51.100.40) that fetch
// hits v2, so a v1 deploy/rollback can falsely fail OR falsely validate
// against the wrong host's `/health`, `/api/setup/status`, SPA, and OIDC
// discovery — the same false-result vector the Wave 3.1.1 ssh-local operator
// transport removed for maintenance/readiness calls.
//
// This module is the runtime-acceptance analogue: it routes the gate's HTTP
// through SSH authority on the deployment target, never the operator's public
// DNS. URL classes map to three deliberate transports:
//
//   1. `/health` and `/api/setup/status` — the server's host port 3001 is NOT
//      published on the droplet, so these run as `ssh <target> -- docker exec
//      <nautilo-server> bun -e <fetch> http://127.0.0.1:3001<path>`. The
//      server sees a loopback caller (its container loopback), exactly the
//      ssh-local operator transport relies on. The public URL's host is
//      ignored — only its path is replayed against loopback — so public DNS
//      cannot redirect the call at a different host.
//   2. SPA and Logto OIDC public-vhost checks over HTTPS (LetsEncrypt mode) —
//      `ssh <target> -- curl --resolve <hostname>:443:127.0.0.1 -k
//      https://<hostname><path>`. This exercises the TARGET Caddy with the
//      correct hostname/SNI while connecting to loopback, so the cert +
//      vhost routing belong to the target, not whatever public DNS resolves
//      to. `-k` is used because the cert is presented over a loopback
//      connection; the hostname match is what we are proving.
//   3. Non-LE / LAN `http://` URLs — `ssh <target> -- curl <url>` run ON the
//      remote host, so the request uses the target's network, not the
//      operator's. This still avoids the operator-host network vector
//      without depending on a published 3001.
//
// Trailer parsing and error handling fail closed exactly like the existing
// ssh-local operator fetch (`buildSshLocalFetch`): a non-zero ssh/probe exit
// or a missing/unparseable status trailer throws a TypeError so the gate
// maps it to a network error rather than a silent false green.

/** Minimal fetch-style response the acceptance gate reads (`ok`, `status`, `text()`). */
export interface RemoteRuntimeAcceptanceResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** Transport the ComposeDriver wires for remote-profile acceptance + health polls. */
export interface RemoteRuntimeAcceptanceTransport {
  fetch(url: string): Promise<RemoteRuntimeAcceptanceResponse>;
  pollHealth(serverBaseUrl: string): Promise<void>;
}

export type RemoteRuntimeFetchSpawn = (
  cmd: string,
  args: string[],
  opts: SpawnOptions,
) => ChildProcess;

export interface RemoteRuntimeAcceptanceTransportOptions {
  ssh: SshProfile;
  /** Compose project used to resolve the running server container by labels. */
  composeProjectName: string;
  /** Injectable spawn for tests. Default uses node:child_process.spawn. */
  spawnFn?: RemoteRuntimeFetchSpawn;
  /** Injectable logger (stderr). */
  log?: (msg: string) => void;
  /** Server /health poll deadline (ms). Default 120s — mirrors ComposeDriver. */
  serverHealthTimeoutMs?: number;
  /** /health poll interval (ms). Default 1000 — mirrors ComposeDriver. */
  pollIntervalMs?: number;
}

/** Loopback base URL inside the target's `nautilo-server` container. */
export const REMOTE_SERVER_LOOPBACK_BASE_URL = "http://127.0.0.1:3001";

/** Paths served by nautilo-server that must be probed over container loopback. */
function isLoopbackServerPath(pathname: string): boolean {
  return pathname === "/health" || pathname.startsWith("/api/setup/status");
}

/**
 * Build the remote runtime-acceptance + health-poll transport. The returned
 * `fetch` classifies each URL into loopback-docker-exec / HTTPS-vhost-resolve
 * / HTTP-direct and runs it through SSH authority on the target. The returned
 * `pollHealth` polls `${serverBaseUrl}/health` via the same fetch (which
 * routes `/health` to container loopback) until ok or the deadline, throwing
 * the canonical "never became ready" error on timeout.
 */
export function buildRemoteRuntimeAcceptanceTransport(
  opts: RemoteRuntimeAcceptanceTransportOptions,
): RemoteRuntimeAcceptanceTransport {
  const spawnFn =
    opts.spawnFn ??
    ((cmd: string, args: string[], so: SpawnOptions) => spawn(cmd, args, so));
  const log = opts.log ?? (() => undefined);
  const serverHealthTimeoutMs = opts.serverHealthTimeoutMs ?? 120_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;

  const fetch = async (url: string): Promise<RemoteRuntimeAcceptanceResponse> => {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;

    if (isLoopbackServerPath(parsed.pathname)) {
      const loopbackUrl = `${REMOTE_SERVER_LOOPBACK_BASE_URL}${path}`;
      log(
        `remote-acceptance: loopback ${parsed.pathname} via ${opts.ssh.user}@${opts.ssh.host}:${opts.ssh.port ?? 22}`,
      );
      return runContainerLoopback(spawnFn, opts.ssh, opts.composeProjectName, loopbackUrl);
    }

    if (parsed.protocol === "https:") {
      const hostname = parsed.hostname;
      log(
        `remote-acceptance: https vhost ${hostname} via ${opts.ssh.user}@${opts.ssh.host}:${opts.ssh.port ?? 22}`,
      );
      return runCurlHost(
        spawnFn,
        opts.ssh,
        ["--resolve", `${hostname}:443:127.0.0.1`, "-k", url],
      );
    }

    log(
      `remote-acceptance: http direct ${url} via ${opts.ssh.user}@${opts.ssh.host}:${opts.ssh.port ?? 22}`,
    );
    return runCurlHost(spawnFn, opts.ssh, [url]);
  };

  const pollHealth = async (serverBaseUrl: string): Promise<void> => {
    const url = `${serverBaseUrl}/health`;
    const deadline = Date.now() + serverHealthTimeoutMs;
    let lastErr: unknown;
    while (true) {
      try {
        const res = await fetch(url);
        if (res.ok) return;
        lastErr = `HTTP ${res.status}`;
      } catch (err) {
        lastErr = err;
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new Error(
      `nautilo-server /health never became ready within ${serverHealthTimeoutMs}ms (${url}): ${String(lastErr)}`,
    );
  };

  return { fetch, pollHealth };
}

/** curl arg stem shared by all three transports: body to stdout + status trailer. */
const CURL_TRAILER_ARGS = ["-sS", "--no-buffer", "-o", "-", "-w", "\n%{http_code}"];

/**
 * Run curl ON the remote host (no container exec). Used for HTTPS vhost
 * (`--resolve ... -k`) and LAN HTTP direct. The URL is the last arg.
 */
function runCurlHost(
  spawnFn: RemoteRuntimeFetchSpawn,
  ssh: SshProfile,
  trailingArgs: string[],
): Promise<RemoteRuntimeAcceptanceResponse> {
  const curlArgs = [...CURL_TRAILER_ARGS, ...trailingArgs];
  const sshArgs = buildSshArgs(ssh, "curl", curlArgs);
  return collectHttpProbe(spawnFn, sshArgs, trailingArgs[trailingArgs.length - 1] ?? "");
}

/**
 * Run curl INSIDE the target's nautilo-server container over loopback, via
 * `ssh <target> -- docker exec`. The server container is resolved by Compose
 * labels (project + service); a missing container fails closed with exit 2.
 */
function runContainerLoopback(
  spawnFn: RemoteRuntimeFetchSpawn,
  ssh: SshProfile,
  composeProjectName: string,
  loopbackUrl: string,
): Promise<RemoteRuntimeAcceptanceResponse> {
  const projectFilter = `label=com.docker.compose.project=${composeProjectName}`;
  const serviceFilter = "label=com.docker.compose.service=nautilo-server";
  const probeCmd = buildContainerBunFetchArgs({ url: loopbackUrl })
    .map(shellQuote)
    .join(" ");
  const remoteScript = [
    `container="$(docker ps -q --filter ${shellQuote(projectFilter)} --filter ${shellQuote(serviceFilter)})"`,
    '[ -n "$container" ] || { echo "nautilo-server container not found" >&2; exit 2; }',
    `exec docker exec -i "$container" ${probeCmd}`,
  ].join("; ");
  const sshArgs = buildSshArgs(ssh, "sh", ["-lc", remoteScript]);
  return collectHttpProbe(spawnFn, sshArgs, loopbackUrl);
}

/** Spawn SSH, collect stdout/stderr, parse the numeric status trailer, and fail closed. */
function collectHttpProbe(
  spawnFn: RemoteRuntimeFetchSpawn,
  sshArgs: string[],
  url: string,
): Promise<RemoteRuntimeAcceptanceResponse> {
  const child = spawnFn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise<RemoteRuntimeAcceptanceResponse>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      reject(new TypeError(`remote-acceptance fetch to ${url} failed: ${stderr}${String(err)}`));
    });
    child.on("close", (code) => {
      const exit = code ?? 0;
      // Both the host curl and container Bun probe append a trailing newline
      // plus status. The status is the LAST line; the body is everything
      // before it. A non-zero exit with no trailer fails closed.
      const trailerNl = stdout.lastIndexOf("\n");
      if (exit !== 0 || trailerNl === -1) {
        const detail = stderr.trim() || `ssh/http probe exited ${exit}`;
        reject(new TypeError(`remote-acceptance fetch to ${url} failed: ${detail}`));
        return;
      }
      const statusStr = stdout.slice(trailerNl + 1).trim();
      const body = stdout.slice(0, trailerNl);
      const status = Number(statusStr);
      if (!Number.isSafeInteger(status) || status <= 0) {
        reject(
          new TypeError(`remote-acceptance fetch to ${url}: unparseable status '${statusStr}'`),
        );
        return;
      }
      resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(body),
      });
    });
  });
}
