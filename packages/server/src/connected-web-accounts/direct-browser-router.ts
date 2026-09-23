import type {
  BrowserUseBrowserSession,
  BrowserUseHostedBrowserSession,
  BrowserUseProviderFailure,
  BrowserUseResult,
} from "../browser-use/browser-use-cloud";
import { warn } from "@nautilo/logger";
import { createHash, randomUUID } from "node:crypto";
import type { BrowserDecisionObservation } from "@nautilo/agent";
import type { ConnectedWebOperationProviderReferences } from "@nautilo/db";
import {
  createDirectBrowserControlSession,
  DirectBrowserControlError,
  type DirectBrowserControlCommand,
  type DirectBrowserControlCommandResult,
  type DirectBrowserControlHarness,
  type DirectBrowserControlSession,
} from "./direct-browser-control";
import type {
  ConnectedWebAccountBinding,
  ConnectedWebAccountStore,
  ConnectedWebOperation,
} from "./store";
import {
  canUseBrowserUseServerFunding,
  type BrowserUseServerFundingAdmission,
} from "../browser-use/browser-use-cloud";

const MAX_ROUTER_RESULT_BYTES = 96 * 1024;

/**
 * The caller may choose a saved profile or a Browser Use browser already
 * associated with the same hosted Agent session. It cannot supply a profile,
 * browser, CDP URL, or any other provider coordinate.
 */
export type DirectBrowserRouterSource = "saved_profile" | "hosted_session";

export interface DirectBrowserRouterAdmission {
  readonly ownerUserId: string;
  readonly accountId: string;
  readonly operationId: string;
  readonly expectedControlEpoch: number;
  readonly source: DirectBrowserRouterSource;
}

/** One-shot form for the future server tool route. */
export interface DirectBrowserRouterCommandInput extends DirectBrowserRouterAdmission {
  readonly command: DirectBrowserControlCommand;
}

export interface DirectBrowserRouterProvider {
  startBrowser(input: {
    readonly profileId: string;
    /** Explicit server policy; Browser Use accepts 1 through 240. */
    readonly timeoutMinutes: number;
  }): Promise<BrowserUseResult<BrowserUseBrowserSession>>;
  findHostedBrowsers(input: {
    readonly agentSessionId: string;
  }): Promise<BrowserUseResult<readonly BrowserUseHostedBrowserSession[]>>;
  stopBrowser(browserId: string): Promise<BrowserUseResult<BrowserUseBrowserSession>>;
}

/** Unsealed provider locators stay inside this server-only dependency. */
export interface DirectBrowserRouterProviderReferences {
  unseal(input: {
    readonly operation: ConnectedWebOperation;
    readonly references: ConnectedWebOperationProviderReferences;
  }): Promise<{
    readonly sessionId: string | null;
  } | null>;
  /** Seals only an exact attached browser id into the operation checkpoint. */
  sealBrowserRef?(input: {
    readonly operation: ConnectedWebOperation;
    readonly browserId: string;
  }): Promise<ConnectedWebOperationProviderReferences>;
}

/**
 * A hosted cancellation acknowledgement is intentionally insufficient. The
 * lifecycle owner must give this router a fresh terminal proof before direct
 * control can fence the hosted writer.
 */
export interface DirectBrowserRouterHostedLifecycle {
  hasTerminalProof(input: { readonly operation: ConnectedWebOperation }): Promise<boolean>;
}

/** The only authority allowed to choose operation-private filesystem paths. */
export interface DirectBrowserRouterDirectoryAuthority {
  allocate(input: {
    readonly ownerUserId: string;
    readonly accountId: string;
    readonly operationId: string;
    readonly controlEpoch: number;
    readonly harnessSession: string;
  }): Promise<DirectBrowserRouterDirectories>;
  /** Existing directories from every generation of this exact operation. */
  forRecovery?(input: { readonly ownerUserId: string; readonly accountId: string; readonly operationId: string; readonly controlEpoch: number }): AsyncIterable<DirectBrowserRouterDirectories>;
  release(input: DirectBrowserRouterDirectories): Promise<void>;
}

export interface DirectBrowserRouterDirectories {
  readonly socketDirectory: string;
  readonly homeDirectory: string;
}

