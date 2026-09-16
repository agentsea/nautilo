/** Content-free coordinates; family repositories remain the durable work owner. */
export interface BackgroundAttemptIdentity {
  family: "memory" | "stenographer" | "reflection";
  stage: string;
  workId: string;
  attemptId: string;
}

export interface BackgroundAccessSession {
  /** Revalidate execution authority. Publishers still fence their SQL claim/source. */
  assertCurrent(): Promise<void>;
  close(): Promise<void>;
}

export class BackgroundAttemptUnavailableError extends Error {
  constructor() { super("background_attempt_unavailable"); }
}

export class BackgroundAttemptCancelledError extends Error {
  constructor() { super("background_attempt_cancelled"); }
}

export interface BackgroundAttemptContext {
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
  /** No late caller may enter publication after this attempt ends. */
  publish<T>(publish: () => Promise<T>): Promise<T>;
}

export interface BackgroundAttemptObservation extends BackgroundAttemptIdentity {
  durationMs: number;
  outcome: "completed" | "failed" | "unavailable" | "cancelled";
}

export interface BackgroundAttemptOptions {
  identity: BackgroundAttemptIdentity;
  signal?: AbortSignal;
  checkAvailable(): Promise<boolean>;
  openAccess(identity: BackgroundAttemptIdentity, signal: AbortSignal): Promise<BackgroundAccessSession>;
  observe?(observation: BackgroundAttemptObservation): void | Promise<void>;
}

export interface BackgroundAttemptLifetime extends BackgroundAttemptContext {
  /** The first close owns the outcome; repeated closes share its cleanup. */
  close(outcome: BackgroundAttemptObservation["outcome"]): Promise<void>;
}

function failureOutcome(error: unknown): BackgroundAttemptObservation["outcome"] {
  if (error instanceof BackgroundAttemptUnavailableError) return "unavailable";
  if (error instanceof BackgroundAttemptCancelledError) return "cancelled";
  return "failed";
}

/**
 * Open one authorized lifetime, including the initial current-authority check.
 * A family retaining prepared work in a batch must close it on every exit.
 * Setup failures close themselves; no content belongs in this handle.
 */
export async function openBackgroundAttempt(options: BackgroundAttemptOptions): Promise<BackgroundAttemptLifetime> {
  const startedAt = performance.now();
  const signal = options.signal ?? new AbortController().signal;
  let session: BackgroundAccessSession | undefined;
  let active = true;
  let closing: Promise<void> | undefined;
  const assertActive = () => {
    if (!active || signal.aborted) throw new BackgroundAttemptCancelledError();
  };
  const assertCurrent = async () => {
    assertActive();
    await session!.assertCurrent();
    assertActive();
  };
  const close = (outcome: BackgroundAttemptObservation["outcome"]): Promise<void> => {
    if (closing) return closing;
    active = false;
    // Schedule teardown after caching its promise, including reentrant closes.
    closing = Promise.resolve().then(async () => {
      // Neither cleanup nor observation can change a canonical commit result.
      try { await session?.close(); } catch { /* best-effort release */ }
      try {
        await options.observe?.({ ...options.identity, durationMs: performance.now() - startedAt, outcome });
      } catch { /* observations never drive semantic retry */ }
    });
    return closing;
  };
  try {
    assertActive();
    if (!(await options.checkAvailable())) throw new BackgroundAttemptUnavailableError();
    assertActive();
    session = await options.openAccess(options.identity, signal);
    await assertCurrent();
    return {
      signal,
      assertCurrent,
      close,
      publish: async (publish) => {
        await assertCurrent();
        assertActive();
        // Once entered, only the canonical publisher can establish whether a
        // commit happened. Never turn its committed result into cancellation.
        return publish();
      },
    };
  } catch (error) {
    await close(failureOutcome(error));
    throw error;
  }
}

/**
 * One access lifetime around family-owned claim/read/transform/publish work.
 * Reconcile uncertain publication in the family repository before transformation.
 * This guard does not retry work or reinterpret canonical publication results.
 */
export async function runBackgroundAttempt<T>(options: BackgroundAttemptOptions & {
  run(context: BackgroundAttemptContext): Promise<T>;
  /** Classify typed family results without changing their return value or retry policy. */
  classifyResult?(value: T): BackgroundAttemptObservation["outcome"];
}): Promise<T> {
  const attempt = await openBackgroundAttempt(options);
  let outcome: BackgroundAttemptObservation["outcome"] = "failed";
  try {
    const value = await options.run(attempt);
    outcome = options.classifyResult?.(value) ?? "completed";
    return value;
  } catch (error) {
    outcome = failureOutcome(error);
    throw error;
  } finally {
    await attempt.close(outcome);
  }
}
