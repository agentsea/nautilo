/** Leave a bounded checkpoint/settlement interval before temporary custody ends. */
const PROTECTED_TASK_CHECKPOINT_REFRESH_LEAD_MS = 60_000;

type Scheduler = Readonly<{
  now(): number;
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
}>;
const scheduler: Scheduler = Object.freeze({ now: Date.now,
  schedule: (callback, delayMs) => setTimeout(callback, delayMs), cancel: clearTimeout });

/** A cooperative request, never an extension or replacement of hard expiry. */
export function scheduleProtectedTaskCheckpointRefresh(input: Readonly<{
  expiresAt: number;
  signal: AbortSignal;
  requestPause(): boolean;
}>, clock: Scheduler = scheduler): () => void {
  const startedAt = clock.now();
  if (!Number.isSafeInteger(startedAt) || startedAt < 0
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0) {
    throw new TypeError("Protected Task checkpoint refresh clock is invalid");
  }
  if (input.signal.aborted || input.expiresAt <= startedAt) return () => {};
  const remaining = input.expiresAt - startedAt;
  // Short grants retain useful execution time instead of parking immediately
  // on every fresh segment. Ordinary QA/production grants use the full margin.
  const lead = Math.min(PROTECTED_TASK_CHECKPOINT_REFRESH_LEAD_MS, Math.floor(remaining / 2));
  const pauseAt = input.expiresAt - lead;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    active = false;
    if (timer !== undefined) clock.cancel(timer);
    input.signal.removeEventListener("abort", close);
  };
  const request = () => {
    if (!active || input.signal.aborted) return;
    const now = clock.now();
    if (!Number.isSafeInteger(now) || now < 0 || now >= input.expiresAt) { close(); return; }
    if (now < pauseAt) { timer = clock.schedule(request, pauseAt - now); return; }
    close();
    input.requestPause();
  };
  input.signal.addEventListener("abort", close, { once: true });
  timer = clock.schedule(request, pauseAt - startedAt);
  return close;
}
