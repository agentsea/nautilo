import type { ServerEvent } from "@nautilo/types";

const ECHO_COUNT = 10;
const ECHO_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Foreground stub executor. Echoes the input message 10 times
 * with delays, simulating LLM token streaming.
 */
export async function* echoExecutor(
  input: Record<string, unknown>,
  _jobId: string,
  laneKey: string | null,
  signal: AbortSignal
): AsyncGenerator<ServerEvent> {
  const message =
    typeof input["message"] === "string" ? input["message"] : "echo";

  for (let i = 1; i <= ECHO_COUNT; i++) {
    if (signal.aborted) return;
    await sleep(ECHO_DELAY_MS);

    yield {
      type: "message.tokens",
      laneKey: laneKey ?? "default",
      content: `[${i}/${ECHO_COUNT}] ${message}\n`,
      chunkSequence: i,
      done: i === ECHO_COUNT,
    };
  }
}
