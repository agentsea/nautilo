import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { formatLocal } from "../../prompts/time-format";

interface GetCurrentTimeContext {
  userTimezone: string;
}

function contextFromUnknown(ctx: unknown): GetCurrentTimeContext {
  const c = (ctx ?? {}) as Record<string, unknown>;
  return {
    userTimezone:
      typeof c["userTimezone"] === "string" && c["userTimezone"].length > 0
        ? c["userTimezone"]
        : "UTC",
  };
}

/**
 * M087 — `get_current_time`. Cloud-executed, owner-only, zero-argument tool.
 * Returns the current time as a UTC ISO timestamp plus the user's local-
 * formatted time and IANA timezone. Uses the same `formatLocal` helper as the
 * system-prompt `## Current time` block (single source of truth), so the
 * tool's `localFormatted` is byte-identical to the prompt at the same instant.
 */
export function createGetCurrentTimeTool(context?: unknown) {
  const { userTimezone } = contextFromUnknown(context);
  return tool(
    // eslint-disable-next-line @typescript-eslint/require-await -- langchain tool funcs are invoked as promises; the body is synchronous.
    async () => {
      const tz = userTimezone || "UTC";
      const now = new Date();
      return JSON.stringify({
        nowUtcIso: now.toISOString(),
        userTimezone: tz,
        localFormatted: formatLocal(now, tz),
      });
    },
    {
      name: "get_current_time",
      description:
        "Return the current time as a UTC ISO timestamp plus the user's local-formatted time and IANA timezone. Use when you need a fresh, deterministic timestamp to pass to other tools or after a long tool chain where the system-prompt clock may be stale.",
      schema: z.object({}).strict(),
    },
  );
}
