import {
  BROWSER_USE_API_KEY_ENV_VAR,
  getKeyByEnvVar,
} from "@nautilo/config-guard";
import { RELAY_MEDIA_MAX_BYTES } from "@nautilo/relay";
import { createHash } from "node:crypto";
import { assertCanUseServerProviderCredentials } from "@nautilo/trust";
import type { UsageFundingProvenance } from "@nautilo/agent";

export const BROWSER_USE_V4_BASE_URL = "https://api.browser-use.com/api/v4";
export const BROWSER_USE_DEFAULT_MODEL = "gpt-5.6-luna";
/** Operational transport deadline; not a product, run, or provider limit. */
const BROWSER_USE_NETWORK_DEADLINE_MS = 30_000;

export interface BrowserUseFetch {
  (input: string, init: RequestInit): Promise<Response>;
}

export interface BrowserUseClock {
  now(): Date;
}

/** Fresh Human authority check used immediately before a server-funded Browser Use dispatch. */
export type BrowserUseServerFundingAdmission = (
  humanUserId: string,
  origin?: string,
) => Promise<void>;

/**
 * Browser Use callers fail closed when RBAC is unavailable or the current
 * Human has selected BYOK-only funding. Provider-neutral callers can map the
 * false result to their existing unavailable response without exposing RBAC.
 */
export async function canUseBrowserUseServerFunding(
  humanUserId: string,
  origin: string,
  admit: BrowserUseServerFundingAdmission = assertCanUseServerProviderCredentials,
): Promise<boolean> {
  try {
    await admit(humanUserId, origin);
    return true;
  } catch {
    return false;
  }
}

export interface BrowserUseCloudAdapterOptions {
  /** Live server key registry. Config Guard updates this object after API-key saves. */
  readonly serverKeys: Readonly<Record<string, string | undefined>>;
  readonly fetch?: BrowserUseFetch;
  readonly clock?: BrowserUseClock;
  /** Operational request deadline to avoid a stuck server fetch. */
  readonly requestTimeoutMs?: number;
  /** Exact request-local credential selected by the durable funding owner. */
  readonly requestCredential?: Readonly<{
    apiKey: string;
    usageFunding: UsageFundingProvenance;
  }>;
}

export type BrowserUseProviderHealth =
  | { readonly kind: "available"; readonly verification: "not_checked" }
  | { readonly kind: "unavailable"; readonly reason: "missing_configuration" | "invalid_configuration" };

type BrowserUseApiKeyResolution =
  | { readonly kind: "configured"; readonly apiKey: string }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" };

export type BrowserUseFailureCode =
  | "missing_configuration"
  | "invalid_configuration"
  | "authentication_failed"
  | "insufficient_balance"
  | "resource_not_found"
  | "conflict"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "cancelled"
  | "network_error"
  | "malformed_response"
  | "invalid_browser_policy"
  | "invalid_cost_policy";

/** Deliberately contains no provider message, body, URL, or external ID. */
export interface BrowserUseProviderFailure {
  readonly kind: "failure";
  readonly code: BrowserUseFailureCode;
}

export interface BrowserUseProfile {
  /** Server checkpoint only; never serialize this beyond server custody. */
  readonly profileId: string;
}

export interface BrowserUseBrowserSession {
  /** Server checkpoint only; never serialize this beyond server custody. */
  readonly browserId: string;
  /** Bearer capability: return only through the future owner-gated route. */
  readonly liveViewUrl: string | null;
  /** Server-only control coordinate. Never put this in an HTTP response or durable projection. */
  readonly cdpUrl: string | null;
  /** Provider-reported expiry, not a Nautilo-derived timeout. */
  readonly timeoutAt: Date;
  readonly observedAt: Date;
  readonly status: "active" | "stopped";
  /** Terminal provider evidence. The durable lifecycle owner records it. */
  readonly costEvidence?: Readonly<{
    readonly estimatedCostUsd: string | null;
    readonly evidenceState: "estimated" | "unknown";
  }>;
}

export interface BrowserUseHostedBrowserCleanup {
  readonly stopped: boolean;
  readonly estimatedCostUsd: string | null;
  readonly evidenceState: "estimated" | "unknown";
}

/**
 * A provider browser discovered through a hosted Agent session. This stays in
 * the server-side operation checkpoint; its capabilities are not an API or
 * model projection.
 */
export interface BrowserUseHostedBrowserSession extends BrowserUseBrowserSession {
  /** Server checkpoint only; used to prove the browser belongs to this run chain. */
  readonly agentSessionId: string;
}

export type BrowserUseRunStatus =
  | "queued"
  | "dispatching"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface BrowserUseHostedReadRun {
  /** Server checkpoint only; never serialize this beyond server custody. */
  readonly runId: string;
  /** Internal-only retrieval locators; never leave the server adapter/runtime. */
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly status: BrowserUseRunStatus;
  readonly observedAt: Date;
}

export interface BrowserUseHostedReadResult extends BrowserUseHostedReadRun {
  /** Untrusted provider output; later tool code must validate it. */
  readonly result: string | null;
  /** Provisional provider-reported usage cost, absent when the provider omits it. */
  readonly totalCostUsd: string | null;
}

