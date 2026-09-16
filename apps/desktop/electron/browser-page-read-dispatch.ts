/** D504 Wave 1 — bounded interactive page-read execution over agent-browser. */

import {
  agentBrowserPageReadEvalArgv,
  browserArgvPrefix,
  chunkBrowserPageReadResult,
  normalizeBrowserPageReadExtractedResult,
  normalizeBrowserPageReadResult,
  parseAgentBrowserPageReadEvalOutput,
  parseBrowserPageSnapshotInspectionRequest,
  findBrowserPageSnapshot,
  rangeBrowserPageSnapshot,
  type BrowserPageReadEvalOutputParseResult,
  type BrowserPageReadNormalizationOptions,
  type BrowserPageReadExtractedContent,
  type BrowserPageReadProgramOutput,
  type BrowserPageReadRequest,
  type BrowserPageReadResult,
  type BrowserPageReadPageReference,
  type BrowserPageSnapshotInspectionResult,
  type RelayDispatchResult,
} from "@nautilo/relay";
import {
  BrowserPageSnapshotStore,
  type BrowserPageSnapshotOwnerBinding,
} from "./browser-page-snapshot-store.ts";
import {
  mozillaReadabilityTurndownExtractor,
  normalizeAgentBrowserAccessibilitySnapshot,
  parseAgentBrowserAccessibilitySnapshotEnvelope,
  type RenderedPageExtractor,
} from "./rendered-page-extractor.ts";

export const BROWSER_PAGE_READ_NO_ACTIVE_TARGET_ERROR =
  "browser_read_page requires an active Nautilo Browser surface";

export interface BrowserPageReadExecOptions {
  timeout: number;
  maxBuffer: number;
  signal?: AbortSignal | undefined;
}

export interface BrowserPageReadDispatchDeps {
  hasActiveTarget: () => boolean;
  exec: (
    bin: string,
    argv: string[],
    options: BrowserPageReadExecOptions,
  ) => Promise<{ stdout: string | Buffer }>;
  now?: () => number;
  parseOutput?: (stdout: string) => BrowserPageReadEvalOutputParseResult;
  normalize?: (
    request: BrowserPageReadRequest,
    programOutput: BrowserPageReadProgramOutput,
    options?: BrowserPageReadNormalizationOptions,
  ) => BrowserPageReadResult;
  extractor?: RenderedPageExtractor;
  /** Present only on negotiated protocol v12+ desktop relay dispatches. */
  snapshotStore?: BrowserPageSnapshotStore;
  /** Installed locally by the authenticated relay client; never model input. */
  snapshotOwner?: BrowserPageSnapshotOwnerBinding;
  /** Present only when the exact v13 relay negotiated snapshot inspection. */
  publishSnapshotReference?: boolean;
}

const MAX_RENDERED_HTML_CHARS = 8_000_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Fixed v0.31.1 JSON envelope for `get html html`; no selector is caller-controlled. */
export function parseAgentBrowserRenderedHtmlEnvelope(stdout: string): string | undefined {
  try {
    const envelope = record(JSON.parse(stdout));
    if (!envelope || envelope["success"] !== true) return undefined;
    const data = record(envelope["data"]);
    const html = data?.["html"];
    return typeof html === "string" && html.length <= MAX_RENDERED_HTML_CHARS ? html : undefined;
  } catch {
    return undefined;
  }
}

/** Fixed v0.31.1 rendered-root capture; the literal `html` selector is Nautilo-owned. */
export function agentBrowserPageReadHtmlArgv(cfgPath: string, session: string): string[] {
  return [...browserArgvPrefix(cfgPath, session), "--json", "get", "html", "html"];
}

/** Fixed v0.31.1 accessibility fallback. `--urls` preserves useful destinations in snapshot text. */
export function agentBrowserPageReadAccessibilitySnapshotArgv(cfgPath: string, session: string): string[] {
  return [...browserArgvPrefix(cfgPath, session), "--json", "snapshot", "--urls"];
}

function pageReadRequest(
  args: Record<string, unknown>,
  targetRole: BrowserPageReadRequest["targetRole"],
  requestedUrl?: string,
): BrowserPageReadRequest {
  const maxChars = args["maxChars"];
  if (maxChars !== undefined && (typeof maxChars !== "number" || !Number.isInteger(maxChars) || maxChars < 1)) {
    throw new Error("browser page read maxChars must be a positive integer");
  }
  return {
    targetRole,
    ...(requestedUrl ? { requestedUrl } : {}),
    ...(typeof maxChars === "number" ? { maxChars } : {}),
  };
}

