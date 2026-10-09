import type {
  ConnectedWebOperationSafeProjection,
  ConnectedWebOperationToolActorContext,
  ConnectedWebOperationToolInput,
  ConnectedWebOperationToolResult,
  ConnectedWebOperationToolRuntime,
} from "@nautilo/agent";
import { canRunWebsiteTask } from "./website-task-contract";
import { randomUUID } from "node:crypto";
import type {
  ConnectedWebOperationProviderReferences,
  ConnectedWebOperationSafeActivity,
} from "@nautilo/db";
import type { ConnectedWebOperation } from "./store";
import type { ConnectedWebAccountReadFacts } from "./read-tool-runtime";
import type { ConnectedWebAccountStore } from "./store";
import type { UsageFundingProvenance } from "@nautilo/agent";

type ProviderFailure = Readonly<{ kind: "failure"; code: string }>;
type ProviderRunStatus = "queued" | "dispatching" | "running" | "completed" | "failed" | "cancelled";
type ProviderRun = Readonly<{
  runId: string;
  sessionId?: string;
  workspaceId?: string;
  status: ProviderRunStatus;
}>;
type ProviderResult<T> = T | ProviderFailure;

/** The exact V4 operations this management vertical needs; no browser capability escapes it. */
export interface ConnectedWebOperationManagementProvider {
  cancelHostedReadRun(runId: string): Promise<ProviderResult<ProviderRun>>;
  pollHostedReadRun(runId: string): Promise<ProviderResult<ProviderRun>>;
}

/** Server-only secret boundary. The plaintext intent is never returned or logged. */
export interface ConnectedWebOperationManagementSecrets {
  unsealIntent(input: {
    readonly context: { readonly operationId: string; readonly ownerUserId: string; readonly accountId: string | null };
    readonly sealedIntent: string;
  }): string;
  unsealProviderReferences(input: {
    readonly context: { readonly operationId: string; readonly ownerUserId: string; readonly accountId: string | null };
    readonly references: ConnectedWebOperationProviderReferences;
  }): {
    readonly runId?: string;
    readonly sessionId?: string;
    readonly workspaceId?: string;
    readonly browserId?: string;
    readonly runCost?: { readonly identity: string; readonly workload: string };
    readonly browserCost?: { readonly identity: string; readonly workload: string };
  };
  sealProviderReferences(input: {
    readonly context: { readonly operationId: string; readonly ownerUserId: string; readonly accountId: string | null };
    readonly coordinates: {
      readonly runId?: string;
      readonly sessionId?: string;
      readonly workspaceId?: string;
      readonly browserId?: string;
      readonly runCost?: { readonly identity: string; readonly workload: string };
      readonly browserCost?: { readonly identity: string; readonly workload: string };
    };
  }): ConnectedWebOperationProviderReferences;
}

export interface ConnectedWebOperationManagementClock {
  now(): Date;
}

export interface ConnectedWebOperationManagementRuntimeOptions {
  readonly facts: ConnectedWebAccountReadFacts;
  readonly store: Pick<
    ConnectedWebAccountStore,
    "getOperationForOwner" | "scheduleOperationCheck" | "claimOperationForControl" | "releaseOperationClaim"
  >;
  readonly provider: ConnectedWebOperationManagementProvider;
  readonly withProvider?: <T>(
    operation: ConnectedWebOperation,
    intent: "spend" | "recover",
    callback: (provider: ConnectedWebOperationManagementProvider, usageFunding?: UsageFundingProvenance) => Promise<T>,
  ) => Promise<T>;
  readonly secrets: ConnectedWebOperationManagementSecrets;
  readonly clock?: ConnectedWebOperationManagementClock;
  /** Optional listener-owned direct runtime.  Keeping this explicit prevents
   * management from ever creating a browser or accepting model coordinates. */
  readonly direct?: {
    preflight(): Promise<boolean>;
    takeControl(actor: ConnectedWebOperationToolActorContext, input: { readonly operationId: string; readonly expectedControlEpoch: number }): Promise<ConnectedWebOperationSafeProjection | null>;
    release(actor: ConnectedWebOperationToolActorContext, input: { readonly operationId: string; readonly expectedControlEpoch: number }): Promise<ConnectedWebOperationSafeProjection | null>;
    stopOperation?(actor: ConnectedWebOperationToolActorContext, input: { readonly operationId: string; readonly expectedControlEpoch: number }): Promise<ConnectedWebOperationSafeProjection | null>;
  };
}

const SYSTEM_CLOCK: ConnectedWebOperationManagementClock = { now: () => new Date() };
// This is a crash-recovery lease, not an operation deadline. It only prevents
// the background reconciler from racing an interactive handoff; expiry makes
// the already-due operation eligible for ordinary reconciliation again.
const DIRECT_TAKEOVER_CLAIM_LEASE_MS = 5 * 60 * 1_000;