export interface DirectBrowserRouterDependencies {
  readonly store: Pick<ConnectedWebAccountStore, "getBindingForOwner" | "getOperationForOwner" | "rotateOperationDriver">
    & Partial<Pick<ConnectedWebAccountStore, "takeOverReadOperationForDirect">>;
  readonly provider: DirectBrowserRouterProvider;
  readonly providerReferences: DirectBrowserRouterProviderReferences;
  readonly hostedLifecycle: DirectBrowserRouterHostedLifecycle;
  readonly directories: DirectBrowserRouterDirectoryAuthority;
  readonly harness: DirectBrowserControlHarness;
  /** Canonical HTTPS discovery -> same-host WSS implementation, injected for tests. */
  readonly resolveCdpWebSocketUrl: (cdpUrl: string, timeoutMs: number) => Promise<string>;
  /** Test seam for exact page target discovery; production uses CDP. */
  readonly findPageTargetAtOrigin?: (websocketUrl: string, origin: string, timeoutMs: number) => Promise<string>;
  /** Explicit provider policy, never model input. Must be Browser Use's 1..240 range. */
  readonly browserTimeoutMinutes: number;
  /** Lands a newly-started saved-profile browser on the durable account
   * origin before exact target discovery. Hosted-session attachment is
   * already on-page and never uses this seam. */
  readonly navigateSavedProfileBrowser: (cdpUrl: string, origin: string, timeoutMs: number) => Promise<void>;
  readonly now?: () => Date;
  readonly discoveryTimeoutMs?: number;
  /** Fresh current-Human funding authority before creating a paid browser. */
  readonly assertServerFunding?: BrowserUseServerFundingAdmission;
}

export interface DirectBrowserRouterCleanupResult {
  readonly browser: "stopped" | "cleanup_unresolved";
  readonly directories: "released" | "cleanup_unresolved";
  /** A stopped browser releases direct ownership; an uncertain stop remains a fenced recovery state. */
  readonly operation: "released" | "recovery_fenced" | "cleanup_unresolved";
}

export interface DirectBrowserRouterCommandResult {
  readonly result: DirectBrowserControlCommandResult;
  readonly cleanup: DirectBrowserRouterCleanupResult;
}

export class DirectBrowserRouterError extends Error {
  constructor(
    readonly code: "unavailable" | "stale_control" | "hosted_still_active" | "origin_not_allowed" | "fresh_snapshot_required" | "observation_stale" | "cancelled" | "outcome_unknown" | "observation_invalid",
    /** Server-only cleanup truth for a post-fence admission failure. */
    readonly cleanup?: DirectBrowserRouterCleanupResult,
    readonly detail?: string,
  ) {
    super("direct browser control unavailable");
    this.name = "DirectBrowserRouterError";
  }
}

function isProviderFailure(value: unknown): value is BrowserUseProviderFailure {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "failure";
}

function validAdmission(input: DirectBrowserRouterAdmission): boolean {
  return input.ownerUserId.length > 0
    && input.accountId.length > 0
    && input.operationId.length > 0
    && Number.isSafeInteger(input.expectedControlEpoch)
    && input.expectedControlEpoch >= 1
    && (input.source === "saved_profile" || input.source === "hosted_session");
}

function validDirectories(value: DirectBrowserRouterDirectories): boolean {
  return value.socketDirectory.length > 0 && value.homeDirectory.length > 0;
}

/** A direct takeover retains, rather than clears, the active read writer fence. */
function isActiveReadCheckpoint(binding: ConnectedWebAccountBinding): boolean {
  const checkpoint = binding.executionCheckpoint;
  return binding.status === "busy" && checkpoint !== null
    && checkpoint.resource === "read" && checkpoint.phase === "active";
}

function isDirectBinding(binding: ConnectedWebAccountBinding): boolean {
  return isActiveReadCheckpoint(binding)
    || (binding.status === "connected" && binding.executionCheckpoint === null);
}

function isUsableBrowser(value: BrowserUseBrowserSession): value is BrowserUseBrowserSession & { readonly cdpUrl: string } {
  return value.status === "active" && typeof value.browserId === "string" && value.browserId.length > 0
    && typeof value.cdpUrl === "string" && value.cdpUrl.length > 0;
}

function directActivity() {
  return {
    version: 1 as const,
    phase: "working" as const,
    code: "direct_browser_control",
    summary: "Connected website control is active.",
  };
}

