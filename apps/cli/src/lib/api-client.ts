import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  resolveServerBaseUrl,
  type ComposeDriverProfile,
} from "@nautilo/compose-driver";
import type { ResolvedInstance } from "@nautilo/config";
import type { MaintenanceOperatorStatus } from "@nautilo/types";
import { readBootstrapToken } from "./bootstrap-tokens.ts";
import type { Profile } from "./profile-schema.ts";
import type { OperatorFetch } from "./remote-operator-transport.ts";

export type { Profile } from "./profile-schema.ts";

export type ResolvedTransport = {
  baseUrl: string;
  bearer?: string;
  /** When set, Bun `fetch` accepts `{ unix: unixSocketPath }` with `http://localhost/...`. */
  unixSocketPath?: string;
};

export function profilesRootDir(home?: string): string {
  const h = home ?? process.env["HOME"] ?? "";
  return join(h, ".nautilo", "profiles");
}

function missingBootstrapTokenMessage(profileName: string, home: string): string {
  const legacy = join(home, ".nautilo", "profiles", `${profileName}.env`);
  const legacyHint = existsSync(legacy)
    ? ` A legacy ${legacy} was detected — run \`nautilo doctor migrate-config\` to extract the token and archive the legacy file.`
    : "";
  return (
    `profile ${profileName} has no NAUTILO_BOOTSTRAP_TOKEN at ~/.nautilo/bootstrap-tokens/${profileName}. ` +
    `This credential is only required by first-install setup API commands; normal remote Compose ` +
    `lifecycle commands use SSH and do not require it. Do not copy it from a running host.${legacyHint}`
  );
}

/**
 * Resolve the per-profile Nautilo state root.
 *   instance_id ""  → ~/.nautilo            (shared default)
 *   instance_id "x" → ~/.nautilo-x          (named instance)
 *
 * Mirrors `resolveNautiloRootDir` in `@nautilo/config` but kept local
 * to avoid pulling the whole config package into the CLI's transport
 * resolver (which must stay sync + tiny).
 */
function instanceRootDir(home: string, instanceId: string | undefined): string {
  const id = (instanceId ?? "").trim();
  const suffix = id === "" ? "" : `-${id}`;
  return join(home, `.nautilo${suffix}`);
}

/**
 * Read the per-instance server URL out of `~/.nautilo${suffix}/instance.json`.
 * Returns `undefined` if the file is missing / malformed — caller falls
 * back to whatever default the profile shape provides.
 *
 * Only `server.port` (+ optional `server.url`) is consulted; we don't
 * validate the rest of the bundle here.
 */
/** Read `server.url` (or derive from `server.port`) from an instance bundle. */
export function readInstanceServerUrl(rootDir: string): string | undefined {
  const path = join(rootDir, "instance.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      server?: { url?: unknown; port?: unknown };
    };
    const url = raw.server?.url;
    if (typeof url === "string" && url.trim() !== "") return url.trim();
    const port = raw.server?.port;
    if (typeof port === "number" && Number.isFinite(port) && port > 0) {
      return `http://127.0.0.1:${port}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Read just the `server.port` from an instance bundle. */
function readInstanceServerPort(rootDir: string): number | undefined {
  const path = join(rootDir, "instance.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      server?: { port?: unknown };
    };
    const port = raw.server?.port;
    if (typeof port === "number" && Number.isFinite(port) && port > 0) {
      return port;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an endpoint without loading authentication material.
 *
 * Descriptive commands such as `profile current` must be able to inspect a
 * day-two remote Compose profile from an independent SSH operator, which
 * intentionally has no local bootstrap token (M207).
 */
export function resolveTransportEndpoint(
  profile: Profile,
  home?: string,
): Promise<ResolvedTransport> {
  const h = home ?? process.env["HOME"] ?? "";
  if (profile.transport === "local") {
    // M092 — compose-lifecycle profiles run inside Docker. The server
    // listens on a TCP port chosen at first-deploy (recorded in
    // `~/.nautilo${suffix}/instance.json`). Honor the suffixed root +
    // instance.json port; never probe a Unix socket because the
    // containerized server doesn't expose one to the host.
    if (profile.lifecycle === "compose") {
      const instanceRoot = instanceRootDir(h, profile.instance_id);
      const url = readInstanceServerUrl(instanceRoot);
      if (url) return Promise.resolve({ baseUrl: url });
      throw new Error(
        `profile ${profile.name}: no instance.json at ${instanceRoot}/instance.json. Run \`nautilo deploy --profile ${profile.name}\` first to provision the instance.`,
      );
    }
    // Legacy `lifecycle=external` path: Bun-on-host server, may expose
    // a Unix socket via the suffixed root, falls back to profile port
    // or the long-standing 3201 default.
    const instanceRoot = instanceRootDir(h, profile.instance_id);
    const socket = join(instanceRoot, "server.sock");
    if (existsSync(socket)) {
      return Promise.resolve({
        baseUrl: "http://localhost",
        unixSocketPath: socket,
      });
    }
    return Promise.resolve({
      baseUrl: `http://127.0.0.1:${profile.port ?? 3201}`,
    });
  }

  if (profile.lifecycle === "compose") {
    const instanceRoot = instanceRootDir(h, profile.instance_id);
    const port = readInstanceServerPort(instanceRoot);
    if (profile.transport === "remote" && port === undefined) {
      const explicit = profile.base_url?.trim();
      const domain = profile.domain?.trim();
      const usesLetsencryptDomain =
        (profile.https ?? "off") === "letsencrypt" &&
        domain !== undefined &&
        domain.length > 0;
      if (!explicit && !usesLetsencryptDomain) {
        throw new Error(
          `profile ${profile.name}: no base_url in profile and no instance.json at ${instanceRoot}/instance.json. Run \`nautilo deploy --profile ${profile.name}\` first to provision the instance.`,
        );
      }
    }
    const baseUrl = resolveServerBaseUrl(
      profile as ComposeDriverProfile,
      { server: { port: port ?? 0 } } as ResolvedInstance,
    );
    return Promise.resolve({ baseUrl });
  }

  const domain = profile.domain?.trim();
  if (!domain) {
    throw new Error(`profile ${profile.name} is missing domain (required for remote transport)`);
  }
  return Promise.resolve({ baseUrl: `https://${domain}` });
}

