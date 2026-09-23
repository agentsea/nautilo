import type {
  BrowserUseHostedReadResult,
  BrowserUseHostedReadRun,
  BrowserUseHostedRunEvent,
  BrowserUseHostedRunEventDelta,
  BrowserUseProviderFailure,
  BrowserUseResult,
} from "../browser-use/browser-use-cloud";
import { createHash } from "node:crypto";
import { isUuidString } from "@nautilo/trust";
import { connectedWebActivityFromEvents } from "./activity-ledger";
import { connectedWebRunCost } from "./operation-cost";
import type {
  ConnectedWebAccountStore,
  ConnectedWebOperation,
} from "./store";
import type { ConnectedWebAccount } from "@nautilo/types";
import {
  parseConnectedWebProviderCost,
  parseConnectedWebProviderOutcome,
  type ConnectedWebTerminalReadResult,
} from "./read-result-contract";
import type {
  ConnectedWebOperationProviderReferences,
  ConnectedWebOperationSafeActivity,
  ConnectedWebOperationSafeReceipt,
} from "@nautilo/db";

export interface ConnectedWebOperationSupervisorClock {
  now(): Date;
}

/** Unsealed provider coordinates may exist only inside this DI boundary. */
export interface ConnectedWebOperationProviderReferenceCodec {
  unseal(input: {
    readonly operationId: string;
    readonly references: ConnectedWebOperationProviderReferences;
  }): Promise<{
    readonly runId: string | null;
    readonly sessionId: string | null;
    readonly workspaceId: string | null;
    readonly browserId: string | null;
  } | null>;
  unsealIntent?(input: {
    readonly operation: ConnectedWebOperation;
  }): Promise<string | null>;
}

/** Narrow provider surface: this worker never creates, queues, cancels, or stops a run. */
export interface ConnectedWebOperationSupervisorProvider {
  pollHostedReadRun(runId: string): Promise<BrowserUseResult<BrowserUseHostedReadRun>>;
  readHostedRunEventDelta(input: {
    readonly runId: string;
    readonly after: number;
    readonly limit: number;
  }): Promise<BrowserUseResult<BrowserUseHostedRunEventDelta>>;
  getHostedReadResult(runId: string): Promise<BrowserUseResult<BrowserUseHostedReadResult>>;
}

export type ConnectedWebOperationSupervisorRescheduleReason = "provider_active" | "provider_unavailable" | "missing_provider_reference";

export interface ConnectedWebOperationSupervisorOptions {
  readonly store: Pick<
    ConnectedWebAccountStore,
    "claimDueOperations" | "releaseOperationClaim" | "recordOperationCheckpoint" | "terminalizeOperation"
    | "terminalizeReadOperationAndCompleteExecution"
  > & Partial<Pick<ConnectedWebAccountStore, "getForOwner">>;
  readonly provider: ConnectedWebOperationSupervisorProvider;
  readonly providerReferences: ConnectedWebOperationProviderReferenceCodec;
  readonly clock: ConnectedWebOperationSupervisorClock;
  /** V4 cursor page size, supplied by boot policy rather than hidden in the worker. */
  readonly eventPageLimit: number;
  /** Operational revisit cadence, not an operation deadline or blind retry. */
  readonly nextCheckAt: (input: {
    readonly operation: ConnectedWebOperation;
    readonly now: Date;
    readonly reason: ConnectedWebOperationSupervisorRescheduleReason;
  }) => Date;
}

export interface ConnectedWebOperationSupervisorRunOnceInput {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly batch?: number;
}

export interface ConnectedWebOperationSupervisorRunOnceResult {
  readonly claimed: number;
  readonly reconciled: number;
  readonly rescheduled: number;
  readonly terminalized: number;
  readonly stale: number;
}

type OperationProcessingResult = "reconciled" | "rescheduled" | "terminalized" | "stale";

const TERMINAL_RUN_STATUSES = new Set<BrowserUseHostedReadRun["status"]>(["completed", "failed", "cancelled"]);

function isTerminalRunStatus(
  status: BrowserUseHostedReadRun["status"],
): status is Extract<BrowserUseHostedReadRun["status"], "completed" | "failed" | "cancelled"> {
  return TERMINAL_RUN_STATUSES.has(status);
}

