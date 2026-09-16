import type { FastifyInstance, FastifyReply } from "fastify";
import { jobManager, type JobManager } from "@nautilo/runtime";
import { requestAllowsPrivilegedSetup } from "../lib/request-trust";
import {
  MaintenanceTransitionError,
  type MaintenanceSnapshot,
} from "@nautilo/db";
import type {
  MaintenanceEnterRequest,
  MaintenanceOperationRequest,
  MaintenanceOperatorStatus,
  MaintenanceTransitionErrorResponse,
  MaintenanceWorkCounts,
} from "@nautilo/types";

type ReadinessJobManager = Pick<JobManager, "getForegroundWorkSummary">;
type MaintenanceJobManager = Pick<
  JobManager,
  "getExecutableJobWorkSummary" | "terminalizeExecutableWorkForMaintenance"
>;

/**
 * Structural seam the operator maintenance API drives. Mirrors the public
 * {@link MaintenanceController} surface without importing the runtime class
 * (keeps the route unit-testable with a stub). Operation ownership and hard
 * expiry remain enforced inside this layer / the durable store; the route
 * only translates results into payload-free HTTP responses.
 */
export interface MaintenanceControllerSeam {
  getState(): Promise<MaintenanceSnapshot>;
  enterDraining(opts?: {
    operationId?: string;
    leaseMs?: number;
    hardMs?: number;
  }): Promise<MaintenanceSnapshot>;
  transitionApplying(operationId: string): Promise<MaintenanceSnapshot>;
  renewLease(operationId: string, opts?: { leaseMs?: number }): Promise<MaintenanceSnapshot>;
  complete(operationId: string): Promise<MaintenanceSnapshot>;
  cancel(operationId: string): Promise<MaintenanceSnapshot>;
}

export interface OperatorMaintenanceDeps {
  controller: MaintenanceControllerSeam;
  jobManager: MaintenanceJobManager;
  /**
   * Aggregate count of payload-free acceptances not yet dispatched or
   * terminalized (Wave 2 task 2.1.2 ledger). Injectable so route unit tests
   * run DB-free; production wires `countAcceptedWorkWith(getServerDirectDb())`.
   */
  countAcceptedWork: () => Promise<number>;
  /**
   * Durable Task observer aggregate. Running task-runs include Job-backed
   * tasks; the Job aggregate excludes those so the operator response cannot
   * count one executable Task twice.
   */
  countActiveTaskWork: () => Promise<{
    runningTaskRuns: number;
    claimedTasks: number;
  }>;
}

/**
 * D420 (Wave 3 task 3.2.1) — sink invoked with the durable maintenance
 * snapshot whenever its payload-free public fields (state / operation /
 * lease + hard expiry) change. Injectable so the wrapper is unit-testable
 * with a spy and decoupled from the WS broadcaster's module-level state.
 */
export type MaintenanceStatusPublisher = (snapshot: MaintenanceSnapshot) => void;

/**
 * D420 (Wave 3 task 3.2.1) — compare two snapshots by ONLY the payload-free
 * public fields carried on `maintenance.status`. Work-count / timestamp
 * churn that does NOT appear on the realtime event is intentionally ignored
 * so the broadcaster never fires for a no-op read (e.g. a `status` GET or a
 * gate admission check that observed no public-field change).
 */
function sameMaintenanceStatus(a: MaintenanceSnapshot, b: MaintenanceSnapshot): boolean {
  return (
    a.state === b.state &&
    a.operationId === b.operationId &&
    toIso(a.leaseExpiresAt) === toIso(b.leaseExpiresAt) &&
    toIso(a.hardExpiresAt) === toIso(b.hardExpiresAt)
  );
}

