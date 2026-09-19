/**
 * discover_models — meta-tool that lets the agent query the resolved model
 * catalog (the current implementation).
 *
 * Sibling of `discover_tools` / `discover_skills`: a bounded, read-only
 * window onto resolved-catalog projection. It never places the
 * full model list in the system prompt; the agent asks for what it needs.
 *
 * invariants enforced here:
 * - `get` accepts one EXACT stable model id and only returns a curated
 * resolved-catalog row. Arbitrary dynamic `openrouter:` / `gateway:`
 * strings are NOT a v1 call surface — they resolve to
 * `availability: "unknown_model"` and are reported as not-found.
 * - Unknown capability metadata stays unknown: a `null` feature never
 * satisfies `requires_*: true` (AND semantics).
 * - Only compact, non-secret data is returned. No env key names with
 * values, account fingerprints, or raw cache payloads are emitted —
 * the resolved projection is already non-secret.
 *
 * Trust tier: guest (everyone can discover).
 * Impact: read-only.
 * Category: meta.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { ResolvedCatalogModel } from "@nautilo/trust";
import {
  listResolvedCatalogModels,
} from "../../config/resolved-catalog";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_QUERY_LEN = 200;
const MAX_MODEL_ID_LEN = 200;
const MAX_PROVIDER_LEN = 64;
const WORKLOADS = ["chat", "generation", "decision"] as const;
const OUTPUT_MODALITIES = ["text", "image", "audio", "video", "embedding"] as const;
const GENERATION_FAMILIES = ["image", "video", "music"] as const;
const REFERENCE_ROLES = ["image", "video", "audio"] as const;

type DiscoverModelsCommand = "list" | "search" | "get";

export interface DiscoverModelsContext {
  /** Override the credential environment (tests / server injection). */
  env?: NodeJS.ProcessEnv;
  allowChinaUpstream?: boolean;
}

interface ListSearchResponse {
  items: ResolvedCatalogModel[];
  totalMatched: number;
  offset: number;
  limit: number;
  truncated: boolean;
  nextOffset: number | null;
}

interface GetFoundResponse {
  found: true;
  model: ResolvedCatalogModel;
}

interface GetNotFoundResponse {
  found: false;
  model_id: string;
  reason: string;
}

function clampLimit(value: number | undefined): number {
  const n = value ?? DEFAULT_LIMIT;
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  const rounded = Math.trunc(n);
  if (rounded < MIN_LIMIT) return MIN_LIMIT;
  if (rounded > MAX_LIMIT) return MAX_LIMIT;
  return rounded;
}

function clampOffset(value: number | undefined): number {
  const n = value ?? 0;
  if (!Number.isFinite(n)) return 0;
  const rounded = Math.trunc(n);
  return rounded < 0 ? 0 : rounded;
}

function capText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Compact, non-secret projection of a resolved catalog row. The
 * `ResolvedCatalogModel` is already non-secret by construction (no env keys,
 * no account fingerprints, no raw cache payloads), so this is a verbatim
 * pass-through with the optional `unavailableReason` normalized away when
 * absent. Kept as an explicit function so the no-secret contract has one
 * named seam to audit.
 */
function projectRow(row: ResolvedCatalogModel): ResolvedCatalogModel {
  const { unavailableReason, ...rest } = row;
  return unavailableReason === undefined ? rest : { ...rest, unavailableReason };
}

function matchesQuery(row: ResolvedCatalogModel, query: string): boolean {
  const lower = query.toLowerCase();
  return (
    row.id.toLowerCase().includes(lower) ||
    row.displayName.toLowerCase().includes(lower) ||
    row.provider.toLowerCase().includes(lower)
  );
}

function matchesProvider(row: ResolvedCatalogModel, provider: string): boolean {
  return row.provider.toLowerCase() === provider.toLowerCase();
}

