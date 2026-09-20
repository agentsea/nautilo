export interface WireMeasurement {
  role: "router" | "controller" | null;
  elapsedMs: number;
  status: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  reasoningTokens?: number | null;
  finishReason?: string | null;
  responseKind: "json" | "stream" | "unreadable" | "network_error";
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Lab-only observation of the existing SDK transport. Never logs URLs,
 * headers, credentials, content, provider request ids or account metadata. */
export function observeOpenRouterFetch(original: typeof fetch, rows: WireMeasurement[], role: () => WireMeasurement["role"]): typeof fetch {
  const observed = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "openrouter.ai" || url.pathname !== "/api/v1/chat/completions") return original(input, init);
    const row: WireMeasurement = { role: role(), elapsedMs: 0, status: null, costUsd: null,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, responseKind: "network_error" };
    rows.push(row);
    const start = performance.now();
    try {
      const response = await original(input, init);
      row.status = response.status;
      if (response.headers.get("content-type")?.includes("text/event-stream")) row.responseKind = "stream";
      else {
        try {
          const parsed: unknown = await response.clone().json();
          const usage = object(object(parsed)["usage"]);
          row.responseKind = "json";
          row.costUsd = number(usage["cost"]);
          row.inputTokens = number(usage["prompt_tokens"]);
          row.outputTokens = number(usage["completion_tokens"]);
          row.cacheReadTokens = number(object(usage["prompt_tokens_details"])["cached_tokens"]);
          row.reasoningTokens = number(object(usage["completion_tokens_details"])["reasoning_tokens"]);
          const choices = object(parsed)["choices"];
          const finish = Array.isArray(choices) ? object(choices[0])["finish_reason"] : null;
          row.finishReason = typeof finish === "string" && ["stop", "length", "tool_calls", "content_filter", "error"].includes(finish) ? finish : null;
        } catch { row.responseKind = "unreadable"; }
      }
      return response;
    } finally { row.elapsedMs = performance.now() - start; }
  };
  return Object.assign(observed, original);
}
