import type {
  ConnectedWebOperationDirectCommand,
  ConnectedWebOperationDirectToolInput,
  ConnectedWebOperationDirectToolResult,
  ConnectedWebOperationDirectToolRuntime,
  ConnectedWebOperationDirectControlOptions,
  ConnectedWebOperationSafeProjection,
  ConnectedWebOperationToolActorContext,
} from "@nautilo/agent";
import { warn } from "@nautilo/logger";
import type { ConnectedWebAccountStore, ConnectedWebOperation } from "./store";
import {
  DirectBrowserRouter,
  DirectBrowserRouterError,
  type DirectBrowserRouterLease,
} from "./direct-browser-router";
import type { ConnectedWebAccountReadFacts } from "./read-tool-runtime";

type LeaseEntry = { readonly lease: DirectBrowserRouterLease; tail: Promise<void>; closing?: boolean };

export interface ConnectedWebOperationDirectRuntimeOptions {
  readonly authorizeOperation: (actor: ConnectedWebOperationToolActorContext, operation: ConnectedWebOperation) => boolean;
  readonly facts: ConnectedWebAccountReadFacts;
  readonly store: Pick<ConnectedWebAccountStore, "getOperationForOwner" | "recordDirectOperationActivity">;
  readonly router: DirectBrowserRouter;
  /** Listener-start durable cleanup; it never reconstructs a lease. */
  readonly recover?: () => Promise<void>;
  /** Exact cleanup for an owned durable row with no live lease. Never reattaches. */
  readonly recoverOperation?: (operation: ConnectedWebOperation) => Promise<boolean>;
  /** Production checks the local executable without opening a browser. */
  readonly checkAvailability?: () => Promise<void>;
  readonly now?: () => Date;
}

function sameForegroundAuthority(actor: ConnectedWebOperationToolActorContext, operation: ConnectedWebOperation): boolean {
  return actor.userId === operation.ownerUserId && actor.agentId === operation.initiatingAgentId
    && actor.roomId === operation.initiatingRoomId && actor.currentThreadId === operation.initiatingThreadId
    && actor.laneKey !== undefined && actor.laneKey === operation.initiatingLane && actor.callingRoomId === null
    && actor.toolCallId.trim().length > 0 && actor.turnId.trim().length > 0;
}

function projection(operation: ConnectedWebOperation): ConnectedWebOperationSafeProjection {
  return {
    operationId: operation.id, driver: operation.driver, lifecycle: operation.lifecycle, controlEpoch: operation.controlEpoch,
    activity: { phase: operation.safeActivity.phase, code: operation.safeActivity.code, summary: operation.safeActivity.summary },
    receipt: operation.terminalReceipt === null ? null : {
      outcome: operation.terminalReceipt.outcome, code: operation.terminalReceipt.code, summary: operation.terminalReceipt.summary,
    },
    result: null,
  };
}

function command(input: ConnectedWebOperationDirectCommand): { readonly toolName: Parameters<DirectBrowserRouterLease["invoke"]>[0]["toolName"]; readonly args: Readonly<Record<string, unknown>> } {
  switch (input.kind) {
    case "snapshot": return { toolName: "browser_snapshot", args: {} };
    case "click": return { toolName: "browser_click", args: { ref: input.ref } };
    case "type": return { toolName: "browser_type", args: { ref: input.ref, text: input.text, ...(input.clear === undefined ? {} : { clear: input.clear }) } };
    case "press": return { toolName: "browser_press", args: { key: input.key } };
    case "open": return { toolName: "browser_open", args: { url: input.url } };
    case "back": return { toolName: "browser_back", args: {} };
    case "forward": return { toolName: "browser_forward", args: {} };
    case "reload": return { toolName: "browser_reload", args: {} };
    case "hover": return { toolName: "browser_hover", args: { ref: input.ref } };
    case "double_click": return { toolName: "browser_double_click", args: { ref: input.ref } };
    case "drag": return { toolName: "browser_drag", args: { from: input.from, to: input.to } };
    case "select": return { toolName: "browser_select", args: { ref: input.ref, values: input.values } };
    case "set_checked": return { toolName: "browser_set_checked", args: { ref: input.ref, checked: input.checked } };
    case "scroll": return { toolName: "browser_scroll", args: { direction: input.direction,
      ...(input.amount === undefined ? {} : { amount: input.amount }) } };
    case "scroll_into_view": return { toolName: "browser_scroll_into_view", args: { ref: input.ref } };
    case "wait_for": return { toolName: "browser_wait", args: { ref: input.ref } };
    case "wait": return { toolName: "browser_wait", args: { milliseconds: input.milliseconds } };
    case "read": return { toolName: "browser_read", args: { ref: input.ref } };
    case "get": return { toolName: "browser_get", args: { what: input.what, ...(input.ref === undefined ? {} : { ref: input.ref }), ...(input.name === undefined ? {} : { name: input.name }) } };
  }
}