function isProviderFailure(value: unknown): value is BrowserUseProviderFailure {
  return typeof value === "object" && value !== null
    && (value as { readonly kind?: unknown }).kind === "failure";
}

function activity(
  phase: ConnectedWebOperationSafeActivity["phase"],
  code: string,
  summary: string,
): ConnectedWebOperationSafeActivity {
  return { version: 1, phase, code, summary };
}

function statusActivity(status: BrowserUseHostedReadRun["status"]): ConnectedWebOperationSafeActivity {
  switch (status) {
    case "queued":
    case "dispatching":
      return activity("starting", "provider_starting", "Browser agent is starting the connected website task.");
    case "running":
      return activity("working", "provider_running", "Browser agent is working on the connected website task.");
    case "completed":
    case "failed":
    case "cancelled":
      return activity("finishing", "provider_terminal", "Browser agent reached a terminal state; Nautilo is reconciling it.");
  }
}

/** Never uses event data or event type text as status output. */
function normalizeEventActivity(
  events: readonly BrowserUseHostedRunEvent[],
  fallback: ConnectedWebOperationSafeActivity,
): ConnectedWebOperationSafeActivity {
  let next = fallback;
  for (const event of events) {
    const type = event.type.toLocaleLowerCase("en-US");
    // Human takeover requires a separately validated terminal/auth contract.
    // Event names alone do not prove the hosted run stopped, so they cannot
    // switch the exclusive writer lease away from Browser Use here.
    if (type === "browser.ready") {
      next = activity("working", "provider_browser_ready", "Browser agent opened the connected website.");
    } else if (/(?:artifact|file|download|upload)/u.test(type)) {
      next = activity("working", "provider_artifact_activity", "Browser agent is handling a requested website artifact.");
    } else if (/(?:complete|result|finish)/u.test(type)) {
      next = activity("finishing", "provider_finishing", "Browser agent is finishing the connected website task.");
    } else if (/(?:tool|browser|action|navigation)/u.test(type)) {
      next = activity("working", "provider_browser_activity", "Browser agent is working in the connected website.");
    } else if (/(?:model|llm|plan)/u.test(type)) {
      next = activity("working", "provider_planning", "Browser agent is planning the connected website task.");
    } else {
      next = activity("working", "provider_activity", "Browser agent reported connected website activity.");
    }
  }
  return next;
}

function checkpointWakeFingerprint(input: {
  readonly operation: ConnectedWebOperation;
  readonly cursor: number;
  readonly activity: ConnectedWebOperationSafeActivity;
  readonly reason: "browser_ready" | "artifact" | "terminal" | "browser_action";
}): string {
  // The fingerprint is stable and provider-coordinate-free as a stored value.
  // It lets the later wake worker deduplicate delivery without exposing an
  // event ID, run ID, or event data outside server custody.
  return createHash("sha256")
    .update("nautilo:connected-web:checkpoint:v1\0")
    .update(input.operation.id)
    .update("\0")
    .update(String(input.operation.controlEpoch))
    .update("\0")
    .update(String(input.cursor))
    .update("\0")
    .update(input.activity.code)
    .update("\0")
    .update(input.reason)
    .digest("hex");
}

function eventWakeFingerprint(input: {
  readonly operation: ConnectedWebOperation;
  readonly events: readonly BrowserUseHostedRunEvent[];
  readonly cursor: number;
  readonly activity: ConnectedWebOperationSafeActivity;
}): string | undefined {
  if (input.events.some((event) => /^(?:artifact|file|download)\./iu.test(event.type))) {
    return checkpointWakeFingerprint({ ...input, reason: "artifact" });
  }
  return undefined;
}

