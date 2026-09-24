/** One app-owned pass at a time, coalesced wakes, and draining shutdown.
 * The receipt owner supplies its snapshot traversal and durable checkpoints.
 * Failures remain pending until another wake or restart; no polling policy.
 */
export function createReceiptRecoveryPump(input: Readonly<{
  runPass(isStopped: () => boolean): Promise<void>;
  onPassFailure?: (() => void) | undefined;
}>) {
  let stopped = false;
  let requested = false;
  let current: Promise<void> | null = null;
  const pump = (): void => {
    if (stopped || current !== null) return;
    requested = false;
    current = input.runPass(() => stopped).catch(() => {
      input.onPassFailure?.();
    }).finally(() => {
      current = null;
      if (requested && !stopped) pump();
    });
  };
  const request = (): void => {
    if (stopped) return;
    requested = true;
    pump();
  };
  return Object.freeze({
    start: request,
    wake: request,
    async stop() {
      stopped = true;
      requested = false;
      await current;
    },
  });
}
