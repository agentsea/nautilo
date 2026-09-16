import { runWithUsageContext } from "@nautilo/agent";

async function runBackgroundModelExecution<T>(
  invoke: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  maximumElapsedMs: number | undefined,
  now: () => number = () => performance.now(),
): Promise<T> {
  if (maximumElapsedMs !== undefined && (!Number.isSafeInteger(maximumElapsedMs) || maximumElapsedMs < 1)) {
    throw new RangeError("maximumElapsedMs must be a positive safe integer");
  }
  if (parentSignal?.aborted) throw new Error("room_side_model_aborted");

  const startedAt = now();
  const controller = new AbortController();
  let rejectInterruption: ((reason: Error) => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject;
  });
  const abortFromParent = () => {
    controller.abort();
    rejectInterruption?.(new Error("room_side_model_aborted"));
  };
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = maximumElapsedMs === undefined ? undefined : setTimeout(() => {
    controller.abort();
    rejectInterruption?.(new Error("room_side_model_deadline_exceeded"));
  }, maximumElapsedMs);

  try {
    // Start through a settled Promise so a synchronously expensive adapter
    // cannot finish before Promise.race is established. The timer remains the
    // prompt cancellation path; the elapsed fence below also fails closed when
    // provider work starves the event loop long enough for a late completion
    // microtask to run before the overdue timer callback.
    const value = await Promise.race([
      Promise.resolve().then(() => invoke(controller.signal)),
      interrupted,
    ]);
    if (maximumElapsedMs !== undefined && now() - startedAt >= maximumElapsedMs) {
      controller.abort();
      throw new Error("room_side_model_deadline_exceeded");
    }
    return value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
    rejectInterruption = undefined;
  }
}

/** Existing Room-side caller deadline policy, shared with other processors. */
export function runBackgroundModelWithDeadline<T>(
  invoke: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  maximumElapsedMs: number,
  now?: () => number,
): Promise<T> {
  return runBackgroundModelExecution(invoke, parentSignal, maximumElapsedMs, now);
}

/** Shared correlation, cancellation and optional caller-owned deadline. */
export function runBackgroundModelInvocation<T>(options: {
  usage: Parameters<typeof runWithUsageContext>[0];
  signal?: AbortSignal;
  maximumElapsedMs?: number;
  invoke(signal: AbortSignal | undefined): Promise<T>;
}): Promise<T> {
  return runWithUsageContext(options.usage, async () => {
    if (options.signal?.aborted) throw new Error("room_side_model_aborted");
    return runBackgroundModelExecution((signal) => options.invoke(signal), options.signal, options.maximumElapsedMs);
  });
}
