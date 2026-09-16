// Node converts larger delays to 1 ms instead of waiting for the requested time.
// https://nodejs.org/api/timers.html#settimeoutcallback-delay-args
const NODE_TIMER_MAX_MS = 2_147_483_647;

/** @param {string | undefined} raw */
export function parseReadyTimeoutMs(raw) {
  if (raw === undefined || raw === '') {
    throw new Error(
      'IME_BROWSER_READY_TIMEOUT_MS is required and must be a positive integer',
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > NODE_TIMER_MAX_MS) {
    throw new Error(
      `IME_BROWSER_READY_TIMEOUT_MS must be an integer from 1 to ${NODE_TIMER_MAX_MS}`,
    );
  }
  return value;
}

/**
 * @template T
 * @param {() => Promise<T>} run
 * @param {Array<() => Promise<void>>} cleanups
 * @returns {Promise<T>}
 */
export async function runWithCleanup(run, cleanups) {
  /** @type {T | undefined} */
  let value;
  /** @type {unknown} */
  let failure;
  let failed = false;
  try {
    value = await run();
  } catch (error) {
    failed = true;
    failure = error;
  }

  const settled = await Promise.allSettled(
    cleanups.map((cleanup) => Promise.resolve().then(cleanup)),
  );
  /** @type {unknown[]} */
  const cleanupFailures = [];
  for (const result of settled) {
    if (result.status === 'rejected') cleanupFailures.push(result.reason);
  }
  if (failed) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError([failure, ...cleanupFailures], 'IME verification and cleanup failed');
    }
    if (failure instanceof Error) throw failure;
    throw new AggregateError([failure], 'IME verification failed');
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'IME verification cleanup failed');
  }
  return /** @type {T} */ (value);
}
