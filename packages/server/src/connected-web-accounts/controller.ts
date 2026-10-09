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
  canUseBrowserUseServerFunding,
  type BrowserUseBrowserSession,
  type BrowserUseProviderFailure,
  type BrowserUseServerFundingAdmission,
} from "../browser-use/browser-use-cloud";
import type { DurableServiceFundingBinding } from "@nautilo/types";
import {
  ConnectedWebAccountStoreError,
  type ConnectedWebAccountStore,
} from "./store";
import {
  ConnectedWebAccountTargetError,
  type ConnectedWebAccountDnsLookup,
  validateConnectedWebTarget,
} from "./target-validator";
import {
  type ConnectedWebBrowserFunding,
  withFundedBrowserUse,
} from "./browser-use-funding";
import type { UsageFundingProvenance } from "@nautilo/agent";
import type {
  ServerProviderCostAttemptAdmission,
  ServerProviderCostReceipt,
} from "../costs/provider-cost-recorder";
import { settleConnectedWebActionRunCleanup } from "./action-tool-runtime";

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
  constructor(readonly kind: "invalid_target" | "provider_unavailable" | "authentication_incomplete" | "server_funding_required") {
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

function isConfirmedProfileCreateFailure(value: BrowserUseProviderFailure): boolean {
  return value.code === "missing_configuration"
    || value.code === "invalid_configuration"
    || value.code === "authentication_failed"
    || value.code === "insufficient_balance"
    || value.code === "conflict"
    || value.code === "rate_limited"
    || value.code === "invalid_browser_policy"
    || value.code === "invalid_cost_policy";
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
    readonly assertServerFunding?: BrowserUseServerFundingAdmission;
    readonly funding?: ConnectedWebBrowserFunding;
    readonly beginCostAttempt?: (input: ServerProviderCostAttemptAdmission) => Promise<void>;
    readonly settleCostAttempt?: (input: ServerProviderCostReceipt) => Promise<void>;
  }) {}

  private async withFunding<T>(
    ownerUserId: string,
    binding: DurableServiceFundingBinding | null,
    intent: "spend" | "recover",
    callback: (browser: BrowserUseCloudAdapter, usageFunding?: UsageFundingProvenance) => Promise<T> | T,
  ): Promise<T> {
    if (!this.deps.funding) return Promise.resolve(callback(this.deps.browser));
    const exact = binding ?? await this.deps.funding.admitLegacyServer(ownerUserId);
    return withFundedBrowserUse(this.deps.funding, this.deps.browser, exact, intent,
      (browser, usageFunding) => Promise.resolve(callback(browser, usageFunding)));
  }

  private browserCostIdentity(accountId: string, reservationToken: string): string {
    return `browser-use:connected-web-account:${accountId}:browser:${reservationToken}`;
  }

  private async startFundedBrowser(input: {
    readonly ownerUserId: string;
    readonly accountId: string;
    readonly reservationToken: string;
    readonly resource: "login" | "view";
    readonly fundingBinding: DurableServiceFundingBinding | null;
    readonly profileId: string;
  }): Promise<Awaited<ReturnType<BrowserUseCloudAdapter["startBrowser"]>>> {
    return this.withFunding(input.ownerUserId, input.fundingBinding, "spend", async (provider, usageFunding) => {
      await this.deps.beginCostAttempt?.({
        identity: this.browserCostIdentity(input.accountId, input.reservationToken),
        ...(usageFunding === undefined ? {} : { usageFunding }),
        userId: input.ownerUserId,
        workload: `connected_web_account_${input.resource}`,
        provider: "browser_use",
        operation: "browser_session",
      });
      const started = await provider.startBrowser({
        profileId: input.profileId,
        timeoutMinutes: CONNECTED_WEB_ACCOUNT_LOGIN_TIMEOUT_MINUTES,
      });
      if (isFailure(started) && isConfirmedProfileCreateFailure(started) && this.deps.settleCostAttempt) {
        await this.deps.settleCostAttempt({
          identity: this.browserCostIdentity(input.accountId, input.reservationToken),
          ...(usageFunding === undefined ? {} : { usageFunding }),
          userId: input.ownerUserId,
          workload: `connected_web_account_${input.resource}`,
          provider: "browser_use",
          operation: "browser_session",
          actualCostUsd: null,
          evidenceState: "unknown",
          attemptOutcome: "failed",
          failureCode: "provider_create_failed",
        });
      }
      return started;
    });
  }

  private async stopFundedBrowser(input: {
    readonly ownerUserId: string;
    readonly accountId: string;
    readonly reservationToken: string;
    readonly resource: "login" | "view";
    readonly fundingBinding: DurableServiceFundingBinding | null;
    readonly browserId: string;
  }): Promise<Awaited<ReturnType<BrowserUseCloudAdapter["stopBrowser"]>>> {
    return this.withFunding(input.ownerUserId, input.fundingBinding, "recover", async (provider, usageFunding) => {
      const stopped = await provider.stopBrowser(input.browserId);
      if (this.deps.settleCostAttempt && (!isFailure(stopped) || isAlreadyGone(stopped))) {
        await this.deps.settleCostAttempt({
          identity: this.browserCostIdentity(input.accountId, input.reservationToken),
          ...(usageFunding === undefined ? {} : { usageFunding }),
          userId: input.ownerUserId,
          workload: `connected_web_account_${input.resource}`,
          provider: "browser_use",
          operation: "browser_session",
          estimatedCostUsd: isFailure(stopped) ? null : stopped.costEvidence?.estimatedCostUsd ?? null,
          actualCostUsd: null,
          evidenceState: isFailure(stopped) ? "unknown" : stopped.costEvidence?.evidenceState ?? "unknown",
          attemptOutcome: "succeeded",
        });
      }
      return stopped;
    });
  }

  providerSetupStatus(): ConnectedWebAccountProviderSetupStatus {
    const health = this.deps.browser.health();
    if (health.kind === "available") return "ready";
    return health.reason === "missing_configuration"
      ? "api_key_required"
      : "api_key_invalid";
  }

  async providerSetupStatusForHuman(ownerUserId: string): Promise<ConnectedWebAccountProviderSetupStatus> {
    if (!this.deps.funding) return this.providerSetupStatus();
    try {
      const binding = await this.deps.funding.admit(ownerUserId);
      return await this.withFunding(ownerUserId, binding, "spend", (provider) => {
        const health = provider.health();
        return health.kind === "available"
          ? "ready"
          : health.reason === "missing_configuration" ? "api_key_required" : "api_key_invalid";
      });
    } catch {
      return "api_key_required";
    }
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
    const profileFundingBinding = this.deps.funding
      ? await this.deps.funding.admit(input.ownerUserId).catch(() => {
        throw new ConnectedWebAccountControllerError("provider_unavailable");
      })
      : (await this.requireServerFunding(input.ownerUserId, "connected_web_account_profile"), undefined);
    const account = await this.deps.store.createPending({
      ownerUserId: input.ownerUserId,
      account: { ...input.account, origin: target.origin },
      ...(profileFundingBinding === undefined ? {} : { profileFundingBinding }),
    });
    try {
      // Recheck after persistence so a concurrent grant revocation cannot use
      // the process-wide Browser Use key for profile creation.
      if (profileFundingBinding === undefined) {
        await this.requireServerFunding(input.ownerUserId, "connected_web_account_profile");
      }
    } catch (error) {
      await this.deps.store.revokeForOwner({ ownerUserId: input.ownerUserId, accountId: account.id });
      throw error;
    }
    const profile = profileFundingBinding === undefined
      ? await this.deps.browser.createProfile()
      : await this.withFunding(input.ownerUserId, profileFundingBinding, "spend", (browser) => browser.createProfile());
    if (isFailure(profile)) {
      if (isConfirmedProfileCreateFailure(profile)) {
        await this.deps.store.revokeForOwner({ ownerUserId: input.ownerUserId, accountId: account.id });
      } else {
        // The provider may have created a profile before the response was
        // lost. Keep this row quarantined; reconnect must not submit another.
        await this.deps.store.markProfileCreationUncertain({ ownerUserId: input.ownerUserId, accountId: account.id });
      }
      throw new ConnectedWebAccountControllerError("provider_unavailable");
    }
    try {
      await this.deps.store.bindProfileReference({ ownerUserId: input.ownerUserId, accountId: account.id, profileRef: profile.profileId,
        ...(profileFundingBinding === undefined ? {} : { profileFundingBinding }) });
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
      const existing = await this.withFunding(input.ownerUserId, binding.profileFundingBinding, "recover",
        (browser) => browser.getBrowser(binding.executionCheckpoint!.opaqueExecutionRef!));
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
    if (!this.deps.funding) await this.requireServerFunding(input.ownerUserId, "connected_web_account_login");
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
    const browser = await this.withFunding(input.ownerUserId, binding.profileFundingBinding, "recover",
      (provider) => provider.getBrowser(binding.executionCheckpoint!.opaqueExecutionRef!));
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
    const stopped = await this.stopFundedBrowser({
      ...input,
      reservationToken: binding.executionCheckpoint.reservationToken,
      resource: "login",
      fundingBinding: binding.profileFundingBinding,
      browserId: binding.executionCheckpoint.opaqueExecutionRef,
    });
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
    const profileRef = binding.profileRef;
    const account = await this.deps.store.getForOwner(input);
    if (!account) throw new ConnectedWebAccountStoreError("not_found");

    if (!this.deps.funding) await this.requireServerFunding(input.ownerUserId, "connected_web_account_view");
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
    const browser = await this.startFundedBrowser({
      ...input,
      reservationToken,
      resource: "view",
      fundingBinding: binding.profileFundingBinding,
      profileId: profileRef,
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
      const stopped = await this.stopFundedBrowser({ ...input, reservationToken, resource: "view", fundingBinding: binding.profileFundingBinding, browserId: browser.browserId });
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
      const stopped = await this.stopFundedBrowser({ ...input, reservationToken, resource: "view", fundingBinding: binding.profileFundingBinding, browserId: browser.browserId });
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
      const stopped = await this.stopFundedBrowser({ ...input, reservationToken, resource: "view", fundingBinding: binding.profileFundingBinding, browserId: browser.browserId });
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
    const stopped = await this.stopFundedBrowser({
      ...input,
      reservationToken: binding.executionCheckpoint.reservationToken,
      resource: "view",
      fundingBinding: binding.profileFundingBinding,
      browserId: binding.executionCheckpoint.opaqueExecutionRef,
    });
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
      const stopped = await this.stopFundedBrowser({
        ...input,
        reservationToken: binding.executionCheckpoint.reservationToken,
        resource: "login",
        fundingBinding: binding.profileFundingBinding,
        browserId: binding.executionCheckpoint.opaqueExecutionRef,
      });
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
    const observed = await this.withFunding(input.ownerUserId, binding.profileFundingBinding, "recover",
      (provider) => provider.observeHostedReadRun(checkpoint.opaqueExecutionRef!));
    if (isFailure(observed)) throw new ConnectedWebAccountControllerError("provider_unavailable");
    return { accountId: input.accountId, stage: observed.stage, canWatch: observed.liveViewUrl !== null };
  }

  async watchRead(input: { readonly ownerUserId: string; readonly accountId: string }): Promise<ConnectedWebAccountReadWatch> {
    const binding = await this.deps.store.getBindingForOwner(input);
    const checkpoint = binding.executionCheckpoint;
    if (checkpoint?.resource !== "read" || checkpoint.phase !== "active" || !checkpoint.opaqueExecutionRef) {
      throw new ConnectedWebAccountStoreError("conflict");
    }
    const observed = await this.withFunding(input.ownerUserId, binding.profileFundingBinding, "recover",
      (provider) => provider.observeHostedReadRun(checkpoint.opaqueExecutionRef!));
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
    const cancelled = await this.withFunding(input.ownerUserId, binding.profileFundingBinding, "recover",
      (provider) => provider.cancelHostedReadRun(checkpoint.opaqueExecutionRef!));
    if (isFailure(cancelled) && !isAlreadyGone(cancelled)) throw new ConnectedWebAccountControllerError("provider_unavailable");
    if (!isFailure(cancelled) && cancelled.status !== "cancelled" && cancelled.status !== "completed" && cancelled.status !== "failed") {
      throw new ConnectedWebAccountControllerError("provider_unavailable");
    }
    if (!await this.withFunding(input.ownerUserId, binding.profileFundingBinding, "recover",
      (provider) => provider.stopHostedReadBrowser(checkpoint.opaqueExecutionRef!))) throw new ConnectedWebAccountControllerError("provider_unavailable");
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
    const observed = await this.withFunding(input.ownerUserId, operation.fundingBinding ?? binding.profileFundingBinding, "recover",
      (provider) => provider.observeHostedReadRun(operation.opaqueRunRef!));
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
    const observed = await this.withFunding(input.ownerUserId, operation.fundingBinding ?? binding.profileFundingBinding, "recover",
      (provider) => provider.observeHostedReadRun(operation.opaqueRunRef!));
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
    const cancelled = await this.withFunding(input.ownerUserId, operation.fundingBinding ?? binding.profileFundingBinding, "recover",
      (provider) => provider.cancelHostedReadRun(operation.opaqueRunRef!));
    const providerTerminal = isAlreadyGone(cancelled) || isConfirmedHostedRunTerminal(cancelled, operation.opaqueRunRef);
    if (!providerTerminal) throw new ConnectedWebAccountControllerError("provider_unavailable");
    const cleaned = await this.withFunding(input.ownerUserId, operation.fundingBinding ?? binding.profileFundingBinding, "recover",
      (provider, usageFunding) => operation.runCostCustody
        ? settleConnectedWebActionRunCleanup({
          provider,
          runId: operation.opaqueRunRef!,
          custody: operation.runCostCustody,
          ...(usageFunding === undefined ? {} : { usageFunding }),
          ...(this.deps.settleCostAttempt === undefined ? {} : { settleCostAttempt: this.deps.settleCostAttempt }),
        })
        : provider.stopHostedReadBrowser(operation.opaqueRunRef!));
    if (!cleaned) throw new ConnectedWebAccountControllerError("provider_unavailable");
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
        const stopped = await this.stopFundedBrowser({
          ...input,
          reservationToken: binding.executionCheckpoint.reservationToken,
          resource: binding.executionCheckpoint.resource,
          fundingBinding: binding.profileFundingBinding,
          browserId: binding.executionCheckpoint.opaqueExecutionRef,
        });
        if (isFailure(stopped) && !isAlreadyGone(stopped)) throw new ConnectedWebAccountControllerError("provider_unavailable");
      } else {
        const cancelled = await this.withFunding(input.ownerUserId, binding.profileFundingBinding, "recover",
          (provider) => provider.cancelHostedReadRun(binding.executionCheckpoint!.opaqueExecutionRef!));
        if (isFailure(cancelled) && !isAlreadyGone(cancelled)) throw new ConnectedWebAccountControllerError("provider_unavailable");
        if (!isAlreadyGone(cancelled) && !isConfirmedHostedRunTerminal(cancelled, binding.executionCheckpoint.opaqueExecutionRef)) {
          throw new ConnectedWebAccountControllerError("provider_unavailable");
        }
        if (!await this.withFunding(input.ownerUserId, binding.profileFundingBinding, "recover",
          (provider) => provider.stopHostedReadBrowser(binding.executionCheckpoint!.opaqueExecutionRef!))) throw new ConnectedWebAccountControllerError("provider_unavailable");
      }
    }
    if (binding.profileRef) {
      const deleted = await this.withFunding(input.ownerUserId, binding.profileFundingBinding, "recover",
        (provider) => provider.deleteProfile(binding.profileRef!));
      if (isFailure(deleted) && !isAlreadyGone(deleted)) throw new ConnectedWebAccountControllerError("provider_unavailable");
    }
    const account = await this.deps.store.revokeForOwner(input);
    if (binding.profileRef) await this.deps.store.markProviderCleanupCompleted(binding.accountId);
    return account;
  }

  async reconcileStaleExecutions(): Promise<void> {
    const stale = await this.deps.store.listStaleExecutions();
    const listStaleActions = (this.deps.store as Partial<ConnectedWebAccountStore>).listStaleActionOperations;
    const staleActions = listStaleActions ? await listStaleActions.call(this.deps.store) : [];
    const actionByCheckpoint = new Map<string, (typeof staleActions)[number]>(staleActions.flatMap((operation) => operation.opaqueRunRef
      ? [[`${operation.accountId}\0${operation.opaqueRunRef}`, operation] as const]
      : []));
    const processedActionIds = new Set<string>();
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
      const checkpointKey = execution.checkpoint.resource === "action" && execution.checkpoint.opaqueExecutionRef
        ? `${execution.accountId}\0${execution.checkpoint.opaqueExecutionRef}`
        : null;
      const actionOperation = checkpointKey === null ? undefined : actionByCheckpoint.get(checkpointKey);
      let result: Awaited<ReturnType<BrowserUseCloudAdapter["stopBrowser"]>> | Awaited<ReturnType<BrowserUseCloudAdapter["cancelHostedReadRun"]>>;
      try {
        result = execution.checkpoint.resource === "login" || execution.checkpoint.resource === "view"
          ? await this.stopFundedBrowser({
            ownerUserId: execution.ownerUserId,
            accountId: execution.accountId,
            reservationToken: execution.checkpoint.reservationToken,
            resource: execution.checkpoint.resource,
            fundingBinding: execution.profileFundingBinding,
            browserId: execution.checkpoint.opaqueExecutionRef ?? "",
          })
          : await this.withFunding(execution.ownerUserId, actionOperation?.fundingBinding ?? execution.profileFundingBinding, "recover", (provider) =>
            provider.cancelHostedReadRun(execution.checkpoint.opaqueExecutionRef ?? ""));
      } catch {
        // A failed cancellation leaves the exact opaque reference fenced for
        // the next boot; do not make the saved profile writable yet.
        continue;
      }
      const terminal = execution.checkpoint.resource === "login" || execution.checkpoint.resource === "view"
        ? (!isFailure(result) || isAlreadyGone(result))
        : (isAlreadyGone(result) || isConfirmedHostedRunTerminal(result, execution.checkpoint.opaqueExecutionRef ?? ""));
      if (terminal) {
        if (execution.checkpoint.resource === "read"
          && !await this.withFunding(execution.ownerUserId, execution.profileFundingBinding, "recover",
            (provider) => provider.stopHostedReadBrowser(execution.checkpoint.opaqueExecutionRef ?? "")).catch(() => false)) continue;
        if (execution.checkpoint.resource === "action") {
          const cleaned = await this.withFunding(execution.ownerUserId, actionOperation?.fundingBinding ?? execution.profileFundingBinding, "recover",
            (provider, usageFunding) => actionOperation?.runCostCustody
              ? settleConnectedWebActionRunCleanup({
                provider,
                runId: execution.checkpoint.opaqueExecutionRef ?? "",
                custody: actionOperation.runCostCustody,
                ...(usageFunding === undefined ? {} : { usageFunding }),
                ...(this.deps.settleCostAttempt === undefined ? {} : { settleCostAttempt: this.deps.settleCostAttempt }),
              })
              : provider.stopHostedReadBrowser(execution.checkpoint.opaqueExecutionRef ?? "")).catch(() => false);
          if (!cleaned) continue;
          if (actionOperation) {
            const finished = await this.deps.store.finishActionOperation({
              operationId: actionOperation.id,
              status: "ambiguous",
              receipt: { executionRef: actionOperation.id, action: "save_item", target: actionOperation.target, effectState: "ambiguous", postcondition: null, evidenceCode: "restart_possible_effect", cost: { amountUsd: null, state: "unknown" } },
              expectedOpaqueRunRef: execution.checkpoint.opaqueExecutionRef ?? "",
            }).then(() => true, () => false);
            if (!finished) continue;
            processedActionIds.add(actionOperation.id);
          }
        }
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
    if (!listStaleActions) return;
    for (const operation of staleActions) {
      if (processedActionIds.has(operation.id)) continue;
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
      try { cancelled = await this.withFunding(operation.ownerUserId, operation.fundingBinding, "recover",
        (provider) => provider.cancelHostedReadRun(operation.opaqueRunRef!)); }
      catch { continue; }
      if (!isAlreadyGone(cancelled) && !isConfirmedHostedRunTerminal(cancelled, operation.opaqueRunRef)) continue;
      if (!await this.withFunding(operation.ownerUserId, operation.fundingBinding, "recover",
        (provider, usageFunding) => operation.runCostCustody
          ? settleConnectedWebActionRunCleanup({
            provider,
            runId: operation.opaqueRunRef!,
            custody: operation.runCostCustody,
            ...(usageFunding === undefined ? {} : { usageFunding }),
            ...(this.deps.settleCostAttempt === undefined ? {} : { settleCostAttempt: this.deps.settleCostAttempt }),
          })
          : provider.stopHostedReadBrowser(operation.opaqueRunRef!)).catch(() => false)) continue;
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
        deleted = await this.withFunding(candidate.ownerUserId, candidate.profileFundingBinding, "recover",
          (provider) => provider.deleteProfile(candidate.profileRef));
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
    if (!this.deps.funding) await this.requireServerFunding(input.ownerUserId, "connected_web_account_login");
    const reservationToken = randomUUID();
    await this.deps.store.reserveExecutionCheckpoint({
      ownerUserId: input.ownerUserId,
      accountId: input.accountId,
      checkpoint: { resource: "login", phase: "reserving", reservationToken, recordedAt: (this.deps.now ?? (() => new Date()))().toISOString() },
    });
    const browser = await this.startFundedBrowser({
      ownerUserId: input.ownerUserId,
      accountId: input.accountId,
      reservationToken,
      resource: "login",
      fundingBinding: binding.profileFundingBinding,
      profileId: binding.profileRef,
    });
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
      const stopped = await this.stopFundedBrowser({ ownerUserId: input.ownerUserId, accountId: input.accountId, reservationToken, resource: "login", fundingBinding: binding.profileFundingBinding, browserId: browser.browserId });
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
      const stopped = await this.stopFundedBrowser({ ownerUserId: input.ownerUserId, accountId: input.accountId, reservationToken, resource: "login", fundingBinding: binding.profileFundingBinding, browserId: browser.browserId });
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
      const stopped = await this.stopFundedBrowser({ ownerUserId: input.ownerUserId, accountId: input.accountId, reservationToken, resource: "login", fundingBinding: binding.profileFundingBinding, browserId: browser.browserId });
      if (!isFailure(stopped) || isAlreadyGone(stopped)) {
        await this.deps.store.completeExecution({ ownerUserId: input.ownerUserId, accountId: input.accountId, reservationToken, status: "attention_needed" });
      }
      throw error;
    }
  }

  private async revokeAndDeleteProfile(input: { readonly ownerUserId: string; readonly accountId: string; readonly profileId: string }): Promise<void> {
    await this.deps.store.revokeForOwner(input);
    const binding = await this.deps.store.getBindingForOwner({ ownerUserId: input.ownerUserId, accountId: input.accountId });
    const deleted = await this.withFunding(input.ownerUserId, binding.profileFundingBinding, "recover", (provider) => provider.deleteProfile(input.profileId));
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

  private async requireServerFunding(ownerUserId: string, origin: string): Promise<void> {
    if (!await canUseBrowserUseServerFunding(ownerUserId, origin, this.deps.assertServerFunding)) {
      throw new ConnectedWebAccountControllerError("server_funding_required");
    }
  }
}