type ContinuationRequest = {
  readonly reference: string;
  readonly offsetCharacters: number;
  readonly mode: "page" | "remainder";
  readonly maxChars?: number;
};

function parseContinuationRequest(args: Record<string, unknown>): ContinuationRequest | null {
  const continuation = args["continuation"];
  if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) return null;
  const record = continuation as Record<string, unknown>;
  const allowedContinuation = new Set(["version", "reference", "offsetCharacters", "mode"]);
  if (
    Object.keys(args).some((key) => key !== "continuation" && key !== "maxChars") ||
    Object.keys(record).some((key) => !allowedContinuation.has(key)) ||
    record["version"] !== 1 ||
    typeof record["reference"] !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(record["reference"]) ||
    !Number.isSafeInteger(record["offsetCharacters"]) || (record["offsetCharacters"] as number) < 0 ||
    (record["mode"] !== "page" && record["mode"] !== "remainder") ||
    (args["maxChars"] !== undefined &&
      (!Number.isSafeInteger(args["maxChars"]) || (args["maxChars"] as number) < 1)) ||
    (record["mode"] === "remainder" && args["maxChars"] !== undefined)
  ) return null;
  return {
    reference: record["reference"],
    offsetCharacters: record["offsetCharacters"] as number,
    mode: record["mode"],
    ...(typeof args["maxChars"] === "number" ? { maxChars: args["maxChars"] } : {}),
  };
}

function pageReference(
  reference: string,
  expiresAt: string,
): BrowserPageReadPageReference {
  return { version: 1, reference, expiresAt };
}

function snapshotRecoveryError(reason: "snapshot_expired" | "snapshot_evicted" | "snapshot_unavailable"): RelayDispatchResult {
  const recovery = "Re-read the original URL to get a fresh reference; content may have changed.";
  if (reason === "snapshot_expired") {
    return {
      status: "error",
      errorCode: "BROWSER_PAGE_SNAPSHOT_EXPIRED",
      error: `browser page snapshot expired. ${recovery}`,
    };
  }
  if (reason === "snapshot_evicted") {
    return {
      status: "error",
      errorCode: "BROWSER_PAGE_SNAPSHOT_EVICTED",
      error: `browser page snapshot was evicted to stay within local memory limits. ${recovery}`,
    };
  }
  return {
    status: "error",
    errorCode: "BROWSER_PAGE_SNAPSHOT_UNAVAILABLE",
    error: `browser page snapshot is unavailable on this relay session. ${recovery}`,
  };
}

/**
 * Handles immutable continuation before any target/readiness inspection. It
 * can never invoke agent-browser or select the current visible page.
 */
export function dispatchBrowserPageContinuation(
  args: Record<string, unknown>,
  deps: Pick<BrowserPageReadDispatchDeps, "snapshotStore" | "snapshotOwner" | "publishSnapshotReference"> & {
    readonly expectedTargetRole?: BrowserPageReadResult["targetRole"];
  },
): RelayDispatchResult {
  const request = parseContinuationRequest(args);
  if (!request) {
    return {
      status: "error",
      errorCode: "BROWSER_PAGE_CONTINUATION_REQUEST_INVALID",
      error: "browser page continuation request is invalid",
    };
  }
  if (deps.snapshotStore === undefined || deps.snapshotOwner === undefined) {
    return {
      status: "error",
      errorCode: "BROWSER_PAGE_CONTINUATION_UNAVAILABLE",
      error: "browser page continuation is unavailable on this relay session",
    };
  }
  const snapshot = deps.snapshotStore.access(request.reference, deps.snapshotOwner, deps.expectedTargetRole);
  if (!snapshot.ok) return snapshotRecoveryError(snapshot.reason);
  if (request.offsetCharacters > snapshot.page.content.length) {
    return {
      status: "error",
      errorCode: "BROWSER_PAGE_CONTINUATION_OFFSET_INVALID",
      error: "browser page continuation offset is outside the retained page",
    };
  }
  const result = chunkBrowserPageReadResult(snapshot.page, {
    offsetCharacters: request.offsetCharacters,
    ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
    mode: request.mode,
    continuation: {
      version: 1,
      reference: request.reference,
      nextOffsetCharacters: request.offsetCharacters,
      expiresAt: snapshot.expiresAt,
    },
  });
  return {
    status: "ok",
    result: deps.publishSnapshotReference === true
      ? { ...result, pageReference: pageReference(request.reference, snapshot.expiresAt) }
      : result,
  };
}

