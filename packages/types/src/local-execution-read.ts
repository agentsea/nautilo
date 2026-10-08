/** Pure observation only. This classification grants no execution ownership. */
export function isLocalExecutionReadArgs(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const args = value as Record<string, unknown>;
  return typeof args["session_id"] === "string" && args["session_id"].length > 0
    && Object.keys(args).every(key => ["session_id", "chars", "cancel", "cursor", "max_output_bytes", "yield_time_ms", "search"].includes(key))
    && (args["search"] === undefined || (typeof args["search"] === "string" && args["search"].length > 0
      && new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(args["search"])) === args["search"]
      && !["chars", "cancel", "yield_time_ms"].some(key => key in args)))
    && (args["chars"] === undefined || args["chars"] === "")
    && (args["cancel"] === undefined || args["cancel"] === false)
    && ["cursor", "max_output_bytes", "yield_time_ms"].every(key => args[key] === undefined ||
      (Number.isSafeInteger(args[key]) && (args[key] as number) >= (key === "max_output_bytes" ? 4 : 0)))
    && (args["yield_time_ms"] === undefined || (args["yield_time_ms"] as number) <= 2_147_483_647);
}
