import { z } from "zod";
import { resolveCatalogModel } from "../config/resolved-catalog";
import { resolveProviderKey } from "../resolve-provider-key";
import { recordLlmUsage } from "../usage/record-usage";
import { getUsageContext } from "../usage/usage-context";
import {
  ChoiceRequestError,
  type ChoiceInput,
  type ChoiceResult,
} from "./choice";

export {
  ChoiceRequestError,
  type ChoiceRequestErrorCode,
} from "./choice";
export type OpenRouterChoiceInput = ChoiceInput;
export type OpenRouterChoiceResult = ChoiceResult;

interface ChoiceDependencies {
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
  readonly recordUsage?: typeof recordLlmUsage;
}

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative().optional(),
});
const answerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
});
const confidenceSchema = z.number().min(0).max(1);
const probabilitiesSchema = z.record(z.string(), z.number().min(0).max(1));
const stateSchema = z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json())]);
const nonBlankString = z.string().refine((value) => value.trim().length > 0);
const requestSchema = z.object({
  modelId: nonBlankString,
  state: stateSchema,
  instructions: nonBlankString,
  choices: z.array(z.object({ id: nonBlankString, description: nonBlankString })).nonempty(),
});
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function safeMetadataString(value: unknown, credential: string): string | undefined {
  const containsControlCharacter = typeof value === "string"
    && value.split("").some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
  if (typeof value !== "string" || value.trim().length === 0
    || value.includes(credential) || containsControlCharacter) return undefined;
  return value;
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ChoiceRequestError("cancelled");
}

/** One single-question request. Retry, deadline, and supervision belong to the caller's run. */
export async function invokeOpenRouterChoice(
  input: OpenRouterChoiceInput,
  deps: ChoiceDependencies = {},
): Promise<OpenRouterChoiceResult> {
  assertNotCancelled(input.signal);
  let request: z.infer<typeof requestSchema>;
  try {
    request = requestSchema.parse(input);
  } catch {
    throw new ChoiceRequestError("invalid_request");
  }
  const apiKey = deps.apiKey?.trim() || resolveProviderKey("openrouter", input.tenantContext)?.trim();
  // Re-resolve current catalog authority. Explicit keys take precedence without
  // changing process credentials or accepting a caller's stale availability DTO.
  const row = resolveCatalogModel(request.modelId, {
    env: { ...process.env, OPENROUTER_API_KEY: apiKey ?? "" },
  });
  if (row.provider !== "openrouter" || row.workload !== "decision"
    || row.decision?.operations.length !== 1 || row.decision.operations[0] !== "choice"
    || (row.availability !== "selectable" && row.availability !== "missing_credentials")) {
    throw new ChoiceRequestError("unsupported_model");
  }
  if (!apiKey || row.availability === "missing_credentials") {
    throw new ChoiceRequestError("missing_credentials");
  }
  const ids = new Set(request.choices.map((choice) => choice.id));
  if (request.choices.length > row.decision.maxChoices || ids.size !== request.choices.length) {
    throw new ChoiceRequestError("invalid_request");
  }
  let body: string;
  try {
    // Keep all state/candidates. The provider enforces its token bound with its
    // own tokenizer; local estimates must not silently truncate the request.
    body = JSON.stringify({
      model: row.id.slice("openrouter:".length),
      state: request.state,
      questions: { candidate: {
        type: "choice",
        instructions: request.instructions,
        criteria: Object.fromEntries(request.choices.map(({ id, description }) => [id, description])),
      } },
    });
  } catch {
    throw new ChoiceRequestError("invalid_request");
  }
  assertNotCancelled(input.signal);
  let response: Response;
  try {
    response = await (deps.fetch ?? globalThis.fetch)("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body,
      signal: input.signal,
    });
  } catch {
    assertNotCancelled(input.signal);
    throw new ChoiceRequestError("network_error", null, true);
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    assertNotCancelled(input.signal);
    throw new ChoiceRequestError("provider_error", response.status,
      [429, 500, 502, 503, 524, 529].includes(response.status));
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    assertNotCancelled(input.signal);
    throw new ChoiceRequestError("invalid_response");
  }
  const envelope = object(payload);
  const usage = usageSchema.safeParse(envelope?.["usage"]);
  if (!usage.success) {
    assertNotCancelled(input.signal);
    throw new ChoiceRequestError("invalid_response");
  }
  const responseModel = z.string().safeParse(envelope?.["model"]);
  const safeResponseModel = responseModel.success
    ? safeMetadataString(responseModel.data, apiKey) : undefined;
  const provider = safeMetadataString(envelope?.["provider"], apiKey);
  const responseId = safeMetadataString(envelope?.["id"], apiKey);
  const ambient = getUsageContext();
  // Record the one readable usage envelope even for an invalid answer or late
  // cancellation. No synthetic usage or second provider-cost ledger entry.
  (deps.recordUsage ?? recordLlmUsage)({
    model: row.id,
    callType: ambient?.callType ?? "other",
    userId: ambient?.userId ?? null,
    roomId: ambient?.roomId ?? null,
    inputTokens: usage.data.input_tokens,
    outputTokens: usage.data.output_tokens,
    totalTokens: usage.data.input_tokens + usage.data.output_tokens,
    ...(usage.data.cost === undefined ? {} : { actualCostUsd: usage.data.cost }),
    metadata: {
      ...ambient?.metadata,
      operation: "choice",
      ...(safeResponseModel === undefined ? {} : { resolvedProviderModel: safeResponseModel }),
      ...(provider === undefined ? {} : { providerRoute: provider }),
      ...(responseId === undefined ? {} : { providerResponseId: responseId }),
    },
  });
  assertNotCancelled(input.signal);
  const answerObject = object(object(envelope?.["answers"])?.["candidate"]);
  const answer = answerSchema.safeParse(answerObject);
  if (!responseModel.success || !answer.success || !ids.has(answer.data.choice)) {
    throw new ChoiceRequestError("invalid_response");
  }
  // Optional provider metadata is observational only. It neither authorizes
  // the selected choice nor invalidates an otherwise usable in-set answer.
  const confidence = confidenceSchema.safeParse(answerObject?.["confidence"]);
  const probabilities = probabilitiesSchema.safeParse(answerObject?.["probabilities"]);
  return {
    selectedId: answer.data.choice,
    requestedModelId: row.id,
    resolvedModelId: safeResponseModel ?? null,
    ...(provider === undefined ? {} : { provider }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(confidence.success ? { confidence: confidence.data } : {}),
    ...(probabilities.success ? { probabilities: probabilities.data } : {}),
    usage: {
      inputTokens: usage.data.input_tokens,
      outputTokens: usage.data.output_tokens,
      actualCostUsd: usage.data.cost ?? null,
    },
  };
}