function directCommandActivity(input: ConnectedWebOperationDirectCommand) {
  switch (input.kind) {
    case "snapshot":
    case "read":
    case "get":
      return { version: 1 as const, phase: "working" as const, code: "direct_page_inspected", summary: "Moxie inspected the connected website." };
    case "type":
      return { version: 1 as const, phase: "working" as const, code: "direct_text_entered", summary: "Moxie entered text on the connected website." };
    case "open":
    case "back":
    case "forward":
    case "reload":
      return { version: 1 as const, phase: "working" as const, code: "direct_page_navigated", summary: "Moxie navigated the connected website." };
    case "wait":
    case "wait_for":
      return { version: 1 as const, phase: "working" as const, code: "direct_waited", summary: "Moxie waited for the connected website." };
    case "click":
      return { version: 1 as const, phase: "working" as const, code: "direct_item_clicked", summary: "Moxie selected an item on the connected website." };
    case "double_click":
      return { version: 1 as const, phase: "working" as const, code: "direct_item_double_clicked", summary: "Moxie opened an item on the connected website." };
    case "hover":
      return { version: 1 as const, phase: "working" as const, code: "direct_item_hovered", summary: "Moxie inspected an item on the connected website." };
    case "drag":
      return { version: 1 as const, phase: "working" as const, code: "direct_item_dragged", summary: "Moxie moved an item on the connected website." };
    case "select":
      return { version: 1 as const, phase: "working" as const, code: "direct_option_selected", summary: "Moxie selected an option on the connected website." };
    case "set_checked":
      return { version: 1 as const, phase: "working" as const, code: "direct_option_checked", summary: "Moxie changed an option on the connected website." };
    case "press":
      return { version: 1 as const, phase: "working" as const, code: "direct_key_pressed", summary: "Moxie used the keyboard on the connected website." };
    case "scroll_into_view":
      return { version: 1 as const, phase: "working" as const, code: "direct_item_scrolled_into_view", summary: "Moxie brought an item into view on the connected website." };
    case "scroll":
      return { version: 1 as const, phase: "working" as const, code: "direct_page_scrolled", summary: "Moxie scrolled the connected website." };
  }
}

/**
 * Server-owned operation leases.  A lease is acquired only by take-control
 * and is retained across commands; this avoids the unsafe acquire/close per
 * command shape of DirectBrowserRouter.execute.
 */
export class ConnectedWebOperationDirectRuntime implements ConnectedWebOperationDirectToolRuntime {
  private readonly leases = new Map<string, LeaseEntry>();
  private ready: boolean;
  private readonly acquisitions = new Map<string, Promise<ConnectedWebOperationSafeProjection | null>>();
  private readonly ownerStops = new Map<string, Promise<ConnectedWebOperation | null>>();

  constructor(private readonly options: ConnectedWebOperationDirectRuntimeOptions) {
    this.ready = options.recover === undefined;
  }

  private key(operationId: string, epoch: number): string { return `${operationId}:${epoch}`; }

  async preflight(): Promise<boolean> {
    if (!this.ready) return false;
    try {
      await this.options.checkAvailability?.();
      return true;
    } catch {
      return false;
    }
  }