function terminalReceipt(
  status: Extract<BrowserUseHostedReadRun["status"], "completed" | "failed" | "cancelled">,
  actionOperationId: string | null,
  costKnown: boolean,
): ConnectedWebOperationSafeReceipt {
  const receipt: ConnectedWebOperationSafeReceipt = status === "completed"
    ? { version: 1 as const, outcome: "completed" as const, code: costKnown ? "provider_completed" : "provider_completed_cost_unknown", summary: costKnown ? "Connected website work completed." : "Connected website work completed; cost details were unavailable, so continuation budget is disabled." }
    : status === "cancelled"
      ? { version: 1 as const, outcome: "cancelled" as const, code: costKnown ? "provider_cancelled" : "provider_cancelled_cost_unknown", summary: costKnown ? "Connected website work was cancelled." : "Connected website work was cancelled; cost details were unavailable, so continuation budget is disabled." }
      : { version: 1 as const, outcome: "failed" as const, code: costKnown ? "provider_failed" : "provider_failed_cost_unknown", summary: costKnown ? "Connected website work ended without a completed result." : "Connected website work ended without a completed result; cost details were unavailable, so continuation budget is disabled." };
  return actionOperationId === null ? receipt : { ...receipt, actionOperationId };
}


type SealedReadIntent = Readonly<{ readonly origin: string; readonly delivery: "text"; readonly publicTarget: boolean; }>;

/** Re-validate the sealed async-admission authority before projecting any text. */
function parseSealedReadIntent(operation: ConnectedWebOperation, raw: string | null): SealedReadIntent | null {
  if (raw === null || raw.length > 16_384) return null;
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const intent = value as Record<string, unknown>;
  const keys = Object.keys(intent).filter((key) => key !== "voiceMode" && !(operation.accountId === null && key === "targetUrl")).sort();
  const expected = ["delivery", "deliveryId", "fundingHumanUserId", "kind", "lane", "origin", "request", "threadId", "turnId", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
    || intent["version"] !== 2 || typeof intent["fundingHumanUserId"] !== "string" || !isUuidString(intent["fundingHumanUserId"])
    || (intent["kind"] !== "run_website_task" && intent["kind"] !== (operation.accountId === null ? "browse_web" : "read_connected_web_account")) || intent["delivery"] !== "text"
    || typeof intent["origin"] !== "string" || intent["origin"].trim().length === 0
    || typeof intent["request"] !== "string" || intent["request"].trim().length === 0
    || intent["deliveryId"] !== operation.deliveryId || intent["threadId"] !== operation.initiatingThreadId
    || intent["lane"] !== operation.initiatingLane || typeof intent["turnId"] !== "string" || intent["turnId"].trim().length === 0) return null;
  if (intent["voiceMode"] !== undefined && typeof intent["voiceMode"] !== "boolean") return null;
  if (operation.accountId === null) {
    try { if (typeof intent["targetUrl"] !== "string" || new URL(intent["targetUrl"]).origin !== intent["origin"]) return null; }
    catch { return null; }
  }
  return { origin: intent["origin"], delivery: "text", publicTarget: operation.accountId === null };
}

function terminalReadSnapshot(input: {
  readonly account: ConnectedWebAccount | null;
  readonly operationId: string;
  readonly intent: SealedReadIntent;
  readonly summary: BrowserUseHostedReadResult;
}): { readonly auth: false; readonly result: ConnectedWebTerminalReadResult | null } | { readonly auth: true; readonly reason: "sign_in" | "mfa" | "captcha"; readonly result: null } {
  const parsed = parseConnectedWebProviderOutcome(input.summary.result, input.intent.origin);
  if (parsed?.kind === "authentication_required") return { auth: true, reason: parsed.reason, result: null };
  const cost = parseConnectedWebProviderCost(input.summary.totalCostUsd);
  if (!cost || (input.account !== null && (input.account.id.trim().length === 0 || input.account.origin !== input.intent.origin))) return { auth: false, result: null };
  return {
    auth: false,
    result: {
      version: 1,
      account: input.account === null ? null : { id: input.account.id, label: input.account.label, service: input.account.service, origin: input.intent.origin },
      page: { ref: input.account?.id ?? input.operationId, title: input.account?.label ?? new URL(input.intent.origin).hostname, origin: input.intent.origin },
      read: parsed?.kind === "read" ? {
        answer: parsed.answer, facts: parsed.facts, completeness: parsed.completeness,
        // Server binds this wording, rather than trusting a provider claim.
        provenance: input.intent.publicTarget ? "public_website" : "authenticated_website", origin: input.intent.origin,
      } : null,
      cost: { currency: "USD", ...cost },
      outputs: [],
      outputsTruncated: false,
    },
  };
}

