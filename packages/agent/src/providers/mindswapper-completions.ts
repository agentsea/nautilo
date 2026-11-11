import {
  ChatOpenAICompletions,
  convertCompletionsDeltaToBaseMessageChunk,
  convertCompletionsMessageToBaseMessage,
} from "@langchain/openai";
import type { MindSwapperChatOffer } from "../config/mindswapper-models";

type ChatDelta = Parameters<typeof convertCompletionsDeltaToBaseMessageChunk>[0];
type ChatCompletion = Parameters<typeof convertCompletionsMessageToBaseMessage>[0];
type WireRecord = Record<string, unknown>;

const NON_PROMPT_FIELDS = new Set(["model", "stream", "stream_options", "n", "max_tokens", "max_completion_tokens",
  "gateway_context", "temperature", "top_p", "seed", "stop", "parallel_tool_calls"]);
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MindSwapperRequestErrorCode = "authentication_error" | "insufficient_balance" | "unsupported_request"
  | "no_eligible_supply" | "rate_limit_error" | "outcome_unknown" | "context_length_exceeded" | "invalid_endpoint";

export class MindSwapperRequestError extends Error {
  readonly provider = "mindswapper";

  constructor(
    message: string,
    readonly code: MindSwapperRequestErrorCode,
    readonly status?: number,
    readonly requestId?: string,
    readonly outcomeUnknown = false,
  ) {
    super(`MindSwapper: ${message}`);
    this.name = "MindSwapperRequestError";
  }
}

function asRecord(value: unknown): WireRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as WireRecord : undefined;
}

function requestId(value: unknown): string | undefined {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

export function sanitizeMindSwapperError(error: unknown): Error {
  if (error instanceof MindSwapperRequestError) return error;
  if (error instanceof Error && error.cause instanceof MindSwapperRequestError) return error.cause;
  if (error instanceof Error && error.name === "AbortError") return error;
  const details = asRecord(error);
  const status = typeof details?.["status"] === "number" ? details["status"] : undefined;
  const id = requestId(details?.["request_id"]);
  if (status === 401 || status === 403) {
    return new MindSwapperRequestError("the connection key was rejected. Check the key in Settings.", "authentication_error", status, id);
  }
  if (status === 402) {
    return new MindSwapperRequestError("the selected account has insufficient credit. Check its balance.", "insufficient_balance", status, id);
  }
  if (status === 400 || status === 422) {
    return new MindSwapperRequestError("the selected model or offer does not support this request.", "unsupported_request", status, id);
  }
  if (status === 404 || status === 503) {
    return new MindSwapperRequestError("the selected model or its supply is unavailable.", "no_eligible_supply", status, id, id !== undefined);
  }
  if (status === 429) return new MindSwapperRequestError("the account or server is rate limited.", "rate_limit_error", status, id, id !== undefined);
  return new MindSwapperRequestError("the connection ended before a complete response. Check the request before retrying.", "outcome_unknown", status, id, true);
}

function hasImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasImage);
  const entry = asRecord(value);
  return entry !== undefined && (entry["type"] === "image_url" || Object.values(entry).some(hasImage));
}

function promptWithoutImageBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(promptWithoutImageBytes);
  const entry = asRecord(value);
  if (!entry) return value;
  if (entry["type"] === "image_url") {
    const image = asRecord(entry["image_url"]);
    return image ? { ...entry, image_url: Object.fromEntries(Object.entries(image).filter(([key]) => key !== "url")) } : entry;
  }
  return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, promptWithoutImageBytes(child)]));
}

function assertWireOffer(request: WireRecord, offer: MindSwapperChatOffer): void {
  const unsupported = ["temperature", "top_p", "stop", "seed", "tools", "tool_choice", "parallel_tool_calls", "response_format"]
    .filter((field) => request[field] !== undefined && !offer.supportedParameters.includes(field));
  if ((request["reasoning"] !== undefined || request["reasoning_effort"] !== undefined) && !offer.supportedParameters.includes("reasoning")) {
    unsupported.push("reasoning");
  }
  if (unsupported.length || (!offer.inputModalities.includes("image") && hasImage(request["messages"]))) {
    throw new MindSwapperRequestError("the selected Chat Completions offer does not support these controls or inputs.", "unsupported_request", 400);
  }
  const maxOutput = request["max_completion_tokens"] ?? request["max_tokens"];
  if (typeof maxOutput !== "number" || !Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > offer.maxOutputTokens) {
    throw new MindSwapperRequestError("the requested output is outside the model's token budget.", "context_length_exceeded", 400);
  }
  // Match the Gateway's Chat Completions input estimate at the final wire boundary.
  const prompt = Object.fromEntries(Object.entries(request).filter(([key]) => !NON_PROMPT_FIELDS.has(key)));
  const inputTokens = Math.ceil(Buffer.byteLength(JSON.stringify(promptWithoutImageBytes(prompt)), "utf8") / 4);
  if (inputTokens > offer.maxInputTokens) {
    throw new MindSwapperRequestError("the prepared input exceeds the model's token budget.", "context_length_exceeded", 400);
  }
}