/**
 * Finds or expands only the already extracted immutable Markdown snapshot.
 * This route intentionally has no browser target, agent-browser binary, URL,
 * network, or model-code dependency and runs before all browser lifecycle work.
 */
export function dispatchBrowserPageSnapshotInspection(
  args: Record<string, unknown>,
  deps: Pick<BrowserPageReadDispatchDeps, "snapshotStore" | "snapshotOwner" | "publishSnapshotReference"> & {
    readonly expectedTargetRole?: BrowserPageReadResult["targetRole"];
  },
): RelayDispatchResult {
  if (Object.keys(args).length !== 1 || args["snapshot"] === undefined) {
    return {
      status: "error",
      errorCode: "BROWSER_PAGE_SNAPSHOT_REQUEST_INVALID",
      error: "browser page snapshot request is invalid",
    };
  }
  const parsed = parseBrowserPageSnapshotInspectionRequest(args["snapshot"]);
  if (!parsed.ok) {
    return {
      status: "error",
      errorCode: "BROWSER_PAGE_SNAPSHOT_REQUEST_INVALID",
      error: "browser page snapshot request is invalid",
    };
  }
  if (deps.publishSnapshotReference !== true || deps.snapshotStore === undefined || deps.snapshotOwner === undefined) {
    return {
      status: "error",
      errorCode: "BROWSER_PAGE_SNAPSHOT_UNAVAILABLE",
      error: "browser page snapshot inspection is unavailable on this relay session",
    };
  }
  // Validate against an immutable copy without touching its lifetime: a range
  // offset is only meaningful relative to this retained page. Successful work
  // below performs the one sliding-TTL refresh.
  const snapshot = deps.snapshotStore.access(
    parsed.request.reference,
    deps.snapshotOwner,
    deps.expectedTargetRole,
    { touch: false },
  );
  if (!snapshot.ok) return snapshotRecoveryError(snapshot.reason);
  if (
    parsed.request.operation === "range" &&
    parsed.request.offsetCharacters > snapshot.page.content.length
  ) {
    return {
      status: "error",
      errorCode: "BROWSER_PAGE_SNAPSHOT_OFFSET_INVALID",
      error: "browser page snapshot offset is outside the retained page",
    };
  }
  const touched = deps.snapshotStore.access(
    parsed.request.reference,
    deps.snapshotOwner,
    deps.expectedTargetRole,
  );
  if (!touched.ok) return snapshotRecoveryError(touched.reason);
  const result: BrowserPageSnapshotInspectionResult = parsed.request.operation === "find"
    ? findBrowserPageSnapshot(snapshot.page.content, parsed.request, touched.expiresAt)
    : rangeBrowserPageSnapshot(snapshot.page.content, parsed.request, touched.expiresAt);
  return { status: "ok", result };
}

function finalizeCapturedPage(
  request: BrowserPageReadRequest,
  result: BrowserPageReadResult,
  deps: BrowserPageReadDispatchDeps,
): RelayDispatchResult {
  const initial = chunkBrowserPageReadResult(result, {
    offsetCharacters: 0,
    ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
    mode: "page",
  });
  // Challenge and failed/empty pages never manufacture a snapshot reference.
  if (
    result.challenge.detected || result.quality === "challenge" || result.content.length === 0 ||
    deps.snapshotStore === undefined || deps.snapshotOwner === undefined
  ) {
    return { status: "ok", result: initial };
  }
  // v12 retains only pages that need continuation. EOF pages acquire an
  // in-memory snapshot solely when the v13 inspection contract was negotiated.
  if (initial.eof && deps.publishSnapshotReference !== true) return { status: "ok", result: initial };
  const created = deps.snapshotStore.create(deps.snapshotOwner, result);
  if (!created.ok) {
    return {
      status: "error",
      errorCode: "BROWSER_PAGE_SNAPSHOT_RESOURCE_LIMIT",
      error: "browser page is too large to retain for safe continuation",
    };
  }
  return {
    status: "ok",
    result: {
      ...initial,
      ...(deps.publishSnapshotReference === true
        ? {
          pageReference: pageReference(created.snapshot.reference, created.snapshot.expiresAt),
          ...(created.evicted.length === 0 ? {} : { evictedPageReferences: [...created.evicted] }),
        }
        : {}),
      ...(initial.eof
        ? {}
        : {
          continuation: {
            version: 1,
            reference: created.snapshot.reference,
            nextOffsetCharacters: initial.nextOffsetCharacters,
            expiresAt: created.snapshot.expiresAt,
          },
        }),
    },
  };
}

