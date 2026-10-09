import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { convertMessagesToResponsesInput } from "@langchain/openai";

const IDENTITY_KEY = "nautilo_tool_invocations";
const PROVIDER_CALL_MAPS = ["__openai_function_call_ids__", "__gemini_function_call_thought_signatures__"];

type RecordValue = Record<string, unknown>;
type Call = { id?: string | undefined; name?: string | undefined; args?: unknown };

export class ModelToolCallIdentityError extends Error {
  override readonly name = "ModelToolCallIdentityError";
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : undefined;
}

function argumentsValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function isNativeComputerCall(value: unknown): boolean {
  return record(value)?.["isComputerTool"] === true;
}

type NativeComputerCall = {
  providerId: string;
  itemId: string;
  status: "in_progress" | "completed" | "incomplete";
  pendingSafetyChecks: unknown[];
  action: unknown;
};

function validateSafetyChecks(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every((entry) => {
    const check = record(entry);
    return typeof check?.["id"] === "string" && check["id"].trim() !== ""
      && (check["code"] === undefined || check["code"] === null || typeof check["code"] === "string")
      && (check["message"] === undefined || check["message"] === null || typeof check["message"] === "string");
  });
}

function nativeMetadata(
  providerId: unknown,
  itemId: unknown,
  status: unknown,
  pendingSafetyChecks: unknown,
  action: unknown,
): NativeComputerCall {
  if (typeof providerId !== "string" || providerId.trim() === "") {
    throw new ModelToolCallIdentityError("Admitted OpenAI computer call is missing its provider call ID");
  }
  if (typeof itemId !== "string" || itemId.trim() === ""
    || (status !== "in_progress" && status !== "completed" && status !== "incomplete")
    || !validateSafetyChecks(pendingSafetyChecks)) {
    throw new ModelToolCallIdentityError("Admitted OpenAI computer call is missing required provider metadata");
  }
  return { providerId, itemId, status, pendingSafetyChecks, action };
}

function rawNativeComputerCalls(message: AIMessage): RecordValue[] {
  const surfaces: unknown[] = [];
  if (Array.isArray(message.response_metadata["output"])) {
    for (const value of message.response_metadata["output"] as unknown[]) surfaces.push(value);
  }
  if (Array.isArray(message.additional_kwargs["tool_outputs"])) {
    for (const value of message.additional_kwargs["tool_outputs"] as unknown[]) surfaces.push(value);
  }
  if (Array.isArray(message.content)) surfaces.push(...message.content);
  return surfaces.flatMap((value) => {
    const item = record(value);
    return item?.["type"] === "computer_call" ? [item] : [];
  });
}

function historicalResponsesWireCallIds(messages: readonly BaseMessage[]): Set<string> {
  const providerIdByCanonical = new Map<string, string>();
  for (const message of messages) {
    if (!AIMessage.isInstance(message)) continue;
    const identity = record(message.additional_kwargs[IDENTITY_KEY]);
    const bindings = identity?.["version"] === 1 && Array.isArray(identity["calls"])
      ? identity["calls"].map(record) : [];
    for (const binding of bindings) {
      if (typeof binding?.["id"] === "string" && typeof binding["providerId"] === "string") {
        providerIdByCanonical.set(binding["id"], binding["providerId"]);
      }
    }
  }

  // The production Responses factory leaves ZDR at its pinned default false.
  // Use the same pure converter instead of duplicating its raw-output priority,
  // legacy fallbacks, and content-block behavior here.
  const input = convertMessagesToResponsesInput({
    messages: [...messages],
    zdrEnabled: false,
    model: "gpt-test",
  });
  const wireIds = new Set<string>();
  for (const value of input) {
    if (!("type" in value) || (value.type !== "function_call"
      && value.type !== "custom_tool_call" && value.type !== "computer_call")
      || typeof value.call_id !== "string" || value.call_id.trim() === "") continue;
    wireIds.add(value.type === "computer_call"
      ? providerIdByCanonical.get(value.call_id) ?? value.call_id
      : value.call_id);
  }
  return wireIds;
}