function matchesCapabilityFilters(
  row: ResolvedCatalogModel,
  filters: {
    runnableOnly?: boolean | undefined;
    requiresTools?: boolean | undefined;
    requiresVision?: boolean | undefined;
    requiresFileInput?: boolean | undefined;
    requiresReasoning?: boolean | undefined;
    requiresVisualGrounding?: boolean | undefined;
    workload?: (typeof WORKLOADS)[number] | undefined;
    output?: (typeof OUTPUT_MODALITIES)[number] | undefined;
    generationFamily?: (typeof GENERATION_FAMILIES)[number] | undefined;
    requiresReferenceRole?: (typeof REFERENCE_ROLES)[number] | undefined;
  },
): boolean {
  if (filters.runnableOnly && row.availability !== "selectable") return false;
  // Unknown (null) never satisfies a positive requires_*: true .
  if (filters.requiresTools && row.features.tools !== true) return false;
  if (filters.requiresReasoning && row.features.reasoning !== true) return false;
  if (filters.requiresVisualGrounding && row.features.visualGrounding !== true) return false;
  if (filters.requiresVision && !row.input.includes("image")) return false;
  if (filters.requiresFileInput && !row.input.includes("file")) return false;
  if (filters.workload && row.workload !== filters.workload) return false;
  if (filters.output && !row.output.includes(filters.output)) return false;
  if (filters.generationFamily && row.generation?.family !== filters.generationFamily) return false;
  // Unknown reference support is not a positive match. This is intentionally
  // stricter than absence: callers can list/get the row and see `null`.
  if (filters.requiresReferenceRole && !row.generation?.references?.roles.includes(filters.requiresReferenceRole)) {
    return false;
  }
  return true;
}

function resolveCatalogRows(context?: DiscoverModelsContext): ResolvedCatalogModel[] {
  // includeUnavailable: true so Genie can see the full curated catalog and
  // learn which rows are selectable vs missing credentials / routing-filtered.
  // listResolvedCatalogModels iterates only signed catalog rows across all
  // workloads, so dynamic openrouter:/gateway: ids never appear here.
  const options: { includeUnavailable: true; env?: NodeJS.ProcessEnv; allowChinaUpstream?: boolean } = {
    includeUnavailable: true,
  };
  if (context?.env !== undefined) options.env = context.env;
  if (context?.allowChinaUpstream !== undefined) options.allowChinaUpstream = context.allowChinaUpstream;
  return listResolvedCatalogModels(options);
}

function paginate(
  rows: readonly ResolvedCatalogModel[],
  offset: number,
  limit: number,
): ListSearchResponse {
  const totalMatched = rows.length;
  const page = rows.slice(offset, offset + limit);
  const remaining = totalMatched - (offset + page.length);
  const truncated = remaining > 0;
  return {
    items: page.map(projectRow),
    totalMatched,
    offset,
    limit,
    truncated,
    nextOffset: truncated ? offset + page.length : null,
  };
}

function malformed(message: string): string {
  return JSON.stringify({ error: "malformed_input", message });
}