function directReleaseActivity(browser: "stopped" | "cleanup_unresolved") {
  return browser === "stopped"
    ? {
      version: 1 as const,
      phase: "attention" as const,
      code: "direct_browser_control_released",
      summary: "Connected website control ended and needs a follow-up decision.",
    }
    : {
      version: 1 as const,
      phase: "attention" as const,
      code: "direct_browser_cleanup_unresolved",
      summary: "Connected website browser cleanup needs recovery before another writer can start.",
    };
}

async function releaseDirectOwnership(input: {
  readonly deps: DirectBrowserRouterDependencies;
  readonly admission: DirectBrowserRouterAdmission;
  readonly controlEpoch: number;
  readonly browser: "stopped" | "cleanup_unresolved";
  readonly onRotated?: (epoch: number) => void;
}): Promise<"released" | "recovery_fenced" | "cleanup_unresolved"> {
  const now = (input.deps.now ?? (() => new Date()))();
  const rotated = await input.deps.store.rotateOperationDriver({
    operationId: input.admission.operationId,
    expectedControlEpoch: input.controlEpoch,
    now,
    // An uncertain provider stop must remain an exclusive durable recovery
    // fence. It is not safe to hand the account to hosted or Human control.
    driver: input.browser === "stopped" ? "checking" : "direct",
    lifecycle: "attention",
    safeActivity: directReleaseActivity(input.browser),
    // The existing durable supervisor owns terminal truth for the cancelled
    // hosted read and atomically releases its exact busy account checkpoint.
    nextCheckAt: input.browser === "stopped" ? now : null,
    controlLeaseExpiresAt: null,
  }).catch(() => null);
  if (!rotated) return "cleanup_unresolved";
  input.onRotated?.(rotated.controlEpoch);
  return input.browser === "stopped" ? "released" : "recovery_fenced";
}

export function directBrowserHarnessSession(input: { readonly operationId: string; readonly accountId: string; readonly controlEpoch: number }): string {
  const digest = createHash("sha256")
    .update(`${input.operationId}:${input.accountId}:${input.controlEpoch}`)
    .digest("hex")
    .slice(0, 32);
  // The operation-private socket has a hard sockaddr_un path budget. Epoch is
  // already an input to this 128-bit digest, so repeating it (and the long
  // "direct" prefix) only consumes transport bytes without adding identity.
  return `d-${digest}`;
}

function harnessSessionFor(input: Pick<DirectBrowserRouterAdmission, "operationId" | "accountId" | "expectedControlEpoch">): string {
  return directBrowserHarnessSession({ operationId: input.operationId, accountId: input.accountId, controlEpoch: input.expectedControlEpoch + 1 });
}

function requestedOpenStaysAtOrigin(command: DirectBrowserControlCommand, origin: string): boolean {
  if (command.toolName !== "browser_open") return true;
  const url = command.args["url"];
  if (typeof url !== "string") return false;
  try { return new URL(url).origin === origin; } catch { return false; }
}

function truncateUtf8(value: string, maximumBytes: number): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return { text: value, truncated: false };
  let retainedBytes = 0;
  let text = "";
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (retainedBytes + bytes > maximumBytes) break;
    text += character;
    retainedBytes += bytes;
  }
  return { text, truncated: true };
}

