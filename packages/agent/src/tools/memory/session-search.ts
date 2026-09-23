import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { searchSessions } from "../../store/session-store";
import { fromRuntimeConfig } from "@nautilo/config";
interface SessionSearchContext {
  ownerId?: string;
  causalHumanUserId?: string;
  personaId?: string;
  currentThreadId?: string;
}

export function createSessionSearchTool(context?: SessionSearchContext) {
  return new DynamicStructuredTool({
    name: "session_search",
    description: `Search past conversation transcripts across prior sessions.

Use this when:
- The user references a past conversation ("last time we talked about...")
- You need full conversation context, not just a stored fact
- You want to recall the flow of a prior discussion

Returns summarized results grouped by session, not raw transcript dumps.`,
    schema: z.object({
      query: z.string().describe("What to search for in past conversations"),
      limit: z.number().optional().default(5).describe("Max sessions to return"),
    }),
    func: async ({ query, limit }) => {
      try {
        const config = fromRuntimeConfig();
        const results = await searchSessions({
          ownerId: context?.ownerId ?? "00000000-0000-0000-0000-000000000000",
          humanUserId: context?.causalHumanUserId ?? "",
          personaId: context?.personaId ?? "owner",
          query,
          limit: limit ?? config.nautilo_session_search_limit,
          ...(context?.currentThreadId
            ? { excludeThreadId: context.currentThreadId }
            : {}),
        });

        if (results.length === 0) {
          return "No past sessions matched this query.";
        }

        return results
          .map(
            (r, i) =>
              `${i + 1}. Session: ${r.title ?? "Untitled"} (${r.startedAt.toISOString().slice(0, 10)})\n${r.summary}`,
          )
          .join("\n\n");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return `Session search failed: ${msg}`;
      }
    },
  });
}