/**
 * One restart-safe supervisor pass. It is deliberately not a scheduler and
 * does not wake a Genie, mutate an account, or make a new Browser Use run.
 */
export class ConnectedWebOperationSupervisor {
  private readonly store: ConnectedWebOperationSupervisorOptions["store"];
  private readonly provider: ConnectedWebOperationSupervisorProvider;
  private readonly providerReferences: ConnectedWebOperationProviderReferenceCodec;
  private readonly clock: ConnectedWebOperationSupervisorClock;
  private readonly eventPageLimit: number;
  private readonly nextCheckAt: ConnectedWebOperationSupervisorOptions["nextCheckAt"];

  constructor(options: ConnectedWebOperationSupervisorOptions) {
    if (!Number.isSafeInteger(options.eventPageLimit) || options.eventPageLimit < 1) {
      throw new Error("connected website event page limit must be a positive safe integer");
    }
    this.store = options.store;
    this.provider = options.provider;
    this.providerReferences = options.providerReferences;
    this.clock = options.clock;
    this.eventPageLimit = options.eventPageLimit;
    this.nextCheckAt = options.nextCheckAt;
  }

  async runOnce(input: ConnectedWebOperationSupervisorRunOnceInput): Promise<ConnectedWebOperationSupervisorRunOnceResult> {
    const now = this.clock.now();
    const claimed = await this.store.claimDueOperations({ workerId: input.workerId, now, leaseMs: input.leaseMs, ...(input.batch === undefined ? {} : { batch: input.batch }) });
    const result: { claimed: number; reconciled: number; rescheduled: number; terminalized: number; stale: number } = {
      claimed: claimed.length, reconciled: 0, rescheduled: 0, terminalized: 0, stale: 0,
    };
    for (const operation of claimed) {
      const outcome = await this.reconcileClaim({ operation, workerId: input.workerId });
      result[outcome] += 1;
    }
    return result;
  }

