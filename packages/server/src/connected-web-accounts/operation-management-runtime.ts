import type {
  ConnectedWebOperationSafeProjection,
  ConnectedWebOperationToolActorContext,
  ConnectedWebOperationToolInput,
  ConnectedWebOperationToolResult,
  ConnectedWebOperationToolRuntime,
} from "@nautilo/agent";
import { buildConnectedWebReadTask, buildPublicBrowserReadTask } from "./read-operation-admission-runtime";
import { buildWebsiteTask, canRunWebsiteTask } from "./website-task-contract";
import { randomUUID } from "node:crypto";
import { connectedWebRunCost } from "./operation-cost";
import type {
  ConnectedWebOperationProviderReferences,
  ConnectedWebOperationSafeActivity,
} from "@nautilo/db";
import type { ConnectedWebOperation } from "./store";
import type { ConnectedWebAccountReadFacts } from "./read-tool-runtime";
import type { ConnectedWebAccountStore } from "./store";

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
  getHostedReadResult(runId: string): Promise<ProviderResult<ProviderRun & { readonly totalCostUsd: string | null }>>;
  cancelHostedReadRun(runId: string): Promise<ProviderResult<ProviderRun>>;
  pollHostedReadRun(runId: string): Promise<ProviderResult<ProviderRun>>;
  inspectHostedSessionQueue(sessionId: string): Promise<ProviderResult<unknown>>;
  createHostedReadContinuationRun(input: {
    readonly sessionId: string;
    readonly workspaceId?: string;
    readonly task: string;
    readonly model: string;
    readonly maxCostUsd: number;
  }): Promise<ProviderResult<ProviderRun>>;
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
  }): { readonly runId?: string; readonly sessionId?: string; readonly workspaceId?: string; readonly browserId?: string };
  sealProviderReferences(input: {
    readonly context: { readonly operationId: string; readonly ownerUserId: string; readonly accountId: string | null };
    readonly coordinates: { readonly runId?: string; readonly sessionId?: string; readonly workspaceId?: string; readonly browserId?: string };
  }): ConnectedWebOperationProviderReferences;
}

export interface ConnectedWebOperationManagementClock {
  now(): Date;
}