  private now(): Date { return (this.options.now ?? (() => new Date()))(); }

  private async closeLease(operation: ConnectedWebOperation, entry: LeaseEntry): Promise<boolean> {
    const key = this.key(operation.id, operation.controlEpoch);
    try {
      const cleanup = await entry.lease.close();
      if (cleanup.operation === "released") {
        if (this.leases.get(key) === entry) this.leases.delete(key);
        return true;
      }
      // Cleanup may rotate the durable recovery fence, but never loses the
      // exact closed-for-input lease needed to retry stopping that browser.
      const recoveryKey = this.key(operation.id, entry.lease.cleanupControlEpoch());
      if (recoveryKey !== key && this.leases.get(key) === entry) {
        this.leases.delete(key);
        this.leases.set(recoveryKey, entry);
      }
    } catch {
      // Keep exact custody, including when the cleanup checkpoint failed.
    }
    return false;
  }

  private async load(actor: ConnectedWebOperationToolActorContext, input: Pick<ConnectedWebOperationDirectToolInput, "operationId" | "expectedControlEpoch">): Promise<ConnectedWebOperation | null> {
    const operation = await this.options.store.getOperationForOwner({ ownerUserId: actor.userId, operationId: input.operationId }).catch(() => null);
    if (!operation || operation.controlEpoch !== input.expectedControlEpoch || !sameForegroundAuthority(actor, operation)) return null;
    if (!this.options.authorizeOperation(actor, operation)) return null;
    const owned = await this.options.facts.hasExactOwnedGenie({ ownerUserId: actor.userId, agentId: actor.agentId }).catch(() => false);
    const privateRoom = owned && await this.options.facts.isOwnersPersonalPrivateRoom({ ownerUserId: actor.userId, agentId: actor.agentId, roomId: actor.roomId }).catch(() => false);
    return privateRoom ? operation : null;
  }

  /** Called only after hosted cancellation has terminal proof. */
  async takeControl(actor: ConnectedWebOperationToolActorContext, input: Pick<ConnectedWebOperationDirectToolInput, "operationId" | "expectedControlEpoch">): Promise<ConnectedWebOperationSafeProjection | null> {
    const key = `${actor.userId}:${input.operationId}`;
    if (this.ownerStops.has(key) || this.acquisitions.has(key)) return null;
    const acquiring = this.acquireControl(actor, input);
    this.acquisitions.set(key, acquiring);
    try { return await acquiring; } finally { this.acquisitions.delete(key); }
  }

  private async acquireControl(actor: ConnectedWebOperationToolActorContext, input: Pick<ConnectedWebOperationDirectToolInput, "operationId" | "expectedControlEpoch">): Promise<ConnectedWebOperationSafeProjection | null> {
    if (!this.ready) return null;
    const operation = await this.load(actor, input);
    if (!operation || operation.accountId === null || operation.actionOperationId !== null || operation.effectIdempotencyKey !== null
      || operation.lifecycle === "terminal" || operation.driver === "direct") return null;
    try {
      const lease = await this.options.router.acquire({
        ownerUserId: operation.ownerUserId, accountId: operation.accountId, operationId: operation.id,
        // Management has already cancelled the hosted Agent run and proved it
        // terminal before entering this method.  A hosted run may tear down its
        // browser as part of that cancellation, so trying to attach to the old
        // session races provider cleanup and makes takeover unreliable.  Open
        // a fresh browser from the same saved profile instead: the account
        // session persists, while Moxie becomes the only page driver.
        expectedControlEpoch: operation.controlEpoch, source: "saved_profile",
      });
      const next = await this.options.store.getOperationForOwner({ ownerUserId: actor.userId, operationId: operation.id });
      if (next.driver !== "direct" || next.controlEpoch !== operation.controlEpoch + 1) {
        await lease.close();
        return null;
      }
      this.leases.set(this.key(next.id, next.controlEpoch), { lease, tail: Promise.resolve() });
      return projection(next);
    } catch (error) {
      warn(`[connected-web-operation] direct takeover unavailable code=${
        error instanceof DirectBrowserRouterError ? error.code : "unexpected"
      } operation=${operation.id}`);
      return null;
    }
  }

