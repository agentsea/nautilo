import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { routeSkipsTrustPreHandler } from "../trust-bypass-routes";

/** Auth/resolution stages timed by M213 observability (Phase 0+). */
export const TELEMETRY_STAGES = [
  "jwt",
  "revocation",
  "principal",
  "rbac",
  "room",
  "namespace",
  "policy",
  "handler",
] as const;

export type TelemetryStage = (typeof TELEMETRY_STAGES)[number];

export interface RequestTelemetrySnapshot {
  readonly correlationId: string;
  readonly stageDurationsMs: Readonly<Partial<Record<TelemetryStage, number>>>;
  readonly dbStatementCount: number;
}

interface MutableRequestTelemetryContext {
  correlationId: string;
  stageDurationsMs: Partial<Record<TelemetryStage, number>>;
  dbStatementCount: number;
  handlerPhaseStartedAt: number | null;
}

export type RequestTelemetryContext = Readonly<MutableRequestTelemetryContext>;

const requestTelemetryStorage = new AsyncLocalStorage<MutableRequestTelemetryContext>();

export function createRequestTelemetryContext(): MutableRequestTelemetryContext {
  return {
    correlationId: randomUUID(),
    stageDurationsMs: {},
    dbStatementCount: 0,
    handlerPhaseStartedAt: null,
  };
}

export function runWithRequestTelemetry<T>(
  ctx: MutableRequestTelemetryContext,
  fn: () => T,
): T {
  return requestTelemetryStorage.run(ctx, fn);
}

/**
 * Allocate and bind a fresh telemetry context to one request lifecycle.
 *
 * The Fastify continuation must be invoked from inside this callback so all
 * downstream hooks and the handler inherit this context. Never use
 * `enterWith`: its ambient store can leak into a later lifecycle chain.
 */
export function runWithNewRequestTelemetry<T>(fn: () => T): T {
  return requestTelemetryStorage.run(createRequestTelemetryContext(), fn);
}

export function getActiveRequestTelemetry(): RequestTelemetryContext | null {
  return requestTelemetryStorage.getStore() ?? null;
}

/**
 * Routes that skip trust resolution also skip request telemetry (Phase 0).
 * Uses the same bypass contract as the trust preHandler where possible.
 */
export function shouldSkipRequestTelemetry(
  requestUrl: string,
  routeTemplate?: string,
): boolean {
  if (requestUrl.startsWith("/wopi/")) return true;
  if (requestUrl.startsWith("/office-engine/")) return true;
  const routePath = routeTemplate ?? requestUrl;
  return routeSkipsTrustPreHandler(routePath);
}

/** Record elapsed time for a completed stage (milliseconds, additive). */
export function recordStageDuration(stage: TelemetryStage, durationMs: number): void {
  const ctx = requestTelemetryStorage.getStore();
  if (!ctx || !Number.isFinite(durationMs) || durationMs < 0) return;
  ctx.stageDurationsMs[stage] = (ctx.stageDurationsMs[stage] ?? 0) + durationMs;
}

/**
 * Time an async/sync stage and record duration on the active request context.
 * No-op when no context is bound (background work, bypass routes).
 */
export async function timeStage<T>(
  stage: TelemetryStage,
  fn: () => T | Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    recordStageDuration(stage, performance.now() - start);
  }
}

/** Mark the start of route handler execution (after preHandler). */
export function markHandlerPhaseStart(): void {
  const ctx = requestTelemetryStorage.getStore();
  if (!ctx) return;
  ctx.handlerPhaseStartedAt = performance.now();
}

/** Finalize handler stage duration from the mark set in preHandler. */
export function finalizeHandlerPhase(): void {
  const ctx = requestTelemetryStorage.getStore();
  if (!ctx || ctx.handlerPhaseStartedAt === null) return;
  recordStageDuration("handler", performance.now() - ctx.handlerPhaseStartedAt);
  ctx.handlerPhaseStartedAt = null;
}

/** Increment DB statement count for the active request (runtime pool observer). */
export function incrementDbStatementCountForActiveRequest(): void {
  const ctx = requestTelemetryStorage.getStore();
  if (!ctx) return;
  ctx.dbStatementCount += 1;
}

/** Safe snapshot for logs/tests — never includes bearer, SQL, or user identifiers. */
export function snapshotRequestTelemetry(
  ctx: RequestTelemetryContext,
): RequestTelemetrySnapshot {
  return {
    correlationId: ctx.correlationId,
    stageDurationsMs: { ...ctx.stageDurationsMs },
    dbStatementCount: ctx.dbStatementCount,
  };
}
