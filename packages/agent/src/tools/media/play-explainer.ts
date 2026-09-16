/**
 * play_explainer — resolve an explicitly accepted Nautilo explainer to a
 * verified-byte playback request.
 *
 * The entry is resolved from the same runtime catalog discovery uses (the
 * verified signed official manifest, with strict fallback to the bundled
 * seed) — never a hardcoded local copy. The result carries ONLY the stable
 * catalog id and display metadata the Workbench needs to request verified
 * media through the authenticated server route (`GET /api/explainers/:id/media`).
 *
 * It deliberately returns NO CDN/media URL, no provider identity, no token,
 * and no signature. The Workbench fetches verified bytes with its bearer
 * through the API client and plays a revocable Blob URL; the browser never
 * sees a permanent CDN URL. This performs no provider API calls.
 */
import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  ExplainerPlaybackEnvelopeSchema,
  type ExplainerCatalogEntry,
  type ExplainerPlaybackEnvelope,
} from "@nautilo/types";
import { z } from "zod";
import {
  findExplainerCatalogEntry,
  getRuntimeExplainerCatalog,
} from "../../media/explainer-catalog/runtime-catalog";

function resolvePlayback(entry: ExplainerCatalogEntry): ExplainerPlaybackEnvelope {
  // Defense-in-depth: the strict catalog schema already guarantees
  // provider === "bunny-storage" and format === "mp4", so a runtime-mutated
  // asset is rejected before the envelope is built.
  const provider = entry.asset.provider as string;
  const format = entry.asset.format as string;
  if (provider !== "bunny-storage") {
    throw new Error(
      `Explainer "${entry.id}" uses unsupported provider "${provider}"; only bunny-storage is available for verified playback.`,
    );
  }
  if (format !== "mp4") {
    throw new Error(
      `Explainer "${entry.id}" uses unsupported format "${format}"; only direct MP4 playback is available.`,
    );
  }

  return ExplainerPlaybackEnvelopeSchema.parse({
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
    description: entry.description,
    tags: entry.tags,
    durationSeconds: entry.durationSeconds,
    publishedAt: entry.publishedAt,
    captionsAvailable: entry.captionsAvailable,
    format: entry.asset.format,
    requiresApproval: true,
  });
}

export function createPlayExplainerTool() {
  return new DynamicStructuredTool({
    name: "play_explainer",
    description:
      "Resolve one previously offered Nautilo explainer for verified playback. " +
      "Invoke only after the user has explicitly agreed to play that explainer; never autoplay or invoke merely because an explainer was found. " +
      "Returns the catalog id and display metadata only — the Workbench fetches verified MP4 bytes through the authenticated server route and plays a revocable Blob URL; no CDN URL is exposed.",
    schema: z
      .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, "must be a catalog explainer id"),
      })
      .strict(),
    func: async ({ id }): Promise<string> => {
      const { catalog } = await getRuntimeExplainerCatalog();
      const entry = findExplainerCatalogEntry(catalog, id);
      if (entry === undefined) {
        throw new Error(`Unknown explainer "${id}". Use find_explainer to choose an available catalog entry.`);
      }
      return JSON.stringify(resolvePlayback(entry));
    },
  });
}
