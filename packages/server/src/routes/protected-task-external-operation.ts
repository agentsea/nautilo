/** End local protected custody without claiming the underlying effect stopped. */
export async function waitForProtectedTaskExternalOperation<Value>(
  signal: AbortSignal,
  operation: Promise<Value>,
): Promise<Value> {
  // The operation retains its own transport/settlement owner after this race.
  // Observing it prevents a late rejection from becoming an unhandled error.
  void operation.catch(() => undefined);
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Protected Task authority ended"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([operation, aborted]); }
  finally { if (onAbort !== undefined) signal.removeEventListener("abort", onAbort); }
}
