export type RegisteredPool = {
  name: string;
  close: (timeoutMs: number) => Promise<void>;
};

const registry = new Map<string, RegisteredPool>();

let closeInFlight: Promise<void> | null = null;
let closed = false;

function raceCloseTimeout(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs <= 0) return promise;
  return Promise.race([
    promise,
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("pool close timed out")), timeoutMs);
    }),
  ]);
}

/**
 * Register a named pool closer for process shutdown. Duplicate names
 * deterministically replace the prior registration.
 */
export function registerPoolForShutdown(pool: RegisteredPool): () => void {
  registry.set(pool.name, pool);
  return () => {
    if (registry.get(pool.name) === pool) {
      registry.delete(pool.name);
    }
  };
}

export async function closeRegisteredPools(options: {
  timeoutMs: number;
  onError?: (name: string, error: unknown) => void;
}): Promise<void> {
  if (closed) return;
  if (closeInFlight) {
    await closeInFlight;
    return;
  }

  closeInFlight = (async () => {
    const entries = [...registry.values()];
    const results = await Promise.all(
      entries.map(async (entry) => {
        try {
          await raceCloseTimeout(
            Promise.resolve().then(() => entry.close(options.timeoutMs)),
            options.timeoutMs,
          );
          return { entry };
        } catch (error) {
          return { entry, error };
        }
      }),
    );
    for (const result of results) {
      if ("error" in result) {
        options.onError?.(result.entry.name, result.error);
      }
    }
    closed = true;
  })();

  try {
    await closeInFlight;
  } finally {
    closeInFlight = null;
  }
}

/** @internal test seam — clear registry state without reaching real Postgres. */
export function __resetPoolShutdownRegistryForTests(): void {
  registry.clear();
  closeInFlight = null;
  closed = false;
}

/** @internal test seam — inspect registered pool names (stable labels only). */
export function __getRegisteredPoolNamesForTests(): string[] {
  return [...registry.keys()];
}