function evaluationFailure(
  request: BrowserPageReadRequest,
  elapsedMs: number,
  normalize: NonNullable<BrowserPageReadDispatchDeps["normalize"]>,
): RelayDispatchResult {
  // Feed a complete placeholder only to reach the shared redacted transport
  // failure contract; no child-process stderr, CDP data, or parser detail is
  // retained in the result.
  return {
    status: "ok",
    result: normalize(request, {}, { elapsedMs, transportFailure: "evaluation-error" }),
  };
}

function agentBrowserPageReadWaitArgv(cfgPath: string, session: string): string[] {
  // v0.31.1 parses this positional form as the fixed `wait` action with a
  // 250ms timeout. It carries no lifecycle subscription or caller input.
  return [...browserArgvPrefix(cfgPath, session), "wait", "250"];
}

function elapsedSince(now: () => number, startedAt: number): number {
  return Math.max(0, now() - startedAt);
}

function remainingTimeout(totalTimeoutMs: number, elapsedMs: number): number {
  return Math.max(0, totalTimeoutMs - elapsedMs);
}

async function retryIncompleteResult(
  request: BrowserPageReadRequest,
  programOutput: BrowserPageReadProgramOutput,
  input: Parameters<typeof extractRenderedPage>[2],
  deps: BrowserPageReadDispatchDeps,
  now: () => number,
  startedAt: number,
): Promise<RelayDispatchResult> {
  return await extractRenderedPage(request, programOutput, input, deps, now, startedAt, { readinessRetryIncomplete: true });
}

function programIframeCount(output: BrowserPageReadProgramOutput): number {
  return typeof output.iframeCount === "number" && Number.isFinite(output.iframeCount) && output.iframeCount > 0
    ? Math.floor(output.iframeCount)
    : 0;
}

function isChallengeProgramOutput(output: BrowserPageReadProgramOutput): boolean {
  return Array.isArray(output.challengeSignals) && output.challengeSignals.some((signal) => typeof signal === "string" &&
    ["captcha", "recaptcha", "hcaptcha", "turnstile", "cloudflare", "verify-human"].includes(signal));
}

function noContent(method: BrowserPageReadExtractedContent["method"], diagnostic: string): BrowserPageReadExtractedContent {
  return { content: "", method, root: "none", diagnostics: [diagnostic] };
}