/** Safe server-side observation. Provider event data is never forwarded. */
export interface BrowserUseHostedReadObservation extends BrowserUseHostedReadRun {
  readonly stage: "starting" | "planning" | "browsing" | "saving" | "finishing";
  /** Bearer capability. Only an owner-authenticated watch route may return it. */
  readonly liveViewUrl: string | null;
}

/** Raw provider event material for the durable server supervisor only. */
export interface BrowserUseHostedRunEvent {
  /** Monotonic Browser Use event cursor; never project it to a client or model. */
  readonly eventId: number;
  readonly occurredAt: Date;
  readonly type: string;
  /**
   * Untrusted provider data. It can contain bearer coordinates and page text;
   * normalization/redaction is the supervisor's boundary before any wake or
   * Workbench projection.
   */
  readonly data: Readonly<Record<string, unknown>>;
}

/** One validated Browser Use cursor page. It is server checkpoint material. */
export interface BrowserUseHostedRunEventDelta {
  readonly runId: string;
  readonly events: readonly BrowserUseHostedRunEvent[];
  /** Highest accepted event ID, or null if this page has no events. */
  readonly nextAfter: number | null;
  /** Preserved provider pagination truth; callers commit a cursor per page. */
  readonly hasMore: boolean;
  readonly observedAt: Date;
}

/** Server-only bytes collected during the active run; no provider locator survives. */
export interface BrowserUseHostedOutput {
  readonly path: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface BrowserUseHostedOutputCollection {
  readonly outputs: readonly BrowserUseHostedOutput[];
  /** More provider files existed than the explicit caller projection requested. */
  readonly truncated: boolean;
}

/**
 * Provider file listings are retrieved in full. This existing Workspace/relay
 * binary-ingestion boundary rejects individual files too large for custody.
 */
export type BrowserUseResult<T> = T | BrowserUseProviderFailure;

interface BrowserWireSession {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly liveUrl?: unknown;
  readonly cdpUrl?: unknown;
  readonly timeoutAt?: unknown;
  readonly browserCost?: unknown;
  readonly proxyCost?: unknown;
  readonly agentSessionId?: unknown;
}

interface RunWireStatus {
  readonly status?: unknown;
  readonly sessionId?: unknown;
  readonly workspaceId?: unknown;
}

interface RunWireSummary extends RunWireStatus {
  readonly result?: unknown;
  readonly totalCostUsd?: unknown;
}

interface RunWireEvent {
  readonly runId?: unknown;
  readonly id?: unknown;
  readonly ts?: unknown;
  readonly type?: unknown;
  readonly data?: unknown;
}

interface HostedOutputCandidate {
  readonly path: string;
  readonly url: string;
  readonly size: number;
}

interface HostedOutputByteReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

const SYSTEM_CLOCK: BrowserUseClock = { now: () => new Date() };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunStatus(value: unknown): value is BrowserUseRunStatus {
  return value === "queued"
    || value === "dispatching"
    || value === "running"
    || value === "completed"
    || value === "failed"
    || value === "cancelled";
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function normalizeHostedOutputPath(rawPath: string, outputScope: string): string | null {
  // Provider paths are presentation only. Keep just a safe basename under a
  // server-owned directory, so neither traversal nor provider hierarchy can
  // become a Workspace authority boundary.
  const segments = rawPath.split(/[\\/]/u).filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  const basename = segments.at(-1);
  if (!basename || basename === "." || basename === ".." || [...basename].some((char) => {
    const point = char.codePointAt(0) ?? 0;
    return point <= 0x1f || point === 0x7f;
  })) return null;
  // Do not trust provider directory segments. The hash avoids collisions when
  // separate provider files share a basename, while the short basename keeps a
  // Human-useful Workspace receipt.
  const safeBasename = [...basename].slice(0, 120).join("");
  // Include the current provider run scope in the digest so repeating the
  // same explicit export later creates a new receipt instead of colliding
  // with an earlier Workspace artifact at the same provider path.
  const suffix = createHash("sha256").update(outputScope).update("\0").update(rawPath).digest("hex").slice(0, 16);
  return `connected-web/${suffix}/${safeBasename}`;
}

function readHostedOutputCandidates(body: unknown, field: "files", outputScope: string): HostedOutputCandidate[] | null {
  if (!isRecord(body) || !Array.isArray(body[field])) return null;
  const candidates: HostedOutputCandidate[] = [];
  for (const item of body[field]) {
    const size = isRecord(item) ? item["size"] : undefined;
    if (!isRecord(item) || typeof item["path"] !== "string" || typeof item["url"] !== "string"
      || typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > RELAY_MEDIA_MAX_BYTES) {
      return null;
    }
    const path = normalizeHostedOutputPath(item["path"], outputScope);
    if (path === null) return null;
    candidates.push({ path, url: item["url"], size });
  }
  return candidates;
}

function normalizeHostedOutputMimeType(value: string | null): string {
  const mimeType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(mimeType)
    ? mimeType
    : "application/octet-stream";
}

async function readHostedOutputBytes(response: Response, expectedSize: number): Promise<Uint8Array | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) !== expectedSize)) return null;
  if (!response.body) return null;
  const bytes = new Uint8Array(expectedSize);
  const reader = response.body.getReader() as HostedOutputByteReader;
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || offset + value.byteLength > expectedSize || offset + value.byteLength > RELAY_MEDIA_MAX_BYTES) return null;
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return offset === expectedSize ? bytes : null;
}

