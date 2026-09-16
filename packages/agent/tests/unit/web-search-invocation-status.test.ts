import { afterEach, expect, test } from "bun:test";
import { clearToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import { fromRuntimeConfig } from "@nautilo/config";
import type { NautiloState } from "../../src/agent/state";
import {
  createNautiloToolInvocationSession,
  createServerToolInvocationContext,
} from "../../src/tools/invocation-service";
import { createRunWebSearchTool } from "../../src/tools/utilities/web-search";

afterEach(() => clearToolCatalog());

test("exhausted search providers produce an actionable non-success invocation", async () => {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "run_web_search",
    exposure: "core",
    category: "research",
    trustTier: "high",
    impact: "low",
    executor: "cloud",
    resultScanPolicy: "never",
    factory: () => createRunWebSearchTool(undefined, {
      getRuntimeConfig: () => fromRuntimeConfig({ nautilo_search_provider: "auto" }),
      createSearchFetcher: () => async (query) => ({
        provider: "duckduckgo_html",
        query,
        items: [],
        outcome: "unavailable",
        failure: "desktop_unavailable",
        fallbackFrom: "tavily",
        fallbackReason: "tavily_failed",
      }),
    }),
  });
  initToolCatalog(catalog);
  const context = createServerToolInvocationContext({
    messages: [], approvedToolCalls: [], actorRole: "owner", userId: "owner",
    causalHumanUserId: "human", personaId: "owner", turnId: "turn", agentId: "agent",
    roomId: "room", approvalLaneKey: "room:room", langgraphThreadId: "room:room",
    trustedExecutionEntrypoint: "foreground.main", activatedToolNames: [], activatedToolLeases: [],
    engagedSkillNames: [], memoryAccessEnvelope: null, relayCapabilities: {},
  } as unknown as NautiloState, () => ({ status: "allowed" }));

  const result = await createNautiloToolInvocationSession(context).invoke({
    callId: "web-search-unavailable",
    toolName: "run_web_search",
    args: { query: "Python documentation" },
    authorityRef: "admitted",
  });

  expect(result.status).toBe("error");
  expect(result.content).toContain("Tavily could not complete the request");
  expect(result.content).toContain("Desktop research browser is unavailable");
  expect(result.content).not.toContain("fallbackReason");
});
