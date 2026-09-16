/**
 * D416 Phase 1 — local-only explainer catalog resolution.
 *
 * This module performs no network I/O and never constructs playback or embed
 * URLs. It returns bounded, metadata-only DTOs for later tool integration.
 */
import {
  ExplainerCatalogDetailSchema,
  ExplainerCatalogListResultSchema,
  ExplainerCatalogSchema,
  ExplainerCatalogSearchInputSchema,
  type ExplainerCatalog,
  type ExplainerCatalogDetail,
  type ExplainerCatalogEntry,
  type ExplainerCatalogListResult,
  type ExplainerCatalogSearchInput,
  type ExplainerCatalogSummary,
  type ExplainerToolMetadata,
} from "@nautilo/types";
import seedManifest from "./seed/catalog.json";

/** Parse untrusted catalog JSON before resolver code can consume it. */
export function parseExplainerCatalog(manifest: unknown): ExplainerCatalog {
  return ExplainerCatalogSchema.parse(manifest);
}

/** Checked-in fallback for Phase 1; intentionally the only catalog source. */
export const localExplainerCatalog = parseExplainerCatalog(seedManifest);

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function words(value: string | undefined): string[] {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function entrySearchText(entry: ExplainerCatalogEntry): string {
  return [
    entry.id,
    entry.title,
    entry.summary,
    entry.description,
    ...entry.tags,
    ...entry.toolReferences.flatMap((reference) => [
      reference.name,
      reference.category ?? "",
      ...reference.tags,
    ]),
  ]
    .join(" ")
    .toLowerCase();
}

function matchesQuery(entry: ExplainerCatalogEntry, query: string | undefined): boolean {
  const terms = words(query);
  if (terms.length === 0) return true;
  const text = entrySearchText(entry);
  return terms.every((term) => text.includes(term));
}

function toolMatchScore(entry: ExplainerCatalogEntry, tool: ExplainerToolMetadata | undefined): number {
  if (!tool) return 0;

  const toolName = normalize(tool.name);
  const toolCategory = tool.category === undefined ? undefined : normalize(tool.category);
  const toolTags = new Set(tool.tags.map(normalize));
  let score = 0;

  for (const reference of entry.toolReferences) {
    if (normalize(reference.name) === toolName) score += 100;
    if (toolCategory !== undefined && normalize(reference.category ?? "") === toolCategory) score += 20;
    for (const tag of reference.tags) {
      if (toolTags.has(normalize(tag))) score += 5;
    }
  }

  return score;
}

function toSummary(entry: ExplainerCatalogEntry): ExplainerCatalogSummary {
  return {
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
    tags: entry.tags,
    durationSeconds: entry.durationSeconds,
    captionsAvailable: entry.captionsAvailable,
  };
}

function toDetail(entry: ExplainerCatalogEntry): ExplainerCatalogDetail {
  return ExplainerCatalogDetailSchema.parse(entry);
}

/**
 * Safe, narrowly typed provenance attached to a discovery result. This is the
 * runtime-side companion to `ExplainerCatalogListResult`'s `source`/`stale`:
 * the synchronous local helpers default to a fresh local catalog, while the
 * runtime seam maps the remote loader's source/staleness into these terms.
 */
export interface ExplainerCatalogSearchProvenance {
  source: "local" | "remote";
  stale: boolean;
}

const LOCAL_FRESH_PROVENANCE: ExplainerCatalogSearchProvenance = { source: "local", stale: false };

/**
 * Search the supplied catalog. Tool metadata has priority over free-text
 * matching, so Genie can select explainers associated with a current tool.
 *
 * `provenance` labels where `catalog` came from (local vs remote) and whether
 * it is stale; it is forwarded verbatim into the bounded list DTO. It defaults
 * to a fresh local catalog so existing synchronous callers and tests keep
 * their `source: "local"` behavior.
 */
export function searchExplainerCatalog(
  catalog: ExplainerCatalog,
  input: ExplainerCatalogSearchInput = {},
  provenance: ExplainerCatalogSearchProvenance = LOCAL_FRESH_PROVENANCE,
): ExplainerCatalogListResult {
  const request = ExplainerCatalogSearchInputSchema.parse(input);
  const ranked = catalog.entries
    .map((entry, index) => ({ entry, index, score: toolMatchScore(entry, request.tool) }))
    .filter(({ entry, score }) => matchesQuery(entry, request.query) && (request.tool === undefined || score > 0))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const total = ranked.length;
  const start = (request.page - 1) * request.pageSize;
  const items = ranked.slice(start, start + request.pageSize).map(({ entry }) => toSummary(entry));

  return ExplainerCatalogListResultSchema.parse({
    version: catalog.version,
    catalogVersion: catalog.catalogVersion,
    publishedAt: catalog.publishedAt,
    source: provenance.source,
    stale: provenance.stale,
    items,
    page: request.page,
    pageSize: request.pageSize,
    total,
    hasMore: start + items.length < total,
  });
}

/** Search the checked-in catalog; no remote source, cache, or signing exists in this helper. */
export function searchLocalExplainerCatalog(
  input: ExplainerCatalogSearchInput = {},
): ExplainerCatalogListResult {
  return searchExplainerCatalog(localExplainerCatalog, input, LOCAL_FRESH_PROVENANCE);
}

/** Resolve one safe, metadata-only local catalog detail by stable ID. */
export function resolveLocalExplainerDetail(id: string): ExplainerCatalogDetail | undefined {
  const entry = localExplainerCatalog.entries.find((candidate) => candidate.id === id);
  return entry === undefined ? undefined : toDetail(entry);
}