/**
 * D420 (Wave 3 task 3.2.1) — wrap a {@link MaintenanceControllerSeam} so
 * every read or mutation that changes the durable maintenance state's public
 * fields publishes a `maintenance.status` broadcast through the supplied
 * {@link MaintenanceStatusPublisher}. Same-state reads are suppressed (no
 * polling noise): the gate calls `getState()` on every executable ingress,
 * and the operator `status` GET may be polled by the CLI, but the publisher
 * fires ONLY when the payload-free public fields actually change.
 *
 * This is the single broadcast chokepoint for maintenance state, so it
 * covers every required transition from one place:
 *   - `enterDraining` / `transitionApplying` / `complete` / `cancel` /
 *     `renewLease` — operator-driven mutations broadcast immediately.
 *   - `getState` — surfaces **expiry recovery**: the underlying controller
 *     reclaims an abandoned / restored `applying` lease to `normal` on read
 *     once its hard expiry passes (R10); the first read that observes that
 *     change broadcasts `normal` to every client. Because this is the same
 *     wrapper the production admission gate reads on every ingress, the
 *     recovery broadcast is event-driven (a real request observes it), not
 *     a polling timer.
 *
 * `publish` is best-effort: it must never throw into a mutating call path.
 * The production sink (`publishMaintenanceStatus`) is fire-and-forget; a
 * unit-test spy can assert call sequences without touching the WS layer.
 */
export function withMaintenanceStatusPublishing(
  controller: MaintenanceControllerSeam,
  publish: MaintenanceStatusPublisher,
): MaintenanceControllerSeam {
  let last: MaintenanceSnapshot | null = null;
  const maybePublish = (snapshot: MaintenanceSnapshot): void => {
    if (last !== null && sameMaintenanceStatus(last, snapshot)) return;
    last = snapshot;
    publish(snapshot);
  };
  return {
    async getState() {
      const s = await controller.getState();
      maybePublish(s);
      return s;
    },
    async enterDraining(opts) {
      const s = await controller.enterDraining(opts);
      maybePublish(s);
      return s;
    },
    async transitionApplying(operationId) {
      const s = await controller.transitionApplying(operationId);
      maybePublish(s);
      return s;
    },
    async renewLease(operationId, opts) {
      const s = await controller.renewLease(operationId, opts);
      maybePublish(s);
      return s;
    },
    async complete(operationId) {
      const s = await controller.complete(operationId);
      maybePublish(s);
      return s;
    },
    async cancel(operationId) {
      const s = await controller.cancel(operationId);
      maybePublish(s);
      return s;
    },
  };
}

/**
 * Deployment-operator readiness check. It deliberately uses the bootstrap
 * trust boundary rather than a room-user session and returns aggregate counts
 * only—never prompts, ids, lane keys, or other job payload.
 */
export function operatorReleaseRoutes(
  app: FastifyInstance,
  manager: ReadinessJobManager = jobManager,
): void {
  app.get("/api/operator/release/readiness", async (request, reply) => {
    if (!requestAllowsPrivilegedSetup(request)) {
      return reply.code(403).send({ error: "Operator authorization required" });
    }

    return reply.send(manager.getForegroundWorkSummary());
  });
}

const MAINTENANCE_PREFIX = "/api/operator/maintenance";

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Build the payload-free operator maintenance snapshot: state, operation
 * ownership, lease + hard expiry, and aggregate work counts. Never includes
 * prompt, room, lane, job, or user payload.
 */
