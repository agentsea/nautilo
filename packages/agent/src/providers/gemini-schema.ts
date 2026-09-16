import { isInteropZodSchema } from "@langchain/core/utils/types";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import type { ChatModel } from "./types";

/**
 * JSON-Schema keywords that Gemini's tool-spec converter rejects with
 * `Unknown name "<keyword>" ... Cannot find field`.
 *
 * Confirmed empirically (2026-05-07 server log):
 *   - `exclusiveMinimum`
 *   - `exclusiveMaximum`
 *
 * Likely also rejected per Google's docs (kept here defensively;
 * stripping is safe — Gemini infers numeric ranges from `minimum` /
 * `maximum` alone):
 *   - `$schema`, `$id`, `$ref` (only `additionalProperties` and
 *     `$schema` are stripped by `@langchain/google-genai` itself; we
 *     extend the list).
 *   - `patternProperties`, `propertyNames`, `unevaluatedProperties`,
 *     `unevaluatedItems`, `dependentRequired`, `dependentSchemas`,
 *     `if`, `then`, `else`, `not` — Gemini's strict subset of
 *     OpenAPI 3.0 schema does not include these.
 *
 * We deliberately do NOT strip `format` (Gemini accepts a subset:
 * `enum`, `date-time`, `int32`, `int64`) — stripping could break
 * tools that depend on it, and Gemini silently ignores unknown formats
 * rather than 400-ing.
 */
export const GEMINI_INCOMPATIBLE_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "exclusiveMinimum",
  "exclusiveMaximum",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
  "not",
  "allOf",
]);

/**
 * Recursively strip Gemini-incompatible JSON Schema keywords. Pure /
 * non-mutating — returns a new object tree. Other keywords are
 * preserved (including `additionalProperties`, which Gemini's own
 * conversion drops separately — we leave that to it so we don't
 * double-strip and confuse the OpenAI/Anthropic paths).
 */
export function sanitizeJsonSchemaForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeJsonSchemaForGemini);
  }
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (GEMINI_INCOMPATIBLE_SCHEMA_KEYS.has(k)) continue;
      out[k] = sanitizeJsonSchemaForGemini(v);
    }
    return out;
  }
  return schema;
}

interface MaybeLangChainTool {
  name?: unknown;
  description?: unknown;
  schema?: unknown;
}

/**
 * Convert a LangChain `StructuredTool` (Zod-schema-based) into the
 * OpenAI tool descriptor shape, with the JSON Schema sanitized for
 * Gemini. `@langchain/google-genai` accepts both shapes via its
 * `processTools` helper (`isLangChainTool || isOpenAITool`); the
 * OpenAI-shape branch lets us inject our sanitizer between
 * `zodToJsonSchema` and the wire conversion.
 *
 * Tools that don't carry a Zod schema (already-JSON-Schema tools, or
 * Gemini-native `{ functionDeclarations: [...] }` blocks) are passed
 * through unchanged.
 */
export function convertToolToSanitizedOpenAITool(tool: unknown): unknown {
  if (!tool || typeof tool !== "object") return tool;
  const t = tool as MaybeLangChainTool;
  if (typeof t.name !== "string" || t.schema == null) return tool;

  const rawJsonSchema = isInteropZodSchema(t.schema) ? toJsonSchema(t.schema) : t.schema;
  const sanitized = sanitizeJsonSchemaForGemini(rawJsonSchema);

  return {
    type: "function",
    function: {
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      parameters: sanitized,
    },
  };
}

/**
 * Wrap a Gemini-backed `ChatModel` so that any `bindTools` call
 * pre-sanitizes tool schemas before delegating to the underlying
 * implementation. The wrapper is recursive: the bound model's own
 * `bindTools` is also wrapped (some LangChain runnables re-bind during
 * fallbacks).
 *
 * The wrap is a no-op for `invoke` — it only intercepts tool binding.
 */
export function wrapGeminiModelForToolSanitization<M extends ChatModel>(model: M): M {
  if (!model.bindTools) return model;
  const originalBindTools = model.bindTools.bind(model);
  const wrapper: ChatModel & { bound: ChatModel } = {
    invoke: model.invoke.bind(model),
    // Keep the concrete delegate observable. Callback checks must inspect the
    // actual model/binding that receives invoke(), never a copied wrapper field.
    bound: model,
    bindTools(tools, options) {
      const sanitizedTools = Array.isArray(tools) ? tools.map(convertToolToSanitizedOpenAITool) : tools;
      const bound = originalBindTools(sanitizedTools, options);
      return wrapGeminiModelForToolSanitization(bound);
    },
  };
  return wrapper as unknown as M;
}