async function extractRenderedPage(
  request: BrowserPageReadRequest,
  programOutput: BrowserPageReadProgramOutput,
  input: {
    bin: string;
    cfgPath: string;
    session: string;
    timeoutMs: number;
    maxBuffer: number;
    signal?: AbortSignal | undefined;
  },
  deps: BrowserPageReadDispatchDeps,
  now: () => number,
  startedAt: number,
  extraOptions: Pick<BrowserPageReadNormalizationOptions, "readinessRetryIncomplete"> = {},
): Promise<RelayDispatchResult> {
  const normalizeExtracted = normalizeBrowserPageReadExtractedResult;
  const finish = (
    extracted: BrowserPageReadExtractedContent,
    options: BrowserPageReadNormalizationOptions,
  ): RelayDispatchResult => finalizeCapturedPage(
    request,
    normalizeExtracted(request, programOutput, extracted, options),
    deps,
  );
  const sharedOptions = (): BrowserPageReadNormalizationOptions => ({
    elapsedMs: elapsedSince(now, startedAt),
    ...extraOptions,
  });
  const nextExecOptions = (): BrowserPageReadExecOptions | undefined => {
    const timeout = remainingTimeout(input.timeoutMs, elapsedSince(now, startedAt));
    return timeout > 0
      ? {
        timeout,
        maxBuffer: input.maxBuffer,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }
      : undefined;
  };
  const timedOut = (): RelayDispatchResult => finish(
    noContent("mozilla-readability-turndown-v1", "rendered-page-capture-timed-out"),
    { ...sharedOptions(), transportFailure: "timeout" },
  );
  if (isChallengeProgramOutput(programOutput)) {
    return finish(
      noContent("mozilla-readability-turndown-v1", "challenge-surface"),
      sharedOptions(),
    );
  }

  let primary: BrowserPageReadExtractedContent | undefined;
  let htmlTransportFailure: "timeout" | "evaluation-error" | undefined;
  const htmlExecOptions = nextExecOptions();
  if (!htmlExecOptions) return timedOut();
  try {
    const { stdout } = await deps.exec(input.bin, agentBrowserPageReadHtmlArgv(input.cfgPath, input.session), htmlExecOptions);
    const html = parseAgentBrowserRenderedHtmlEnvelope(String(stdout));
    if (html !== undefined) {
      const extraction = (deps.extractor ?? mozillaReadabilityTurndownExtractor).extract({
        html,
        finalUrl: typeof programOutput.finalUrl === "string" ? programOutput.finalUrl : "",
        iframeCount: programIframeCount(programOutput),
        virtualizedHint: programOutput.virtualizedHint === true,
      });
      primary = {
        content: extraction.content,
        method: extraction.method,
        root: extraction.root,
        diagnostics: extraction.diagnostics,
      };
      if (!extraction.needsAccessibilityFallback && extraction.content) {
        return finish(primary, sharedOptions());
      }
    }
  } catch (error) {
    const failure = error as { code?: string; killed?: boolean };
    htmlTransportFailure = failure.killed || failure.code === "ETIMEDOUT" ? "timeout" : "evaluation-error";
  }

  // Readability has no article, or the fixed evaluator identifies a surface
  // where DOM article extraction is intrinsically incomplete. The snapshot is
  // a fixed agent-browser command, not a model-authored selector or script.
  const snapshotExecOptions = nextExecOptions();
  if (!snapshotExecOptions) {
    if (primary) {
      return finish({
          ...primary,
          diagnostics: [...primary.diagnostics, "accessibility-fallback-unavailable"],
        }, sharedOptions());
    }
    return timedOut();
  }
  try {
    const { stdout } = await deps.exec(
      input.bin,
      agentBrowserPageReadAccessibilitySnapshotArgv(input.cfgPath, input.session),
      snapshotExecOptions,
    );
    let envelope: unknown;
    try {
      envelope = JSON.parse(String(stdout));
    } catch {
      envelope = undefined;
    }
    const snapshot = parseAgentBrowserAccessibilitySnapshotEnvelope(envelope);
    if (snapshot) {
      const fallback = normalizeAgentBrowserAccessibilitySnapshot(snapshot);
      return finish({
          content: fallback.content,
          method: fallback.method,
          root: fallback.root,
          diagnostics: fallback.diagnostics,
        }, sharedOptions());
    }
  } catch (error) {
    const failure = error as { code?: string; killed?: boolean };
    if (primary) {
      return finish({
          ...primary,
          diagnostics: [...primary.diagnostics, "accessibility-fallback-unavailable"],
        }, sharedOptions());
    }
    return finish(
      noContent("mozilla-readability-turndown-v1", "rendered-page-capture-failed"),
      { ...sharedOptions(), transportFailure: failure.killed || failure.code === "ETIMEDOUT" ? "timeout" : "evaluation-error" },
    );
  }

  if (primary) {
    return finish({
        ...primary,
        diagnostics: [...primary.diagnostics, "accessibility-fallback-unavailable"],
      }, sharedOptions());
  }
  return finish(
    noContent("mozilla-readability-turndown-v1", "rendered-page-capture-failed"),
    { ...sharedOptions(), transportFailure: htmlTransportFailure ?? "evaluation-error" },
  );
}

/**
 * Executes only Nautilo's fixed page-read evaluator against one caller-owned
 * target. Caller arguments can bound output, but never supply JavaScript, a
 * URL, session, or another target; those are fixed by the owning wrapper.
 */
