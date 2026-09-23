import { z } from "zod";
import { VENICE_DECISIONS_URL } from "./venice-api";
import { resolveCatalogModel } from "../config/resolved-catalog";
import { resolveProviderKey } from "../resolve-provider-key";
import { recordLlmUsage } from "../usage/record-usage";
import { getUsageContext } from "../usage/usage-context";
import { ChoiceRequestError } from "./choice";
import {
  assertCanUseServerProviderCredentials,
  ServerProviderCredentialsDeniedError,
  type ServerProviderCredentialOrigin,
} from "@nautilo/trust";
import { causalHumanForExecution } from "../runtime/causal-human-context";

import { decisionStateSchema, decisionQuestionsSchema, type DecisionInput, type DecisionReceipt, type DecisionQuestion } from "./decision";
import { isSupportedChoiceProvider } from "./choice-provider-support";

export interface DecisionDependencies {
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
  readonly recordUsage?: typeof recordLlmUsage;
  readonly fundingHumanUserId?: string;
  readonly assertCanUseServerProviderCredentials?: typeof assertCanUseServerProviderCredentials;
}
const DECISION_FUNDING_ORIGIN: ServerProviderCredentialOrigin = "decision_model";
const TRANSPORTS = {
  openrouter: { endpoint: "https://openrouter.ai/api/alpha/decisions", envKey: "OPENROUTER_API_KEY" },
  typesafe: { endpoint: "https://api.typesafe.ai/v1/systemone", envKey: "TYPESAFE_API_KEY" },
  venice: { endpoint: VENICE_DECISIONS_URL, envKey: "VENICE_API_KEY" },
} as const;
export type DecisionProvider = keyof typeof TRANSPORTS;
export function decisionProvider(value: string): DecisionProvider | null {
  return isSupportedChoiceProvider(value) ? value.toLowerCase() as DecisionProvider : null;
}
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative().optional(),
});
const nonBlankString = z.string().refine((value) => value.trim().length > 0);
const requestSchema = z.object({
  modelId: nonBlankString,
  state: decisionStateSchema,
  questions: decisionQuestionsSchema,
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

/** Recognize structured context errors without retaining provider bodies or echoed data. */
function contextCapacityExceeded(payload: unknown): boolean {
  const envelope = object(payload);
  if (object(envelope?.["detail"])?.["error_type"] === "max_tokens_exceeded") return true;
  const error = object(envelope?.["error"]);
  if (error?.["code"] === "context_length_exceeded") return true;
  const message = error?.["message"];
  if (typeof message !== "string") return false;
  // OpenRouter wraps the upstream JSON detail in its HTTP diagnostic string.
  const wrapped = /^HTTP \d+: (\{.*\})$/s.exec(message);
  if (!wrapped?.[1]) return false;
  try { return object(object(JSON.parse(wrapped[1]))?.["detail"])?.["error_type"] === "max_tokens_exceeded"; }
  catch { return false; }
}

/** One provider evaluation. Retry, deadline, and supervision belong to the caller. */
export async function requestDecisions(
  input: DecisionInput,
  deps: DecisionDependencies = {},
): Promise<{ receipt: DecisionReceipt; answers: unknown; questions: Readonly<Record<string, DecisionQuestion>>; hasResponseModel: boolean }> {
  assertNotCancelled(input.signal);
  let request: z.infer<typeof requestSchema>;
  try {
    request = requestSchema.parse(input);
  } catch {
    throw new ChoiceRequestError("invalid_request");
  }
  const providerName = decisionProvider(request.modelId.split(":")[0] ?? "");
  if (!providerName) throw new ChoiceRequestError("unsupported_model");
  const transport = TRANSPORTS[providerName];
  const apiKey = deps.apiKey?.trim() || resolveProviderKey(providerName, input.tenantContext)?.trim();
  const row = resolveCatalogModel(request.modelId, {
    env: { ...process.env, [transport.envKey]: apiKey ?? "" },
  });
  if (row.provider !== providerName || row.workload !== "decision" || !row.decision
    || (row.availability !== "selectable" && row.availability !== "missing_credentials"))
    throw new ChoiceRequestError("unsupported_model");
  if (!apiKey || row.availability === "missing_credentials") throw new ChoiceRequestError("missing_credentials");
  const questions = Object.values(request.questions);
  if (questions.length > 1 && !row.decision.supportsMultipleQuestions)
    throw new ChoiceRequestError("invalid_request");
  for (const question of questions) {
    if (!row.decision.operations.includes(question.type)) throw new ChoiceRequestError("unsupported_model");
    if (question.type === "choice" && Object.keys(question.criteria).length > row.decision.maxChoices)
      throw new ChoiceRequestError("invalid_request");
    if (question.type === "score" && (row.decision.maxScoreLevels === undefined
      || question.criteria.length > row.decision.maxScoreLevels)) throw new ChoiceRequestError("invalid_request");
  }
  let body: string;
  try {
    // Keep all state/candidates. The provider enforces its token bound with its
    // own tokenizer; local estimates must not silently truncate the request.
    body = JSON.stringify({
      model: row.id.slice(providerName.length + 1),
      state: request.state,
      questions: request.questions,
    });
  } catch {
    throw new ChoiceRequestError("invalid_request");
  }
  assertNotCancelled(input.signal);
  const fundingHumanUserId = causalHumanForExecution(deps.fundingHumanUserId);
  if (!fundingHumanUserId) {
    throw new ServerProviderCredentialsDeniedError("", DECISION_FUNDING_ORIGIN);
  }
  await (deps.assertCanUseServerProviderCredentials
    ?? assertCanUseServerProviderCredentials)(
      fundingHumanUserId,
      DECISION_FUNDING_ORIGIN,
    );
  assertNotCancelled(input.signal);
  let response: Response;
  try {
    response = await (deps.fetch ?? globalThis.fetch)(transport.endpoint, {
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
    const errorPayload: unknown = await response.json().catch(() => null);
    assertNotCancelled(input.signal);
    if (contextCapacityExceeded(errorPayload)) throw new ChoiceRequestError("context_length_exceeded", response.status);
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
      operation: questions.length === 1 ? questions[0]!.type : "decision",
      ...(safeResponseModel === undefined ? {} : { resolvedProviderModel: safeResponseModel }),
      ...(provider === undefined ? {} : { providerRoute: provider }),
      ...(responseId === undefined ? {} : { providerResponseId: responseId }),
    },
  });
  assertNotCancelled(input.signal);
  return {
    answers: envelope?.["answers"],
    questions: request.questions,
    hasResponseModel: responseModel.success,
    receipt: {
      requestedModelId: row.id,
      resolvedModelId: safeResponseModel ?? null,
      ...(provider === undefined ? {} : { provider }),
      ...(responseId === undefined ? {} : { responseId }),
      usage: {
        inputTokens: usage.data.input_tokens,
        outputTokens: usage.data.output_tokens,
        actualCostUsd: usage.data.cost ?? null,
      },
    },
  };
}