function failure(code: "unavailable" | "not_found" | "forbidden" | "conflict" | "invalid_result" | "steer_budget_unverified"): ConnectedWebOperationToolResult {
  return { ok: false, code, recovery: "none" };
}

function providerFailure(value: unknown): value is ProviderFailure {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "failure";
}

function isTerminal(status: ProviderRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function secretContext(operation: ConnectedWebOperation) {
  return {
    operationId: operation.id,
    ownerUserId: operation.ownerUserId,
    accountId: operation.accountId,
  };
}

function activity(
  phase: ConnectedWebOperationSafeActivity["phase"],
  code: string,
  summary: string,
): ConnectedWebOperationSafeActivity {
  return { version: 1, phase, code, summary };
}

/** Deliberately drops every durable/server-only operation field. */
function projection(operation: Pick<
  ConnectedWebOperation,
  "id" | "driver" | "lifecycle" | "controlEpoch" | "safeActivity" | "terminalReceipt" | "terminalReadResult" | "activityLog"
>, includeTerminalReadResult = false): ConnectedWebOperationSafeProjection {
  return {
    operationId: operation.id,
    driver: operation.driver,
    lifecycle: operation.lifecycle,
    controlEpoch: operation.controlEpoch,
    ...(includeTerminalReadResult && operation.activityLog ? { activityLog: operation.activityLog } : {}),
    activity: {
      phase: operation.safeActivity.phase,
      code: operation.safeActivity.code,
      summary: operation.safeActivity.summary,
    },
    receipt: operation.terminalReceipt === null ? null : {
      outcome: operation.terminalReceipt.outcome,
      code: operation.terminalReceipt.code,
      summary: operation.terminalReceipt.summary,
    },
    result: !includeTerminalReadResult || operation.terminalReadResult == null ? null : {
      ok: true,
      status: "completed",
      account: operation.terminalReadResult.account,
      page: operation.terminalReadResult.page,
      read: operation.terminalReadResult.read === null ? null : { ...operation.terminalReadResult.read, facts: [...operation.terminalReadResult.read.facts] },
      cost: operation.terminalReadResult.cost,
      outputs: operation.terminalReadResult.outputs.map((output) => ({ ...output })),
      outputsTruncated: operation.terminalReadResult.outputsTruncated,
    },
  };
}

function accepted(
  control: ConnectedWebOperationToolInput["operation"],
  operation: Parameters<typeof projection>[0],
): ConnectedWebOperationToolResult {
  return { ok: true, accepted: control, operation: projection(operation, control === "inspect") };
}

function dueAt(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function sameForegroundAuthority(
  actor: ConnectedWebOperationToolActorContext,
  operation: ConnectedWebOperation,
): boolean {
  return actor.userId === operation.ownerUserId
    && actor.agentId === operation.initiatingAgentId
    && actor.roomId === operation.initiatingRoomId
    && actor.currentThreadId === operation.initiatingThreadId
    && actor.laneKey !== undefined
    && actor.laneKey === operation.initiatingLane
    && (operation.accountId === null || actor.callingRoomId === null)
    && actor.toolCallId.trim().length > 0
    && actor.turnId.trim().length > 0;
}

/**
 * This runtime is a management boundary, not a worker. It never polls in a
 * loop, never exposes provider state, and never terminalizes from a provider
 * acknowledgement. The supervisor remains the only terminal reconciler.
 */
export function createConnectedWebOperationManagementServerRuntime(
  options: ConnectedWebOperationManagementRuntimeOptions,
): ConnectedWebOperationToolRuntime {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const withProvider = options.withProvider ?? ((_operation, _intent, callback) => callback(options.provider));

  async function authorized(
    actor: ConnectedWebOperationToolActorContext,
    operation: ConnectedWebOperation,
  ): Promise<boolean> {
    if (!sameForegroundAuthority(actor, operation)) return false;
    try {
      const intent = JSON.parse(options.secrets.unsealIntent({ context: secretContext(operation), sealedIntent: operation.sealedIntent })) as Record<string, unknown>;
      const task = intent["kind"] === "run_website_task";
      if (task && !canRunWebsiteTask(actor)) return false;
      if (operation.accountId === null) return await options.facts.canResearchPublic?.(actor, task ? "run_website_task" : "browse_web") ?? false;
      if (!task && !["allow", "read_only"].includes(actor.memoryAccessEnvelope.toolPolicy?.["read_connected_web_account"] ?? "forbidden")) return false;
      const owned = await options.facts.hasExactOwnedGenie({ ownerUserId: actor.userId, agentId: actor.agentId });
      if (!owned) return false;
      return await options.facts.isOwnersPersonalPrivateRoom({
        ownerUserId: actor.userId,
        agentId: actor.agentId,
        roomId: actor.roomId,
      });
    } catch {
      return false;
    }
  }

  async function load(
    actor: ConnectedWebOperationToolActorContext,
    input: ConnectedWebOperationToolInput,
  ): Promise<ConnectedWebOperation | ConnectedWebOperationToolResult> {
    let operation: ConnectedWebOperation;
    try {
      operation = await options.store.getOperationForOwner({ ownerUserId: actor.userId, operationId: input.operationId,
        ...(input.operation === "inspect" && input.activityBefore !== undefined ? { activityBefore: input.activityBefore } : {}),
      });
    } catch {
      return failure("not_found");
    }
    if (!await authorized(actor, operation)) return failure("forbidden");
    return operation.controlEpoch === input.expectedControlEpoch ? operation : failure("conflict");
  }

  async function schedule(
    operation: ConnectedWebOperation,
    due: Date,
    nextActivity: ConnectedWebOperationSafeActivity,
    requestedWakeAt?: Date,
  ): Promise<ConnectedWebOperationSafeProjection | null> {
    try {
      const now = clock.now();
      const persisted = await options.store.scheduleOperationCheck({
        operationId: operation.id,
        expectedControlEpoch: operation.controlEpoch,
        now,
        dueAt: due < now ? now : due,
        safeActivity: nextActivity,
        ...(requestedWakeAt === undefined ? {} : { requestedWakeAt: requestedWakeAt < now ? now : requestedWakeAt }),
      });
      return persisted
        ? projection({ ...operation, driver: "checking", lifecycle: "running", safeActivity: nextActivity })
        : null;
    } catch {
      return null;
    }
  }

  async function cancelAndProveTerminal(operation: ConnectedWebOperation, runId: string): Promise<boolean> {
    let cancellation: ProviderResult<ProviderRun>;
    try {
      cancellation = await withProvider(operation, "recover", (provider) => provider.cancelHostedReadRun(runId));
    } catch {
      return false;
    }
    // A missing provider row is not terminal truth for a steer: it may be a
    // transient/control-plane visibility gap. Do not create a replacement.
    if (providerFailure(cancellation)) return false;
    let observed: ProviderResult<ProviderRun>;
    try {
      observed = await withProvider(operation, "recover", (provider) => provider.pollHostedReadRun(runId));
    } catch {
      return false;
    }
    return !providerFailure(observed) && observed.runId === runId && isTerminal(observed.status);
  }

  async function stop(operation: ConnectedWebOperation): Promise<ConnectedWebOperationToolResult> {
    if (operation.lifecycle === "terminal") return accepted("stop", operation);
    if (operation.driver !== "hosted" && operation.driver !== "checking") return failure("unavailable");
    let cancellationAccepted = false;
    try {
      const coordinates = options.secrets.unsealProviderReferences({
        context: secretContext(operation), references: operation.sealedProviderRefs,
      });
      if (coordinates.runId !== undefined) {
        // Cancellation is intentionally idempotent, but its acknowledgement is
        // not a terminal receipt. The supervisor performs the next observation.
        const cancellation = await withProvider(operation, "recover", (provider) => provider.cancelHostedReadRun(coordinates.runId!));
        // A missing provider run is not completion/terminal truth. The
        // supervisor currently rechecks that state, so surface this Stop as
        // unavailable rather than claiming it was accepted by the provider.
        cancellationAccepted = !providerFailure(cancellation);
      }
    } catch {
      // A missing coordinate is also reconciliation work; do not claim stop.
    }
    // A failure result promises that no management control was accepted. The
    // operation remains under its prior durable supervision cadence; do not
    // hide a scheduling mutation behind `unavailable`.
    if (!cancellationAccepted) return failure("unavailable");
    const nextActivity = activity("checking", "stop_reconciliation_scheduled", "Stop was requested; Nautilo is reconciling the connected website operation.");
    const scheduled = await schedule(operation, clock.now(), nextActivity);
    return scheduled === null
      ? failure("conflict")
      : { ok: true, accepted: "stop", operation: scheduled };
  }

  function steer(operation: ConnectedWebOperation): ConnectedWebOperationToolResult {
    // An admitted external effect has a separate action ledger/postcondition
    // authority. A same-session replay would be an unproven repeat effect.
    if (operation.actionOperationId !== null || operation.effectIdempotencyKey !== null) return failure("conflict");
    if (operation.lifecycle === "terminal" || (operation.driver !== "hosted" && operation.driver !== "checking")) return failure("unavailable");
    // Browser Use exposes only provisional run usage and no settlement marker.
    // Cancelling a useful run would not prove the remaining hosted-run budget,
    // so steering cannot safely authorize a paid replacement. Keep the current
    // run and its supervision state intact; inspect, stop, and direct takeover
    // remain independent controls.
    return failure("steer_budget_unverified");
  }

  return {
    async manage(actor, input) {
      const loaded = await load(actor, input);
      if ("ok" in loaded) return loaded;
      const operation = loaded;
      if (input.operation === "inspect") return accepted("inspect", operation);
      if (input.operation === "take_control") {
        // Direct control is a supervision path for authenticated reads.  An
        // admitted external effect has its own confirmation, idempotency, and
        // postcondition ledger and must never cross into this approval-free
        // browser-control surface.
        if (operation.accountId === null || !options.direct || operation.actionOperationId !== null || operation.effectIdempotencyKey !== null
          || operation.lifecycle === "terminal" || (operation.driver !== "hosted" && operation.driver !== "checking")) return failure("unavailable");
        // Check local prerequisites before changing the epoch or cancelling
        // the hosted writer. A missing binary must leave useful work running.
        if (!await options.direct.preflight().catch(() => false)) return failure("unavailable");
        let coordinates: ReturnType<ConnectedWebOperationManagementSecrets["unsealProviderReferences"]>;
        try { coordinates = options.secrets.unsealProviderReferences({ context: secretContext(operation), references: operation.sealedProviderRefs }); } catch { return failure("unavailable"); }
        if (!coordinates.runId || !operation.sealedProviderRefs.runRef) return failure("unavailable");

        // Fence the background supervisor before cancellation or browser
        // startup. Without this epoch rotation, it can terminalize the row
        // between direct admission and the final browser lease CAS. The claim
        // remains due and expires, so a process loss resumes reconciliation.
        const takeoverWorkerId = `direct-takeover:${randomUUID()}`;
        const preparingActivity = activity("checking", "direct_takeover_preparing", "Moxie is taking direct control of the connected website.");
        let takeoverEpoch: number | null;
        try {
          takeoverEpoch = await options.store.claimOperationForControl({
            operationId: operation.id,
            ownerUserId: operation.ownerUserId,
            expectedControlEpoch: operation.controlEpoch,
            expectedRunRef: operation.sealedProviderRefs.runRef,
            workerId: takeoverWorkerId,
            now: clock.now(),
            leaseMs: DIRECT_TAKEOVER_CLAIM_LEASE_MS,
            safeActivity: preparingActivity,
          });
        } catch {
          takeoverEpoch = null;
        }
        if (takeoverEpoch === null) return failure("conflict");
        const releaseTakeoverClaim = async () => {
          await options.store.releaseOperationClaim({
            operationId: operation.id,
            workerId: takeoverWorkerId,
            expectedControlEpoch: takeoverEpoch,
            now: clock.now(),
            nextCheckAt: clock.now(),
          }).catch(() => false);
        };

        // The direct router is admitted only after the exact hosted writer is
        // cancelled and re-observed terminal under the takeover fence.
        if (!await cancelAndProveTerminal(operation, coordinates.runId)) {
          await releaseTakeoverClaim();
          return failure("unavailable");
        }
        const next = await options.direct.takeControl(actor, {
          operationId: operation.id,
          expectedControlEpoch: takeoverEpoch,
        });
        if (next === null) await releaseTakeoverClaim();
        return next === null ? failure("conflict") : { ok: true, accepted: "take_control", operation: next };
      }
      if (input.operation === "release_control") {
        if (!options.direct || operation.driver !== "direct") return failure("unavailable");
        const next = await options.direct.release(actor, input);
        return next === null ? failure("conflict") : { ok: true, accepted: "release_control", operation: next };
      }
      if (input.operation === "check_later") {
        const requestedDueAt = dueAt(input.dueAt);
        if (requestedDueAt === null || requestedDueAt < clock.now()) return failure("conflict");
        const nextActivity = activity("checking", "check_scheduled", "Connected website work will be checked at the requested time.");
        const scheduled = await schedule(operation, requestedDueAt, nextActivity, requestedDueAt);
        return scheduled === null ? failure("conflict") : { ok: true, accepted: "check_later", operation: scheduled };
      }
      if (input.operation === "continue") {
        if (operation.lifecycle === "terminal") return accepted("continue", operation);
        const nextActivity = activity("checking", "supervision_scheduled", "Connected website work is scheduled for immediate supervision.");
        const scheduled = await schedule(operation, clock.now(), nextActivity);
        return scheduled === null ? failure("conflict") : { ok: true, accepted: "continue", operation: scheduled };
      }
      if (input.operation === "stop") {
        if (operation.driver === "direct") {
          if (!options.direct?.stopOperation) return failure("unavailable");
          const next = await options.direct.stopOperation(actor, input);
          return next === null ? failure("conflict") : { ok: true, accepted: "stop", operation: next };
        }
        return stop(operation);
      }
      return steer(operation);
    },
  };
}
