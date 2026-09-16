import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  getCostsSummary as getCostsSummaryDefault,
  PROVIDER_TOOL_PRICING_VERSION,
  type CostsSummary,
} from "@nautilo/db";
import { getModelById, PRICING_VERSION } from "@nautilo/agent";
import { userHasCapability } from "@nautilo/trust";

export interface CostsRoutesDeps {
  /** Capability gate; defaults to `manage_billing` via trust. Injectable for tests. */
  hasBillingCapability?: (userId: string) => Promise<boolean>;
  /** Aggregation source; defaults to the DB query. Injectable for tests. */
  getCostsSummary?: (range: { sinceIso: string; untilIso: string }) => Promise<CostsSummary>;
}

const RANGE_DAYS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

const DEFAULT_RANGE = "30d";

const PROVIDER_COST_COVERAGE = {
  state: "partial" as const,
  accounted: [
    { provider: "browser_use", operation: "hosted_read" },
    { provider: "browser_use", operation: "browser_session" },
    { provider: "tavily", operation: "search" },
    { provider: "tavily", operation: "extract" },
    { provider: "tavily", operation: "deep_research_search" },
    { provider: "cloudconvert", operation: "conversion" },
    { provider: "elevenlabs", operation: "text_to_speech" },
    { provider: "elevenlabs", operation: "voice_preview" },
    { provider: "elevenlabs", operation: "speech_to_text" },
    { provider: "groq", operation: "speech_to_text" },
    { provider: "openai", operation: "native_web_search" },
    { provider: "anthropic", operation: "native_web_search" },
    { provider: "oomol", operation: "connected_app_execute" },
  ],
  unavailable: ["dynamic_mcp_billing", "external_harness_billing"],
};

/** Financial data — owner/admin only. Mirrors the audit-log gating pattern. */
async function requireBilling(
  request: FastifyRequest,
  reply: FastifyReply,
  hasCap: (userId: string) => Promise<boolean>,
): Promise<string | null> {
  const userId = request.sessionUserId;
  if (!userId) {
    reply.code(401).send({ error: "Authentication required" });
    return null;
  }
  if (!(await hasCap(userId))) {
    reply.code(403).send({ error: "manage_billing capability required" });
    return null;
  }
  return userId;
}

function resolveWindow(query: Record<string, unknown>): {
  sinceIso: string;
  untilIso: string;
  range: string;
} {
  const rangeRaw = typeof query["range"] === "string" ? query["range"] : DEFAULT_RANGE;
  const range = rangeRaw in RANGE_DAYS ? rangeRaw : DEFAULT_RANGE;

  const untilParam = typeof query["until"] === "string" ? new Date(query["until"]) : null;
  const sinceParam = typeof query["since"] === "string" ? new Date(query["since"]) : null;

  const until =
    untilParam && !Number.isNaN(untilParam.getTime()) ? untilParam : new Date();
  const since =
    sinceParam && !Number.isNaN(sinceParam.getTime())
      ? sinceParam
      : new Date(until.getTime() - RANGE_DAYS[range]! * 24 * 60 * 60 * 1000);

  return { sinceIso: since.toISOString(), untilIso: until.toISOString(), range };
}

export function costsRoutes(app: FastifyInstance, deps: CostsRoutesDeps = {}): void {
  const hasCap =
    deps.hasBillingCapability ??
    ((userId: string) => userHasCapability(userId, "manage_billing"));
  const getSummary = deps.getCostsSummary ?? getCostsSummaryDefault;

  app.get("/api/costs", async (request, reply) => {
    if (!(await requireBilling(request, reply, hasCap))) return;

    const { sinceIso, untilIso, range } = resolveWindow(
      request.query as Record<string, unknown>,
    );

    const summary = await getSummary({ sinceIso, untilIso });

    // Enrich model rows with a human display name from the catalog.
    const byModel = summary.byModel.map((row) => ({
      ...row,
      displayName: getModelById(row.model)?.displayName ?? row.model,
    }));

    return reply.send({
      range: { since: sinceIso, until: untilIso, key: range },
      pricingVersion: PRICING_VERSION,
      providerPricingVersion: PROVIDER_TOOL_PRICING_VERSION,
      providerCoverage: PROVIDER_COST_COVERAGE,
      totals: summary.totals,
      byModel,
      byCallType: summary.byCallType,
      byProvider: summary.byProvider,
      byUser: summary.byUser.map((row) => ({
        ...row,
        label: row.handle
          ? `@${row.handle}`
          : row.name ?? (row.userId ? "unknown user" : "system / background"),
      })),
      timeSeries: summary.timeSeries,
    });
  });
}