function isExpectedProviderCapability(value: unknown, protocol: "https:", hostname: string): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === protocol
      && url.hostname === hostname
      && url.port.length === 0
      && url.username.length === 0
      && url.password.length === 0
      && url.hash.length === 0
      && url.pathname.startsWith("/");
  } catch { return false; }
}

/** Browser Use currently returns an HTTPS CDP discovery capability per browser. */
function isExpectedCdpDiscoveryCapability(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const suffix = ".cdp.browser-use.com";
    const capabilityLabel = url.hostname.endsWith(suffix)
      ? url.hostname.slice(0, -suffix.length)
      : "";
    return url.protocol === "https:"
      && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(capabilityLabel)
      && url.port.length === 0
      && url.username.length === 0
      && url.password.length === 0
      && url.hash.length === 0;
  } catch { return false; }
}

function isFailure(value: unknown): value is BrowserUseProviderFailure {
  return isRecord(value) && value["kind"] === "failure" && typeof value["code"] === "string";
}

function isMissingHostedOutputSurface(value: unknown): value is BrowserUseProviderFailure {
  return isFailure(value) && value.code === "resource_not_found";
}

function resolveBrowserUseApiKey(
  serverKeys: Readonly<Record<string, string | undefined>>,
): BrowserUseApiKeyResolution {
  const value = serverKeys[BROWSER_USE_API_KEY_ENV_VAR];
  if (value === undefined || value.length === 0) return { kind: "missing" };
  const definition = getKeyByEnvVar(BROWSER_USE_API_KEY_ENV_VAR);
  if (!definition?.formatCheck(value)) return { kind: "invalid" };
  return { kind: "configured", apiKey: value };
}

function unavailableFailure(
  resolution: BrowserUseApiKeyResolution,
): BrowserUseProviderFailure | null {
  if (resolution.kind === "missing") {
    return { kind: "failure", code: "missing_configuration" };
  }
  if (resolution.kind === "invalid") {
    return { kind: "failure", code: "invalid_configuration" };
  }
  return null;
}

function mapHttpFailure(status: number): BrowserUseProviderFailure {
  if (status === 401) {
    return { kind: "failure", code: "authentication_failed" };
  }
  if (status === 402) return { kind: "failure", code: "insufficient_balance" };
  if (status === 404) return { kind: "failure", code: "resource_not_found" };
  if (status === 408 || status === 504) return { kind: "failure", code: "timeout" };
  if (status === 409) return { kind: "failure", code: "conflict" };
  if (status === 429) return { kind: "failure", code: "rate_limited" };
  if (status >= 500) return { kind: "failure", code: "provider_unavailable" };
  return { kind: "failure", code: "provider_unavailable" };
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error["name"] === "AbortError";
}

/**
 * Narrow REST adapter for the connected website lifecycle. It intentionally owns
 * no retries, queues, durable checkpoints, or UI/API projection. Values with
 * provider bearer authority remain inside the server caller and are never put
 * in exception messages or this adapter's failure type.
 */
export class BrowserUseCloudAdapter {
  private readonly serverKeys: Readonly<Record<string, string | undefined>>;
  private readonly fetchImpl: BrowserUseFetch;
  private readonly clock: BrowserUseClock;
  private readonly requestTimeoutMs: number;
  private readonly requestCredential: BrowserUseCloudAdapterOptions["requestCredential"];

  constructor(options: BrowserUseCloudAdapterOptions) {
    this.serverKeys = options.serverKeys;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.requestCredential = options.requestCredential;
    const requestTimeoutMs = options.requestTimeoutMs;
    this.requestTimeoutMs = typeof requestTimeoutMs === "number" && Number.isInteger(requestTimeoutMs) && requestTimeoutMs > 0
      ? requestTimeoutMs
      : BROWSER_USE_NETWORK_DEADLINE_MS;
  }

  /**
   * Binds one admitted key to one callback-owned adapter. No process-global
   * environment or shared key registry is changed, and this adapter never
   * falls back to the server key while the request credential is present.
   */
  withRequestCredential(input: {
    readonly apiKey: string;
    readonly usageFunding: UsageFundingProvenance;
  }): BrowserUseCloudAdapter {
    return new BrowserUseCloudAdapter({
      serverKeys: this.serverKeys,
      fetch: this.fetchImpl,
      clock: this.clock,
      requestTimeoutMs: this.requestTimeoutMs,
      requestCredential: input,
    });
  }

  health(): BrowserUseProviderHealth {
    const resolution: BrowserUseApiKeyResolution = this.requestCredential === undefined
      ? resolveBrowserUseApiKey(this.serverKeys)
      : this.requestCredential.apiKey.trim().length === 0
        ? { kind: "invalid" }
        : { kind: "configured", apiKey: this.requestCredential.apiKey };
    if (resolution.kind === "configured") {
      // The captured public V4 contract has no non-mutating health endpoint.
      return { kind: "available", verification: "not_checked" };
    }
    return resolution.kind === "missing"
      ? { kind: "unavailable", reason: "missing_configuration" }
      : { kind: "unavailable", reason: "invalid_configuration" };
  }