/** Resolve an endpoint plus the bootstrap bearer required by setup API calls. */
export async function resolveTransport(
  profile: Profile,
  home?: string,
): Promise<ResolvedTransport> {
  const endpoint = await resolveTransportEndpoint(profile, home);
  if (profile.transport === "local") return endpoint;

  const h = home ?? process.env["HOME"] ?? "";
  const bearer = readBootstrapToken(profile.name, { home: h });
  if (!bearer) {
    throw new Error(missingBootstrapTokenMessage(profile.name, h));
  }
  return { ...endpoint, bearer };
}

export function withUnixSocket(
  transport: ResolvedTransport,
  init?: RequestInit,
): RequestInit {
  if (!transport.unixSocketPath) {
    return init ?? {};
  }
  return { ...init, unix: transport.unixSocketPath } as RequestInit;
}

// ---------------------------------------------------------------------------
// D420 (Wave 2 task 2.2.2) — operator maintenance drain client.
//
// Thin HTTP client for the privileged operator maintenance endpoints
// (enter/status/renew/applying/cancel/complete). It uses the SAME transport
// resolution as the rest of the CLI (`resolveTransport`: loopback for local
// compose, bootstrap bearer for remote) and parses responses STRICTLY: a
// network failure, a 403, a non-2xx, or a malformed/missing-field body all
// throw a typed {@link MaintenanceApiError} so the drain orchestrator can
// fail closed (abort/clear the lease and surface a no-mutation error). It
// never returns prompt, room, lane, job, or user payload — only the payload-
// free {@link MaintenanceOperatorStatus}.
// ---------------------------------------------------------------------------

export type MaintenanceApiErrorKind =
  | "network"
  | "auth"
  | "http"
  | "malformed"
  | "transition";

export class MaintenanceApiError extends Error {
  readonly kind: MaintenanceApiErrorKind;
  readonly status: number;
  readonly transitionCode?: string;
  constructor(
    kind: MaintenanceApiErrorKind,
    message: string,
    opts: { status?: number; transitionCode?: string } = {},
  ) {
    super(message);
    this.name = "MaintenanceApiError";
    this.kind = kind;
    this.status = opts.status ?? 0;
    if (opts.transitionCode !== undefined) this.transitionCode = opts.transitionCode;
  }
}

const MAINTENANCE_STATES = new Set(["normal", "draining", "applying"]);