export interface ConnectedWebOperationManagementRuntimeOptions {
  readonly facts: ConnectedWebAccountReadFacts;
  readonly store: Pick<
    ConnectedWebAccountStore,
    "getOperationForOwner" | "scheduleOperationCheck" | "rotateOperationProviderRunByControl"
      | "claimOperationForControl" | "releaseOperationClaim"
  >;
  readonly provider: ConnectedWebOperationManagementProvider;
  readonly secrets: ConnectedWebOperationManagementSecrets;
  /** Explicit continuation model; never inferred from provider defaults. */
  readonly continuationModel: string;
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

function failure(code: "unavailable" | "not_found" | "forbidden" | "conflict" | "invalid_result"): ConnectedWebOperationToolResult {
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
      outputs: [],
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

function validContinuationModel(value: string): boolean {
  return value.trim().length > 0 && value.length <= 256;
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

  async function cancelAndProveTerminal(runId: string): Promise<boolean> {
    let cancellation: ProviderResult<ProviderRun>;
    try {
      cancellation = await options.provider.cancelHostedReadRun(runId);
    } catch {
      return false;
    }
    // A missing provider row is not terminal truth for a steer: it may be a
    // transient/control-plane visibility gap. Do not create a replacement.
    if (providerFailure(cancellation)) return false;
    let observed: ProviderResult<ProviderRun>;
    try {
      observed = await options.provider.pollHostedReadRun(runId);
    } catch {
      return false;
    }
    return !providerFailure(observed) && observed.runId === runId && isTerminal(observed.status);
  }

  async function scheduleSteerRecovery(operation: ConnectedWebOperation): Promise<void> {
    await schedule(
      operation,
      clock.now(),
      activity("attention", "steer_reconciliation_pending", "The requested direction could not be started; Nautilo is reconciling the connected website operation."),
    );
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
        const cancellation = await options.provider.cancelHostedReadRun(coordinates.runId);
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

  async function steer(
    operation: ConnectedWebOperation,
    instruction: string,
  ): Promise<ConnectedWebOperationToolResult> {
    // An admitted external effect has a separate action ledger/postcondition
    // authority. A same-session replay would be an unproven repeat effect.
    if (operation.actionOperationId !== null || operation.effectIdempotencyKey !== null) return failure("conflict");
    if (operation.lifecycle === "terminal" || (operation.driver !== "hosted" && operation.driver !== "checking")) return failure("unavailable");
    if (!validContinuationModel(options.continuationModel) || operation.remainingBudgetUsdMicros <= 0) return failure("unavailable");

    let coordinates: ReturnType<ConnectedWebOperationManagementSecrets["unsealProviderReferences"]>;
    let originalIntent: string;
    try {
      const context = secretContext(operation);
      coordinates = options.secrets.unsealProviderReferences({ context, references: operation.sealedProviderRefs });
      originalIntent = options.secrets.unsealIntent({ context, sealedIntent: operation.sealedIntent });
      const intent = JSON.parse(originalIntent) as Record<string, unknown>;
      if (typeof intent["origin"] !== "string" || typeof intent["request"] !== "string") return failure("invalid_result");
      if (operation.accountId === null) {
        if ((intent["kind"] !== "browse_web" && intent["kind"] !== "run_website_task") || typeof intent["targetUrl"] !== "string"
          || typeof intent["origin"] !== "string" || typeof intent["request"] !== "string"
          || new URL(intent["targetUrl"]).origin !== intent["origin"]) return failure("invalid_result");
        originalIntent = intent["kind"] === "run_website_task"
          ? buildWebsiteTask({ origin: intent["origin"], targetUrl: intent["targetUrl"], request: intent["request"] })
          : buildPublicBrowserReadTask({ origin: intent["origin"], targetUrl: intent["targetUrl"] }, intent["request"]);
      } else {
        originalIntent = intent["kind"] === "run_website_task"
          ? buildWebsiteTask({ origin: intent["origin"], request: intent["request"] })
          : buildConnectedWebReadTask({ origin: intent["origin"], request: { account: operation.accountId, request: intent["request"], delivery: "text" } });
      }
    } catch {
      return failure("unavailable");
    }
    if (!coordinates.runId || !coordinates.sessionId || originalIntent.trim().length === 0) return failure("unavailable");

    // V4 queue inspection is mandatory before steering. Its documented
    // interrupt handoff remains best-effort, so this runtime cannot honestly
    // claim a queued message altered the active run. Use a fenced replacement.
    try {
      const queue = await options.provider.inspectHostedSessionQueue(coordinates.sessionId);
      if (providerFailure(queue)) return failure("unavailable");
    } catch {
      return failure("unavailable");
    }

    const workerId = `hosted-steer:${randomUUID()}`;
    const claimedEpoch = await options.store.claimOperationForControl({
      operationId: operation.id, ownerUserId: operation.ownerUserId,
      expectedControlEpoch: operation.controlEpoch, expectedRunRef: operation.sealedProviderRefs.runRef!,
      workerId, now: clock.now(), leaseMs: DIRECT_TAKEOVER_CLAIM_LEASE_MS,
      safeActivity: activity("checking", "steer_preparing", "Your Genie is updating the connected website task."),
    }).catch(() => null);
    if (claimedEpoch === null) return failure("conflict");
    operation = { ...operation, controlEpoch: claimedEpoch };
    try {
      if (!await cancelAndProveTerminal(coordinates.runId)) {
        await scheduleSteerRecovery(operation);
        return failure("unavailable");
      }

      const previous = await options.provider.getHostedReadResult(coordinates.runId).catch(() => null);
      if (!previous || providerFailure(previous) || previous.runId !== coordinates.runId || !isTerminal(previous.status)) {
        await scheduleSteerRecovery(operation);
        return failure("unavailable");
      }
      const cost = connectedWebRunCost({ operation, result: previous });
      if (!cost || !cost.known || cost.exceeded || cost.remaining <= 0) {
        await scheduleSteerRecovery(operation);
        return failure("unavailable");
      }
      const maxCostUsd = cost.remaining / 1_000_000;
      let replacement: ProviderResult<ProviderRun>;
      try {
        // V4 creates have no idempotency key. A process death after POST reaches
        // the provider but before this runtime receives a run id is an
        // irreducible orphan-risk window; every observable post-create failure
        // path below cancels the exact replacement before returning.
        replacement = await options.provider.createHostedReadContinuationRun({
          sessionId: coordinates.sessionId,
          ...(coordinates.workspaceId === undefined ? {} : { workspaceId: coordinates.workspaceId }),
          task: `${originalIntent}\n\n[Steering instruction]\n${instruction}`,
          model: options.continuationModel,
          maxCostUsd,
        });
      } catch {
        await scheduleSteerRecovery(operation);
        return failure("unavailable");
      }
      if (providerFailure(replacement) || replacement.sessionId !== coordinates.sessionId || !replacement.workspaceId) {
        await scheduleSteerRecovery(operation);
        return failure("unavailable");
      }

      let observedReplacement: ProviderResult<ProviderRun>;
      try {
        observedReplacement = await options.provider.pollHostedReadRun(replacement.runId);
      } catch {
        observedReplacement = { kind: "failure", code: "network_error" };
      }
      if (providerFailure(observedReplacement) || observedReplacement.runId !== replacement.runId) {
        await options.provider.cancelHostedReadRun(replacement.runId).catch(() => undefined);
        await scheduleSteerRecovery(operation);
        return failure("unavailable");
      }

      const nextActivity = isTerminal(observedReplacement.status)
        ? activity("finishing", "steer_replacement_observed", "A replacement connected website run was observed and is waiting for reconciliation.")
        : activity("working", "steer_replacement_started", "A replacement connected website run is following the requested direction.");
      let nextEpoch: number | null = null;
      try {
        nextEpoch = await options.store.rotateOperationProviderRunByControl({
          workerId,
          expectedOpaqueExecutionRef: coordinates.runId,
          opaqueExecutionRef: replacement.runId,
          operationId: operation.id,
          ownerUserId: operation.ownerUserId,
          now: clock.now(),
          expectedControlEpoch: operation.controlEpoch,
          expectedRunRef: operation.sealedProviderRefs.runRef ?? null,
          sealedProviderRefs: options.secrets.sealProviderReferences({
            context: secretContext(operation),
            coordinates: {
              runId: replacement.runId,
              sessionId: replacement.sessionId,
              workspaceId: replacement.workspaceId,
            },
          }),
          safeActivity: nextActivity,
          nextCheckAt: clock.now(),
          cumulativeCostUsdMicros: cost.cumulative,
          remainingBudgetUsdMicros: cost.remaining,
        });
      } catch {
        nextEpoch = null;
      }
      if (nextEpoch === null) {
        await options.provider.cancelHostedReadRun(replacement.runId).catch(() => undefined);
        await scheduleSteerRecovery(operation);
        return failure("conflict");
      }
      return accepted("steer", {
        ...operation,
        driver: "hosted",
        lifecycle: "running",
        controlEpoch: nextEpoch,
        safeActivity: nextActivity,
        terminalReceipt: null,
      });
    } finally {
      await options.store.releaseOperationClaim({ operationId: operation.id, workerId,
        expectedControlEpoch: claimedEpoch, now: clock.now(), nextCheckAt: clock.now(),
      }).catch(() => false);
    }
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
        if (!await cancelAndProveTerminal(coordinates.runId)) {
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
      return steer(operation, input.instruction);
    },
  };
}
