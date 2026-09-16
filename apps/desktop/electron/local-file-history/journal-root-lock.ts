/**
 * Process-wide serialization for one durable journal manifest.
 *
 * Lock order is canonical-path lock, then journal-root lock. This module has
 * no dependency on the path-lock module and must never acquire path locks.
 */

const tails = new Map<string, Promise<void>>();

export function journalRootLockKey(canonicalRootDir: string): string {
  return canonicalRootDir;
}

async function acquire(key: string): Promise<() => void> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  tails.set(key, tail);
  await previous;
  return () => {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  };
}

export async function withJournalRootLock<T>(
  journalKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquire(journalKey);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Test-only reset; callers must ensure no holder is active. */
export function resetJournalRootLocksForTests(): void {
  tails.clear();
}