  async release(actor: ConnectedWebOperationToolActorContext, input: Pick<ConnectedWebOperationDirectToolInput, "operationId" | "expectedControlEpoch">): Promise<ConnectedWebOperationSafeProjection | null> {
    if (!this.ready) return null;
    const operation = await this.load(actor, input);
    if (!operation || operation.driver !== "direct") return null;
    const entry = this.leases.get(this.key(operation.id, operation.controlEpoch));
    if (!entry) return null; // never silently re-acquire after process restart
    entry.closing = true;
    await entry.tail.catch(() => undefined);
    if (!await this.closeLease(operation, entry)) return null;
    return this.options.store.getOperationForOwner({ ownerUserId: actor.userId, operationId: operation.id }).then(projection).catch(() => null);
  }

  /** Stop and Release have the same exact direct-lease cleanup spine. */
  async stopOperation(actor: ConnectedWebOperationToolActorContext, input: Pick<ConnectedWebOperationDirectToolInput, "operationId" | "expectedControlEpoch">): Promise<ConnectedWebOperationSafeProjection | null> {
    return this.release(actor, input);
  }

  /** Watching requires a live lease; Stop may also clean an exact orphaned row. */
  async ownerControls(input: { readonly ownerUserId: string; readonly operationId: string }): Promise<{
    readonly operation: ConnectedWebOperation;
    readonly liveViewUrl: string | null;
  } | null> {
    if (!this.ready) return null;
    await this.acquisitions.get(`${input.ownerUserId}:${input.operationId}`)?.catch(() => null);
    const operation = await this.options.store.getOperationForOwner(input).catch(() => null);
    if (!operation || operation.ownerUserId !== input.ownerUserId || operation.lifecycle === "terminal" || operation.driver !== "direct") return null;
    const entry = this.leases.get(this.key(operation.id, operation.controlEpoch));
    if (!entry) return this.options.recoverOperation && operation.sealedProviderRefs.browserRef
      ? { operation, liveViewUrl: null } : null;
    return { operation, liveViewUrl: entry.closing ? null : entry.lease.ownerLiveViewUrl() };
  }

  /** Owner Stop serializes exact cleanup, including failed admission and restart. */
  async stopForOwner(input: { readonly ownerUserId: string; readonly operationId: string }): Promise<ConnectedWebOperation | null> {
    const key = `${input.ownerUserId}:${input.operationId}`;
    const pending = this.ownerStops.get(key);
    if (pending) return pending;
    const stopping = this.stopOwnedOperation(input);
    this.ownerStops.set(key, stopping);
    try { return await stopping; } finally { this.ownerStops.delete(key); }
  }

  private async stopOwnedOperation(input: { readonly ownerUserId: string; readonly operationId: string }): Promise<ConnectedWebOperation | null> {
    if (!this.ready) return null;
    await this.acquisitions.get(`${input.ownerUserId}:${input.operationId}`)?.catch(() => null);
    const operation = await this.options.store.getOperationForOwner(input).catch(() => null);
    if (!operation || operation.ownerUserId !== input.ownerUserId) return null;
    if (operation.lifecycle === "terminal" || operation.driver === "checking") return operation;
    if (operation.driver !== "direct") return null;
    const entry = this.leases.get(this.key(operation.id, operation.controlEpoch));
    if (!entry) {
      if (!this.options.recoverOperation || !operation.sealedProviderRefs.browserRef) return null;
      await this.options.recoverOperation(operation).catch(() => false);
    } else {
      entry.closing = true;
      await entry.tail.catch(() => undefined);
      await this.closeLease(operation, entry);
    }
    return this.options.store.getOperationForOwner(input).catch(() => null);
  }

