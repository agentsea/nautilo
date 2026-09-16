import { createOoxmlLoadOwner, type OoxmlDestroyable } from "./lifecycle";
import { runOoxmlLoadWithParserBytes, type OoxmlByteSource } from "./source";

export type OoxmlRendererStatus<T extends OoxmlDestroyable> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly viewer: T }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "closed" };

export type OoxmlRendererOutcome =
  | { readonly kind: "ready" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "closed" };

export interface OoxmlRendererCreateContext<H extends object> {
  readonly host: H;
  readonly source: OoxmlByteSource;
  isLive: () => boolean;
  fail: (error: unknown) => void;
}

export interface RenderOoxmlOptions<H extends object, T extends OoxmlDestroyable> {
  /** Opaque master bytes and the caller-owned deadline are the only source input. */
  readonly source: OoxmlByteSource;
  /** An object identity owned by exactly one active renderer at a time. */
  readonly host: H;
  readonly createViewer: (context: OoxmlRendererCreateContext<H>) => T;
  /** Receives the one lifecycle-owned parser clone at the exact load handoff. */
  readonly load: (viewer: T, parserBytes: ArrayBuffer) => Promise<void>;
  readonly sanitizeError: (error: unknown) => string;
  readonly onStatus: (status: OoxmlRendererStatus<T>) => void;
}

export interface OoxmlRenderer {
  readonly done: Promise<OoxmlRendererOutcome>;
  close: () => void;
}

const EXPIRED_DEADLINE_MESSAGE = "Document preview timed out.";
const SAFE_ERROR_MESSAGE = "Document preview failed.";
const MAX_SAFE_ERROR_LENGTH = 280;
const renderersByHost = new WeakMap<object, OoxmlRenderer>();

/**
 * Starts one opaque OOXML parser generation. Format-specific UI and runtime
 * options remain injected at the edge; this core owns only host replacement,
 * source deadline, one-clone handoff, cancellation, and destroy-once lifecycle.
 */
export function renderOoxml<H extends object, T extends OoxmlDestroyable>(
  options: RenderOoxmlOptions<H, T>,
): OoxmlRenderer {
  let settle!: (outcome: OoxmlRendererOutcome) => void;
  const done = new Promise<OoxmlRendererOutcome>((resolve) => { settle = resolve; });
  let outcomeSettled = false;
  let active = true;
  let loadGeneration: number | null = null;
  let owner: ReturnType<typeof createOoxmlLoadOwner> | undefined;
  let removeAbortListener = (): void => {};

  const safeMessage = (error: unknown): string => {
    try {
      const message = options.sanitizeError(error);
      return typeof message === "string" && message.length > 0 && message.length <= MAX_SAFE_ERROR_LENGTH
        ? message
        : SAFE_ERROR_MESSAGE;
    } catch {
      return SAFE_ERROR_MESSAGE;
    }
  };
  const settleOutcome = (outcome: OoxmlRendererOutcome): void => {
    if (outcomeSettled) return;
    outcomeSettled = true;
    settle(outcome);
  };
  let renderer!: OoxmlRenderer;
  const releaseHost = (): void => {
    if (renderersByHost.get(options.host) === renderer)
      renderersByHost.delete(options.host);
  };
  const invalidateOwner = (): void => {
    try {
      owner?.invalidate();
    } catch {
      // The lifecycle already marks a destroy callback as consumed before it calls it.
    }
  };
  const emitTerminal = (status: Extract<OoxmlRendererStatus<T>, { kind: "error" | "closed" }>): void => {
    try {
      options.onStatus(status);
    } catch {
      // Cleanup and the outcome are already final; observers cannot reopen it.
    }
  };
  const terminalError = (message: string): void => {
    if (!active) return;
    active = false;
    invalidateOwner();
    removeAbortListener();
    releaseHost();
    emitTerminal({ kind: "error", message });
    settleOutcome({ kind: "error", message });
  };
  const fail = (error: unknown): void => terminalError(safeMessage(error));
  const close = (): void => {
    if (!active) return;
    active = false;
    invalidateOwner();
    removeAbortListener();
    releaseHost();
    emitTerminal({ kind: "closed" });
    settleOutcome({ kind: "closed" });
  };
  renderer = { done, close };
  const isHostActive = (): boolean => active && renderersByHost.get(options.host) === renderer;
  const isLive = (): boolean => isHostActive()
    && (loadGeneration === null || owner?.isCurrent(loadGeneration) === true);
  const emitLoading = (): boolean => {
    try {
      options.onStatus({ kind: "loading" });
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };
  const emitReady = (viewer: T): void => {
    try {
      options.onStatus({ kind: "ready", viewer });
    } catch (error) {
      fail(error);
      return;
    }
    if (isHostActive()) settleOutcome({ kind: "ready" });
  };

  // Claim first so a prior renderer's synchronous closed observer cannot
  // replace a nested winner after this contender has already been superseded.
  const prior = renderersByHost.get(options.host);
  renderersByHost.set(options.host, renderer);
  // Replacement is synchronous and occurs before deadline checks, viewer
  // construction, or parser cloning for this host identity.
  prior?.close();
  if (!isHostActive()) return renderer;

  const deadlineMs = options.source.deadlineAt - Date.now();
  if (!Number.isSafeInteger(options.source.deadlineAt) || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    terminalError(EXPIRED_DEADLINE_MESSAGE);
    return renderer;
  }
  if (options.source.signal.aborted) {
    close();
    return renderer;
  }
  const abort = (): void => close();
  options.source.signal.addEventListener("abort", abort, { once: true });
  removeAbortListener = () => options.source.signal.removeEventListener("abort", abort);
  owner = createOoxmlLoadOwner({
    timeoutMs: deadlineMs,
    signal: options.source.signal,
    sanitizeError: safeMessage,
  });
  if (!emitLoading() || !isHostActive()) return renderer;

  let viewer: T;
  try {
    viewer = options.createViewer({ host: options.host, source: options.source, isLive, fail });
  } catch (error) {
    fail(error);
    return renderer;
  }
  if (!isHostActive()) {
    try {
      viewer.destroy();
    } catch {
      // A synchronous replacement cannot be revived by a destroy failure.
    }
    return renderer;
  }

  loadGeneration = runOoxmlLoadWithParserBytes(owner, options.source, viewer, options.load, {
    onReady: (value) => {
      if (!isLive()) return;
      emitReady(value);
    },
    onError: (message) => {
      // The lower lifecycle advances its generation before reporting timeout or
      // load failure, so this is intentionally gated by host activity, not isLive.
      if (!isHostActive()) return;
      terminalError(message);
    },
  });
  return renderer;
}
