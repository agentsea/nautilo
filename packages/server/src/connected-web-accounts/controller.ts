import type {
  ConnectedWebAccount,
  ConnectedWebAccountCreateRequest,
  ConnectedWebAccountLoginResponse,
  ConnectedWebAccountReadActivity,
  ConnectedWebAccountReadWatch,
  ConnectedWebAccountActionActivity,
  ConnectedWebAccountActionWatch,
  ConnectedWebAccountProviderSetupStatus,
} from "@nautilo/types";
import { randomUUID } from "node:crypto";
import {
  BrowserUseCloudAdapter,
  type BrowserUseBrowserSession,
  type BrowserUseProviderFailure,
} from "../browser-use/browser-use-cloud";
import {
  ConnectedWebAccountStoreError,
  type ConnectedWebAccountStore,
} from "./store";
import {
  ConnectedWebAccountTargetError,
  type ConnectedWebAccountDnsLookup,
  validateConnectedWebTarget,
} from "./target-validator";

const CONNECTED_WEB_ACCOUNT_LOGIN_TIMEOUT_MINUTES = 240;
/** Bounded one-shot CDP setup/verification; never a click-loop deadline. */
const CONNECTED_WEB_ACCOUNT_CDP_TIMEOUT_MS = 30_000;

export interface ConnectedWebAccountNavigator {
  navigate(input: { readonly cdpUrl: string; readonly targetUrl: string; readonly timeoutMs: number }): Promise<void>;
  verifySignIn(input: { readonly cdpUrl: string; readonly origin: string; readonly timeoutMs: number }): Promise<{
    readonly atExpectedOrigin: boolean;
    readonly authenticationRequired: boolean;
  }>;
}

export class ConnectedWebAccountControllerError extends Error {
  constructor(readonly kind: "invalid_target" | "provider_unavailable" | "authentication_incomplete") {
    super(kind);
    this.name = "ConnectedWebAccountControllerError";
  }
}

function isFailure(value: unknown): value is BrowserUseProviderFailure {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "failure";
}

function isAlreadyGone(value: unknown): boolean {
  return isFailure(value) && value.code === "resource_not_found";
}

/** A cancel acknowledgement is not enough: queued/running is still a live fence. */
function isConfirmedHostedRunTerminal(value: unknown, expectedRunId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || isFailure(value)) return false;
  const record = value as Record<string, unknown>;
  return record["runId"] === expectedRunId
    && (record["status"] === "cancelled" || record["status"] === "completed" || record["status"] === "failed");
}

function loginResponse(
  account: ConnectedWebAccount,
  browser: BrowserUseBrowserSession,
  createdNewAccount: boolean,
): ConnectedWebAccountLoginResponse {
  if (browser.status !== "active" || browser.liveViewUrl === null) {
    throw new ConnectedWebAccountControllerError("provider_unavailable");
  }
  return {
    account,
    login: { liveViewUrl: browser.liveViewUrl, expiresAt: browser.timeoutAt.toISOString() },
    createdNewAccount,
  };
}

function reusableAccountRank(account: ConnectedWebAccount): number {
  switch (account.status) {
    case "connected": return 8;
    case "busy": return 7;
    case "connecting": return 6;
    case "attention_needed": return 5;
    case "expired": return 4;
    case "provider_unavailable": return 3;
    case "error": return 2;
    case "revoked": return 1;
  }
}

/**
 * Server-owned foreground lifecycle. Its only bearer output is the live-view
 * URL in an owner-authenticated create, reconnect, or open-page response; no
 * public account projection or durable record includes provider browser
 * coordinates.
 */
export class ConnectedWebAccountController {
  constructor(private readonly deps: {
    readonly store: ConnectedWebAccountStore;
    readonly browser: BrowserUseCloudAdapter;
    readonly navigator: ConnectedWebAccountNavigator;
    readonly stopDirectOperations?: (input: { readonly ownerUserId: string; readonly accountId: string }) => Promise<boolean>;
    readonly lookup?: ConnectedWebAccountDnsLookup;
    readonly now?: () => Date;
  }) {}

  providerSetupStatus(): ConnectedWebAccountProviderSetupStatus {
    const health = this.deps.browser.health();
    if (health.kind === "available") return "ready";
    return health.reason === "missing_configuration"
      ? "api_key_required"
      : "api_key_invalid";
  }

