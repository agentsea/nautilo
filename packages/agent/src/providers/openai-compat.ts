import {
  ChatOpenAICompletions,
  ChatOpenAIResponses,
  convertMessagesToResponsesInput,
  convertResponsesMessageToAIMessage,
  convertResponsesDeltaToChatGenerationChunk,
} from "@langchain/openai";
import { AIMessage } from "@langchain/core/messages";

type InvocationOptions = Parameters<ChatOpenAICompletions["invocationParams"]>[0];
type InvocationExtra = Parameters<ChatOpenAICompletions["invocationParams"]>[1];

const TOOL_INVOCATION_IDENTITY_KEY = "nautilo_tool_invocations";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

/**
 * Project admitted canonical IDs onto OpenAI's request wire without mutating
 * messages or checkpoints. Function/custom calls drop stale provider item IDs.
 * Native computer calls are the exception: OpenAI requires their provider item
 * ID and requires the output to reference the original provider call_id, so both
 * sides of that pair are restored from preserved metadata at this boundary.
 */
function convertCanonicalResponsesInput(
  params: Parameters<typeof convertMessagesToResponsesInput>[0],
): ReturnType<typeof convertMessagesToResponsesInput> {
  const providerIds = new Map<string, unknown>();
  const computerDetails = new Map<string, RecordValue>();
  const admittedIds = new Set(params.messages.flatMap((message) => {
    if (!AIMessage.isInstance(message)) return [];
    const identity = record(message.additional_kwargs[TOOL_INVOCATION_IDENTITY_KEY]);
    if (identity?.["version"] !== 1 || !Array.isArray(identity["calls"])) return [];
    const bindings = identity["calls"].map(record);
    for (const binding of bindings) {
      const id = binding?.["id"];
      if (typeof id === "string") providerIds.set(id, binding?.["providerId"]);
    }
    for (const value of message.tool_calls ?? []) {
      const call = record(value);
      if (call?.["isComputerTool"] === true && typeof call["id"] === "string") {
        computerDetails.set(call["id"], call);
      }
    }
    return bindings.flatMap((binding) => {
      const id = binding?.["id"];
      return typeof id === "string" ? [id] : [];
    });
  }));
  const input = convertMessagesToResponsesInput(params);
  if (admittedIds.size === 0) return input;
  const computerProviderIds = new Map<string, string>();
  const canonicalIdsByProvider = new Map<string, string>();
  for (const value of input) {
    if (!("type" in value) || value.type !== "computer_call"
      || !admittedIds.has(value.call_id)) continue;
    const providerId = providerIds.get(value.call_id);
    if (typeof providerId !== "string" || providerId.trim() === "") {
      throw new Error("Admitted OpenAI computer call is missing its provider call ID");
    }
    const existingCanonicalId = canonicalIdsByProvider.get(providerId);
    if (existingCanonicalId !== undefined && existingCanonicalId !== value.call_id) {
      throw new Error("Ambiguous admitted OpenAI computer call provider ID");
    }
    canonicalIdsByProvider.set(providerId, value.call_id);
    computerProviderIds.set(value.call_id, providerId);
  }
  return input.map((value) => {
    if (!("type" in value) || !("call_id" in value)
      || typeof value.call_id !== "string") return value;
    if (value.type === "computer_call" && admittedIds.has(value.call_id)) {
      const providerId = computerProviderIds.get(value.call_id);
      const details = computerDetails.get(value.call_id);
      const id = typeof value.id === "string" && value.id.trim() !== ""
        ? value.id : details?.["call_id"];
      const status = value.status ?? details?.["status"];
      const pendingSafetyChecks = value.pending_safety_checks ?? details?.["pending_safety_checks"];
      if (providerId === undefined || typeof id !== "string" || id.trim() === ""
        || (status !== "in_progress" && status !== "completed" && status !== "incomplete")
        || !Array.isArray(pendingSafetyChecks)) {
        throw new Error("Admitted OpenAI computer call is missing required provider metadata");
      }
      return {
        ...value,
        id,
        call_id: providerId,
        status,
        pending_safety_checks: pendingSafetyChecks,
      };
    }
    if (value.type === "computer_call_output") {
      const providerId = computerProviderIds.get(value.call_id);
      return providerId === undefined ? value : { ...value, call_id: providerId };
    }
    if ((value.type === "function_call" || value.type === "custom_tool_call")
      && admittedIds.has(value.call_id)) {
      const projected = { ...value };
      Reflect.deleteProperty(projected, "id");
      return projected;
    }
    return value;
  });
}

