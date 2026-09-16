/**
 * HTTP server for `nautilo-smoke serve` (D063 Phase 3).
 *
 * Wraps a configured `Runner` behind a local-only REST + SSE surface.
 * Consumers: `curl`, the stdio MCP server (Phase 4), future
 * CI / dashboard integrations.
 *
 * Design choices:
 *
 * - `node:http` directly, not Express / Fastify / etc. Smoke runner's
 *   dep tree is tiny and we want to keep it that way; the endpoint
 *   surface is ~10 routes and doesn't benefit from a framework.
 * - 127.0.0.1 by default. Binding publicly requires an explicit host
 *   option from the caller — there's no "listen on 0.0.0.0 by
 *   accident" path.
 * - Bearer-token auth via the `token` module. Unauthenticated /api/*
 *   requests get 401. `/health` is unauthenticated (liveness probe).
 * - JSON in, JSON out. Request bodies parse on the fly, max 128KB.
 *
 * Route handlers themselves will land in subsequent commits; this
 * file provides the server machinery, routing table, and auth.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Expectations } from "./expectations.ts";
import type { RunFilter } from "./runner.ts";
import { RunRegistry, type RunnerConfig } from "./run-registry.ts";
import type { VmDriver } from "./driver.ts";
import type { Mode, Platform, SecurityLevel, TestLayer } from "./types.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SmokeServerOptions {
  /** Runner config (expectations, platforms, watchdog interval, ...).
   *  The registry builds a fresh Runner per run_id with its own
   *  onEvent injected; callers pass everything EXCEPT onEvent. */
  readonly runnerConfig: RunnerConfig;
  /** Bearer token — caller obtained from `getOrCreateToken()`. */
  readonly token: string;
  /** Listen host. Default 127.0.0.1 (loopback only). */
  readonly host?: string;
  /** Listen port. Default 7788. */
  readonly port?: number;
  /** Max request body size in bytes. Default 128KB. */
  readonly maxBodyBytes?: number;
  /** Emit one-line lifecycle logs to this callback. Defaults to console.log. */
  readonly log?: (line: string) => void;
  /** Override the registry's retention bound. */
  readonly maxCompletedRuns?: number;
}

export interface SmokeServer {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  /** Shared run registry (exposed for SSE wiring in Phase 3.4 + tests). */
  readonly registry: RunRegistry;
  /** Close the server; resolves when connections drain. */
  close(): Promise<void>;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
) => Promise<void>;

