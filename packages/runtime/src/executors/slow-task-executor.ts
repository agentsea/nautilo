import type { ServerEvent } from "@nautilo/types";

const PHASES = [
  "Starting...",
  "Gathering data...",
  "Processing...",
  "Analyzing...",
  "Finalizing...",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Background stub executor. Simulates a slow task with progress phases,
 * ~8 seconds total. Yields progress events and a final completion.
 */
export async function* slowTaskExecutor(
  input: Record<string, unknown>,
  jobId: string,
  _laneKey: string | null,
  signal: AbortSignal
): AsyncGenerator<ServerEvent> {
  const task =
    typeof input["task"] === "string" ? input["task"] : "background work";

  for (let i = 0; i < PHASES.length; i++) {
    if (signal.aborted) return;

    yield {
      type: "job.progress",
      jobId,
      phase: PHASES[i]!,
      detail: `${task} (${i + 1}/${PHASES.length})`,
    };

    await sleep(1500);
  }

  yield {
    type: "worker.complete",
    jobId,
    result: "success",
  };
}