export function isDirectGpt6Model(modelId: string): boolean {
  return /^openai:gpt-(?:6-(?:astra|sol|luna)|6\.1-sol)$/.test(modelId);
}

/**
 * The installed LangChain release recognizes GPT-5 and o-series reasoning
 * models, but not GPT-6. OpenAI rejects `max_tokens` for GPT-6 and requires
 * `max_completion_tokens`; preserve Chat Completions while correcting that
 * one provider-wire classification at the shared adapter boundary.
 */
export class OpenAIGpt6Completions extends ChatOpenAICompletions {
  override invocationParams(options?: InvocationOptions, extra?: InvocationExtra) {
    const params = super.invocationParams(options, extra);
    if (/^gpt-6(?:[.-]|$)/i.test(this.model)) {
      if (typeof this.maxTokens === "number" && this.maxTokens !== -1) {
        params.max_completion_tokens = this.maxTokens;
      } else {
        delete params.max_completion_tokens;
      }
      delete params.max_tokens;
    }
    return params;
  }
}

/** Preserve usage and scoped request fields omitted by the installed Responses adapter. */
export class OpenAIUsageResponses extends ChatOpenAIResponses {
  override invocationParams(
    options?: Parameters<ChatOpenAIResponses["invocationParams"]>[0],
  ): ReturnType<ChatOpenAIResponses["invocationParams"]> {
    const params = super.invocationParams(options);
    // The installed serializer handles named choices but drops these standard
    // string choices. Keep the caller's tool policy on direct GPT-6 requests.
    if (isDirectGpt6Model(`openai:${this.model}`)
      && (options?.tool_choice === "auto" || options?.tool_choice === "none" || options?.tool_choice === "required")) {
      params.tool_choice = options.tool_choice;
    }
    return params;
  }

  override async *_streamResponseChunks(
    messages: Parameters<ChatOpenAIResponses["_streamResponseChunks"]>[0],
    options: Parameters<ChatOpenAIResponses["_streamResponseChunks"]>[1],
    runManager?: Parameters<ChatOpenAIResponses["_streamResponseChunks"]>[2],
  ) {
    const stream = await this.completionWithRetry({
      ...this.invocationParams(options),
      input: convertCanonicalResponsesInput({
        messages,
        zdrEnabled: this.zdrEnabled ?? false,
        model: this.model,
      }),
      stream: true,
    }, options);
    for await (const event of stream) {
      options.signal?.throwIfAborted();
      // The installed converter only retains terminal metadata for completed
      // events. Reuse that conversion for incomplete responses while preserving
      // their actual status and reason; never turn partial output into success.
      const chunk = convertResponsesDeltaToChatGenerationChunk(event.type === "response.incomplete"
        ? { ...event, type: "response.completed" } : event);
      if (chunk === null) continue;
      yield chunk;
      await runManager?.handleLLMNewToken(chunk.text || "", {
        prompt: options.promptIndex ?? 0, completion: 0,
      }, undefined, undefined, undefined, { chunk });
    }
    options.signal?.throwIfAborted();
  }

  override async _generate(
    messages: Parameters<ChatOpenAIResponses["_generate"]>[0],
    options: Parameters<ChatOpenAIResponses["_generate"]>[1],
    runManager?: Parameters<ChatOpenAIResponses["_generate"]>[2],
  ) {
    options.signal?.throwIfAborted();
    const params = this.invocationParams(options);
    // The streaming adapter already retains raw usage on response.completed.
    if (params.stream) return super._generate(messages, options, runManager);
    const response = await this.completionWithRetry({
      input: convertCanonicalResponsesInput({
        messages,
        zdrEnabled: this.zdrEnabled ?? false,
        model: this.model,
      }),
      ...params,
      stream: false,
    }, { signal: options.signal, ...options.options });
    const message = convertResponsesMessageToAIMessage(response);
    if (response.usage) message.response_metadata["usage"] = response.usage;
    return {
      generations: [{ text: response.output_text, message }],
      llmOutput: {
        id: response.id,
        ...(response.usage ? { tokenUsage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.total_tokens,
        } } : {}),
      },
    };
  }
}