  async create(input: { readonly ownerUserId: string; readonly account: ConnectedWebAccountCreateRequest }): Promise<ConnectedWebAccountLoginResponse> {
    let target: Awaited<ReturnType<typeof validateConnectedWebTarget>>;
    try { target = await validateConnectedWebTarget(input.account.origin, this.deps.lookup); }
    catch (error) {
      if (error instanceof ConnectedWebAccountTargetError) throw new ConnectedWebAccountControllerError("invalid_target");
      throw new ConnectedWebAccountControllerError("invalid_target");
    }
    if (!input.account.createAnother) {
      const reusable = (await this.deps.store.listForOwner(input.ownerUserId))
        .filter((account) => account.status !== "revoked" && account.origin === target.origin)
        .sort((left, right) => reusableAccountRank(right) - reusableAccountRank(left))[0];
      if (reusable) {
        return this.reconnect({ ownerUserId: input.ownerUserId, accountId: reusable.id });
      }
    }
    const account = await this.deps.store.createPending({
      ownerUserId: input.ownerUserId,
      account: { ...input.account, origin: target.origin },
    });
    const profile = await this.deps.browser.createProfile();
    if (isFailure(profile)) {
      await this.deps.store.revokeForOwner({ ownerUserId: input.ownerUserId, accountId: account.id });
      throw new ConnectedWebAccountControllerError("provider_unavailable");
    }
    try {
      await this.deps.store.bindProfileReference({ ownerUserId: input.ownerUserId, accountId: account.id, profileRef: profile.profileId });
      return await this.startNewLogin({ ownerUserId: input.ownerUserId, accountId: account.id, targetUrl: target.targetUrl, account, createdNewAccount: true });
    } catch (error) {
      const binding = await this.deps.store.getBindingForOwner({ ownerUserId: input.ownerUserId, accountId: account.id }).catch(() => null);
      // If provider stop was not confirmed, either phase is a recovery fence:
      // do not revoke the row or delete its profile underneath possible live work.
      if (binding?.executionCheckpoint?.resource === "login") throw error;
      await this.revokeAndDeleteProfile({ ownerUserId: input.ownerUserId, accountId: account.id, profileId: profile.profileId });
      throw error;
    }
  }

