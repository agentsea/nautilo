import { z } from "zod";
import { getCachedServerModelConfigRow, kickServerModelConfigRefresh } from "@nautilo/db";
import { VENICE_DECISIONS_URL } from "./venice-api";
import { resolveCatalogModel } from "../config/resolved-catalog";
import { resolveProviderKey } from "../resolve-provider-key";
import { recordLlmUsage } from "../usage/record-usage";
import { getUsageContext, runWithUsageContext } from "../usage/usage-context";
import {
  PersonalAttemptInvocationError,
  runPersonalLlmAttempt,
} from "../usage/personal-llm-attempt";
import { ChoiceRequestError } from "./choice";
import {
  assertCanUseServerProviderCredentials,
  ServerProviderCredentialsDeniedError,
  type ServerProviderCredentialOrigin,
} from "@nautilo/trust";
import { causalHumanForExecution } from "../runtime/causal-human-context";

import { decisionStateSchema, decisionQuestionsSchema, type DecisionInput, type DecisionReceipt, type DecisionQuestion } from "./decision";
import { isSupportedChoiceProvider } from "./choice-provider-support";
import {
  invokeSurplusDecisionAttempt,
  SurplusDecisionDirectFallbackError,
  SurplusDecisionHttpError,
} from "./surplus-decision-attempt";
import {
  resolveQualifiedSurplusDecisionRoute,
  resolveSurplusDecisionServingAvailability,
  type QualifiedSurplusDecisionRoute,
} from "./surplus-decision-route";
import { readSurplusWireReceipt, SurplusOutcomeUnknownError } from "./surplus-transport";
import {
  isAdmittedDecisionFundingAttempt,
  type AdmittedDecisionFundingAttempt,
} from "./decision-funding";