function validateFreshNativeComputerCalls(
  message: AIMessage,
  priorProviderMessages: readonly BaseMessage[],
): void {
  const parsedCalls = message.tool_calls ?? [];
  const explicitNativeCalls = parsedCalls.filter(isNativeComputerCall);
  const rawItems = rawNativeComputerCalls(message);
  if (explicitNativeCalls.length === 0 && rawItems.length === 0) return;

  const seenProviderIds = historicalResponsesWireCallIds(priorProviderMessages);
  const rawCalls = rawItems.map((item) => nativeMetadata(
    item["call_id"], item["id"], item["status"], item["pending_safety_checks"], item["action"],
  ));
  const nativeCalls: NativeComputerCall[] = [];
  const parsedProviderIds = new Set<string>();

  for (const call of explicitNativeCalls) {
    const callRecord = record(call);
    if (!callRecord) continue;
    const metadata = nativeMetadata(
      call.id,
      callRecord["call_id"],
      callRecord["status"],
      callRecord["pending_safety_checks"],
      record(call.args)?.["action"],
    );
    if (parsedProviderIds.has(metadata.providerId)) {
      throw new ModelToolCallIdentityError("Ambiguous admitted OpenAI computer call provider ID");
    }
    parsedProviderIds.add(metadata.providerId);
    nativeCalls.push(metadata);
  }

  // Completed Responses streams keep native metadata in tool_outputs while the
  // aggregated parsed call has no isComputerTool marker. Correlate that pinned
  // shape without manufacturing metadata on the parsed call.
  for (const rawCall of rawCalls) {
    const candidates = parsedCalls.filter((call) => call.id === rawCall.providerId
      && call.name === "computer_use"
      && isDeepStrictEqual(record(call.args)?.["action"], rawCall.action));
    if (candidates.length !== 1) {
      throw new ModelToolCallIdentityError("Ambiguous OpenAI computer call metadata correlation");
    }
    if (candidates.some(isNativeComputerCall)) {
      const matching = nativeCalls.find((call) => call.providerId === rawCall.providerId
        && call.itemId === rawCall.itemId);
      if (!matching || matching.status !== rawCall.status
        || !isDeepStrictEqual(matching.pendingSafetyChecks, rawCall.pendingSafetyChecks)
        || !isDeepStrictEqual(matching.action, rawCall.action)) {
        throw new ModelToolCallIdentityError("Contradictory OpenAI computer call metadata");
      }
    } else {
      nativeCalls.push(rawCall);
    }
  }

  const distinctCalls = new Map<string, NativeComputerCall>();
  for (const call of nativeCalls) {
    const priorRepresentation = distinctCalls.get(call.providerId);
    if (priorRepresentation && priorRepresentation.itemId !== call.itemId) {
      throw new ModelToolCallIdentityError("Ambiguous admitted OpenAI computer call provider ID");
    }
    if (priorRepresentation && !isDeepStrictEqual(priorRepresentation, call)) {
      throw new ModelToolCallIdentityError("Contradictory OpenAI computer call metadata");
    }
    if (priorRepresentation) continue;
    if (seenProviderIds.has(call.providerId)) {
      throw new ModelToolCallIdentityError("Ambiguous admitted OpenAI computer call provider ID");
    }
    seenProviderIds.add(call.providerId);
    distinctCalls.set(call.providerId, call);
  }
}

/**
 * Admit a completed model response before it reaches any merge, persistence or
 * approval boundary. Provider IDs correlate wire fields; they do not identify
 * executions. Checkpoint/resume paths carry this admitted message unchanged.
 */