  async createProfile(): Promise<BrowserUseResult<BrowserUseProfile>> {
    const response = await this.request("/profiles", { method: "POST", body: {} });
    if (isFailure(response)) return response;
    const body = await this.json(response);
    if (!isRecord(body) || typeof body["id"] !== "string" || body["id"].length === 0) {
      return { kind: "failure", code: "malformed_response" };
    }
    return { profileId: body["id"] };
  }

  async deleteProfile(profileId: string): Promise<BrowserUseResult<void>> {
    const response = await this.request(`/profiles/${encodeURIComponent(profileId)}`, {
      method: "DELETE",
    });
    if (isFailure(response)) return response;
    return undefined;
  }

  async startBrowser(input: {
    readonly profileId: string;
    /** Explicit Nautilo operator policy; Browser Use permits 1 through 240. */
    readonly timeoutMinutes: number;
  }): Promise<BrowserUseResult<BrowserUseBrowserSession>> {
    if (!Number.isInteger(input.timeoutMinutes)
      || input.timeoutMinutes < 1
      || input.timeoutMinutes > 240) {
      return { kind: "failure", code: "invalid_browser_policy" };
    }
    const response = await this.request("/browsers", {
      method: "POST",
      body: {
        profileId: input.profileId,
        timeout: input.timeoutMinutes,
        enableRecording: false,
      },
    });
    if (isFailure(response)) return response;
    return this.parseBrowserSession(await this.json(response));
  }

  async getBrowser(browserId: string): Promise<BrowserUseResult<BrowserUseBrowserSession>> {
    const response = await this.request(`/browsers/${encodeURIComponent(browserId)}`, {
      method: "GET",
    });
    if (isFailure(response)) return response;
    return this.parseBrowserSession(await this.json(response));
  }

  async stopBrowser(browserId: string): Promise<BrowserUseResult<BrowserUseBrowserSession>> {
    const response = await this.request(`/browsers/${encodeURIComponent(browserId)}`, {
      method: "PATCH",
      body: { action: "stop" },
    });
    if (isFailure(response)) return response;
    const body = await this.json(response);
    const session = this.parseBrowserSession(body);
    if (!isFailure(session) && session.status === "stopped") {
      const browserCost = providerUsd((body as BrowserWireSession)["browserCost"]);
      const proxyCost = providerUsd((body as BrowserWireSession)["proxyCost"]);
      // The provider reports these as separate components. A missing component
      // is unknown evidence, not a zero-cost component.
      const total = browserCost === null || proxyCost === null
        ? null
        : (browserCost + proxyCost).toFixed(8);
      return {
        ...session,
        costEvidence: {
          estimatedCostUsd: total,
          evidenceState: total === null ? "unknown" : "estimated",
        },
      };
    }
    return session;
  }

  /**
   * Lists only browser sessions Browser Use associates with one hosted Agent
   * session. The result remains server-only until direct-control qualification
   * proves that a particular capability may be attached safely.
   */
  async findHostedBrowsers(input: {
    readonly agentSessionId: string;
  }): Promise<BrowserUseResult<readonly BrowserUseHostedBrowserSession[]>> {
    if (!isNonEmptyString(input.agentSessionId)) return { kind: "failure", code: "malformed_response" };
    const browsers: BrowserUseHostedBrowserSession[] = [];
    let pageNumber = 1;
    let totalItems: number | null = null;
    for (;;) {
      const query = new URLSearchParams({
        agentSessionId: input.agentSessionId,
        pageSize: "100",
        pageNumber: String(pageNumber),
      });
      const response = await this.request(`/browsers?${query.toString()}`, { method: "GET" });
      if (isFailure(response)) return response;
      const body = await this.json(response);
      if (!isRecord(body) || !Array.isArray(body["items"])
        || !isSafeNonNegativeInteger(body["totalItems"])
        || body["pageNumber"] !== pageNumber
        || body["pageSize"] !== 100) {
        return { kind: "failure", code: "malformed_response" };
      }
      if (totalItems === null) totalItems = body["totalItems"];
      if (totalItems !== body["totalItems"] || body["items"].length > 100 || browsers.length + body["items"].length > totalItems) {
        return { kind: "failure", code: "malformed_response" };
      }
      for (const item of body["items"]) {
        const browser = this.parseHostedBrowserSession(item, input.agentSessionId);
        if (isFailure(browser)) return browser;
        browsers.push(browser);
      }
      if (browsers.length === totalItems) return browsers;
      // A nonempty under-filled page is still valid only when it exactly
      // finished the declared result set. Anything else could make this
      // server loop forever or silently skip an attach candidate.
      if (body["items"].length === 0 || body["items"].length < 100) {
        return { kind: "failure", code: "malformed_response" };
      }
      pageNumber += 1;
    }
  }