  async control(actor: ConnectedWebOperationToolActorContext, input: ConnectedWebOperationDirectToolInput, options: ConnectedWebOperationDirectControlOptions = {}): Promise<ConnectedWebOperationDirectToolResult> {
    if (!this.ready) return { ok: false, code: "unavailable", recovery: "none" };
    const operation = await this.load(actor, input);
    if (!operation) return { ok: false, code: "forbidden", recovery: "none" };
    if (operation.driver !== "direct" || operation.lifecycle === "terminal") return { ok: false, code: "conflict", recovery: "none" };
    const key = this.key(operation.id, operation.controlEpoch);
    const entry = this.leases.get(key);
    if (!entry || entry.closing) return { ok: false, code: "unavailable", recovery: "none" };
    let resolve!: () => void;
    const previous = entry.tail;
    entry.tail = new Promise<void>((done) => { resolve = done; });
    await previous.catch(() => undefined);
    let decisionActionCompleted = false;
    try {
      if (entry.closing) return { ok: false, code: "unavailable", recovery: "none" };
      if (options.signal?.aborted) return { ok: false, code: "conflict", recovery: "none", browserFailure: "browser_cancelled" };
      const observation = options.decision?.kind === "observe"
        ? await entry.lease.observeDecision(options.signal)
        : undefined;
      const result = options.decision?.kind === "act"
        ? await entry.lease.invokeDecision(command(input.command), options.decision.observationId, options.signal)
        : options.decision?.kind === "observe"
          ? { text: observation!.snapshot, truncated: false }
          : await entry.lease.invoke(command(input.command));
      decisionActionCompleted = options.decision?.kind === "act";
      const recorded = await this.options.store.recordDirectOperationActivity({
        operationId: operation.id,
        ownerUserId: actor.userId,
        expectedControlEpoch: operation.controlEpoch,
        now: this.now(),
        safeActivity: directCommandActivity(input.command),
      });
      if (!recorded) throw new DirectBrowserRouterError("stale_control");
      const fresh = await this.load(actor, input);
      if (!fresh || fresh.driver !== "direct") throw new DirectBrowserRouterError("stale_control");
      return { ok: true, command: result, ...(observation === undefined ? {} : { observation }), operation: projection(fresh) };
    } catch (error) {
      // A stale snapshot reference is an ordinary control conflict. It must
      // not tear down a healthy exact-browser lease; the Genie can snapshot
      // the pinned tab again and make one newly-authorized mutation.
      if (error instanceof DirectBrowserRouterError && error.code === "fresh_snapshot_required") {
        return { ok: false, code: "conflict", recovery: "none" };
      }
      if (error instanceof DirectBrowserRouterError && ["observation_stale", "cancelled", "observation_invalid"].includes(error.code)) {
        const browserFailure = error.code === "observation_stale" ? "browser_observation_stale" as const
          : error.code === "cancelled" ? "browser_cancelled" as const : "browser_observation_invalid" as const;
        return { ok: false, code: "conflict", recovery: "none", browserFailure, detail: error.detail ?? error.message };
      }
      if (!entry.closing) {
        entry.closing = true;
        await this.closeLease(operation, entry);
      }
      const browserFailure = decisionActionCompleted || error instanceof DirectBrowserRouterError && error.code === "outcome_unknown"
        ? "browser_outcome_unknown" as const : "browser_authority_lost" as const;
      return { ok: false, code: "unavailable", recovery: "none", browserFailure,
        detail: error instanceof DirectBrowserRouterError ? error.detail ?? error.message
          : "direct browser control unavailable" };
    } finally {
      resolve();
    }
  }

  /** Listener shutdown and restart recovery never leave an in-memory lease live. */
  async recover(): Promise<void> {
    if (!this.options.recover) {
      this.ready = true;
      return;
    }
    try {
      await this.options.recover();
      this.ready = true;
    } catch {
      // Hosted supervision remains useful when direct startup recovery cannot
      // inventory its durable rows. Keep every direct verb fail-closed.
      this.ready = false;
    }
  }

  async stop(): Promise<void> {
    const entries = [...this.leases.values()];
    this.leases.clear();
    await Promise.all(entries.map(async ({ lease, tail }) => { await tail.catch(() => undefined); await lease.close().catch(() => undefined); }));
  }
}