export function normalizeModelToolCallIdentity(
  message: AIMessage,
  priorProviderMessages: readonly BaseMessage[] = [],
): AIMessage {
  const calls: Call[] = [...message.tool_calls ?? [], ...message.invalid_tool_calls ?? []];
  const prior = record(message.additional_kwargs[IDENTITY_KEY]);
  if (prior) {
    const bindings = Array.isArray(prior["calls"]) ? prior["calls"].map(record) : [];
    if (prior["version"] !== 1 || bindings.length !== calls.length
      || calls.some((call, index) => !call.id || bindings[index]?.["id"] !== call.id)) {
      throw new ModelToolCallIdentityError("Invalid admitted tool invocation identity");
    }
    return message;
  }

  // Native Responses computer outputs can refer only to the provider call_id;
  // their opaque item ID cannot disambiguate two outputs with the same call_id.
  // Reject an unprojectable fresh call before any workstation effect executes.
  validateFreshNativeComputerCalls(message, priorProviderMessages);
  if (calls.length === 0) return message;

  const responseId = randomUUID().replaceAll("-", "");
  const ids = calls.map((_, index) => `nc_${responseId}_${index}`);
  const ambiguous = (): never => {
    throw new ModelToolCallIdentityError("Ambiguous model tool-call correlation; no tools were admitted");
  };

  // Each equivalent representation has its own occurrence cursor. Match the
  // arguments as well as ID/name so reordered raw fields cannot rebind a call.
  // Identical siblings are distinguished by their positions in that field.
  function rewrite(items: unknown[], describe: (item: RecordValue) => Call | undefined,
    replace: (item: RecordValue, id: string) => RecordValue): unknown[] {
    const used = new Set<number>();
    return items.map((value) => {
      const item = record(value);
      const alias = item && describe(item);
      if (!item || !alias) return value;
      const index = calls.findIndex((call, position) => !used.has(position)
        && (alias.id === undefined || alias.id === call.id)
        && (alias.name === undefined || alias.name === call.name)
        && (alias.args === undefined || isDeepStrictEqual(argumentsValue(alias.args), argumentsValue(call.args))));
      if (index < 0) return ambiguous();
      used.add(index);
      return replace(item, ids[index]!);
    });
  }

  function contentCall(item: RecordValue): Call | undefined {
    if (item["type"] === "tool_use" || item["type"] === "tool_call") {
      return { id: typeof item["id"] === "string" ? item["id"] : undefined,
        name: typeof item["name"] === "string" ? item["name"] : undefined,
        args: item["type"] === "tool_use"
          ? item["input"] === "" ? {} : item["input"]
          : item["args"] };
    }
    if (item["type"] === "function_call") {
      return { id: typeof item["call_id"] === "string" ? item["call_id"] : undefined,
        name: typeof item["name"] === "string" ? item["name"] : undefined, args: item["arguments"] };
    }
    if (item["type"] === "custom_tool_call" || item["type"] === "computer_call") {
      return { id: typeof item["call_id"] === "string" ? item["call_id"] : undefined,
        name: item["type"] === "computer_call" ? "computer_use" : typeof item["name"] === "string" ? item["name"] : undefined,
        args: item["type"] === "computer_call" ? { action: item["action"] } : { input: item["input"] } };
    }
    if (item["type"] === "functionCall" && record(item["functionCall"])) {
      const call = record(item["functionCall"])!;
      return { id: typeof call["id"] === "string" ? call["id"] : undefined,
        name: typeof call["name"] === "string" ? call["name"] : undefined, args: call["args"] };
    }
    return undefined;
  }
  function replaceContent(item: RecordValue, id: string): RecordValue {
    if (item["type"] === "function_call" || item["type"] === "custom_tool_call" || item["type"] === "computer_call") return { ...item, call_id: id };
    if (item["type"] === "functionCall") return { ...item, functionCall: { ...record(item["functionCall"]), id } };
    return { ...item, id };
  }

  const additionalKwargs: RecordValue = { ...message.additional_kwargs };
  if (Array.isArray(additionalKwargs["tool_calls"])) {
    additionalKwargs["tool_calls"] = rewrite(additionalKwargs["tool_calls"], (item) => {
      const fn = record(item["function"]);
      return fn ? { id: typeof item["id"] === "string" ? item["id"] : undefined,
        name: typeof fn["name"] === "string" ? fn["name"] : undefined, args: fn["arguments"] } : ambiguous();
    }, (item, id) => ({ ...item, id }));
  }
  const responseMetadata = { ...message.response_metadata };
  // Responses may serialize this raw output in preference to tool_calls.
  if (Array.isArray(responseMetadata["output"])) {
    responseMetadata["output"] = rewrite(responseMetadata["output"], contentCall, replaceContent);
  }
  if (Array.isArray(additionalKwargs["tool_outputs"])) {
    additionalKwargs["tool_outputs"] = rewrite(additionalKwargs["tool_outputs"], contentCall, replaceContent);
  }
  const openaiItemIds = new Map<string, unknown>();
  if (Array.isArray(responseMetadata["output"])) {
    for (const value of responseMetadata["output"]) {
      const item = record(value);
      if (item?.["type"] === "function_call" && typeof item["call_id"] === "string" && typeof item["id"] === "string") {
        openaiItemIds.set(item["call_id"], item["id"]);
      }
    }
  }
  // These maps bind provider-owned item IDs/signatures to calls. Preserve their
  // opaque values, but rekey the bindings. A lossy same-ID map cannot establish
  // which sibling owns a value, so fail before effects rather than guessing.
  for (const key of PROVIDER_CALL_MAPS) {
    const map = record(additionalKwargs[key]);
    if (!map) continue;
    const bindings: [string, unknown][] = [];
    for (const [providerId, value] of Object.entries(map)) {
      const positions = calls.flatMap((call, index) => call.id === providerId ? [index] : []);
      if (positions.length === 0) return ambiguous();
      for (const position of positions) {
        const id = ids[position]!;
        const itemId = key === "__openai_function_call_ids__" ? openaiItemIds.get(id) : undefined;
        if (positions.length > 1 && itemId === undefined) return ambiguous();
        bindings.push([id, itemId ?? value]);
      }
    }
    additionalKwargs[key] = Object.fromEntries(bindings);
  }
  additionalKwargs[IDENTITY_KEY] = { version: 1, responseId,
    calls: calls.map((call, index) => ({ id: ids[index]!, providerId: call.id ?? null })) };

  // Convert aggregated chunks to one completed message. Keeping raw chunk IDs
  // would let checkpoint deserialization rebuild the old provider identities.
  return new AIMessage({
    ...(message.id === undefined ? {} : { id: message.id }),
    ...(message.name === undefined ? {} : { name: message.name }),
    content: Array.isArray(message.content)
      ? rewrite(message.content, contentCall, replaceContent) as typeof message.content : message.content,
    ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls.map((call, index) => ({ ...call, id: ids[index]! })) }),
    ...(message.invalid_tool_calls === undefined ? {} : { invalid_tool_calls: message.invalid_tool_calls.map((call, index) => ({ ...call, id: ids[(message.tool_calls?.length ?? 0) + index]! })) }),
    additional_kwargs: additionalKwargs,
    response_metadata: responseMetadata,
    ...(message.usage_metadata === undefined ? {} : { usage_metadata: message.usage_metadata }),
  });
}