  async createHostedReadRun(input: {
    readonly profileId?: string;
    readonly task: string;
    readonly maxCostUsd: number;
    readonly sessionId?: string;
    readonly workspaceId?: string;
  }): Promise<BrowserUseResult<BrowserUseHostedReadRun>> {
    if (!Number.isFinite(input.maxCostUsd) || input.maxCostUsd <= 0) {
      return { kind: "failure", code: "invalid_cost_policy" };
    }
    const response = await this.request("/runs", {
      method: "POST",
      body: {
        task: input.task,
        model: BROWSER_USE_DEFAULT_MODEL,
        browserSettings: { ...(input.profileId === undefined ? {} : { profileId: input.profileId }), record: false },
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        maxCostUsd: input.maxCostUsd,
      },
    });
    if (isFailure(response)) return response;
    const body = await this.json(response);
    if (!isRecord(body) || typeof body["id"] !== "string" || !isRunStatus(body["status"])
      || typeof body["sessionId"] !== "string" || typeof body["workspaceId"] !== "string"
      || (input.sessionId !== undefined && body["sessionId"] !== input.sessionId)) {
      return { kind: "failure", code: "malformed_response" };
    }
    return { runId: body["id"], sessionId: body["sessionId"], workspaceId: body["workspaceId"], status: body["status"], observedAt: this.clock.now() };
  }

  async pollHostedReadRun(runId: string): Promise<BrowserUseResult<BrowserUseHostedReadRun>> {
    const response = await this.request(`/runs/${encodeURIComponent(runId)}/status`, {
      method: "GET",
    });
    if (isFailure(response)) return response;
    const body = await this.json(response) as RunWireStatus | null;
    if (!isRecord(body) || !isRunStatus(body["status"])) {
      return { kind: "failure", code: "malformed_response" };
    }
    return { runId, status: body["status"], observedAt: this.clock.now() };
  }

  async getHostedReadResult(runId: string): Promise<BrowserUseResult<BrowserUseHostedReadResult>> {
    const response = await this.request(`/runs/${encodeURIComponent(runId)}`, { method: "GET" });
    if (isFailure(response)) return response;
    const body = await this.json(response) as RunWireSummary | null;
    if (!isRecord(body) || !isRunStatus(body["status"])
      || (body["result"] !== null && body["result"] !== undefined && typeof body["result"] !== "string")
      || (body["totalCostUsd"] !== null && body["totalCostUsd"] !== undefined && typeof body["totalCostUsd"] !== "string")) {
      return { kind: "failure", code: "malformed_response" };
    }
    return {
      runId,
      status: body["status"],
      ...(isNonEmptyString(body["sessionId"]) ? { sessionId: body["sessionId"] } : {}),
      ...(isNonEmptyString(body["workspaceId"]) ? { workspaceId: body["workspaceId"] } : {}),
      result: typeof body["result"] === "string" ? body["result"] : null,
      totalCostUsd: typeof body["totalCostUsd"] === "string" ? body["totalCostUsd"] : null,
      observedAt: this.clock.now(),
    };
  }

  /**
   * Exact legacy run cleanup, also usable after restart from its durable run
   * checkpoint. Cancelling an Agent does not stop its billable browser.
   * Missing run/session coordinates are unresolved, never proof of shutdown.
   */
  async stopHostedReadBrowser(runId: string): Promise<boolean> {
    return (await this.stopHostedReadBrowserWithCost(runId)).stopped;
  }

  /**
   * Stops every browser attached to the exact hosted run and returns the
   * provider's usage estimate only when every browser and proxy component is
   * present. Resource disappearance proves no final amount.
   */
  async stopHostedReadBrowserWithCost(runId: string): Promise<BrowserUseHostedBrowserCleanup> {
    const unresolved = (stopped = false): BrowserUseHostedBrowserCleanup => ({
      stopped, estimatedCostUsd: null, evidenceState: "unknown",
    });
    try {
      const run = await this.getHostedReadResult(runId);
      if (isFailure(run) || !run.sessionId) return unresolved();
      if (run.status !== "completed" && run.status !== "cancelled" && run.status !== "failed") {
        const cancelled = await this.cancelHostedReadRun(runId);
        if (isFailure(cancelled)) return unresolved();
        const terminal = await this.pollHostedReadRun(runId);
        if (isFailure(terminal) || (terminal.status !== "completed" && terminal.status !== "cancelled" && terminal.status !== "failed")) return unresolved();
      }
      const browsers = await this.findHostedBrowsers({ agentSessionId: run.sessionId });
      if (isFailure(browsers)) return unresolved();
      let estimatedCostUsd = 0;
      let completeEstimate = browsers.length > 0;
      for (const browser of browsers) {
        if (browser.agentSessionId !== run.sessionId) return unresolved();
        const stopped = browser.status === "stopped" ? browser : await this.stopBrowser(browser.browserId);
        if (isFailure(stopped)) {
          if (stopped.code !== "resource_not_found") return unresolved();
          completeEstimate = false;
          continue;
        }
        if (stopped.browserId !== browser.browserId || stopped.status !== "stopped") return unresolved();
        const amount = stopped.costEvidence?.estimatedCostUsd === null
          || stopped.costEvidence?.estimatedCostUsd === undefined
          ? NaN
          : Number(stopped.costEvidence.estimatedCostUsd);
        if (!Number.isFinite(amount) || amount < 0 || stopped.costEvidence?.evidenceState !== "estimated") completeEstimate = false;
        else estimatedCostUsd += amount;
      }
      return completeEstimate
        ? { stopped: true, estimatedCostUsd: estimatedCostUsd.toFixed(8), evidenceState: "estimated" }
        : unresolved(true);
    } catch { return unresolved(); }
  }