function isCounts(value: unknown): value is {
  runningForegroundJobs: number;
  runningBackgroundJobs: number;
  queuedTurns: number;
  bufferedLanes: number;
  acceptedWork: number;
  runningTaskRuns: number;
  claimedTasks: number;
} {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["runningForegroundJobs"] === "number" &&
    typeof v["runningBackgroundJobs"] === "number" &&
    typeof v["queuedTurns"] === "number" &&
    typeof v["bufferedLanes"] === "number" &&
    typeof v["acceptedWork"] === "number" &&
    typeof v["runningTaskRuns"] === "number" &&
    typeof v["claimedTasks"] === "number" &&
    Number.isSafeInteger(v["runningForegroundJobs"]) &&
    Number.isSafeInteger(v["runningBackgroundJobs"]) &&
    Number.isSafeInteger(v["queuedTurns"]) &&
    Number.isSafeInteger(v["bufferedLanes"]) &&
    Number.isSafeInteger(v["acceptedWork"]) &&
    Number.isSafeInteger(v["runningTaskRuns"]) &&
    Number.isSafeInteger(v["claimedTasks"]) &&
    v["runningForegroundJobs"] >= 0 &&
    v["runningBackgroundJobs"] >= 0 &&
    v["queuedTurns"] >= 0 &&
    v["bufferedLanes"] >= 0 &&
    v["acceptedWork"] >= 0 &&
    v["runningTaskRuns"] >= 0 &&
    v["claimedTasks"] >= 0
  );
}

/**
 * Validate and narrow a parsed JSON body to {@link MaintenanceOperatorStatus}.
 * Throws {@link MaintenanceApiError} (kind `malformed`) on any shape/field
 * violation so callers fail closed instead of acting on a partial response.
 */
export function parseMaintenanceStatus(
  body: unknown,
  context: string,
): MaintenanceOperatorStatus {
  if (body === null || typeof body !== "object") {
    throw new MaintenanceApiError("malformed", `${context}: response body is not an object`);
  }
  const v = body as Record<string, unknown>;
  const state = v["state"];
  if (typeof state !== "string" || !MAINTENANCE_STATES.has(state)) {
    throw new MaintenanceApiError("malformed", `${context}: missing or invalid state`);
  }
  const operationId = v["operationId"];
  if (operationId !== null && typeof operationId !== "string") {
    throw new MaintenanceApiError("malformed", `${context}: invalid operationId`);
  }
  const leaseExpiresAt = v["leaseExpiresAt"];
  if (leaseExpiresAt !== null && typeof leaseExpiresAt !== "string") {
    throw new MaintenanceApiError("malformed", `${context}: invalid leaseExpiresAt`);
  }
  const hardExpiresAt = v["hardExpiresAt"];
  if (hardExpiresAt !== null && typeof hardExpiresAt !== "string") {
    throw new MaintenanceApiError("malformed", `${context}: invalid hardExpiresAt`);
  }
  if (!isCounts(v["work"])) {
    throw new MaintenanceApiError("malformed", `${context}: missing or invalid work counts`);
  }
  return {
    state: state as MaintenanceOperatorStatus["state"],
    operationId: typeof operationId === "string" ? operationId : null,
    leaseExpiresAt: typeof leaseExpiresAt === "string" ? leaseExpiresAt : null,
    hardExpiresAt: typeof hardExpiresAt === "string" ? hardExpiresAt : null,
    work: v["work"],
  };
}

function buildHeaders(transport: ResolvedTransport, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (transport.bearer) headers["authorization"] = `Bearer ${transport.bearer}`;
  if (json) headers["content-type"] = "application/json";
  return headers;
}