async function buildMaintenanceStatus(
  snapshot: MaintenanceSnapshot,
  deps: OperatorMaintenanceDeps,
): Promise<MaintenanceOperatorStatus> {
  const summary = deps.jobManager.getExecutableJobWorkSummary();
  const [acceptedWork, taskWork] = await Promise.all([
    deps.countAcceptedWork(),
    deps.countActiveTaskWork(),
  ]);
  const work: MaintenanceWorkCounts = {
    runningForegroundJobs: summary.runningForegroundJobs,
    runningBackgroundJobs: summary.runningBackgroundJobs,
    queuedTurns: summary.queuedTurns,
    bufferedLanes: summary.bufferedLanes,
    acceptedWork,
    runningTaskRuns: taskWork.runningTaskRuns,
    claimedTasks: taskWork.claimedTasks,
  };
  return {
    state: snapshot.state,
    operationId: snapshot.operationId,
    leaseExpiresAt: toIso(snapshot.leaseExpiresAt),
    hardExpiresAt: toIso(snapshot.hardExpiresAt),
    work,
  };
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

function readEnterBody(body: unknown): MaintenanceEnterRequest {
  if (body === null || typeof body !== "object") return {};
  const raw = body as Record<string, unknown>;
  const out: MaintenanceEnterRequest = {};
  if (typeof raw["operationId"] === "string" && raw["operationId"].trim() !== "") {
    out.operationId = raw["operationId"];
  }
  if (isPositiveInt(raw["leaseMs"])) out.leaseMs = raw["leaseMs"];
  if (isPositiveInt(raw["hardMs"])) out.hardMs = raw["hardMs"];
  return out;
}

function readOperationBody(body: unknown): MaintenanceOperationRequest | null {
  if (body === null || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  const operationId = raw["operationId"];
  if (typeof operationId !== "string" || operationId.trim() === "") return null;
  return { operationId };
}

/** Render a {@link MaintenanceTransitionError} as a 409 transition-failure body. */
function replyTransitionError(
  reply: FastifyReply,
  err: MaintenanceTransitionError,
): void {
  const body: MaintenanceTransitionErrorResponse = {
    error: "maintenance_transition",
    code: err.code,
    message: err.message,
  };
  reply.code(409).send(body);
}

/**
 * D420 (Wave 2 task 2.2.2) — authenticated operator maintenance API beside
 * the existing release-readiness route. enter/status/renew/applying/cancel/
 * complete all share the SAME privileged setup trust boundary
 * ({@link requestAllowsPrivilegedSetup}: loopback OR constant-time bootstrap
 * bearer) — these routes are NOT exposed to ordinary room-user sessions.
 *
 * Every response is the payload-free {@link MaintenanceOperatorStatus}:
 * maintenance state, operation ownership, lease + hard expiry, and aggregate
 * work counts only. Operation ownership and hard expiry are enforced by the
 * controller / durable query layer; this route never relaxes them.
 */
export function operatorMaintenanceRoutes(
  app: FastifyInstance,
  deps: OperatorMaintenanceDeps,
): void {
  app.post(`${MAINTENANCE_PREFIX}/enter`, async (request, reply) => {
    if (!requestAllowsPrivilegedSetup(request)) {
      return reply.code(403).send({ error: "Operator authorization required" });
    }
    const opts = readEnterBody(request.body);
    let snapshot: MaintenanceSnapshot;
    try {
      snapshot = await deps.controller.enterDraining(opts);
    } catch (err) {
      if (err instanceof MaintenanceTransitionError) return replyTransitionError(reply, err);
      throw err;
    }
    return reply.send(await buildMaintenanceStatus(snapshot, deps));
  });

  app.get(`${MAINTENANCE_PREFIX}/status`, async (request, reply) => {
    if (!requestAllowsPrivilegedSetup(request)) {
      return reply.code(403).send({ error: "Operator authorization required" });
    }
    const snapshot = await deps.controller.getState();
    return reply.send(await buildMaintenanceStatus(snapshot, deps));
  });

  app.post(`${MAINTENANCE_PREFIX}/renew`, async (request, reply) => {
    if (!requestAllowsPrivilegedSetup(request)) {
      return reply.code(403).send({ error: "Operator authorization required" });
    }
    const body = readOperationBody(request.body);
    if (!body) {
      return reply.code(400).send({ error: "operationId required" });
    }
    const raw = request.body as Record<string, unknown> | null;
    const leaseMsRaw = raw?.["leaseMs"];
    const leaseMs = isPositiveInt(leaseMsRaw) ? leaseMsRaw : undefined;
    let snapshot: MaintenanceSnapshot;
    try {
      snapshot = await deps.controller.renewLease(body.operationId, leaseMs ? { leaseMs } : {});
    } catch (err) {
      if (err instanceof MaintenanceTransitionError) return replyTransitionError(reply, err);
      throw err;
    }
    return reply.send(await buildMaintenanceStatus(snapshot, deps));
  });

  app.post(`${MAINTENANCE_PREFIX}/applying`, async (request, reply) => {
    if (!requestAllowsPrivilegedSetup(request)) {
      return reply.code(403).send({ error: "Operator authorization required" });
    }
    const body = readOperationBody(request.body);
    if (!body) {
      return reply.code(400).send({ error: "operationId required" });
    }
    let snapshot: MaintenanceSnapshot;
    try {
      snapshot = await deps.controller.transitionApplying(body.operationId);
    } catch (err) {
      if (err instanceof MaintenanceTransitionError) return replyTransitionError(reply, err);
      throw err;
    }
    return reply.send(await buildMaintenanceStatus(snapshot, deps));
  });

  app.post(`${MAINTENANCE_PREFIX}/cancel`, async (request, reply) => {
    if (!requestAllowsPrivilegedSetup(request)) {
      return reply.code(403).send({ error: "Operator authorization required" });
    }
    const body = readOperationBody(request.body);
    if (!body) {
      return reply.code(400).send({ error: "operationId required" });
    }
    let snapshot: MaintenanceSnapshot;
    try {
      snapshot = await deps.controller.cancel(body.operationId);
    } catch (err) {
      if (err instanceof MaintenanceTransitionError) return replyTransitionError(reply, err);
      throw err;
    }
    return reply.send(await buildMaintenanceStatus(snapshot, deps));
  });

  app.post(`${MAINTENANCE_PREFIX}/complete`, async (request, reply) => {
    if (!requestAllowsPrivilegedSetup(request)) {
      return reply.code(403).send({ error: "Operator authorization required" });
    }
    const body = readOperationBody(request.body);
    if (!body) {
      return reply.code(400).send({ error: "operationId required" });
    }
    let snapshot: MaintenanceSnapshot;
    try {
      snapshot = await deps.controller.complete(body.operationId);
    } catch (err) {
      if (err instanceof MaintenanceTransitionError) return replyTransitionError(reply, err);
      throw err;
    }
    return reply.send(await buildMaintenanceStatus(snapshot, deps));
  });

  app.post(`${MAINTENANCE_PREFIX}/cancel-work`, async (request, reply) => {
    if (!requestAllowsPrivilegedSetup(request)) {
      return reply.code(403).send({ error: "Operator authorization required" });
    }
    const body = readOperationBody(request.body);
    if (!body) {
      return reply.code(400).send({ error: "operationId required" });
    }
    // Verify the caller owns the active drain lease BEFORE terminalizing
    // executable work. The controller / durable store own operation ownership;
    // this route only refuses a cross-owner / inactive lease. Cancellation is
    // permitted only while `draining` (the applying transition + stop-before-
    // backup ordering is a later task), so a `normal` or `applying` lease is a
    // 409 transition failure.
    let snapshot: MaintenanceSnapshot;
    try {
      snapshot = await deps.controller.getState();
    } catch (err) {
      if (err instanceof MaintenanceTransitionError) return replyTransitionError(reply, err);
      throw err;
    }
    if (snapshot.state !== "draining") {
      const err = new MaintenanceTransitionError(
        `maintenance cancel-work refused (state=${snapshot.state}); expected draining`,
        "invalid_transition",
      );
      return replyTransitionError(reply, err);
    }
    if (snapshot.operationId !== body.operationId) {
      const err = new MaintenanceTransitionError(
        "maintenance cancel-work refused: not the owning operation",
        "not_owner",
      );
      return replyTransitionError(reply, err);
    }
    // Terminalize all remaining executable work. The runtime owns job/queue/
    // buffer/acceptance cancellation; errors propagate (fail closed) — a
    // partial cancellation must not let the upgrade proceed against unsettled
    // work.
    await deps.jobManager.terminalizeExecutableWorkForMaintenance();
    const after = await deps.controller.getState();
    return reply.send(await buildMaintenanceStatus(after, deps));
  });
}
