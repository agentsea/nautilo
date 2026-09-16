/**
 * find_explainer — search the official Nautilo explainer catalog for a relevant
 * curated walkthrough when a user asks how to use a capability.
 *
 * Discovery runs through the runtime catalog seam: it fetches the verified
 * official manifest (with strict fallback to the checked-in local catalog) and
 * reports truthful, narrowly typed provenance/staleness. It never exposes the
 * manifest URL, playback URLs, provider identities, or credentials, and it
 * never accepts a caller-supplied URL. Playback is a separate, consented phase.
 */
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { searchExplainerCatalog } from "../../media/explainer-catalog/catalog";
import {
  getRuntimeExplainerCatalog,
  mapExplainerCatalogProvenance,
} from "../../media/explainer-catalog/runtime-catalog";

const toolMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    description: z.string().trim().max(1_000).optional(),
    category: z.string().trim().min(1).max(64).optional(),
    tags: z.array(z.string().trim().min(1).max(48)).max(20).default([]),
  })
  .strict();

export function createFindExplainerTool() {
  return new DynamicStructuredTool({
    name: "find_explainer",
    description:
      "Find a relevant curated Nautilo walkthrough when a user asks how to use a capability. " +
      "Searches the official Nautilo explainer catalog and returns bounded title and duration details to offer the user. " +
      "Do not autoplay or request playback until the user consents.",
    schema: z.object({
      query: z.string().trim().max(160).optional().describe("Keywords describing the capability or help topic"),
      tool: toolMetadataSchema
        .optional()
        .describe("Optional current Nautilo tool metadata to find its associated walkthrough"),
      page: z.number().int().positive().default(1).describe("One-based catalog result page"),
      pageSize: z.number().int().min(1).max(20).default(10).describe("Maximum walkthroughs to return (1-20)"),
    }),
    func: async ({ query, tool, page, pageSize }): Promise<string> => {
      const result = await getRuntimeExplainerCatalog();
      const provenance = mapExplainerCatalogProvenance(result);
      const list = searchExplainerCatalog(
        result.catalog,
        { query, tool, page, pageSize },
        { source: provenance.source, stale: provenance.stale },
      );
      return JSON.stringify(list);
    },
  });
}