export interface HandlerContext {
  /** Config for building fresh Runners per run. Consumers that need to
   *  inspect expectations/platforms/etc. pull them from here. */
  readonly runnerConfig: RunnerConfig;
  readonly registry: RunRegistry;
  /** Parsed URL (URL instance constructed from req.url + host header). */
  readonly url: URL;
  /** Parsed request body, if the caller called `readJsonBody`. */
  readJsonBody(): Promise<unknown>;
  /** Path parameters captured from the route pattern (e.g. `:id`). */
  readonly params: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Routing table
// ---------------------------------------------------------------------------

/**
 * Routing table. Each entry matches method + path pattern. Path
 * patterns use `:name` for captured segments. Exact match on method
 * required. First match wins.
 *
 * Handlers land in subsequent commits — this scaffold wires the
 * routing + auth + error shape. `/health` is the only implemented
 * endpoint right now; it exercises the unauthenticated path.
 */
interface Route {
  readonly method: string;
  readonly pattern: string; // literal or :segment placeholders
  readonly auth: "required" | "none";
  readonly handler: RouteHandler;
}

const ROUTES: Route[] = [
  { method: "GET",    pattern: "/health",                               auth: "none",     handler: healthHandler },
  { method: "GET",    pattern: "/api/smoke/tests",                      auth: "required", handler: listTestsHandler },
  { method: "POST",   pattern: "/api/smoke/runs",                       auth: "required", handler: startRunHandler },
  { method: "GET",    pattern: "/api/smoke/runs/:id",                   auth: "required", handler: getRunHandler },
  { method: "GET",    pattern: "/api/smoke/runs/:id/stream",            auth: "required", handler: streamRunHandler },
  { method: "GET",    pattern: "/api/smoke/runs/:id/report",            auth: "required", handler: getReportHandler },
  { method: "POST",   pattern: "/api/smoke/vms/:platform/snapshot",     auth: "required", handler: vmSnapshotHandler },
  { method: "POST",   pattern: "/api/smoke/vms/:platform/restore",      auth: "required", handler: vmRestoreHandler },
  { method: "GET",    pattern: "/api/smoke/vms/:platform/health",       auth: "required", handler: vmHealthHandler },
];

// ---------------------------------------------------------------------------
// Server construction
// ---------------------------------------------------------------------------

export function createSmokeServer(options: SmokeServerOptions): Promise<SmokeServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7788;
  const maxBodyBytes = options.maxBodyBytes ?? 128 * 1024;
  const log = options.log ?? ((l) => console.log(l));
  const registry = new RunRegistry({
    ...(options.maxCompletedRuns !== undefined ? { maxCompleted: options.maxCompletedRuns } : {}),
  });

  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      runnerConfig: options.runnerConfig,
      registry,
      token: options.token,
      maxBodyBytes,
      log,
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const resolvedPort = typeof addr === "object" && addr !== null ? addr.port : port;
      log(`[nautilo-smoke] serving on http://${host}:${resolvedPort}`);
      resolve({
        server,
        host,
        port: resolvedPort,
        registry,
        close: () => new Promise<void>((r, rej) => {
          server.close((err) => (err ? rej(err) : r()));
        }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Dispatch + auth
// ---------------------------------------------------------------------------

interface DispatchDeps {
  readonly runnerConfig: RunnerConfig;
  readonly registry: RunRegistry;
  readonly token: string;
  readonly maxBodyBytes: number;
  readonly log: (line: string) => void;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DispatchDeps,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const hostHeader = req.headers.host ?? "localhost";
  // Parse with a base so `new URL` accepts path-only req.url.
  const url = new URL(req.url ?? "/", `http://${hostHeader}`);
  const path = url.pathname;

  const match = matchRoute(method, path);
  if (!match) {
    // Preserve the "404 hides the route's existence" posture used by
    // the test-mode route. Return 404 for both unknown path AND
    // unauthenticated /api/* — see below.
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  if (match.route.auth === "required") {
    const auth = (req.headers["authorization"] ?? "").toString();
    const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!provided || !timingSafeEquals(provided, deps.token)) {
      // 401 rather than 404 because the URL has already been matched —
      // a 404 here leaks that the path exists. Clients-already-routed
      // is a different posture than route-hidden.
      sendJson(res, 401, { error: "Authentication required" });
      deps.log(`[nautilo-smoke] 401 ${method} ${path}`);
      return;
    }
  }

  let bodyCache: unknown;
  let bodyRead = false;
  const readJsonBody = async (): Promise<unknown> => {
    if (bodyRead) return bodyCache;
    bodyRead = true;
    bodyCache = await readJson(req, deps.maxBodyBytes);
    return bodyCache;
  };

  try {
    await match.route.handler(req, res, {
      runnerConfig: deps.runnerConfig,
      registry: deps.registry,
      url,
      readJsonBody,
      params: match.params,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error", message });
    deps.log(`[nautilo-smoke] 500 ${method} ${path}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

interface Match {
  readonly route: Route;
  readonly params: Record<string, string>;
}

function matchRoute(method: string, path: string): Match | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const params = matchPattern(route.pattern, path);
    if (params !== null) return { route, params };
  }
  return null;
}

/**
 * Match `/api/smoke/runs/:id` against `/api/smoke/runs/abc` → `{ id: "abc" }`.
 * Return null if no match.
 */
export function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter((s) => s.length > 0);
  const pathParts = path.split("/").filter((s) => s.length > 0);
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i]!;
    const xp = pathParts[i]!;
    if (pp.startsWith(":")) {
      if (xp.length === 0) return null;
      params[pp.slice(1)] = decodeURIComponent(xp);
    } else if (pp !== xp) {
      return null;
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// JSON I/O
// ---------------------------------------------------------------------------

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(json));
  res.end(json);
}

async function readJson(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    total += buf.length;
    if (total > maxBodyBytes) {
      throw new Error(`request body exceeds ${maxBodyBytes} bytes`);
    }
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  const text = Buffer.concat(chunks as unknown as Uint8Array[]).toString("utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Constant-time compare for the bearer token
// ---------------------------------------------------------------------------

/**
 * Constant-time equality. A regular `a === b` comparison short-circuits
 * on first differing byte, which leaks token length + prefix to a
 * timing attacker on a local (and therefore low-noise) network. We run
 * on 127.0.0.1 by default so the attack surface is small — but the
 * check is cheap and removes the concern entirely.
 *
 * Not imported from `node:crypto`'s `timingSafeEqual` because that
 * requires equal-length buffers and throws otherwise; for auth token
 * comparison we want a uniform "different → false" for any length.
 */
function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still spin over b to keep timing roughly constant w.r.t. the
    // expected token length, regardless of whether the attacker sent
    // a short / long guess. We ignore the dummy value but do the work.
    let dummy = 0;
    for (let i = 0; i < b.length; i++) dummy |= b.charCodeAt(i);
    void dummy;
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Built-in handlers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await -- conforms to RouteHandler contract; may grow async work later (DB pings, etc.)
async function healthHandler(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: HandlerContext,
): Promise<void> {
  sendJson(res, 200, { ok: true, uptimeMs: Math.round(process.uptime() * 1000) });
}

// ---------------------------------------------------------------------------
// GET /api/smoke/tests — list test catalog (Phase 3.3)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await
async function listTestsHandler(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  const layerFilter = ctx.url.searchParams.get("layer");
  const patternFilter = ctx.url.searchParams.get("pattern");
  const platformFilter = ctx.url.searchParams.get("platform") as Platform | null;

  const expectations: Expectations = ctx.runnerConfig.expectations;
  // Collect one entry per (id, platform) from expectations, optionally filtered.
  const specs = expectations.list({
    ...(platformFilter ? { platform: platformFilter } : {}),
    ...(layerFilter !== null ? { layer: layerFilter as TestLayer } : {}),
    ...(patternFilter !== null ? { pattern: patternFilter } : {}),
  });

  sendJson(res, 200, {
    tests: specs.map((s) => ({
      id: s.id,
      platform: s.platform,
      applicablePlatforms: s.applicablePlatforms,
      layer: s.layer,
      description: s.description,
      modesSupported: s.modesSupported,
      expectBlocked: s.expectBlocked,
      honeypotRequired: s.honeypotRequired,
      securityLevels: s.securityLevels,
      timeoutMs: s.timeoutMs,
    })),
  });
}

// ---------------------------------------------------------------------------
// POST /api/smoke/runs — start a run (Phase 3.3)
// ---------------------------------------------------------------------------

async function startRunHandler(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    const raw = await ctx.readJsonBody();
    if (raw !== undefined && (raw === null || typeof raw !== "object")) {
      sendJson(res, 400, { error: "invalid body", message: "body must be a JSON object" });
      return;
    }
    if (raw) body = raw as Record<string, unknown>;
  } catch (err) {
    sendJson(res, 400, { error: "invalid body", message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const pattern = typeof body["pattern"] === "string" ? body["pattern"] : undefined;
  const platformRaw = typeof body["platform"] === "string" ? body["platform"] : "both";
  const modeRaw = typeof body["mode"] === "string" ? body["mode"] : "destructive";
  const levelRaw = typeof body["level"] === "string" ? body["level"] : "standard";
  const layerRaw = typeof body["layer"] === "string" ? body["layer"] : undefined;

  const platforms = parsePlatformArg(platformRaw);
  if (!platforms) {
    sendJson(res, 400, { error: "invalid platform", message: `platform must be "linux" | "macos" | "both"` });
    return;
  }
  if (!isMode(modeRaw)) {
    sendJson(res, 400, { error: "invalid mode", message: `mode must be "destructive" | "substitution"` });
    return;
  }
  if (!isSecurityLevel(levelRaw)) {
    sendJson(res, 400, { error: "invalid level" });
    return;
  }

  const filter: RunFilter = {
    mode: modeRaw,
    level: levelRaw,
    platforms,
    ...(pattern !== undefined ? { pattern } : {}),
    ...(layerRaw !== undefined ? { layer: layerRaw as TestLayer } : {}),
  };

  const record = ctx.registry.start(ctx.runnerConfig, filter);
  sendJson(res, 200, { runId: record.runId, startedAt: record.startedAt, status: record.status });
}

// ---------------------------------------------------------------------------
// GET /api/smoke/runs/:id — poll status (Phase 3.3)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await
async function getRunHandler(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  const record = ctx.registry.get(ctx.params["id"] ?? "");
  if (!record) {
    sendJson(res, 404, { error: "run not found", runId: ctx.params["id"] });
    return;
  }
  sendJson(res, 200, {
    runId: record.runId,
    status: record.status,
    startedAt: record.startedAt,
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    progress: record.progress,
    ...(record.error !== undefined ? { error: record.error } : {}),
  });
}

// ---------------------------------------------------------------------------
// GET /api/smoke/runs/:id/report — fetch final report (Phase 3.3)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await
async function getReportHandler(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  const record = ctx.registry.get(ctx.params["id"] ?? "");
  if (!record) {
    sendJson(res, 404, { error: "run not found", runId: ctx.params["id"] });
    return;
  }
  if (record.status === "running") {
    sendJson(res, 409, { error: "run not complete", runId: record.runId, status: record.status });
    return;
  }
  if (record.status === "failed") {
    sendJson(res, 500, { error: "run failed", runId: record.runId, detail: record.error });
    return;
  }
  sendJson(res, 200, record.report);
}

// ---------------------------------------------------------------------------
// GET /api/smoke/runs/:id/stream — SSE of per-test events (Phase 3.4)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await -- conforms to RouteHandler; event-stream lives on after the handler returns
async function streamRunHandler(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  const runId = ctx.params["id"] ?? "";
  const record = ctx.registry.get(runId);
  if (!record) {
    sendJson(res, 404, { error: "run not found", runId });
    return;
  }

  // SSE headers. Keep-alive + no-buffering so events land at clients
  // as they happen (some reverse proxies buffer text/* without the
  // explicit X-Accel-Buffering hint).
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // If the run is already done, emit the final state and close. Late
  // attach is the common case when a client polls first and then
  // attaches the stream.
  if (record.status !== "running") {
    writeSseEvent(res, "run-status", {
      runId: record.runId,
      status: record.status,
      ...(record.report !== undefined ? { report: record.report } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    });
    writeSseEvent(res, "close", { reason: "already-finished" });
    res.end();
    return;
  }

  // Seed with current progress snapshot so a late attacher sees state.
  writeSseEvent(res, "run-status", {
    runId: record.runId,
    status: record.status,
    progress: record.progress,
  });

  // Periodic keep-alive to keep intermediaries from idling the socket.
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(":keepalive\n\n");
  }, 15_000);

  // `cleanup` and `unsubscribe` form a mutual closure: the subscribe
  // callback may call cleanup() during SYNCHRONOUS event-log replay
  // (registry.subscribe fires every logged event inline before
  // returning), and cleanup() calls unsubscribe(). Declare the
  // forward refs first so the race window where replay sees a
  // buffered `run-end` doesn't hit TDZ.
  let unsubscribe: () => void = () => {};
  const cleanup = () => {
    clearInterval(keepalive);
    unsubscribe();
    if (!res.writableEnded) res.end();
  };

  unsubscribe = ctx.registry.subscribe(runId, (evt) => {
    if (res.writableEnded) return;
    writeSseEvent(res, evt.type, evt);

    if (evt.type === "run-end") {
      writeSseEvent(res, "close", { reason: "run-end" });
      cleanup();
    }
  });

  // Disconnect if the client drops.
  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);
}

function writeSseEvent(res: ServerResponse, eventName: string, data: unknown): void {
  if (res.writableEnded) return;
  // SSE frame: optional `event: <name>` line + one or more `data:`
  // lines + blank line terminator. Split JSON on newlines so
  // compliant clients see a single data event (rare for our JSON
  // which is normally one line, but defensive).
  const serialized = JSON.stringify(data);
  const lines = serialized.split("\n").map((l) => `data: ${l}`).join("\n");
  res.write(`event: ${eventName}\n${lines}\n\n`);
}

// ---------------------------------------------------------------------------
// VM endpoints (Phase 3.3)
// ---------------------------------------------------------------------------

async function vmSnapshotHandler(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  const driver = resolveDriver(ctx);
  if (!driver) {
    sendJson(res, 404, { error: "platform not configured", platform: ctx.params["platform"] });
    return;
  }
  const body = await ctx.readJsonBody().catch(() => undefined);
  const name = typeof (body as { name?: unknown })?.name === "string" ? (body as { name: string }).name : "baseline";
  const start = Date.now();
  try {
    await driver.snapshotTake(name);
    sendJson(res, 200, { ok: true, name, tookMs: Date.now() - start });
  } catch (err) {
    sendJson(res, 500, { error: "snapshot failed", message: err instanceof Error ? err.message : String(err) });
  }
}

async function vmRestoreHandler(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  const driver = resolveDriver(ctx);
  if (!driver) {
    sendJson(res, 404, { error: "platform not configured", platform: ctx.params["platform"] });
    return;
  }
  const body = await ctx.readJsonBody().catch(() => undefined);
  const name = typeof (body as { name?: unknown })?.name === "string" ? (body as { name: string }).name : "baseline";
  const start = Date.now();
  try {
    await driver.snapshotRestore(name);
    sendJson(res, 200, { ok: true, name, tookMs: Date.now() - start });
  } catch (err) {
    sendJson(res, 500, { error: "restore failed", message: err instanceof Error ? err.message : String(err) });
  }
}

async function vmHealthHandler(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  const driver = resolveDriver(ctx);
  if (!driver) {
    sendJson(res, 404, { error: "platform not configured", platform: ctx.params["platform"] });
    return;
  }
  try {
    const result = await driver.healthProbe();
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 500, { error: "health probe failed", message: err instanceof Error ? err.message : String(err) });
  }
}

function resolveDriver(ctx: HandlerContext): VmDriver | undefined {
  const platform = ctx.params["platform"];
  if (platform !== "linux" && platform !== "macos") return undefined;
  return ctx.runnerConfig.platforms[platform]?.driver;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function parsePlatformArg(arg: string): readonly Platform[] | null {
  if (arg === "both") return ["linux", "macos"];
  if (arg === "linux") return ["linux"];
  if (arg === "macos") return ["macos"];
  return null;
}

function isMode(s: string): s is Mode {
  return s === "destructive" || s === "substitution";
}

function isSecurityLevel(s: string): s is SecurityLevel {
  return s === "yolo" || s === "permissive" || s === "standard" || s === "cautious" || s === "paranoid";
}