async function callMaintenance(
  transport: ResolvedTransport,
  fetchFn: OperatorFetch,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  context: string,
): Promise<MaintenanceOperatorStatus> {
  const url = `${transport.baseUrl.replace(/\/+$/, "")}${path}`;
  const init: RequestInit = {
    method,
    headers: buildHeaders(transport, body !== undefined),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  let response: Response;
  try {
    response = await fetchFn(url, withUnixSocket(transport, init));
  } catch (error) {
    throw new MaintenanceApiError(
      "network",
      `${context}: operator endpoint unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 403) {
    throw new MaintenanceApiError(
      "auth",
      `${context}: operator endpoint refused authorization (HTTP 403).`,
      { status: 403 },
    );
  }
  if (response.status === 409) {
    let code: string | undefined;
    try {
      const parsed = (await response.json()) as { code?: unknown };
      if (typeof parsed["code"] === "string") code = parsed["code"];
    } catch {
      /* fall through with no code */
    }
    const transitionOpts: { status: number; transitionCode?: string } = { status: 409 };
    if (code !== undefined) transitionOpts.transitionCode = code;
    throw new MaintenanceApiError(
      "transition",
      `${context}: maintenance transition refused (HTTP 409${code ? `: ${code}` : ""}).`,
      transitionOpts,
    );
  }
  if (!response.ok) {
    throw new MaintenanceApiError(
      "http",
      `${context}: operator endpoint returned HTTP ${response.status}.`,
      { status: response.status },
    );
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new MaintenanceApiError(
      "malformed",
      `${context}: operator endpoint returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseMaintenanceStatus(parsed, context);
}

/** POST /api/operator/maintenance/enter — claim the drain lease. */
export function enterMaintenanceDrain(
  transport: ResolvedTransport,
  fetchFn: OperatorFetch,
  body?: { operationId?: string; leaseMs?: number; hardMs?: number },
): Promise<MaintenanceOperatorStatus> {
  return callMaintenance(transport, fetchFn, "POST", "/api/operator/maintenance/enter", body ?? {}, "maintenance enter");
}

/** GET /api/operator/maintenance/status — read state + aggregate counts. */
export function readMaintenanceStatus(
  transport: ResolvedTransport,
  fetchFn: OperatorFetch,
): Promise<MaintenanceOperatorStatus> {
  return callMaintenance(transport, fetchFn, "GET", "/api/operator/maintenance/status", undefined, "maintenance status");
}

/** POST /api/operator/maintenance/renew — renew the owning lease. */
export function renewMaintenanceLease(
  transport: ResolvedTransport,
  fetchFn: OperatorFetch,
  operationId: string,
  leaseMs?: number,
): Promise<MaintenanceOperatorStatus> {
  return callMaintenance(
    transport,
    fetchFn,
    "POST",
    "/api/operator/maintenance/renew",
    { operationId, ...(leaseMs !== undefined ? { leaseMs } : {}) },
    "maintenance renew",
  );
}

/** POST /api/operator/maintenance/applying — draining → applying (owning op). */
export function transitionMaintenanceApplying(
  transport: ResolvedTransport,
  fetchFn: OperatorFetch,
  operationId: string,
): Promise<MaintenanceOperatorStatus> {
  return callMaintenance(transport, fetchFn, "POST", "/api/operator/maintenance/applying", { operationId }, "maintenance applying");
}

/** POST /api/operator/maintenance/cancel — release the lease (explicit cancel). */
export function cancelMaintenanceDrain(
  transport: ResolvedTransport,
  fetchFn: OperatorFetch,
  operationId: string,
): Promise<MaintenanceOperatorStatus> {
  return callMaintenance(transport, fetchFn, "POST", "/api/operator/maintenance/cancel", { operationId }, "maintenance cancel");
}

/**
 * D420 (Wave 2 task 2.2.3) — POST /api/operator/maintenance/cancel-work:
 * terminalize all remaining executable work (running foreground/background Jobs,
 * queued turns, buffered acceptances) at the drain deadline. Owning
 * `operationId` required; the server verifies lease ownership and refuses a
 * cross-owner / inactive lease with a 409. Returns the payload-free maintenance
 * status the orchestrator reconciles against.
 */
export function cancelMaintenanceWork(
  transport: ResolvedTransport,
  fetchFn: OperatorFetch,
  operationId: string,
): Promise<MaintenanceOperatorStatus> {
  return callMaintenance(
    transport,
    fetchFn,
    "POST",
    "/api/operator/maintenance/cancel-work",
    { operationId },
    "maintenance cancel-work",
  );
}

/** POST /api/operator/maintenance/complete — release the lease (success). */
export function completeMaintenanceDrain(
  transport: ResolvedTransport,
  fetchFn: OperatorFetch,
  operationId: string,
): Promise<MaintenanceOperatorStatus> {
  return callMaintenance(transport, fetchFn, "POST", "/api/operator/maintenance/complete", { operationId }, "maintenance complete");
}

/**
 * D420 (task 2.2.2) — true when every aggregate work count is zero. The drain
 * orchestrator proceeds immediately on this; otherwise it polls until the
 * `--wait-for` deadline.
 */
export function maintenanceWorkIsIdle(status: MaintenanceOperatorStatus): boolean {
  const {
    runningForegroundJobs,
    runningBackgroundJobs,
    queuedTurns,
    bufferedLanes,
    acceptedWork,
    runningTaskRuns,
    claimedTasks,
  } = status.work;
  return (
    runningForegroundJobs === 0 &&
    runningBackgroundJobs === 0 &&
    queuedTurns === 0 &&
    bufferedLanes === 0 &&
    acceptedWork === 0 &&
    runningTaskRuns === 0 &&
    claimedTasks === 0
  );
}