  async cancelHostedReadRun(runId: string): Promise<BrowserUseResult<BrowserUseHostedReadRun>> {
    const response = await this.request(`/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      body: {},
    });
    if (isFailure(response)) return response;
    const body = await this.json(response) as RunWireSummary | null;
    if (!isRecord(body) || !isRunStatus(body["status"])) {
      return { kind: "failure", code: "malformed_response" };
    }
    return { runId, status: body["status"], observedAt: this.clock.now() };
  }

  /**
   * Reads one cursor page exactly as Browser Use returned it. A durable caller
   * commits `nextAfter` with its normalized checkpoint, then asks again while
   * `hasMore` is true; this avoids advancing a cursor before local state is
   * durable.
   */
  async readHostedRunEventDelta(input: {
    readonly runId: string;
    readonly after: number;
    readonly limit: number;
  }): Promise<BrowserUseResult<BrowserUseHostedRunEventDelta>> {
    if (!isNonEmptyString(input.runId) || !isSafeNonNegativeInteger(input.after)
      || !Number.isSafeInteger(input.limit) || input.limit < 1) {
      return { kind: "failure", code: "malformed_response" };
    }
    const query = new URLSearchParams({
      limit: String(input.limit),
      after: String(input.after),
      include_output: "false",
    });
    const response = await this.request(`/runs/${encodeURIComponent(input.runId)}/events?${query.toString()}`, {
      method: "GET",
    });
    if (isFailure(response)) return response;
    const body = await this.json(response);
    if (!isRecord(body) || !Array.isArray(body["events"]) || body["events"].length > input.limit
      || (body["hasMore"] !== undefined && typeof body["hasMore"] !== "boolean")
      || (body["nextAfter"] !== undefined && body["nextAfter"] !== null && !isSafeNonNegativeInteger(body["nextAfter"]))) {
      return { kind: "failure", code: "malformed_response" };
    }
    const events: BrowserUseHostedRunEvent[] = [];
    let lastEventId = input.after;
    for (const rawEvent of body["events"] as RunWireEvent[]) {
      if (!isRecord(rawEvent) || rawEvent["runId"] !== input.runId || !isSafeNonNegativeInteger(rawEvent["id"])
        || rawEvent["id"] <= lastEventId || !isNonEmptyString(rawEvent["type"])
        || rawEvent["type"].length > 128 || !isRecord(rawEvent["data"])) {
        return { kind: "failure", code: "malformed_response" };
      }
      const occurredAt = parseDate(rawEvent["ts"]);
      if (occurredAt === null) return { kind: "failure", code: "malformed_response" };
      events.push({
        eventId: rawEvent["id"],
        occurredAt,
        type: rawEvent["type"],
        data: rawEvent["data"],
      });
      lastEventId = rawEvent["id"];
    }
    const rawNextAfter = body["nextAfter"];
    const nextAfter = rawNextAfter === undefined || rawNextAfter === null
      ? events.length === 0 ? null : lastEventId
      : rawNextAfter;
    const hasMore = body["hasMore"] === true;
    if ((nextAfter !== null && nextAfter !== lastEventId)
      || (hasMore && nextAfter === null)
      || (nextAfter !== null && nextAfter <= input.after)) {
      return { kind: "failure", code: "malformed_response" };
    }
    return { runId: input.runId, events, nextAfter, hasMore, observedAt: this.clock.now() };
  }

  /**
   * Convenience drain for server reconciliation that does not need an atomic
   * per-page checkpoint. Restart-safe supervisors should prefer the single
   * page method above and persist each accepted cursor independently.
   */
  async drainHostedRunEventDeltas(input: {
    readonly runId: string;
    readonly after: number;
    readonly limit: number;
  }): Promise<BrowserUseResult<BrowserUseHostedRunEventDelta>> {
    const events: BrowserUseHostedRunEvent[] = [];
    let after = input.after;
    let lastAcceptedAfter: number | null = null;
    let observedAt = this.clock.now();
    const seenCursors = new Set<number>();
    for (;;) {
      const page = await this.readHostedRunEventDelta({ ...input, after });
      if (isFailure(page)) return page;
      events.push(...page.events);
      observedAt = page.observedAt;
      if (!page.hasMore) {
        return {
          runId: input.runId,
          events,
          nextAfter: page.nextAfter ?? lastAcceptedAfter,
          hasMore: false,
          observedAt,
        };
      }
      if (page.nextAfter === null || seenCursors.has(page.nextAfter)) {
        return { kind: "failure", code: "malformed_response" };
      }
      seenCursors.add(page.nextAfter);
      after = page.nextAfter;
      lastAcceptedAfter = page.nextAfter;
    }
  }

  /**
   * Reads V4 status plus the bounded event page and projects only a coarse
   * Human-facing stage. Event payload text, reasoning, page contents, and
   * provider identifiers never leave this adapter.
   */
  async observeHostedReadRun(runId: string): Promise<BrowserUseResult<BrowserUseHostedReadObservation>> {
    const status = await this.pollHostedReadRun(runId);
    if (isFailure(status)) return status;
    const events = await this.readHostedRunEventDelta({ runId, after: 0, limit: 200 });
    if (isFailure(events)) return events;

    let stage: BrowserUseHostedReadObservation["stage"] = status.status === "queued" || status.status === "dispatching"
      ? "starting"
      : status.status === "completed" || status.status === "failed" || status.status === "cancelled"
        ? "finishing"
        : "planning";
    const stageRank: Record<BrowserUseHostedReadObservation["stage"], number> = {
      starting: 0,
      planning: 1,
      browsing: 2,
      saving: 3,
      finishing: 4,
    };
    const advanceStage = (candidate: BrowserUseHostedReadObservation["stage"]): void => {
      if (stageRank[candidate] > stageRank[stage]) stage = candidate;
    };
    let liveViewUrl: string | null = null;
    for (const rawEvent of events.events) {
      const type = rawEvent.type.toLocaleLowerCase("en-US");
      if (type === "browser.ready") {
        const candidate = rawEvent.data["live_view_url"];
        if (candidate !== undefined && !isExpectedProviderCapability(candidate, "https:", "live.browser-use.com")) {
          return { kind: "failure", code: "malformed_response" };
        }
        if (typeof candidate === "string") liveViewUrl = candidate;
        advanceStage("browsing");
      } else if (type.includes("artifact") || type.includes("file") || type.includes("download") || type.includes("upload")) {
        advanceStage("saving");
      } else if (type.includes("tool") || type.includes("browser") || type.includes("action")) {
        advanceStage("browsing");
      } else if (type.includes("model") || type.includes("llm") || type.includes("plan")) {
        advanceStage("planning");
      } else if (type.includes("complete") || type.includes("result") || type.includes("finish")) {
        advanceStage("finishing");
      }
    }
    if (status.status === "completed" || status.status === "failed" || status.status === "cancelled") stage = "finishing";
    return { ...status, stage, liveViewUrl };
  }

  async collectHostedReadOutputs(input: {
    readonly sessionId: string;
    readonly workspaceId: string;
    /** Nautilo first-house model-projection policy, not a Browser Use limit. */
    readonly maxOutputs: number;
  }): Promise<BrowserUseResult<BrowserUseHostedOutputCollection>> {
    if (!Number.isInteger(input.maxOutputs) || input.maxOutputs < 1) {
      return { kind: "failure", code: "malformed_response" };
    }
    const outputScope = `${input.workspaceId}\0${input.sessionId}`;
    const [workspace, downloads] = await Promise.all([
      this.listHostedOutputCandidates(`/workspaces/${encodeURIComponent(input.workspaceId)}/files`, outputScope),
      this.listHostedOutputCandidates(`/browsers/${encodeURIComponent(input.sessionId)}/downloads`, outputScope),
    ]);
    // Workspace files and browser downloads are independent provider surfaces.
    // A completed run can still have one surface unavailable (for example, a
    // browser session that has already stopped) while the other contains the
    // Human's requested output. Preserve the usable side; fail only when
    // neither side can be inspected. An explicit delivery with no imported
    // output is reported incomplete by the runtime.
    if (isFailure(workspace) && !isMissingHostedOutputSurface(workspace)) return workspace;
    if (isFailure(downloads) && !isMissingHostedOutputSurface(downloads)) return downloads;
    if (isFailure(workspace) && isFailure(downloads)) return workspace;
    const missingSurface = isMissingHostedOutputSurface(workspace) || isMissingHostedOutputSurface(downloads);
    let truncated = false;
    const outputs: BrowserUseHostedOutput[] = [];
    const seenPaths = new Set<string>();
    const candidates = [
      ...(isFailure(workspace) ? [] : workspace),
      ...(isFailure(downloads) ? [] : downloads),
    ];
    for (const candidate of candidates) {
      if (seenPaths.has(candidate.path)) continue;
      seenPaths.add(candidate.path);
      if (outputs.length >= input.maxOutputs) {
        return { outputs, truncated: true };
      }
      const response = await this.fetchPresigned(candidate.url);
      if (isFailure(response)) {
        if (outputs.length === 0) return response;
        truncated = true;
        continue;
      }
      const bytes = await readHostedOutputBytes(response, candidate.size);
      if (bytes === null) {
        if (outputs.length === 0) return { kind: "failure", code: "malformed_response" };
        truncated = true;
        continue;
      }
      outputs.push({ path: candidate.path, mimeType: normalizeHostedOutputMimeType(response.headers.get("content-type")), bytes });
    }
    // One imported output is enough to satisfy this first-house delivery
    // contract. A missing independent surface matters only when neither side
    // yielded anything; the runtime also treats an empty explicit delivery as
    // incomplete.
    return { outputs, truncated: truncated || (missingSurface && outputs.length === 0) };
  }

  /** Follows the provider's explicit cursor contract; it never silently truncates. */
  private async listHostedOutputCandidates(path: string, outputScope: string): Promise<BrowserUseResult<readonly HostedOutputCandidate[]>> {
    const candidates: HostedOutputCandidate[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const query = cursor === null
        ? "?includeUrls=true"
        : `?includeUrls=true&cursor=${encodeURIComponent(cursor)}`;
      const response = await this.request(`${path}${query}`, { method: "GET" });
      if (isFailure(response)) return response;
      const body = await this.json(response);
      const page = readHostedOutputCandidates(body, "files", outputScope);
      if (page === null || !isRecord(body)) return { kind: "failure", code: "malformed_response" };
      candidates.push(...page);
      if (body["hasMore"] === undefined || body["hasMore"] === false) return candidates;
      if (body["hasMore"] !== true || typeof body["nextCursor"] !== "string" || body["nextCursor"].length === 0
        || seenCursors.has(body["nextCursor"])) {
        return { kind: "failure", code: "malformed_response" };
      }
      seenCursors.add(body["nextCursor"]);
      cursor = body["nextCursor"];
    }
  }

  private async fetchPresigned(url: string): Promise<Response | BrowserUseProviderFailure> {
    let target: URL;
    try { target = new URL(url); } catch { return { kind: "failure", code: "malformed_response" }; }
    if (target.protocol !== "https:" || target.username || target.password || target.hash) return { kind: "failure", code: "malformed_response" };
    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(target.toString(), { method: "GET", redirect: "error", signal: controller.signal });
      return response.ok ? response : mapHttpFailure(response.status);
    } catch (error) {
      return timedOut
        ? { kind: "failure", code: "timeout" }
        : isAbortError(error)
        ? { kind: "failure", code: "cancelled" }
        : { kind: "failure", code: "network_error" };
    } finally { clearTimeout(deadline); }
  }

  private async request(
    path: string,
    request: { readonly method: "GET" | "POST" | "PATCH" | "DELETE"; readonly body?: unknown },
  ): Promise<Response | BrowserUseProviderFailure> {
    const resolution: BrowserUseApiKeyResolution = this.requestCredential === undefined
      ? resolveBrowserUseApiKey(this.serverKeys)
      : this.requestCredential.apiKey.trim().length === 0
        ? { kind: "invalid" }
        : { kind: "configured", apiKey: this.requestCredential.apiKey };
    const unavailable = unavailableFailure(resolution);
    if (unavailable !== null) return unavailable;
    if (resolution.kind !== "configured") return { kind: "failure", code: "invalid_configuration" };
    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${BROWSER_USE_V4_BASE_URL}${path}`, {
        method: request.method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-browser-use-api-key": resolution.apiKey,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
      });
      return response.ok ? response : mapHttpFailure(response.status);
    } catch (error) {
      return timedOut
        ? { kind: "failure", code: "timeout" }
        : isAbortError(error)
        ? { kind: "failure", code: "cancelled" }
        : { kind: "failure", code: "network_error" };
    } finally {
      clearTimeout(deadline);
    }
  }

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private parseHostedBrowserSession(
    body: unknown,
    expectedAgentSessionId: string,
  ): BrowserUseResult<BrowserUseHostedBrowserSession> {
    const browser = this.parseBrowserSession(body);
    if (isFailure(browser)) return browser;
    if (!isRecord(body) || body["agentSessionId"] !== expectedAgentSessionId) {
      return { kind: "failure", code: "malformed_response" };
    }
    return { ...browser, agentSessionId: expectedAgentSessionId };
  }

  private parseBrowserSession(body: unknown): BrowserUseResult<BrowserUseBrowserSession> {
    const session = body as BrowserWireSession | null;
    if (!isRecord(session)
      || typeof session["id"] !== "string"
      || (session["status"] !== "active" && session["status"] !== "stopped")
      || (session["liveUrl"] !== null && session["liveUrl"] !== undefined && !isExpectedProviderCapability(session["liveUrl"], "https:", "live.browser-use.com"))
      || (session["cdpUrl"] !== null && session["cdpUrl"] !== undefined && !isExpectedCdpDiscoveryCapability(session["cdpUrl"]))) {
      return { kind: "failure", code: "malformed_response" };
    }
    const timeoutAt = parseDate(session["timeoutAt"]);
    if (timeoutAt === null) return { kind: "failure", code: "malformed_response" };
    return {
      browserId: session["id"],
      status: session["status"],
      liveViewUrl: typeof session["liveUrl"] === "string" ? session["liveUrl"] : null,
      cdpUrl: typeof session["cdpUrl"] === "string" ? session["cdpUrl"] : null,
      timeoutAt,
      observedAt: this.clock.now(),
      ...(session["status"] === "stopped" ? { costEvidence: browserCostEvidence(session) } : {}),
    };
  }
}

function browserCostEvidence(session: BrowserWireSession): NonNullable<BrowserUseBrowserSession["costEvidence"]> {
  const browserCost = providerUsd(session["browserCost"]);
  const proxyCost = providerUsd(session["proxyCost"]);
  const total = browserCost === null || proxyCost === null ? null : (browserCost + proxyCost).toFixed(8);
  return { estimatedCostUsd: total, evidenceState: total === null ? "unknown" : "estimated" };
}

function providerUsd(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