function safeResult(result: DirectBrowserControlCommandResult): DirectBrowserControlCommandResult {
  const sanitized = result.text
    .replace(/wss:\/\/[^\s"'<>]+/gu, "[redacted]")
    .replace(/https:\/\/[^\s"'<>]*\.cdp\.browser-use\.com[^\s"'<>]*/giu, "[redacted]");
  const printable = [...sanitized].filter((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point === 9 || point === 10 || point === 13 || (point >= 32 && point !== 127);
  }).join("");
  const bounded = truncateUtf8(printable, MAX_ROUTER_RESULT_BYTES);
  return { text: bounded.text, truncated: result.truncated || bounded.truncated };
}

function browserForStart(result: BrowserUseResult<BrowserUseBrowserSession>): BrowserUseBrowserSession & { readonly cdpUrl: string } | null {
  return !isProviderFailure(result) && isUsableBrowser(result) ? result : null;
}

function browserForAttach(
  result: BrowserUseResult<readonly BrowserUseHostedBrowserSession[]>,
  agentSessionId: string,
): (BrowserUseHostedBrowserSession & { readonly cdpUrl: string }) | null {
  if (isProviderFailure(result)) return null;
  const candidates = result.filter((browser): browser is BrowserUseHostedBrowserSession & { readonly cdpUrl: string } =>
    browser.agentSessionId === agentSessionId && isUsableBrowser(browser));
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * A server-only direct browser lease. It never exposes a browser ID, profile,
 * CDP discovery URL, or private directory. Every command re-reads owner-scoped
 * operation and account state before starting the private harness.
 */
export class DirectBrowserRouterLease {
  private closed = false;
  private cleanup: Promise<DirectBrowserRouterCleanupResult> | null = null;
  private hasFreshSnapshot = false;
  private readonly decisionSessionId = randomUUID();
  private decisionObservation: { readonly id: string; readonly fingerprint: string } | null = null;

  constructor(
    private readonly admission: DirectBrowserRouterAdmission,
    private controlEpoch: number,
    private readonly bindingOrigin: string,
    /** Ephemeral owner-only Browser Use capability; it is never persisted. */
    private readonly liveViewUrl: string | null,
    private readonly directories: DirectBrowserRouterDirectories,
    private readonly control: DirectBrowserControlSession,
    private readonly deps: DirectBrowserRouterDependencies,
  ) {}

  /**
   * Returns only the exact Browser Use live-view capability attached to this
   * live lease. It deliberately exposes no browser, CDP, harness, or path
   * coordinate, and returns nothing after cleanup begins.
   */
  ownerLiveViewUrl(): string | null {
    return this.closed ? null : this.liveViewUrl;
  }

  /** Exact recovery epoch after cleanup fences a failed provider stop. */
  cleanupControlEpoch(): number { return this.controlEpoch; }

  private async currentBinding(): Promise<ConnectedWebAccountBinding> {
    const operation = await this.deps.store.getOperationForOwner({
      ownerUserId: this.admission.ownerUserId,
      operationId: this.admission.operationId,
    }).catch(() => null);
    const binding = await this.deps.store.getBindingForOwner({
      ownerUserId: this.admission.ownerUserId,
      accountId: this.admission.accountId,
    }).catch(() => null);
    if (!operation || !binding
      || operation.ownerUserId !== this.admission.ownerUserId
      || operation.accountId !== this.admission.accountId
      || operation.lifecycle === "terminal"
      || operation.driver !== "direct"
      || operation.controlEpoch !== this.controlEpoch
      || binding.ownerUserId !== this.admission.ownerUserId
      || binding.accountId !== this.admission.accountId
      || !isDirectBinding(binding)
      || binding.profileRef === null
      || binding.origin !== this.bindingOrigin) {
      throw new DirectBrowserRouterError("stale_control");
    }
    return binding;
  }

  async invoke(command: DirectBrowserControlCommand): Promise<DirectBrowserControlCommandResult> {
    if (this.closed) throw new DirectBrowserRouterError("stale_control");
    this.decisionObservation = null;
    const mutating = command.toolName === "browser_click"
      || command.toolName === "browser_type"
      || command.toolName === "browser_press"
      || command.toolName === "browser_open"
      || command.toolName === "browser_back"
      || command.toolName === "browser_forward"
      || command.toolName === "browser_reload"
      || command.toolName === "browser_hover"
      || command.toolName === "browser_double_click"
      || command.toolName === "browser_drag"
      || command.toolName === "browser_select"
      || command.toolName === "browser_set_checked"
      || command.toolName === "browser_scroll"
      || command.toolName === "browser_scroll_into_view";
    if (mutating && !this.hasFreshSnapshot) {
      throw new DirectBrowserRouterError("fresh_snapshot_required");
    }
    try {
      const binding = await this.currentBinding();
      if (!requestedOpenStaysAtOrigin(command, binding.origin)) {
        throw new DirectBrowserRouterError("origin_not_allowed");
      }
      // Consume the snapshot before an action begins: a transport failure is
      // never permission to replay an action against a possibly changed page.
      if (mutating) this.hasFreshSnapshot = false;
      const result = await this.control.invoke(command);
      if (command.toolName === "browser_snapshot") this.hasFreshSnapshot = true;
      return safeResult(result);
    } catch (error) {
      await this.close();
      if (error instanceof DirectBrowserRouterError) throw error;
      if (error instanceof DirectBrowserControlError && error.code === "stale_control") {
        throw new DirectBrowserRouterError("stale_control");
      }
      throw new DirectBrowserRouterError("unavailable");
    }
  }

  async observeDecision(signal?: AbortSignal): Promise<BrowserDecisionObservation> {
    if (this.closed) throw new DirectBrowserRouterError("stale_control");
    this.decisionObservation = null;
    this.hasFreshSnapshot = false;
    if (signal?.aborted) throw new DirectBrowserRouterError("cancelled");
    try {
      await this.currentBinding();
      const result = await this.control.observe(signal);
      if (signal?.aborted) throw new DirectBrowserRouterError("cancelled");
      const observation: BrowserDecisionObservation = {
        version: 1,
        snapshot: result.observation.snapshot,
        refs: result.observation.refs,
        pageUrl: result.pageUrl,
        browserSessionId: this.decisionSessionId,
        observationId: randomUUID(),
      };
      const fingerprint = createHash("sha256").update(JSON.stringify({ snapshot: observation.snapshot,
        refs: observation.refs, pageUrl: observation.pageUrl })).digest("hex");
      this.decisionObservation = { id: observation.observationId, fingerprint };
      this.hasFreshSnapshot = true;
      return observation;
    } catch (error) {
      if (error instanceof DirectBrowserRouterError) throw error;
      if (signal?.aborted) throw new DirectBrowserRouterError("cancelled");
      if (error instanceof DirectBrowserControlError && error.code === "stale_control") {
        await this.close();
        throw new DirectBrowserRouterError("stale_control", undefined, error.detail);
      }
      const detail = typeof error === "object" && error !== null && "detail" in error && typeof error.detail === "string"
        ? error.detail : undefined;
      throw new DirectBrowserRouterError("observation_invalid", undefined, detail);
    }
  }

  async invokeDecision(command: DirectBrowserControlCommand, observationId: string, signal?: AbortSignal): Promise<DirectBrowserControlCommandResult> {
    if (this.closed) throw new DirectBrowserRouterError("stale_control");
    if (signal?.aborted) throw new DirectBrowserRouterError("cancelled");
    if (!this.decisionObservation || this.decisionObservation.id !== observationId) {
      throw new DirectBrowserRouterError("observation_stale");
    }
    this.hasFreshSnapshot = false;
    try {
      await this.currentBinding();
    } catch (error) {
      await this.close();
      throw error;
    }
    const refreshed = await this.control.observe(signal).catch((error: unknown) => {
      if (signal?.aborted) throw new DirectBrowserRouterError("cancelled");
      if (error instanceof DirectBrowserControlError && error.code === "stale_control") {
        throw new DirectBrowserRouterError("stale_control", undefined, error.detail);
      }
      const detail = typeof error === "object" && error !== null && "detail" in error && typeof error.detail === "string"
        ? error.detail : undefined;
      throw new DirectBrowserRouterError("observation_invalid", undefined, detail);
    });
    const fingerprint = createHash("sha256").update(JSON.stringify({ snapshot: refreshed.observation.snapshot,
      refs: refreshed.observation.refs, pageUrl: refreshed.pageUrl })).digest("hex");
    if (fingerprint !== this.decisionObservation.fingerprint) {
      this.decisionObservation = null;
      this.hasFreshSnapshot = false;
      throw new DirectBrowserRouterError("observation_stale");
    }
    this.decisionObservation = null;
    this.hasFreshSnapshot = false;
    if (signal?.aborted) throw new DirectBrowserRouterError("cancelled");
    try {
      await this.currentBinding();
      if (!requestedOpenStaysAtOrigin(command, this.bindingOrigin)) throw new DirectBrowserRouterError("origin_not_allowed");
      return await this.control.invoke(command, signal);
    } catch (error) {
      await this.close();
      if (error instanceof DirectBrowserRouterError) throw error;
      const detail = error instanceof DirectBrowserControlError ? error.detail : undefined;
      throw new DirectBrowserRouterError("outcome_unknown", undefined, detail);
    }
  }

  /** Stop the exact browser; failed cleanup retries retain the recovery epoch. */
  async close(): Promise<DirectBrowserRouterCleanupResult> {
    if (this.cleanup !== null) return this.cleanup;
    this.closed = true;
    this.cleanup = (async () => {
      const browser = await this.control.close();
      const directories = browser.status === "stopped"
        ? await this.deps.directories.release(this.directories)
          .then(() => "released" as const)
          .catch(() => "cleanup_unresolved" as const)
        : "cleanup_unresolved" as const;
      const operation = await releaseDirectOwnership({
        deps: this.deps,
        admission: this.admission,
        controlEpoch: this.controlEpoch,
        onRotated: (epoch) => { this.controlEpoch = epoch; },
        // A stopped provider browser is not full release proof while its
        // private harness directory remains unresolved. Keep the durable
        // direct fence so restart recovery can retry that exact cleanup.
        browser: browser.status === "stopped" && directories === "released"
          ? "stopped"
          : "cleanup_unresolved",
      });
      return { browser: browser.status, directories, operation };
    })();
    try {
      const result = await this.cleanup;
      if (result.operation !== "released") this.cleanup = null;
      return result;
    } catch (error) {
      this.cleanup = null;
      throw error;
    }
  }
}

/**
 * Direct-driver admission/router core. This is intentionally not registered
 * as a Genie tool or HTTP route yet; callers must construct it with server
 * authorities and keep the returned lease in their private operation runtime.
 */
export class DirectBrowserRouter {
  constructor(private readonly deps: DirectBrowserRouterDependencies) {}

  private async readAdmission(input: DirectBrowserRouterAdmission): Promise<{
    readonly operation: ConnectedWebOperation;
    readonly binding: ConnectedWebAccountBinding;
  }> {
    if (!validAdmission(input)) throw new DirectBrowserRouterError("unavailable");
    const [operation, binding] = await Promise.all([
      this.deps.store.getOperationForOwner({ ownerUserId: input.ownerUserId, operationId: input.operationId }).catch(() => null),
      this.deps.store.getBindingForOwner({ ownerUserId: input.ownerUserId, accountId: input.accountId }).catch(() => null),
    ]);
    if (!operation || !binding
      || operation.ownerUserId !== input.ownerUserId
      || operation.accountId !== input.accountId
      // The legacy saved-item verifier owns its effect ledger. General website
      // tasks use the sealed task intent and ordinary supervised operation;
      // production rechecks that authority before every direct command.
      || operation.actionOperationId !== null
      || operation.effectIdempotencyKey !== null
      || operation.lifecycle === "terminal"
      || operation.controlEpoch !== input.expectedControlEpoch
      || binding.ownerUserId !== input.ownerUserId
      || binding.accountId !== input.accountId
      || binding.profileRef === null
      || !isDirectBinding(binding)) {
      throw new DirectBrowserRouterError("stale_control");
    }
    if (operation.driver === "direct" || operation.driver === "human") {
      throw new DirectBrowserRouterError("stale_control");
    }
    if ((operation.driver === "hosted" || operation.driver === "checking")
      && !await this.deps.hostedLifecycle.hasTerminalProof({ operation }).catch(() => false)) {
      throw new DirectBrowserRouterError("hosted_still_active");
    }
    return { operation, binding };
  }

  private async startOrAttach(input: DirectBrowserRouterAdmission, binding: ConnectedWebAccountBinding, operation: ConnectedWebOperation): Promise<BrowserUseBrowserSession & { readonly cdpUrl: string }> {
    if (input.source === "saved_profile") {
      if (!await canUseBrowserUseServerFunding(
        input.ownerUserId,
        "connected_web_direct_browser",
        this.deps.assertServerFunding,
      )) throw new DirectBrowserRouterError("unavailable");
      const browser = browserForStart(await this.deps.provider.startBrowser({
        profileId: binding.profileRef!, timeoutMinutes: this.deps.browserTimeoutMinutes,
      }).catch(() => ({ kind: "failure", code: "network_error" } as const)));
      if (!browser) throw new DirectBrowserRouterError("unavailable");
      return browser;
    }
    const references = await this.deps.providerReferences.unseal({
      operation,
      references: operation.sealedProviderRefs,
    }).catch(() => null);
    if (!references?.sessionId) throw new DirectBrowserRouterError("unavailable");
    const browser = browserForAttach(await this.deps.provider.findHostedBrowsers({
      agentSessionId: references.sessionId,
    }).catch(() => ({ kind: "failure", code: "network_error" } as const)), references.sessionId);
    if (!browser) throw new DirectBrowserRouterError("unavailable");
    return browser;
  }

  private async stopBrowser(browserId: string): Promise<void> {
    const stopped = await this.deps.provider.stopBrowser(browserId);
    if (isProviderFailure(stopped) && stopped.code === "resource_not_found") return;
    if (isProviderFailure(stopped) || stopped.browserId !== browserId || stopped.status !== "stopped") {
      throw new Error("stop unavailable");
    }
  }

  /**
   * Opens one fenced direct-control lease. The caller owns closing it; command
   * invocations additionally close it on every failed/origin-stale path.
   */
  async acquire(input: DirectBrowserRouterAdmission): Promise<DirectBrowserRouterLease> {
    let setupStage = "admission";
    let browser: (BrowserUseBrowserSession & { readonly cdpUrl: string }) | null = null;
    let directories: DirectBrowserRouterDirectories | null = null;
    let controlCreationAttempted = false;
    let rotatedControlEpoch: number | null = null;
    try {
      if (!Number.isInteger(this.deps.browserTimeoutMinutes)
        || this.deps.browserTimeoutMinutes < 1 || this.deps.browserTimeoutMinutes > 240) {
        throw new DirectBrowserRouterError("unavailable");
      }
      const { operation, binding } = await this.readAdmission(input);
      setupStage = "browser";
      browser = await this.startOrAttach(input, binding, operation);
      // Retain exact browser custody before any fallible navigation so the
      // catch path stops the paid resource even when no lease was established.
      if (input.source === "saved_profile") {
        setupStage = "navigation";
        await this.deps.navigateSavedProfileBrowser(
          browser.cdpUrl, binding.origin, this.deps.discoveryTimeoutMs ?? 10_000,
        );
      }
      setupStage = "directories";
      const harnessSession = harnessSessionFor(input);
      directories = await this.deps.directories.allocate({
        ownerUserId: input.ownerUserId,
        accountId: input.accountId,
        operationId: input.operationId,
        controlEpoch: input.expectedControlEpoch + 1,
        harnessSession,
      });
      if (!validDirectories(directories)) throw new DirectBrowserRouterError("unavailable");
      setupStage = "fence";
      const now = (this.deps.now ?? (() => new Date()))();
      const activeRead = isActiveReadCheckpoint(binding);
      const rotated = activeRead
        ? await (async () => {
          const checkpoint = binding.executionCheckpoint;
          if (!checkpoint || checkpoint.phase !== "active" || checkpoint.resource !== "read" || !checkpoint.opaqueExecutionRef
            || !operation.sealedProviderRefs.runRef || !this.deps.providerReferences.sealBrowserRef || !this.deps.store.takeOverReadOperationForDirect) {
            throw new DirectBrowserRouterError("stale_control");
          }
          const sealedProviderRefs = await this.deps.providerReferences.sealBrowserRef({ operation, browserId: browser.browserId });
          return this.deps.store.takeOverReadOperationForDirect({
            ownerUserId: input.ownerUserId, accountId: input.accountId, operationId: input.operationId,
            expectedControlEpoch: input.expectedControlEpoch, expectedRunRef: operation.sealedProviderRefs.runRef,
            opaqueExecutionRef: checkpoint.opaqueExecutionRef, sealedProviderRefs, now, safeActivity: directActivity(),
          });
        })()
        : await this.deps.store.rotateOperationDriver({
          operationId: input.operationId, expectedControlEpoch: input.expectedControlEpoch, now,
          driver: "direct", lifecycle: "running", safeActivity: directActivity(), nextCheckAt: null, controlLeaseExpiresAt: null,
        });
      if (!rotated || rotated.controlEpoch !== input.expectedControlEpoch + 1) {
        throw new DirectBrowserRouterError("stale_control");
      }
      rotatedControlEpoch = rotated.controlEpoch;
      setupStage = "harness";
      const identity = {
        operationId: input.operationId,
        accountId: input.accountId,
        controlEpoch: rotated.controlEpoch,
      };
      controlCreationAttempted = true;
      const control = await createDirectBrowserControlSession({
        identity,
        browser: { browserId: browser.browserId, cdpUrl: browser.cdpUrl },
        allowedOrigin: binding.origin,
        harnessSession,
        socketDirectory: directories.socketDirectory,
        homeDirectory: directories.homeDirectory,
      }, {
        provider: { stopBrowser: (browserId) => this.stopBrowser(browserId) },
        harness: this.deps.harness,
        isCurrentControlEpoch: async (current) => {
          const fresh = await this.readCurrentForControl(input, current.controlEpoch);
          return fresh;
        },
        resolveCdpWebSocketUrl: this.deps.resolveCdpWebSocketUrl,
        ...(this.deps.findPageTargetAtOrigin === undefined ? {} : { findPageTargetAtOrigin: this.deps.findPageTargetAtOrigin }),
        ...(this.deps.discoveryTimeoutMs === undefined ? {} : { discoveryTimeoutMs: this.deps.discoveryTimeoutMs }),
      });
      return new DirectBrowserRouterLease(input, rotated.controlEpoch, binding.origin, browser.liveViewUrl, directories, control, this.deps);
    } catch (error) {
      warn(`[connected-web-operation] direct router setup failed stage=${setupStage} code=${
        error instanceof DirectBrowserRouterError || error instanceof DirectBrowserControlError
          ? error.code
          : "unexpected"
      } operation=${input.operationId}`);
      const controlCleanup = error instanceof DirectBrowserControlError ? error.cleanup : undefined;
      const directoriesCleanup = directories === null
        ? "released" as const
        : controlCreationAttempted && controlCleanup?.status !== "stopped"
          ? "cleanup_unresolved" as const
        : await this.deps.directories.release(directories)
          .then(() => "released" as const)
          .catch(() => "cleanup_unresolved" as const);
      // createDirectBrowserControlSession owns exact cleanup once it begins.
      const browserCleanup = browser === null
        ? "stopped" as const
        : controlCreationAttempted
          ? controlCleanup?.status ?? "cleanup_unresolved" as const
          : await this.stopBrowser(browser.browserId)
            .then(() => "stopped" as const)
            .catch(() => "cleanup_unresolved" as const);
      const cleanup = rotatedControlEpoch === null
        ? undefined
        : {
          browser: browserCleanup,
          directories: directoriesCleanup,
          operation: await releaseDirectOwnership({
            deps: this.deps,
            admission: input,
            controlEpoch: rotatedControlEpoch,
            browser: browserCleanup === "stopped" && directoriesCleanup === "released" ? "stopped" : "cleanup_unresolved",
          }),
        } satisfies DirectBrowserRouterCleanupResult;
      if (error instanceof DirectBrowserRouterError) throw new DirectBrowserRouterError(error.code, cleanup);
      if (error instanceof DirectBrowserControlError && error.code === "stale_control") {
        throw new DirectBrowserRouterError("stale_control", cleanup);
      }
      throw new DirectBrowserRouterError("unavailable", cleanup);
    }
  }

  private async readCurrentForControl(input: DirectBrowserRouterAdmission, epoch: number): Promise<boolean> {
    const [operation, binding] = await Promise.all([
      this.deps.store.getOperationForOwner({ ownerUserId: input.ownerUserId, operationId: input.operationId }).catch(() => null),
      this.deps.store.getBindingForOwner({ ownerUserId: input.ownerUserId, accountId: input.accountId }).catch(() => null),
    ]);
    return operation !== null && binding !== null
      && operation.ownerUserId === input.ownerUserId
      && operation.accountId === input.accountId
      && operation.driver === "direct"
      && operation.lifecycle !== "terminal"
      && operation.controlEpoch === epoch
      && binding.ownerUserId === input.ownerUserId
      && binding.accountId === input.accountId
      && binding.profileRef !== null
      && isDirectBinding(binding);
  }

  /** Safely useful for a future single-command route; it reports any unresolved exact-browser cleanup. */
  async execute(input: DirectBrowserRouterCommandInput): Promise<DirectBrowserRouterCommandResult> {
    const lease = await this.acquire(input);
    try {
      const result = await lease.invoke(input.command);
      return { result, cleanup: await lease.close() };
    } catch (error) {
      await lease.close();
      throw error;
    }
  }
}