  async list(ownerUserId: string): Promise<readonly ConnectedWebAccount[]> { return this.deps.store.listForOwner(ownerUserId); }
  async get(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccount | null> { return this.deps.store.getForOwner(input); }

  async reconnect(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccountLoginResponse> {
    let binding = await this.deps.store.getBindingForOwner(input);
    if (!binding.profileRef) throw new ConnectedWebAccountStoreError("conflict");
    if (binding.executionCheckpoint?.resource === "login") {
      if (binding.executionCheckpoint.phase === "reserving" || !binding.executionCheckpoint.opaqueExecutionRef) {
        throw new ConnectedWebAccountStoreError("conflict");
      }
      const existing = await this.deps.browser.getBrowser(binding.executionCheckpoint.opaqueExecutionRef);
      if (!isFailure(existing) && existing.status === "active" && existing.liveViewUrl !== null) {
        const account = await this.deps.store.getForOwner(input);
        if (!account) throw new ConnectedWebAccountStoreError("not_found");
        return loginResponse(account, existing, false);
      }
      if (isAlreadyGone(existing)) {
        await this.deps.store.completeExecution({ ownerUserId: input.ownerUserId, accountId: binding.accountId, reservationToken: binding.executionCheckpoint.reservationToken, status: "expired" });
      } else if (isFailure(existing)) {
        throw new ConnectedWebAccountControllerError("provider_unavailable");
      } else {
        await this.deps.store.completeExecution({ ownerUserId: input.ownerUserId, accountId: binding.accountId, reservationToken: binding.executionCheckpoint.reservationToken, status: "attention_needed" });
      }
      binding = await this.deps.store.getBindingForOwner(input);
    }
    const account = await this.deps.store.beginReconnect(input);
    return this.startNewLogin({
      ownerUserId: input.ownerUserId,
      accountId: input.accountId,
      targetUrl: binding.origin,
      account,
      createdNewAccount: false,
    });
  }

  async finish(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccount> {
    const binding = await this.deps.store.getBindingForOwner(input);
    if (binding.status === "connected" && binding.executionCheckpoint === null) {
      const account = await this.deps.store.getForOwner(input);
      if (!account) throw new ConnectedWebAccountStoreError("not_found");
      return account;
    }
    if (!binding.profileRef || binding.executionCheckpoint?.resource !== "login" || binding.executionCheckpoint.phase !== "active" || !binding.executionCheckpoint.opaqueExecutionRef) throw new ConnectedWebAccountStoreError("conflict");
    const browser = await this.deps.browser.getBrowser(binding.executionCheckpoint.opaqueExecutionRef);
    if (isAlreadyGone(browser)) {
      return this.deps.store.completeExecution({ ...input, reservationToken: binding.executionCheckpoint.reservationToken, status: "expired" });
    }
    if (isFailure(browser) || browser.status !== "active" || browser.cdpUrl === null) throw new ConnectedWebAccountControllerError("provider_unavailable");
    const verification = await this.deps.navigator.verifySignIn({
      cdpUrl: browser.cdpUrl,
      origin: binding.origin,
      timeoutMs: CONNECTED_WEB_ACCOUNT_CDP_TIMEOUT_MS,
    });
    // `Done` is a Human assertion, not authentication proof. Keep the exact
    // live browser/checkpoint available when the visible page is still on an
    // OAuth provider or presents a generic sign-in/verification surface; do
    // not publish a false Connected state that the next Agent run disproves.
    if (!verification.atExpectedOrigin || verification.authenticationRequired) {
      throw new ConnectedWebAccountControllerError("authentication_incomplete");
    }
    const stopped = await this.deps.browser.stopBrowser(binding.executionCheckpoint.opaqueExecutionRef);
    if (isFailure(stopped) && !isAlreadyGone(stopped)) {
      throw new ConnectedWebAccountControllerError("provider_unavailable");
    }
    return this.deps.store.completeExecution({
      ...input,
      reservationToken: binding.executionCheckpoint.reservationToken,
      status: "connected",
      lastVerifiedAt: (this.deps.now ?? (() => new Date()))(),
    });
  }

  /**
   * Opens a Human's saved profile for a direct, owner-only page view. The
   * durable origin, rather than a route-supplied URL, is the sole navigation
   * target so this cannot become a general authenticated browsing proxy.
   */
  async openPage(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccountLoginResponse> {
    const binding = await this.deps.store.getBindingForOwner(input);
    if (binding.status !== "connected" || binding.executionCheckpoint !== null || !binding.profileRef) {
      throw new ConnectedWebAccountStoreError("conflict");
    }
    const account = await this.deps.store.getForOwner(input);
    if (!account) throw new ConnectedWebAccountStoreError("not_found");

    const reservationToken = randomUUID();
    await this.deps.store.reserveExecutionCheckpoint({
      ownerUserId: input.ownerUserId,
      accountId: input.accountId,
      checkpoint: {
        resource: "view",
        phase: "reserving",
        reservationToken,
        recordedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
      },
    });
    const browser = await this.deps.browser.startBrowser({
      profileId: binding.profileRef,
      timeoutMinutes: CONNECTED_WEB_ACCOUNT_LOGIN_TIMEOUT_MINUTES,
    });
    if (isFailure(browser)) {
      await this.deps.store.releaseExecutionReservation({
        ownerUserId: input.ownerUserId,
        accountId: input.accountId,
        reservationToken,
        status: "provider_unavailable",
      });
      throw new ConnectedWebAccountControllerError("provider_unavailable");
    }
    try {
      await this.deps.store.activateExecutionCheckpoint({
        ownerUserId: input.ownerUserId,
        accountId: input.accountId,
        reservationToken,
        opaqueExecutionRef: browser.browserId,
      });
    } catch (error) {
      const stopped = await this.deps.browser.stopBrowser(browser.browserId);
      if (!isFailure(stopped) || isAlreadyGone(stopped)) {
        await this.deps.store.releaseExecutionReservation({
          ownerUserId: input.ownerUserId,
          accountId: input.accountId,
          reservationToken,
          status: "connected",
        }).catch(() => undefined);
      }
      throw error;
    }
    if (browser.cdpUrl === null) {
      const stopped = await this.deps.browser.stopBrowser(browser.browserId);
      if (!isFailure(stopped) || isAlreadyGone(stopped)) {
        await this.deps.store.completeExecution({
          ownerUserId: input.ownerUserId,
          accountId: input.accountId,
          reservationToken,
          status: "connected",
        });
      }
      throw new ConnectedWebAccountControllerError("provider_unavailable");
    }
    try {
      await this.deps.navigator.navigate({
        cdpUrl: browser.cdpUrl,
        targetUrl: binding.origin,
        timeoutMs: CONNECTED_WEB_ACCOUNT_CDP_TIMEOUT_MS,
      });
      const saved = await this.deps.store.getForOwner(input);
      if (!saved) throw new ConnectedWebAccountStoreError("not_found");
      return loginResponse(saved, browser, false);
    } catch (error) {
      const stopped = await this.deps.browser.stopBrowser(browser.browserId);
      if (!isFailure(stopped) || isAlreadyGone(stopped)) {
        await this.deps.store.completeExecution({
          ownerUserId: input.ownerUserId,
          accountId: input.accountId,
          reservationToken,
          status: "connected",
        });
      }
      throw error;
    }
  }

  async closePage(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccount> {
    const binding = await this.deps.store.getBindingForOwner(input);
    if (binding.executionCheckpoint?.resource !== "view" || binding.executionCheckpoint.phase !== "active" || !binding.executionCheckpoint.opaqueExecutionRef) {
      throw new ConnectedWebAccountStoreError("conflict");
    }
    const stopped = await this.deps.browser.stopBrowser(binding.executionCheckpoint.opaqueExecutionRef);
    if (isFailure(stopped) && !isAlreadyGone(stopped)) {
      throw new ConnectedWebAccountControllerError("provider_unavailable");
    }
    return this.deps.store.completeExecution({
      ...input,
      reservationToken: binding.executionCheckpoint.reservationToken,
      status: "connected",
    });
  }

  async cancelLogin(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccount> {
    const binding = await this.deps.store.getBindingForOwner(input);
    if (binding.executionCheckpoint?.resource !== "login") throw new ConnectedWebAccountStoreError("conflict");
    // The provider browser may already exist while its identifier is still
    // being durably activated. Clearing the fence here could orphan it if the
    // concurrent start cannot stop cleanly. Let that start finish, then the
    // Human can cancel the now-active browser deterministically.
    if (binding.executionCheckpoint.phase === "reserving") throw new ConnectedWebAccountStoreError("conflict");
    if (binding.executionCheckpoint.phase === "active" && binding.executionCheckpoint.opaqueExecutionRef) {
      const stopped = await this.deps.browser.stopBrowser(binding.executionCheckpoint.opaqueExecutionRef);
      if (isFailure(stopped) && !isAlreadyGone(stopped)) throw new ConnectedWebAccountControllerError("provider_unavailable");
    }
    return this.deps.store.completeExecution({ ...input, reservationToken: binding.executionCheckpoint.reservationToken, status: "attention_needed" });
  }

  async readActivity(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccountReadActivity> {
    const binding = await this.deps.store.getBindingForOwner(input);
    const checkpoint = binding.executionCheckpoint;
    if (checkpoint?.resource !== "read") throw new ConnectedWebAccountStoreError("conflict");
    if (checkpoint.phase === "reserving" || !checkpoint.opaqueExecutionRef) {
      return { accountId: input.accountId, stage: "starting", canWatch: false };
    }
    const observed = await this.deps.browser.observeHostedReadRun(checkpoint.opaqueExecutionRef);
    if (isFailure(observed)) throw new ConnectedWebAccountControllerError("provider_unavailable");
    return { accountId: input.accountId, stage: observed.stage, canWatch: observed.liveViewUrl !== null };
  }

  async watchRead(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccountReadWatch> {
    const binding = await this.deps.store.getBindingForOwner(input);
    const checkpoint = binding.executionCheckpoint;
    if (checkpoint?.resource !== "read" || checkpoint.phase !== "active" || !checkpoint.opaqueExecutionRef) {
      throw new ConnectedWebAccountStoreError("conflict");
    }
    const observed = await this.deps.browser.observeHostedReadRun(checkpoint.opaqueExecutionRef);
    if (isFailure(observed)) throw new ConnectedWebAccountControllerError("provider_unavailable");
    if (observed.liveViewUrl === null) throw new ConnectedWebAccountStoreError("conflict");
    return { liveViewUrl: observed.liveViewUrl };
  }

  async cancelRead(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccount> {
    const binding = await this.deps.store.getBindingForOwner(input);
    const checkpoint = binding.executionCheckpoint;
    if (checkpoint?.resource !== "read" || checkpoint.phase !== "active" || !checkpoint.opaqueExecutionRef) {
      throw new ConnectedWebAccountStoreError("conflict");
    }
    const cancelled = await this.deps.browser.cancelHostedReadRun(checkpoint.opaqueExecutionRef);
    if (isFailure(cancelled) && !isAlreadyGone(cancelled)) throw new ConnectedWebAccountControllerError("provider_unavailable");
    if (!isFailure(cancelled) && cancelled.status !== "cancelled" && cancelled.status !== "completed" && cancelled.status !== "failed") {
      throw new ConnectedWebAccountControllerError("provider_unavailable");
    }
    if (!await this.deps.browser.stopHostedReadBrowser(checkpoint.opaqueExecutionRef)) throw new ConnectedWebAccountControllerError("provider_unavailable");
    return this.deps.store.completeExecution({
      ...input,
      reservationToken: checkpoint.reservationToken,
      status: "connected",
    });
  }

  private async actionForDelivery(input: { readonly ownerUserId: string; readonly deliveryId: string }) {
    const operation = await this.deps.store.getActionOperationForOwnerDelivery(input);
    const binding = await this.deps.store.getBindingForOwner({ ownerUserId: input.ownerUserId, accountId: operation.accountId });
    return { operation, binding };
  }

  async actionActivity(input: { readonly ownerUserId: string; readonly deliveryId: string }): Promise<ConnectedWebAccountActionActivity> {
    const { operation, binding } = await this.actionForDelivery(input);
    if (operation.status !== "reserving" && operation.status !== "running" && operation.status !== "verifying") {
      return { deliveryId: operation.deliveryId, accountId: operation.accountId, action: "save_item", stage: "finishing", canWatch: false, canStop: false, terminal: operation.status };
    }
    if (operation.status === "reserving") {
      // No provider run exists yet, so offering Stop would be an unsafe lie.
      return { deliveryId: operation.deliveryId, accountId: operation.accountId, action: "save_item", stage: "starting", canWatch: false, canStop: false, terminal: null };
    }
    const checkpoint = binding.executionCheckpoint;
    if (checkpoint?.resource !== "action" || checkpoint.phase !== "active" || !checkpoint.opaqueExecutionRef
      || !operation.opaqueRunRef || checkpoint.opaqueExecutionRef !== operation.opaqueRunRef) {
      throw new ConnectedWebAccountStoreError("conflict");
    }
    const observed = await this.deps.browser.observeHostedReadRun(operation.opaqueRunRef);
    if (isFailure(observed)) throw new ConnectedWebAccountControllerError("provider_unavailable");
    const active = observed.status === "queued" || observed.status === "dispatching" || observed.status === "running";
    return { deliveryId: operation.deliveryId, accountId: operation.accountId, action: "save_item", stage: observed.stage,
      canWatch: active && observed.liveViewUrl !== null, canStop: active,
      // The action may now rotate to its read-only verifier run. The durable
      // operation ledger, not this one provider snapshot, owns terminal truth.
      terminal: null };
  }

  async watchAction(input: { readonly ownerUserId: string; readonly deliveryId: string }): Promise<ConnectedWebAccountActionWatch> {
    const { operation, binding } = await this.actionForDelivery(input);
    const checkpoint = binding.executionCheckpoint;
    if ((operation.status !== "running" && operation.status !== "verifying") || !operation.opaqueRunRef || checkpoint?.resource !== "action"
      || checkpoint.phase !== "active" || checkpoint.opaqueExecutionRef !== operation.opaqueRunRef) throw new ConnectedWebAccountStoreError("conflict");
    const observed = await this.deps.browser.observeHostedReadRun(operation.opaqueRunRef);
    if (isFailure(observed)) throw new ConnectedWebAccountControllerError("provider_unavailable");
    if (observed.status !== "queued" && observed.status !== "dispatching" && observed.status !== "running") throw new ConnectedWebAccountStoreError("conflict");
    if (observed.liveViewUrl === null) throw new ConnectedWebAccountStoreError("conflict");
    return { liveViewUrl: observed.liveViewUrl };
  }

  async stopAction(input: { readonly ownerUserId: string; readonly deliveryId: string }): Promise<ConnectedWebAccountActionActivity> {
    const { operation, binding } = await this.actionForDelivery(input);
    const checkpoint = binding.executionCheckpoint;
    if ((operation.status !== "running" && operation.status !== "verifying") || !operation.opaqueRunRef || checkpoint?.resource !== "action"
      || checkpoint.phase !== "active" || checkpoint.opaqueExecutionRef !== operation.opaqueRunRef) throw new ConnectedWebAccountStoreError("conflict");
    const cancelled = await this.deps.browser.cancelHostedReadRun(operation.opaqueRunRef);
    const providerTerminal = isAlreadyGone(cancelled) || isConfirmedHostedRunTerminal(cancelled, operation.opaqueRunRef);
    if (!providerTerminal) throw new ConnectedWebAccountControllerError("provider_unavailable");
    if (!await this.deps.browser.stopHostedReadBrowser(operation.opaqueRunRef)) throw new ConnectedWebAccountControllerError("provider_unavailable");
    // No terminal response for action A—including an exact cancellation—can
    // prove there is no verifier B being created after the runtime's last
    // ledger check and before either durable rotation. Leave A fenced; the
    // runtime that knows whether B exists must cancel and confirm it first.
    if (operation.status === "running") {
      return { deliveryId: operation.deliveryId, accountId: operation.accountId, action: "save_item", stage: "finishing", canWatch: false, canStop: false, terminal: "ambiguous" };
    }
    // Stopping the read-only verifier still cannot establish whether the
    // preceding website action took effect, so the delivery remains
    // externally ambiguous.
    const terminal = "ambiguous" as const;
    // Persist terminal truth before releasing this profile's writer fence.
    await this.deps.store.finishActionOperation({ operationId: operation.id, status: terminal, expectedOpaqueRunRef: operation.opaqueRunRef, receipt: {
      executionRef: operation.id, action: "save_item", target: operation.target, effectState: terminal, postcondition: null,
      evidenceCode: operation.status === "verifying" ? "owner_stopped_verifier" : "owner_stopped_action_unverified", cost: { amountUsd: null, state: "unknown" },
    } });
    await this.deps.store.completeExecution({ ownerUserId: input.ownerUserId, accountId: operation.accountId,
      reservationToken: checkpoint.reservationToken, status: "connected", expectedOpaqueExecutionRef: operation.opaqueRunRef });
    return { deliveryId: operation.deliveryId, accountId: operation.accountId, action: "save_item", stage: "finishing", canWatch: false, canStop: false, terminal };
  }

  async disconnect(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccount> {
    const binding = await this.deps.store.getBindingForOwner(input);
    if (binding.executionCheckpoint?.phase === "reserving") {
      if (binding.executionCheckpoint.resource === "action") {
        // A submitted hosted action can lose its provider response before we
        // learn a run id. There is no safe automatic clear or cancellation.
        // An owner may still explicitly revoke this account; the existing
        // revoked-profile cleanup queue owns provider deletion thereafter.
        return this.deps.store.revokeForOwner(input);
      }
      throw new ConnectedWebAccountStoreError("conflict");
    }
    if (this.deps.stopDirectOperations && !await this.deps.stopDirectOperations(input)) {
      throw new ConnectedWebAccountControllerError("provider_unavailable");
    }
    if (binding.executionCheckpoint?.phase === "active" && binding.executionCheckpoint.opaqueExecutionRef) {
      if (binding.executionCheckpoint.resource === "login" || binding.executionCheckpoint.resource === "view") {
        const stopped = await this.deps.browser.stopBrowser(binding.executionCheckpoint.opaqueExecutionRef);
        if (isFailure(stopped) && !isAlreadyGone(stopped)) throw new ConnectedWebAccountControllerError("provider_unavailable");
      } else {
        const cancelled = await this.deps.browser.cancelHostedReadRun(binding.executionCheckpoint.opaqueExecutionRef);
        if (isFailure(cancelled) && !isAlreadyGone(cancelled)) throw new ConnectedWebAccountControllerError("provider_unavailable");
        if (!isAlreadyGone(cancelled) && !isConfirmedHostedRunTerminal(cancelled, binding.executionCheckpoint.opaqueExecutionRef)) {
          throw new ConnectedWebAccountControllerError("provider_unavailable");
        }
        if (!await this.deps.browser.stopHostedReadBrowser(binding.executionCheckpoint.opaqueExecutionRef)) throw new ConnectedWebAccountControllerError("provider_unavailable");
      }
    }
    if (binding.profileRef) {
      const deleted = await this.deps.browser.deleteProfile(binding.profileRef);
      if (isFailure(deleted) && !isAlreadyGone(deleted)) throw new ConnectedWebAccountControllerError("provider_unavailable");
    }
    const account = await this.deps.store.revokeForOwner(input);
    if (binding.profileRef) await this.deps.store.markProviderCleanupCompleted(binding.accountId);
    return account;
  }

  async reconcileStaleExecutions(): Promise<void> {
    const stale = await this.deps.store.listStaleExecutions();
    const actionCheckpointKeys = new Set(stale.flatMap((execution) =>
      execution.checkpoint.resource === "action" && execution.checkpoint.phase === "active"
        && execution.checkpoint.opaqueExecutionRef
        ? [`${execution.accountId}\0${execution.checkpoint.opaqueExecutionRef}`]
        : []));
    const confirmedActionCheckpointKeys = new Set<string>();
    for (const execution of stale) {
      if (execution.checkpoint.resource === "read"
        && await this.deps.store.hasNonterminalReadOperation({
          ownerUserId: execution.ownerUserId,
          accountId: execution.accountId,
        })) {
        // The operation supervisor, not boot cleanup, owns an async read whose
        // durable operation is still live. Cancelling it here would strand the
        // operation and erase the exact account writer fence after restart.
        continue;
      }
      if (execution.checkpoint.phase === "reserving") {
        if (execution.checkpoint.resource === "action" || execution.checkpoint.resource === "read") {
          // A crash or transport throw may have submitted a billable run
          // before its provider run id was received. With no id we cannot
          // prove cancellation, so this is an explicit safe quarantine.
          continue;
        }
        await this.deps.store.reconcileStaleExecution({
          accountId: execution.accountId,
          status: execution.checkpoint.resource === "view" ? "connected" : "attention_needed",
        });
        continue;
      }
      let result: Awaited<ReturnType<BrowserUseCloudAdapter["stopBrowser"]>> | Awaited<ReturnType<BrowserUseCloudAdapter["cancelHostedReadRun"]>>;
      try {
        result = execution.checkpoint.resource === "login" || execution.checkpoint.resource === "view"
          ? await this.deps.browser.stopBrowser(execution.checkpoint.opaqueExecutionRef ?? "")
          : await this.deps.browser.cancelHostedReadRun(execution.checkpoint.opaqueExecutionRef ?? "");
      } catch {
        // A failed cancellation leaves the exact opaque reference fenced for
        // the next boot; do not make the saved profile writable yet.
        continue;
      }
      const terminal = execution.checkpoint.resource === "login" || execution.checkpoint.resource === "view"
        ? (!isFailure(result) || isAlreadyGone(result))
        : (isAlreadyGone(result) || isConfirmedHostedRunTerminal(result, execution.checkpoint.opaqueExecutionRef ?? ""));
      if (terminal) {
        if ((execution.checkpoint.resource === "read" || execution.checkpoint.resource === "action")
          && !await this.deps.browser.stopHostedReadBrowser(execution.checkpoint.opaqueExecutionRef ?? "").catch(() => false)) continue;
        if (execution.checkpoint.resource === "action" && execution.checkpoint.opaqueExecutionRef) {
          confirmedActionCheckpointKeys.add(`${execution.accountId}\0${execution.checkpoint.opaqueExecutionRef}`);
        }
        await this.deps.store.completeExecution({
          accountId: execution.accountId,
          reservationToken: execution.checkpoint.reservationToken,
          status: execution.checkpoint.resource === "view" || execution.checkpoint.resource === "action" ? "connected" : "attention_needed",
          ...(execution.checkpoint.resource === "action" && execution.checkpoint.opaqueExecutionRef
            ? { expectedOpaqueExecutionRef: execution.checkpoint.opaqueExecutionRef }
            : {}),
        });
      }
    }
    // D568 action runs are never replayed after a process loss. A running or
    // verifying row may have crossed the website effect boundary; a verifier
    // is read-only but still owns the profile fence until it is terminal. An
    // action reservation may
    // likewise be an accepted request whose response was lost. Keep both
    // durable references until provider cancellation is terminal/gone.
    // Older, read-only store fakes and deployments have no action ledger. The
    // recovery loop remains additive until the schema/runtime seam is wired.
    const listStaleActions = (this.deps.store as Partial<ConnectedWebAccountStore>).listStaleActionOperations;
    if (!listStaleActions) return;
    for (const operation of await listStaleActions.call(this.deps.store)) {
      if (operation.status === "reserving") {
        await this.deps.store.finishActionOperation({
          operationId: operation.id, status: "ambiguous", receipt: { executionRef: operation.id, action: "save_item", target: operation.target, effectState: "ambiguous", postcondition: null, evidenceCode: "restart_before_provider_reference", cost: { amountUsd: null, state: "unknown" } },
          expectedOpaqueRunRef: null,
        }).catch(() => undefined);
        continue;
      }
      if (!operation.opaqueRunRef) continue;
      const operationKey = `${operation.accountId}\0${operation.opaqueRunRef}`;
      if (actionCheckpointKeys.has(operationKey)) {
        // The account loop above owns this exact live run. Never issue a
        // second cancel that can leave account=connected and ledger=running.
        if (!confirmedActionCheckpointKeys.has(operationKey)) continue;
        await this.deps.store.finishActionOperation({
          operationId: operation.id, status: "ambiguous", receipt: { executionRef: operation.id, action: "save_item", target: operation.target, effectState: "ambiguous", postcondition: null, evidenceCode: "restart_possible_effect", cost: { amountUsd: null, state: "unknown" } },
          expectedOpaqueRunRef: operation.opaqueRunRef,
        }).catch(() => undefined);
        continue;
      }
      let cancelled: Awaited<ReturnType<BrowserUseCloudAdapter["cancelHostedReadRun"]>>;
      try { cancelled = await this.deps.browser.cancelHostedReadRun(operation.opaqueRunRef); }
      catch { continue; }
      if (!isAlreadyGone(cancelled) && !isConfirmedHostedRunTerminal(cancelled, operation.opaqueRunRef)) continue;
      if (!await this.deps.browser.stopHostedReadBrowser(operation.opaqueRunRef).catch(() => false)) continue;
      await this.deps.store.finishActionOperation({
        operationId: operation.id, status: "ambiguous", receipt: { executionRef: operation.id, action: "save_item", target: operation.target, effectState: "ambiguous", postcondition: null, evidenceCode: "restart_possible_effect", cost: { amountUsd: null, state: "unknown" } },
        expectedOpaqueRunRef: operation.opaqueRunRef,
      }).catch(() => undefined);
    }
  }

  /**
   * A failed create revokes before deleting its provider profile so the
   * account can never be used. Keep that deletion recoverable after a crash
   * or transient provider failure; the durable row is the only retry queue.
   */
  async reconcileRevokedProfileCleanup(): Promise<void> {
    const candidates = await this.deps.store.listRevokedProfilesForCleanup();
    for (const candidate of candidates) {
      let deleted: Awaited<ReturnType<BrowserUseCloudAdapter["deleteProfile"]>>;
      try {
        deleted = await this.deps.browser.deleteProfile(candidate.profileRef);
      } catch {
        await this.markProfileCleanupFailed(candidate.accountId);
        continue;
      }
      if (isFailure(deleted) && !isAlreadyGone(deleted)) {
        await this.markProfileCleanupFailed(candidate.accountId);
        continue;
      }
      // A provider 404 proves the desired end state and is deliberately
      // idempotent: a prior delete may have succeeded before a process loss.
      try {
        await this.deps.store.markProviderCleanupCompleted(candidate.accountId);
      } catch {
        // Keep the row pending/failed for the next boot; do not leak provider
        // coordinates or prevent cleanup of the remaining candidates.
      }
    }
  }

  private async startNewLogin(input: { readonly ownerUserId: string; readonly accountId: string; readonly targetUrl: string; readonly account: ConnectedWebAccount; readonly createdNewAccount: boolean }): Promise<ConnectedWebAccountLoginResponse> {
    const binding = await this.deps.store.getBindingForOwner(input);
    if (!binding.profileRef) throw new ConnectedWebAccountStoreError("conflict");
    const reservationToken = randomUUID();
    await this.deps.store.reserveExecutionCheckpoint({
      ownerUserId: input.ownerUserId,
      accountId: input.accountId,
      checkpoint: { resource: "login", phase: "reserving", reservationToken, recordedAt: (this.deps.now ?? (() => new Date()))().toISOString() },
    });
    const browser = await this.deps.browser.startBrowser({ profileId: binding.profileRef, timeoutMinutes: CONNECTED_WEB_ACCOUNT_LOGIN_TIMEOUT_MINUTES });
    if (isFailure(browser)) {
      await this.deps.store.releaseExecutionReservation({ ownerUserId: input.ownerUserId, accountId: input.accountId, reservationToken, status: "provider_unavailable" });
      throw new ConnectedWebAccountControllerError("provider_unavailable");
    }
    try {
      await this.deps.store.activateExecutionCheckpoint({
        ownerUserId: input.ownerUserId,
        accountId: input.accountId,
        reservationToken,
        opaqueExecutionRef: browser.browserId,
      });
    } catch (error) {
      const stopped = await this.deps.browser.stopBrowser(browser.browserId);
      if (!isFailure(stopped) || isAlreadyGone(stopped)) {
        await this.deps.store.releaseExecutionReservation({
          ownerUserId: input.ownerUserId,
          accountId: input.accountId,
          reservationToken,
          status: "attention_needed",
        }).catch(() => undefined);
      }
      throw error;
    }
    if (browser.cdpUrl === null) {
      const stopped = await this.deps.browser.stopBrowser(browser.browserId);
      if (!isFailure(stopped) || isAlreadyGone(stopped)) {
        await this.deps.store.completeExecution({ ownerUserId: input.ownerUserId, accountId: input.accountId, reservationToken, status: "attention_needed" });
      }
      throw new ConnectedWebAccountControllerError("provider_unavailable");
    }
    try {
      await this.deps.navigator.navigate({ cdpUrl: browser.cdpUrl, targetUrl: input.targetUrl, timeoutMs: CONNECTED_WEB_ACCOUNT_CDP_TIMEOUT_MS });
      const saved = await this.deps.store.getForOwner({ ownerUserId: input.ownerUserId, accountId: input.accountId });
      if (!saved) throw new ConnectedWebAccountStoreError("not_found");
      return loginResponse(saved, browser, input.createdNewAccount);
    } catch (error) {
      const stopped = await this.deps.browser.stopBrowser(browser.browserId);
      if (!isFailure(stopped) || isAlreadyGone(stopped)) {
        await this.deps.store.completeExecution({ ownerUserId: input.ownerUserId, accountId: input.accountId, reservationToken, status: "attention_needed" });
      }
      throw error;
    }
  }

  private async revokeAndDeleteProfile(input: { readonly ownerUserId: string; readonly accountId: string; readonly profileId: string }): Promise<void> {
    await this.deps.store.revokeForOwner(input);
    const deleted = await this.deps.browser.deleteProfile(input.profileId);
    if (isFailure(deleted) && !isAlreadyGone(deleted)) await this.deps.store.markProviderCleanupFailed({ accountId: input.accountId, safeFailureCode: "cleanup_unavailable" });
    else await this.deps.store.markProviderCleanupCompleted(input.accountId);
  }

  private async markProfileCleanupFailed(accountId: string): Promise<void> {
    try {
      await this.deps.store.markProviderCleanupFailed({ accountId, safeFailureCode: "cleanup_unavailable" });
    } catch {
      // The revoked row remains a future boot candidate if persistence itself
      // is temporarily unavailable.
    }
  }
}
