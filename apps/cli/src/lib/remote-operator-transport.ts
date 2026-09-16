import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  buildContainerBunFetchArgs,
  buildSshArgs,
  shellQuote,
  type SshProfile,
} from "@nautilo/compose-driver";
import type { ResolvedInstance } from "@nautilo/config";

/**
 * D427 (Wave 3 task 3.1.1) — SSH-local operator transport for remote
 * maintenance / readiness calls.
 *
 * Instead of driving the privileged operator endpoints over PUBLIC DNS plus a
 * copied bootstrap bearer, remote maintenance/readiness calls now execute
 * against LOOPBACK on the deployment target through SSH authority:
 *
 *   - the base URL is `http://127.0.0.1:3001` inside the server container, and
 *   - the fetch is implemented by `ssh <target> -- docker exec <server> bun
 *     ... http://127.0.0.1:3001`, so the server sees a loopback caller and
 *     trusts it WITHOUT a bearer.
 *
 * This preserves the explicit authorization boundary (you must hold SSH
 * access to the target; the server's `requestAllowsPrivilegedSetup` loopback
 * bar is unchanged) and removes the public-DNS + laptop-bearer drift vector:
 * stale local DNS, `/etc/hosts`, public Caddy routing, and laptop token drift
 * can no longer direct an upgrade at a different host, because the call never
 * touches public DNS or the bearer file. Remote SSH/Docker authority is NOT
 * weakened — the operator still reaches the target exclusively over SSH.
 */

export interface SshLocalFetchOptions {
  ssh: SshProfile;
  /** Compose project used to resolve the running server container by labels. */
  composeProjectName: string;
  /** Injectable spawn for tests. Default uses node:child_process.spawn. */
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  /** Injectable logger (stderr). */
  log?: (msg: string) => void;
}

/**
 * Call-signature of the fetch-style function the operator maintenance /
 * readiness clients need. Narrower than `typeof fetch` (which also carries
 * Node-specific `preconnect` etc.) so the SSH-local implementation only has
 * to implement the call, not the whole global fetch surface.
 */
export type OperatorFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Local Docker authority reaches the same container-loopback operator boundary
 * as SSH. Published ports cannot use bootstrap credentials after owner binding.
 * Resolve the container on every call so upgrade replacement is respected.
 */
export function buildLocalContainerFetch(
  opts: Omit<SshLocalFetchOptions, "ssh">,
): OperatorFetch {
  const spawnFn = opts.spawnFn ?? spawn;
  return async (input, init) => {
    // Preserve the caller's cancellation policy across discovery and execution.
    // The transport does not invent a separate deadline for operator actions.
    const signal = init?.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const url = extractUrl(input);
    const target = new URL(url);
    if (target.origin !== "http://127.0.0.1:3001" ||
      !target.pathname.startsWith("/api/operator/") ||
      target.username || target.password || target.search || target.hash) {
      throw new TypeError("local-container fetch requires a container-loopback operator URL");
    }
    const body = bodyToString(init?.body);
    const discovery = spawnFn("docker", [
      "ps", "-q", "--filter", `label=com.docker.compose.project=${opts.composeProjectName}`,
      "--filter", "label=com.docker.compose.service=nautilo-server",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    discovery.stdin?.end();
    const found = await collectLocalOperatorChild(discovery, signal);
    const ids = found.stdout.trim().split(/\s+/).filter(Boolean);
    if (found.code !== 0 || ids.length !== 1 || !/^[a-f0-9]+$/i.test(ids[0]!)) {
      throw new TypeError("local-container fetch could not resolve exactly one running nautilo-server container");
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      if (key !== "authorization") headers[key] = value;
    });
    const method = (init?.method ?? "GET").toUpperCase();
    const probeArgs = buildContainerBunFetchArgs({ url, method, headers, hasBody: body !== undefined });
    opts.log?.(`local-container: ${method} ${target.pathname}`);
    signal.throwIfAborted();
    const child = spawnFn("docker", ["exec", "-i", ids[0]!, ...probeArgs], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (body !== undefined) child.stdin?.write(body);
    child.stdin?.end();
    const result = await collectLocalOperatorChild(child, signal);
    const trailer = result.stdout.lastIndexOf("\n");
    const status = Number(result.stdout.slice(trailer + 1).trim());
    if (result.code !== 0 || trailer < 0 || !Number.isInteger(status) || status < 200 || status > 599) {
      throw new TypeError("local-container operator probe failed or returned an invalid HTTP status");
    }
    const responseBody = result.stdout.slice(0, trailer);
    return new Response([204, 205, 304].includes(status) ? null : responseBody, { status });
  };
}

function collectLocalOperatorChild(child: ChildProcess, signal: AbortSignal): Promise<{
  stdout: string; stderr: string; code: number;
}> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, code = 1) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else resolve({ stdout, stderr, code });
    };
    const abort = () => finish(new Error("local-container operator probe aborted or timed out"));
    const append = (chunk: Buffer, isError: boolean) => {
      if (settled) return;
      if (isError) stderr += chunk.toString("utf8");
      else stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => append(chunk, false));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, true));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(undefined, code ?? 1));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/**
 * Loopback base URL inside the target's `nautilo-server` container. Remote
 * Compose deployments do not publish server port 3001 on the droplet host;
 * the SSH-local transport resolves the container by Compose labels and runs
 * the request through `docker exec`.
 */
