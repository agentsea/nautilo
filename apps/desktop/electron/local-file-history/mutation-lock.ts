/**
 * Process-wide exclusion for mutations of canonical Desktop paths.
 *
 * Callers must resolve and authorize paths before entering this module. This is
 * deliberately only an in-process lock: it coordinates the relay's existing
 * writers without changing their authority or persistence semantics.
 */

const tails = new Map<string, Promise<void>>();

function normalizedPaths(canonicalPaths: readonly string[]): string[] {
  return [...new Set(canonicalPaths)].sort();
}

async function acquire(canonicalPath: string): Promise<() => void> {
  const previous = tails.get(canonicalPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  tails.set(canonicalPath, tail);
  await previous;

  return () => {
    release();
    if (tails.get(canonicalPath) === tail) {
      tails.delete(canonicalPath);
    }
  };
}

/**
 * Serialize a mutation across every canonical path it can change.
 *
 * Sorted, deduplicated acquisition makes opposite source/destination orders
 * wait rather than deadlock. Releases run in reverse order and always happen
 * after throws or rejections.
 */
export async function withCanonicalPathLocks<T>(
  canonicalPaths: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const releases: Array<() => void> = [];
  try {
    for (const canonicalPath of normalizedPaths(canonicalPaths)) {
      releases.push(await acquire(canonicalPath));
    }
    return await fn();
  } finally {
    for (const release of releases.reverse()) {
      release();
    }
  }
}

/** Test hook — never use outside focused unit tests. */
export function resetCanonicalPathLocksForTests(): void {
  tails.clear();
}