/** MindSwapper's SSE contract requires a terminal data event. Never accept a truncated body as a completed generation. */
function requireStreamTerminator(response: Response): Response {
  const body = response.body;
  if (!body) throw new MindSwapperRequestError("the streaming response was empty.", "outcome_unknown", undefined, requestId(response.headers.get("x-request-id")), true);
  const decoder = new TextDecoder();
  const terminator = "data: [DONE]";
  let done = false;
  let line = "";
  let lineOverflow = false;
  const inspect = (fragment: string) => {
    const lines = fragment.split("\n");
    for (const [index, part] of lines.entries()) {
      if (!lineOverflow) {
        if (line.length + part.length > terminator.length + 1) lineOverflow = true;
        else line += part;
      }
      if (index === lines.length - 1) break;
      if (!lineOverflow && line.trimEnd() === terminator) done = true;
      line = "";
      lineOverflow = false;
    }
  };
  return new Response(body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      inspect(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    flush() {
      inspect(decoder.decode());
      if (!done && (lineOverflow || line.trimEnd() !== terminator)) {
        throw new MindSwapperRequestError("the streaming response ended before its completion marker.", "outcome_unknown", undefined, requestId(response.headers.get("x-request-id")), true);
      }
    },
  })), { headers: response.headers, status: response.status, statusText: response.statusText });
}

export function createMindSwapperFetch(
  connection: { readonly baseUrl: string; readonly apiKey: string },
  upstreamModelId: string,
  offer: MindSwapperChatOffer,
): typeof fetch {
  const endpoint = new URL(`${connection.baseUrl.replace(/\/+$/, "")}/chat/completions`).href;
  return (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== endpoint || (init?.method ?? (input instanceof Request ? input.method : undefined))?.toUpperCase() !== "POST") {
      throw new MindSwapperRequestError("the request did not match its admitted endpoint.", "invalid_endpoint", 400);
    }
    if (typeof init?.body !== "string") {
      throw new MindSwapperRequestError("the request did not have a Chat Completions body.", "unsupported_request", 400);
    }
    const request = asRecord(JSON.parse(init.body));
    if (!request || request["model"] !== upstreamModelId) {
      throw new MindSwapperRequestError("the request did not match its admitted model.", "unsupported_request", 400);
    }
    assertWireOffer(request, offer);
    const response = await globalThis.fetch(endpoint, {
      method: "POST",
      body: init.body,
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
        Accept: request["stream"] === true ? "text/event-stream" : "application/json",
      },
      redirect: "error",
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw sanitizeMindSwapperError({ status: response.status, request_id: response.headers.get("x-request-id") });
    }
    return request["stream"] === true ? requireStreamTerminator(response) : response;
  }) as typeof fetch;
}

export class MindSwapperCompletions extends ChatOpenAICompletions {
  override async *_streamResponseChunks(...args: Parameters<ChatOpenAICompletions["_streamResponseChunks"]>) {
    let id: string | undefined;
    let finished = false;
    for await (const chunk of super._streamResponseChunks(...args)) {
      if (!id) {
        id = requestId(chunk.message.id);
        if (id) chunk.message.response_metadata["request_id"] = id;
      }
      if (typeof chunk.generationInfo?.["finish_reason"] === "string") finished = true;
      yield chunk;
    }
    if (!finished) {
      throw new MindSwapperRequestError("the streaming response ended without a finish reason.", "outcome_unknown", undefined, id, true);
    }
  }

  protected override _convertCompletionsDeltaToBaseMessageChunk(
    delta: ChatDelta["delta"],
    response: ChatDelta["rawResponse"],
    role?: ChatDelta["defaultRole"],
  ) {
    const chunk = super._convertCompletionsDeltaToBaseMessageChunk(delta, response, role);
    // The SDK emits a separate final usage chunk. Keep it as the only usage receipt.
    delete chunk.response_metadata["usage"];
    return chunk;
  }

  protected override _convertCompletionsMessageToBaseMessage(
    message: ChatCompletion["message"],
    response: ChatCompletion["rawResponse"],
  ) {
    const result = super._convertCompletionsMessageToBaseMessage(message, response);
    const id = requestId(response.id);
    if (id) result.response_metadata["request_id"] = id;
    return result;
  }
}