export function createDiscoverModelsTool(context?: DiscoverModelsContext) {
  return new DynamicStructuredTool({
    name: "discover_models",
    description:
      "Search the resolved model catalog to find available models by " +
      "name, provider, workload, or capability. Use `list` to browse with optional " +
      "workload/capability/output/generation filters, `search` to add a text query to those " +
      "filters (AND semantics), and `get` " +
      "to fetch one curated model by its exact stable id. Results are " +
      "non-secret and bounded with explicit truncation/next offset. " +
      "Dynamic openrouter:/gateway: ids are not accepted by `get`.",
    schema: z.object({
      command: z
        .enum(["list", "search", "get"])
        .describe("Discovery command: list (browse), search (text + filters), or get (one curated id)."),
      model_id: z
        .string()
        .optional()
        .describe("Exact stable model id (required for `get`). Dynamic openrouter:/gateway: ids are rejected."),
      query: z
        .string()
        .optional()
        .describe("Case-insensitive text match against model id, display name, and provider (required for `search`)."),
      provider: z
        .string()
        .optional()
        .describe("Exact provider match (e.g. anthropic, openai, openrouter, google, venice)."),
      runnable_only: z
        .boolean()
        .optional()
        .describe("When true, only return models currently selectable (runnable + not routing-filtered)."),
      requires_tools: z
        .boolean()
        .optional()
        .describe("When true, only return models known to support tool/function calling (null capability never matches)."),
      requires_vision: z
        .boolean()
        .optional()
        .describe("When true, only return models that accept image input."),
      requires_file_input: z
        .boolean()
        .optional()
        .describe("When true, only return models that accept file input."),
      requires_reasoning: z
        .boolean()
        .optional()
        .describe("When true, only return models known to support reasoning (null capability never matches)."),
      requires_visual_grounding: z
        .boolean()
        .optional()
        .describe(
          "When true, only return models known to support grounding screenshot targets to coordinates (null capability never matches).",
        ),
      workload: z
        .enum(WORKLOADS)
        .optional()
        .describe("Only return models for this execution workload: chat, generation, or decision."),
      output: z
        .enum(OUTPUT_MODALITIES)
        .optional()
        .describe("Only return models that emit this output modality (for example `video` or `audio`)."),
      generation_family: z
        .enum(GENERATION_FAMILIES)
        .optional()
        .describe("Only return generation rows in this family (image, video, or music)."),
      requires_reference_role: z
        .enum(REFERENCE_ROLES)
        .optional()
        .describe("Only return models known to support this reference kind; unknown support never matches."),
      limit: z
        .number()
        .int()
        .optional()
        .describe(`Maximum items to return per page (1..${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
      offset: z
        .number()
        .int()
        .optional()
        .describe("Zero-based offset of the first item to return (default 0)."),
    }),
    // LangChain DynamicStructuredTool requires func to return Promise<string>;
    // this handler is synchronous (queries local/cache-backed catalog rows).
    // eslint-disable-next-line @typescript-eslint/require-await
    func: async (input): Promise<string> => {
      const command = input.command as DiscoverModelsCommand;
      const limit = clampLimit(input.limit);
      const offset = clampOffset(input.offset);
      const query = capText(input.query?.trim() || undefined, MAX_QUERY_LEN);
      const provider = capText(input.provider?.trim() || undefined, MAX_PROVIDER_LEN);
      const modelId = capText(input.model_id?.trim() || undefined, MAX_MODEL_ID_LEN);

      // Handler-level validation of command-specific required fields. The
      // top-level schema stays a flat z.object (never a discriminated union),
      // so required-ness is enforced here per §2.1 schema guidance.
      if (command === "get") {
        if (!modelId) {
          return malformed("`get` requires a non-empty `model_id`.");
        }
        // `get` only returns a curated resolved-catalog row. Dynamic
        // openrouter:/gateway: ids are NOT a v1 call surface : they
        // synthesize a config in getModelById and would otherwise resolve to
        // selectable/missing_credentials, so membership is checked against
        // the curated list (which iterates only ASSISTANT_MODELS) rather than
        // relying on the availability state.
        const curated = resolveCatalogRows(context);
        const row = curated.find((candidate) => candidate.id === modelId);
        if (!row) {
          const notFound: GetNotFoundResponse = {
            found: false,
            model_id: modelId,
            reason:
              "model id not found in the curated catalog; `get` does not accept dynamic openrouter:/gateway: ids.",
          };
          return JSON.stringify(notFound);
        }
        const found: GetFoundResponse = { found: true, model: projectRow(row) };
        return JSON.stringify(found);
      }

      if (command === "search" && !query) {
        return malformed("`search` requires a non-empty `query`.");
      }

      const filters = {
        runnableOnly: input.runnable_only,
        requiresTools: input.requires_tools,
        requiresVision: input.requires_vision,
        requiresFileInput: input.requires_file_input,
        requiresReasoning: input.requires_reasoning,
        requiresVisualGrounding: input.requires_visual_grounding,
        workload: input.workload,
        output: input.output,
        generationFamily: input.generation_family,
        requiresReferenceRole: input.requires_reference_role,
      };

      const rows = resolveCatalogRows(context).filter((row) => {
        if (query && !matchesQuery(row, query)) return false;
        if (provider && !matchesProvider(row, provider)) return false;
        if (!matchesCapabilityFilters(row, filters)) return false;
        return true;
      });

      return JSON.stringify(paginate(rows, offset, limit));
    },
  });
}