export function resolveRemoteLoopbackBaseUrl(
  ssh: SshProfile,
  _inst?: ResolvedInstance,
): string {
  if (ssh.host === undefined) {
    throw new Error(
      "resolveRemoteLoopbackBaseUrl: remote profile is missing ssh.host",
    );
  }
  return `http://127.0.0.1:3001`;
}

function extractUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function bodyToString(body: RequestInit["body"] | undefined): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(
      body instanceof Uint8Array ? body : new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
  }
  // FormData / URLSearchParams / ReadableStream are not used by the operator
  // maintenance client (it only sends JSON strings). Fail closed rather than
  // silently encoding something the operator protocol never sends.
  throw new TypeError("ssh-local fetch: unsupported body type (expected a string)");
}

/**
 * Build a fetch-compatible function that executes HTTP requests against
 * loopback on the target via the Bun runtime guaranteed in nautilo-server.
 * The returned Response carries only `status` + the body (the operator
 * maintenance / readiness clients read no response headers). A non-zero
 * SSH/container-probe exit or a missing status trailer throws so the caller's
 * fail-closed path maps it to a network error.
 */
export function buildSshLocalFetch(opts: SshLocalFetchOptions): OperatorFetch {
  const spawnFn =
    opts.spawnFn ??
    ((cmd: string, args: string[], so: SpawnOptions) => spawn(cmd, args, so));
  const log = opts.log ?? (() => undefined);

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = extractUrl(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = bodyToString(init?.body);
    const hasBody = body !== undefined;

    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      for (const [k, v] of h.entries()) headers[k] = v;
    }
    const probeArgs = buildContainerBunFetchArgs({ url, method, headers, hasBody });

    const projectFilter = `label=com.docker.compose.project=${opts.composeProjectName}`;
    const serviceFilter = "label=com.docker.compose.service=nautilo-server";
    const remoteScript = [
      `container="$(docker ps -q --filter ${shellQuote(projectFilter)} --filter ${shellQuote(serviceFilter)})"`,
      '[ -n "$container" ] || { echo "nautilo-server container not found" >&2; exit 2; }',
      `exec docker exec -i "$container" ${probeArgs.map(shellQuote).join(" ")}`,
    ].join("; ");
    const sshArgs = buildSshArgs(opts.ssh, "sh", ["-lc", remoteScript]);
    log(`ssh-local: ${method} ${url} (via ${opts.ssh.user}@${opts.ssh.host}:${opts.ssh.port ?? 22})`);

    const child = spawnFn("ssh", sshArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (hasBody) {
      child.stdin?.write(body);
    }
    child.stdin?.end();

    const { stdout, stderr, code } = await collectChild(child);

    // The container Bun probe appends a trailing newline + status after the
    // body. The status is the LAST line; the body is everything before it.
    // A non-zero exit or missing trailer fails closed as a network error.
    const trailerNl = stdout.lastIndexOf("\n");
    if (code !== 0 || trailerNl === -1) {
      const detail = stderr.trim() || `ssh/container probe exited ${code}`;
      throw new TypeError(`ssh-local fetch to ${url} failed: ${detail}`);
    }
    const statusStr = stdout.slice(trailerNl + 1).trim();
    const responseBody = stdout.slice(0, trailerNl);
    const status = Number(statusStr);
    if (!Number.isSafeInteger(status) || status <= 0) {
      throw new TypeError(`ssh-local fetch to ${url}: unparseable status '${statusStr}'`);
    }
    return new Response(responseBody, { status });
  };
}

function collectChild(child: ChildProcess): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ stdout, stderr: stderr + String(err), code: 1 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}
