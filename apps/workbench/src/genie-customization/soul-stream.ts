import type { SoulGenerationEvent } from "@nautilo/genie-customization-ui";

const MALFORMED_STREAM_ERROR = "Soul generation returned an invalid response. Please try again.";
const INCOMPLETE_STREAM_ERROR = "Soul generation ended before it finished. Please try again.";

export type SoulStreamHandlers = {
  onEvent: (event: SoulGenerationEvent) => void;
};

function parseFrame(frame: string): SoulGenerationEvent | null {
  const lines = frame.replace(/\r/g, "").split("\n");
  const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  const dataText = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");

  if (!eventName || !eventName.startsWith("soul.")) return null;
  if (!dataText) return { type: "error", error: MALFORMED_STREAM_ERROR };

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(dataText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { type: "error", error: MALFORMED_STREAM_ERROR };
    }
    data = parsed as Record<string, unknown>;
  } catch {
    return { type: "error", error: MALFORMED_STREAM_ERROR };
  }

  switch (eventName) {
    case "soul.started":
      return { type: "started" };
    case "soul.delta":
      return typeof data["text"] === "string"
        ? { type: "delta", text: data["text"] }
        : { type: "error", error: MALFORMED_STREAM_ERROR };
    case "soul.completed":
      return typeof data["soulFile"] === "string" && data["soulFile"].trim()
        ? { type: "completed", soulFile: data["soulFile"] }
        : { type: "error", error: MALFORMED_STREAM_ERROR };
    case "soul.error": {
      const error = typeof data["error"] === "string" && data["error"].trim()
        ? data["error"]
        : "Soul generation failed.";
      const fallback = typeof data["fallback"] === "string" && data["fallback"].trim()
        ? data["fallback"]
        : undefined;
      return fallback ? { type: "error", error, fallback } : { type: "error", error };
    }
    default:
      return null;
  }
}

/**
 * Consume complete SSE frames and retain the trailing incomplete frame. Both
 * the profile editor and the wizard use this parser; the wizard also consumes
 * its started and fallback semantics.
 */
export function consumeSoulStreamChunk(
  chunk: string,
  carry: string,
  handlers: SoulStreamHandlers,
): string {
  const combined = carry + chunk;
  const frames = combined.split(/\n\n/);
  const nextCarry = frames.pop() ?? "";
  for (const frame of frames) {
    const event = parseFrame(frame);
    if (event) handlers.onEvent(event);
  }
  return nextCarry;
}

export async function readSoulGenerationStream(
  response: Response,
  handlers: SoulStreamHandlers,
): Promise<string> {
  if (!response.ok) throw new Error("Soul generation is unavailable. Please try again.");
  if (!response.body) throw new Error(INCOMPLETE_STREAM_ERROR);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let completed: string | null = null;
  let terminalError: string | null = null;
  const onEvent = (event: SoulGenerationEvent): void => {
    handlers.onEvent(event);
    if (event.type === "completed") completed = event.soulFile;
    if (event.type === "error") {
      if (event.fallback) completed = event.fallback;
      else terminalError = event.error;
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    carry = consumeSoulStreamChunk(decoder.decode(value, { stream: true }), carry, { onEvent });
    if (terminalError) throw new Error(terminalError);
  }

  carry = consumeSoulStreamChunk(decoder.decode(), carry, { onEvent });
  if (carry.trim()) {
    const event = parseFrame(carry);
    if (event) onEvent(event);
  }
  if (terminalError) throw new Error(terminalError);
  if (!completed) throw new Error(INCOMPLETE_STREAM_ERROR);
  return completed;
}