  private async reconcileClaim(input: {
    readonly operation: ConnectedWebOperation;
    readonly workerId: string;
  }): Promise<OperationProcessingResult> {
    const now = this.clock.now();
    const { operation, workerId } = input;
    // Another driver owns direct/Human input. Do not poll it or retain a
    // hosted-worker claim; its future control path will schedule its own work.
    if (operation.driver !== "hosted" && operation.driver !== "checking") {
      const released = await this.store.releaseOperationClaim({
        operationId: operation.id, workerId, expectedControlEpoch: operation.controlEpoch, now, nextCheckAt: null,
      });
      return released ? "reconciled" : "stale";
    }

    let unsealed: Awaited<ReturnType<ConnectedWebOperationProviderReferenceCodec["unseal"]>>;
    try {
      unsealed = await this.providerReferences.unseal({ operationId: operation.id, references: operation.sealedProviderRefs });
    } catch {
      return this.reschedule(input, "missing_provider_reference", activity("checking", "provider_reference_unavailable", "Waiting to reconcile the connected website operation."));
    }
    if (!unsealed?.runId) {
      return this.reschedule(input, "missing_provider_reference", activity("checking", "provider_reference_unavailable", "Waiting to reconcile the connected website operation."));
    }

    const status = await this.provider.pollHostedReadRun(unsealed.runId).catch(() => ({ kind: "failure", code: "network_error" } as const));
    if (isProviderFailure(status)) {
      return this.reschedule(input, "provider_unavailable", activity("checking", "provider_check_pending", "Waiting to recheck the connected website operation."));
    }

    let current = operation;
    let nextActivity = current.safeActivity.code === "browser_action" && !isTerminalRunStatus(status.status)
      ? current.safeActivity : statusActivity(status.status);
    for (;;) {
      const page = await this.provider.readHostedRunEventDelta({
        runId: unsealed.runId,
        after: current.eventCursor,
        limit: this.eventPageLimit,
      }).catch(() => ({ kind: "failure", code: "network_error" } as const));
      if (isProviderFailure(page)) {
        return this.reschedule({ operation: current, workerId }, "provider_unavailable", activity("checking", "provider_check_pending", "Waiting to recheck the connected website operation."));
      }
      nextActivity = normalizeEventActivity(page.events, nextActivity);
      const activityEntries = connectedWebActivityFromEvents(page.events);
      const latestAction = activityEntries.at(-1);
      if (latestAction) nextActivity = activity("working", "browser_action", latestAction.summary);
      const nextCursor = page.nextAfter ?? current.eventCursor;
      const wakeFingerprint = latestAction && latestAction.status === "error"
        ? checkpointWakeFingerprint({ operation: current, cursor: nextCursor, activity: nextActivity, reason: "browser_action" })
        : eventWakeFingerprint({
        operation: current,
        events: page.events,
        cursor: nextCursor,
        activity: nextActivity,
      });
      const persisted = await this.store.recordOperationCheckpoint({
        operationId: current.id,
        workerId,
        now: this.clock.now(),
        expectedControlEpoch: current.controlEpoch,
        expectedEventCursor: current.eventCursor,
        expectedRunRef: current.sealedProviderRefs.runRef ?? null,
        sealedProviderRefs: current.sealedProviderRefs,
        eventCursor: nextCursor,
        activityEntries,
        safeActivity: nextActivity,
        ...(wakeFingerprint === undefined ? {} : { wakeFingerprint }),
        // This page is durable before the later release/terminal write. Keep
        // it due across that crash boundary; a NULL would make a nonterminal
        // row invisible to `claimDueOperations` after restart.
        nextCheckAt: this.clock.now(),
        lifecycle: "running",
        driver: current.driver,
        cumulativeCostUsdMicros: current.cumulativeCostUsdMicros,
        remainingBudgetUsdMicros: current.remainingBudgetUsdMicros,
      });
      if (!persisted) return "stale";
      current = {
        ...current,
        eventCursor: nextCursor,
        safeActivity: nextActivity,
        lifecycle: "running",
        driver: current.driver,
      };
      if (!page.hasMore) break;
    }

    if (!isTerminalRunStatus(status.status)) {
      return this.reschedule({ operation: current, workerId }, "provider_active", nextActivity);
    }

    const summary = await this.provider.getHostedReadResult(unsealed.runId).catch(() => ({ kind: "failure", code: "network_error" } as const));
    if (isProviderFailure(summary) || summary.status !== status.status) {
      return this.reschedule({ operation: current, workerId }, "provider_unavailable", activity("checking", "provider_terminal_pending", "Waiting to verify the connected website result."));
    }
    const cost = connectedWebRunCost({ operation: current, result: summary });
    if (cost === null) {
      return this.reschedule({ operation: current, workerId }, "provider_unavailable", activity("checking", "provider_cost_pending", "Waiting to verify connected website cost details."));
    }
    let terminalRead: ReturnType<typeof terminalReadSnapshot> = { auth: false, result: null };
    let invalidReadAuthority = false;
    if (status.status === "completed" && current.actionOperationId === null) {
      let intent: SealedReadIntent | null = null;
      let account: ConnectedWebAccount | null = null;
      try {
        intent = parseSealedReadIntent(current, this.providerReferences.unsealIntent === undefined ? null : await this.providerReferences.unsealIntent({ operation: current }));
        account = current.accountId === null || this.store.getForOwner === undefined ? null : await this.store.getForOwner({ ownerUserId: current.ownerUserId, accountId: current.accountId });
      } catch {
        return this.reschedule({ operation: current, workerId }, "provider_unavailable", activity("checking", "read_finalization_pending", "Waiting to safely record the connected website result."));
      }
      // Malformed provider summaries are completed with null read. A corrupt
      // sealed authority is different: terminal provider truth must release
      // the fence, but it cannot be presented as a completed read.
      if (intent === null || (current.accountId !== null && (account === null || account.id !== current.accountId || account.origin !== intent.origin))) {
        invalidReadAuthority = true;
      } else {
        terminalRead = terminalReadSnapshot({ account, intent, summary, operationId: current.id });
      }
    }
    const costActivity = cost.exceeded
      ? activity("finishing", "provider_cost_exceeded", "Connected website work exceeded its authorized budget and is being recorded safely.")
      : !cost.known
        ? activity("finishing", "provider_cost_unknown", "Connected website work finished; cost details were unavailable.")
      : activity("finishing", "provider_terminal_verified", "Connected website work finished; Nautilo is recording the result.");
    // Cost and terminal truth are one write. If the receipt transaction fails,
    // a later pass must not deduct this same run from the budget a second time.
    const finalCheckpoint = {
      safeActivity: costActivity,
      wakeFingerprint: checkpointWakeFingerprint({
        operation: current,
        cursor: current.eventCursor,
        activity: costActivity,
        reason: "terminal",
      }),
      cumulativeCostUsdMicros: cost.cumulative,
      remainingBudgetUsdMicros: cost.remaining,
    };
    const receipt: ConnectedWebOperationSafeReceipt = invalidReadAuthority
      ? { version: 1, outcome: "failed", code: "invalid_read_authority", summary: "Connected website work completed, but its stored read authority could not be verified." }
      : terminalRead.auth
      ? { version: 1, outcome: "attention_required", code: "authentication_required", summary: "Connected website sign-in needs Human attention." }
      : current.accountId === null && status.status === "completed" && terminalRead.result?.read == null
      ? { version: 1, outcome: "failed", code: "invalid_result", summary: "The browser run ended without a valid research result." }
      : cost.exceeded
      ? {
        version: 1 as const,
        outcome: "failed" as const,
        code: "provider_cost_exceeded",
        summary: "Connected website work exceeded its authorized budget.",
        ...(current.actionOperationId === null ? {} : { actionOperationId: current.actionOperationId }),
      }
      : terminalReceipt(status.status, current.actionOperationId, cost.known);
    // A terminal read cannot be committed independently of its exact account
    // writer release: a crash between those writes would strand the account
    // busy forever because a terminal row is not claimed again.
    const terminalized = current.actionOperationId === null
      ? await this.store.terminalizeReadOperationAndCompleteExecution({
        operationId: current.id,
        ownerUserId: current.ownerUserId,
        accountId: current.accountId,
        expectedControlEpoch: current.controlEpoch,
        expectedRunRef: current.sealedProviderRefs.runRef!,
        opaqueExecutionRef: unsealed.runId,
        now: this.clock.now(),
        receipt,
        ...finalCheckpoint,
        terminalReadResult: status.status === "completed" && receipt.outcome === "completed" && !cost.exceeded ? terminalRead.result : null,
        ...(terminalRead.auth ? { authenticationRequired: terminalRead.reason } : {}),
      }).catch(() => false)
      : await this.store.terminalizeOperation({
        operationId: current.id,
        expectedControlEpoch: current.controlEpoch,
        expectedRunRef: current.sealedProviderRefs.runRef ?? null,
        now: this.clock.now(),
        receipt,
        ...finalCheckpoint,
      }).catch(() => false);
    return terminalized ? "terminalized" : "stale";
  }

