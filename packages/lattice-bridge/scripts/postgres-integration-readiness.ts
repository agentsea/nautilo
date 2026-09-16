export const POSTGRES_INIT_COMPLETE_MARKER =
  "PostgreSQL init process complete; ready for start up.";

export interface PostgresReadinessProbe {
  readonly canQuery: () => boolean;
  readonly inspectStatus: () => string | undefined;
  readonly now: () => number;
  readonly readLogs: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface PostgresReadinessOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export async function waitForFinalPostgres(
  probe: PostgresReadinessProbe,
  options: PostgresReadinessOptions = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const deadline = probe.now() + (options.timeoutMs ?? 60_000);

  while (probe.now() < deadline) {
    const status = probe.inspectStatus();
    if (status === "exited") {
      throw new Error(
        "disposable lattice Postgres exited during bootstrap",
      );
    }

    const initializationCompleted = probe.readLogs().includes(
      POSTGRES_INIT_COMPLETE_MARKER,
    );
    if (
      initializationCompleted
      && status === "healthy"
      && probe.canQuery()
    ) {
      return;
    }

    await probe.sleep(pollIntervalMs);
  }

  throw new Error(
    "disposable lattice Postgres did not finish initialization in 60s",
  );
}