export interface DecisionDependencies {
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
  readonly recordUsage?: typeof recordLlmUsage;
  readonly fundingHumanUserId?: string;
  readonly assertCanUseServerProviderCredentials?: typeof assertCanUseServerProviderCredentials;
  /** Exact admitted wire. Omission preserves the historical direct-server path. */
  readonly providerRoute?: "direct" | "surplus";
  /** Pure route seam for narrowed transport tests. */
  readonly surplusRoute?: QualifiedSurplusDecisionRoute;
  readonly runPersonalAttempt?: typeof runPersonalLlmAttempt;
  readonly runSurplusAttempt?: typeof invokeSurplusDecisionAttempt;
  /** Test seam; production uses the current server serving preference. */
  readonly preferSurplus?: boolean;
  /** Opaque authority minted only inside an admitted funding-session attempt. */
  readonly admittedFundingAttempt?: AdmittedDecisionFundingAttempt;
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
interface DecisionTransportResponse {
  readonly receipt: DecisionReceipt;
  readonly answers: unknown;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  readonly hasResponseModel: boolean;
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
export async function requestDecisions<T>(
  input: DecisionInput,
  deps: DecisionDependencies,
  finalize: (response: DecisionTransportResponse) => T,
): Promise<T> {
  return runWithUsageContext({
    ...getUsageContext(),
    callType: "decision",
  }, () => requestDecisionsWithUsage(input, deps, finalize));
}

async function requestDecisionsWithUsage<T>(
  input: DecisionInput,
  deps: DecisionDependencies,
  finalize: (response: DecisionTransportResponse) => T,
): Promise<T> {
  const complete = finalize;
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
  if (deps.providerRoute === undefined) kickServerModelConfigRefresh();
  const preferredSurplus = deps.providerRoute === undefined
    ? resolveSurplusDecisionServingAvailability({
        catalogModelId: request.modelId,
        policyEnabled: deps.preferSurplus ?? getCachedServerModelConfigRow()?.preferSurplus === true,
        keyConfigured: resolveProviderKey("surplus", input.tenantContext) !== null,
      })
    : null;
  const providerRoute = deps.providerRoute
    ?? (preferredSurplus?.status === "available" ? "surplus" : "direct");
  const surplusRoute = providerRoute === "surplus"
    ? deps.surplusRoute ?? resolveQualifiedSurplusDecisionRoute(request.modelId)
    : null;
  if (providerRoute === "surplus" && !surplusRoute) throw new ChoiceRequestError("unsupported_model");
  const ambient = getUsageContext();
  const admitted = isAdmittedDecisionFundingAttempt(deps.admittedFundingAttempt)
    ? deps.admittedFundingAttempt
    : null;
  const expectedFundingRoute = providerRoute === "surplus" ? "surplus" : providerName;
  const admittedMatchesContext = admitted !== null
    && admitted.providerRoute === providerRoute
    && ambient?.funding === admitted.usageFunding
    && admitted.usageFunding.providerRoute === expectedFundingRoute;
  const ambientIsPersonal = ambient?.funding?.kind === "personal";
  if (admitted !== null && !admittedMatchesContext) {
    throw new ChoiceRequestError("missing_credentials");
  }
  if (ambientIsPersonal && (!admittedMatchesContext
    || admitted?.usageFunding.kind !== "personal"
    || !admitted.personalApiKey?.trim()
    || deps.apiKey?.trim() !== admitted.personalApiKey.trim())) {
    throw new ChoiceRequestError("missing_credentials");
  }
  if (!ambientIsPersonal && admitted?.usageFunding.kind === "personal") {
    throw new ChoiceRequestError("missing_credentials");
  }
  const apiKey = ambientIsPersonal
    ? admitted!.personalApiKey!.trim()
    : (providerRoute === "direct" ? deps.apiKey?.trim() : undefined)
      || resolveProviderKey(providerRoute === "surplus" ? "surplus" : providerName, input.tenantContext)?.trim();
  const row = resolveCatalogModel(request.modelId, {
    env: providerRoute === "direct"
      ? { ...process.env, [transport.envKey]: apiKey ?? "" }
      : process.env,
  });
  if (row.provider !== providerName || row.workload !== "decision" || !row.decision
    || (row.availability !== "selectable" && row.availability !== "missing_credentials"))
    throw new ChoiceRequestError("unsupported_model");
  if (!apiKey || (providerRoute === "direct" && row.availability === "missing_credentials")) {
    throw new ChoiceRequestError("missing_credentials");
  }
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
  const requestedProviderModelId = surplusRoute?.surplusModelId ?? row.id.slice(providerName.length + 1);
  try {
    // Keep all state/candidates. The provider enforces its token bound with its
    // own tokenizer; local estimates must not silently truncate the request.
    body = JSON.stringify({
      model: requestedProviderModelId,
      state: request.state,
      questions: request.questions,
      ...(surplusRoute ? { provider: surplusRoute.providerPin } : {}),
    });
  } catch {
    throw new ChoiceRequestError("invalid_request");
  }
  assertNotCancelled(input.signal);
  let admittedServerHumanId: string | null = null;
  if (admitted === null) {
    const fundingHumanUserId = causalHumanForExecution(deps.fundingHumanUserId);
    if (!fundingHumanUserId) {
      throw new ServerProviderCredentialsDeniedError("", DECISION_FUNDING_ORIGIN);
    }
    await (deps.assertCanUseServerProviderCredentials
      ?? assertCanUseServerProviderCredentials)(fundingHumanUserId, DECISION_FUNDING_ORIGIN);
    admittedServerHumanId = fundingHumanUserId;
  }

  type Parsed = {
    value: {
      receipt: DecisionReceipt;
      answers: unknown;
      questions: Readonly<Record<string, DecisionQuestion>>;
      hasResponseModel: boolean;
    };
    inputTokens: number;
    outputTokens: number;
  };
  const parseResponse = async (response: Response): Promise<Parsed> => {
    if (!response.ok) {
      const errorPayload: unknown = await response.json().catch(() => null);
      assertNotCancelled(input.signal);
      if (providerRoute === "surplus") throw new SurplusDecisionHttpError(response.status, errorPayload);
      if (contextCapacityExceeded(errorPayload)) {
        throw new ChoiceRequestError("context_length_exceeded", response.status);
      }
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
    const acceptedSurplusModelIds = surplusRoute
      ? new Set([
          surplusRoute.surplusModelId,
          surplusRoute.surplusModelId.slice(surplusRoute.surplusModelId.lastIndexOf("/") + 1),
        ].map((value) => value.toLowerCase()))
      : null;
    const isDocumentedOpenRouterModelIdentity = responseModel.success
      && (providerName !== "openrouter"
        || responseModel.data === requestedProviderModelId
        || responseModel.data.match(new RegExp(`^${requestedProviderModelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{8}$`)) !== null);
    const hasExactResponseRoute = responseModel.success
      && (acceptedSurplusModelIds === null
        ? isDocumentedOpenRouterModelIdentity
        : (acceptedSurplusModelIds.has(responseModel.data.toLowerCase())
          && (provider === undefined || provider.toLowerCase() === surplusRoute?.providerPin)));
    const surplusCostMicro = providerRoute === "surplus"
      ? readSurplusWireReceipt(response.headers).buyerCostMicro
      : undefined;
    const actualCostUsd = providerRoute === "surplus"
      ? surplusCostMicro === undefined ? null : surplusCostMicro / 1_000_000
      : usage.data.cost ?? null;
    return {
      inputTokens: usage.data.input_tokens,
      outputTokens: usage.data.output_tokens,
      value: {
        answers: envelope?.["answers"],
        questions: request.questions,
        hasResponseModel: hasExactResponseRoute,
        receipt: {
          requestedModelId: row.id,
          resolvedModelId: safeResponseModel ?? null,
          ...(provider === undefined ? {} : { provider }),
          ...(responseId === undefined ? {} : { responseId }),
          usage: {
            inputTokens: usage.data.input_tokens,
            outputTokens: usage.data.output_tokens,
            actualCostUsd,
          },
        },
      },
    };
  };

  if (providerRoute === "surplus" && surplusRoute) {
    const funding = admitted?.usageFunding
      ?? (admittedServerHumanId === null ? null : {
        kind: "server" as const,
        humanUserId: admittedServerHumanId,
        providerRoute: "surplus" as const,
      });
    if (!funding) throw new ChoiceRequestError("missing_credentials");
    try {
      return await (deps.runSurplusAttempt ?? invokeSurplusDecisionAttempt)({
        route: surplusRoute,
        apiKey,
        body,
        signal: input.signal,
        funding,
        ...(deps.fetch === undefined ? {} : { fetchImpl: deps.fetch }),
        parse: async (response) => {
          const parsed = await parseResponse(response);
          return {
            inputTokens: parsed.inputTokens,
            outputTokens: parsed.outputTokens,
            finalize: () => complete(parsed.value),
          };
        },
      });
    } catch (error) {
      if (input.signal.aborted) throw error;
      const fallback = error instanceof SurplusDecisionDirectFallbackError
        || error instanceof SurplusOutcomeUnknownError
        || (error instanceof SurplusDecisionHttpError && error.status >= 500)
        || (error instanceof ChoiceRequestError
          && ["invalid_response", "network_error", "provider_error"].includes(error.code));
      if (!fallback) throw error;
      // Explicit routes are owned by the funding session. Signal that session
      // so it can re-admit the same payer/model on its direct rail.
      if (deps.providerRoute !== undefined) throw new SurplusDecisionDirectFallbackError();
      return requestDecisions(input, { ...deps, providerRoute: "direct" }, finalize);
    }
  }

  const invokeDirect = async () => {
    let response: Response;
    try {
      response = await (deps.fetch ?? globalThis.fetch)(transport.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        signal: input.signal,
      });
    } catch {
      assertNotCancelled(input.signal);
      throw new ChoiceRequestError("network_error", null, true);
    }
    const parsed = await parseResponse(response);
    const current = getUsageContext();
    const usageEvidence = {
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      totalTokens: parsed.inputTokens + parsed.outputTokens,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      actualCostUsd: parsed.value.receipt.usage.actualCostUsd,
      ...(parsed.value.receipt.responseId === undefined
        ? {}
        : { providerRequestId: parsed.value.receipt.responseId }),
    };
    if (current?.trackedAttemptId) {
      current.onAttemptUsage?.(usageEvidence);
    } else {
      (deps.recordUsage ?? recordLlmUsage)({
        model: row.id,
        callType: "decision",
        userId: current?.userId ?? null,
        roomId: current?.roomId ?? null,
        ...(typeof current?.metadata?.["taskId"] === "string"
          && current.metadata["taskId"].trim().length > 0
          ? { taskId: current.metadata["taskId"].trim() }
          : {}),
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        totalTokens: parsed.inputTokens + parsed.outputTokens,
        ...(parsed.value.receipt.usage.actualCostUsd === null
          ? {}
          : { actualCostUsd: parsed.value.receipt.usage.actualCostUsd }),
        ...(current?.funding === undefined ? {} : { funding: current.funding }),
        metadata: {
          ...current?.metadata,
          operation: questions.length === 1 ? questions[0]!.type : "decision",
          ...(parsed.value.receipt.resolvedModelId === null
            ? {}
            : { resolvedProviderModel: parsed.value.receipt.resolvedModelId }),
          ...(parsed.value.receipt.provider === undefined
            ? {}
            : { providerRoute: parsed.value.receipt.provider }),
          ...(parsed.value.receipt.responseId === undefined
            ? {}
            : { providerResponseId: parsed.value.receipt.responseId }),
        },
      });
    }
    assertNotCancelled(input.signal);
    return complete(parsed.value);
  };

  try {
    return await (deps.runPersonalAttempt ?? runPersonalLlmAttempt)({
      modelId: row.id,
      endpoint: transport.endpoint,
      signal: input.signal,
      invoke: invokeDirect,
    });
  } catch (error) {
    if (error instanceof PersonalAttemptInvocationError
      && error.cause instanceof ChoiceRequestError
      && (error.disposition === "safe_refusal" || error.cause.code === "cancelled")) {
      throw error.cause;
    }
    throw error;
  }
}
