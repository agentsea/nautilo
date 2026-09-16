export interface OoxmlDestroyable {
  destroy: () => void;
}

export function destroyOnce(destroy: (() => void) | undefined): () => void {
  let destroyed = false;
  return () => {
    if (destroyed) return;
    destroyed = true;
    destroy?.();
  };
}

export interface OoxmlLoadOwner {
  readonly generation: number;
  isCurrent: (generation: number) => boolean;
  run: <T extends OoxmlDestroyable>(
    value: T,
    load: (value: T) => Promise<void>,
    handlers: { onReady: (value: T) => void; onError: (message: string) => void },
  ) => number;
  /**
   * Gives the parser precisely one disposable clone for this generation.
   * The master bytes stay private to the caller; this is intentionally not a
   * reusable clone factory.
   */
  runWithParserBytes: <T extends OoxmlDestroyable>(
    value: T,
    source: ArrayBuffer,
    load: (value: T, parserBytes: ArrayBuffer) => Promise<void>,
    handlers: { onReady: (value: T) => void; onError: (message: string) => void },
  ) => number;
  invalidate: () => void;
}

export interface CreateOoxmlLoadOwnerOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  sanitizeError?: (error: unknown) => string;
}

const defaultErrorMessage = () => "Document preview failed.";

/**
 * Owns one selected source generation and the viewer it creates. Its timeout
 * is host-provided so this inert package never decides a Mobile Web default.
 */
export function createOoxmlLoadOwner(
  options: CreateOoxmlLoadOwnerOptions,
): OoxmlLoadOwner {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    throw new RangeError("OOXML load timeout must be a positive safe integer.");
  let generation = 0;
  let aborted = false;
  let activeDestroy: (() => void) | undefined;
  let activeTimer: ReturnType<typeof setTimeout> | undefined;
  const clearActiveTimer = () => {
    if (activeTimer === undefined) return;
    clearTimeout(activeTimer);
    activeTimer = undefined;
  };
  const invalidate = () => {
    generation += 1;
    clearActiveTimer();
    activeDestroy?.();
    activeDestroy = undefined;
  };
  const abort = () => {
    aborted = true;
    invalidate();
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  const run = <T extends OoxmlDestroyable>(
    value: T,
    load: (value: T) => Promise<void>,
    handlers: { onReady: (value: T) => void; onError: (message: string) => void },
  ): number => {
    if (aborted) {
      destroyOnce(() => value.destroy())();
      return generation;
    }
    invalidate();
    const ownerGeneration = generation;
    const destroyValue = destroyOnce(() => value.destroy());
    activeDestroy = destroyValue;
    let settled = false;
    const clearTimer = () => {
      if (activeTimer === undefined) return;
      clearTimeout(activeTimer);
      activeTimer = undefined;
    };
    activeTimer = setTimeout(() => {
      if (settled || ownerGeneration !== generation) return;
      settled = true;
      activeTimer = undefined;
      generation += 1;
      destroyValue();
      activeDestroy = undefined;
      handlers.onError("Document preview timed out.");
    }, options.timeoutMs);
    const ready = () => {
      if (settled || ownerGeneration !== generation) {
        destroyValue();
        return;
      }
      settled = true;
      clearTimer();
      handlers.onReady(value);
    };
    const failed = (error: unknown) => {
      if (settled || ownerGeneration !== generation) return;
      settled = true;
      clearTimer();
      destroyValue();
      activeDestroy = undefined;
      handlers.onError((options.sanitizeError ?? defaultErrorMessage)(error));
    };
    try {
      void Promise.resolve(load(value)).then(ready, failed);
    } catch (error) {
      failed(error);
    }
    return ownerGeneration;
  };

  return {
    get generation() {
      return generation;
    },
    isCurrent: (candidate) => !aborted && candidate === generation,
    run,
    runWithParserBytes(value, source, load, handlers) {
      // Slice only at the parser handoff and only for the active generation.
      // A new run invalidates the old generation before it can make another clone.
      return run(value, (active) => load(active, source.slice(0)), handlers);
    },
    invalidate,
  };
}