  private async reschedule(
    input: { readonly operation: ConnectedWebOperation; readonly workerId: string },
    reason: ConnectedWebOperationSupervisorRescheduleReason,
    safeActivity: ConnectedWebOperationSafeActivity,
  ): Promise<OperationProcessingResult> {
    const now = this.clock.now();
    const nextCheckAt = this.nextCheckAt({ operation: input.operation, now, reason });
    const persisted = await this.store.recordOperationCheckpoint({
      operationId: input.operation.id,
      workerId: input.workerId,
      now,
      expectedControlEpoch: input.operation.controlEpoch,
      expectedEventCursor: input.operation.eventCursor,
      expectedRunRef: input.operation.sealedProviderRefs.runRef ?? null,
      sealedProviderRefs: input.operation.sealedProviderRefs,
      eventCursor: input.operation.eventCursor,
      safeActivity,
      nextCheckAt,
      lifecycle: "running",
      driver: input.operation.driver === "checking" ? "checking" : "hosted",
      cumulativeCostUsdMicros: input.operation.cumulativeCostUsdMicros,
      remainingBudgetUsdMicros: input.operation.remainingBudgetUsdMicros,
    });
    if (!persisted) return "stale";
    const released = await this.store.releaseOperationClaim({
      operationId: input.operation.id,
      workerId: input.workerId,
      expectedControlEpoch: input.operation.controlEpoch,
      now: this.clock.now(),
      nextCheckAt,
    });
    return released ? "rescheduled" : "stale";
  }
}