async function dispatchBrowserPageRead(
  args: Record<string, unknown>,
  input: {
    bin: string;
    cfgPath: string;
    session: string;
    timeoutMs: number;
    maxBuffer: number;
    signal?: AbortSignal | undefined;
  },
  deps: BrowserPageReadDispatchDeps,
  target: {
    role: BrowserPageReadRequest["targetRole"];
    requestedUrl?: string;
    unavailableError: string;
  },
): Promise<RelayDispatchResult> {
  let request: BrowserPageReadRequest;
  try {
    request = pageReadRequest(args, target.role, target.requestedUrl);
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }

  if (!deps.hasActiveTarget()) {
    return { status: "error", error: target.unavailableError };
  }

  const now = deps.now ?? Date.now;
  const parseOutput = deps.parseOutput ?? parseAgentBrowserPageReadEvalOutput;
  const normalize = deps.normalize ?? normalizeBrowserPageReadResult;
  const startedAt = now();
  const evalArgv = agentBrowserPageReadEvalArgv(input.cfgPath, input.session);

  try {
    const { stdout } = await deps.exec(input.bin, evalArgv, {
      timeout: input.timeoutMs,
      maxBuffer: input.maxBuffer,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const parsed = parseOutput(String(stdout));
    const elapsedMs = elapsedSince(now, startedAt);
    if (!parsed.ok) return evaluationFailure(request, elapsedMs, normalize);
    const firstResult = normalize(request, parsed.programOutput, { elapsedMs });
    const shouldRetry =
      parsed.programOutput.readiness === "loading" ||
      (firstResult.quality === "empty" && firstResult.failure === "empty-dom");
    if (!shouldRetry) {
      return await extractRenderedPage(request, parsed.programOutput, input, deps, now, startedAt);
    }

    let remainingMs = remainingTimeout(input.timeoutMs, elapsedMs);
    if (remainingMs <= 0) {
      return await retryIncompleteResult(request, parsed.programOutput, input, deps, now, startedAt);
    }

    try {
      await deps.exec(input.bin, agentBrowserPageReadWaitArgv(input.cfgPath, input.session), {
        timeout: remainingMs,
        maxBuffer: input.maxBuffer,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch {
      return await retryIncompleteResult(
        request,
        parsed.programOutput,
        input,
        deps,
        now,
        startedAt,
      );
    }

    remainingMs = remainingTimeout(input.timeoutMs, elapsedSince(now, startedAt));
    if (remainingMs <= 0) {
      return await retryIncompleteResult(
        request,
        parsed.programOutput,
        input,
        deps,
        now,
        startedAt,
      );
    }

    try {
      const { stdout: retryStdout } = await deps.exec(input.bin, evalArgv, {
        timeout: remainingMs,
        maxBuffer: input.maxBuffer,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const retried = parseOutput(String(retryStdout));
      if (!retried.ok) {
        return await retryIncompleteResult(request, parsed.programOutput, input, deps, now, startedAt);
      }
      return await extractRenderedPage(request, retried.programOutput, input, deps, now, startedAt);
    } catch {
      return await retryIncompleteResult(
        request,
        parsed.programOutput,
        input,
        deps,
        now,
        startedAt,
      );
    }
  } catch (err) {
    const failure = err as { code?: string; killed?: boolean };
    if (failure.killed || failure.code === "ETIMEDOUT") {
      return {
        status: "ok",
        result: normalize(request, {}, {
          elapsedMs: elapsedSince(now, startedAt),
          transportFailure: "timeout",
        }),
      };
    }
    return evaluationFailure(request, elapsedSince(now, startedAt), normalize);
  }
}

export async function dispatchInteractiveBrowserPageRead(
  args: Record<string, unknown>,
  input: {
    bin: string;
    cfgPath: string;
    session: string;
    timeoutMs: number;
    maxBuffer: number;
    signal?: AbortSignal | undefined;
  },
  deps: BrowserPageReadDispatchDeps,
): Promise<RelayDispatchResult> {
  return dispatchBrowserPageRead(args, input, deps, {
    role: "interactive",
    unavailableError: BROWSER_PAGE_READ_NO_ACTIVE_TARGET_ERROR,
  });
}

export const BROWSER_RESEARCH_PAGE_READ_NO_TARGET_ERROR =
  "browser research page read requires the exact active research lease";

/** Reads an already-navigated exact research lease through the Wave 1 extractor. */
export async function dispatchResearchBrowserPageRead(
  args: Record<string, unknown>,
  requestedUrl: string,
  input: {
    bin: string;
    cfgPath: string;
    session: string;
    timeoutMs: number;
    maxBuffer: number;
    signal?: AbortSignal | undefined;
  },
  deps: BrowserPageReadDispatchDeps,
): Promise<RelayDispatchResult> {
  return dispatchBrowserPageRead(args, input, deps, {
    role: "research",
    requestedUrl,
    unavailableError: BROWSER_RESEARCH_PAGE_READ_NO_TARGET_ERROR,
  });
}
