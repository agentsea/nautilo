import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { computerMutationReceiptSchema, windowStateObservationSchema } from "@nautilo/computer-use-contracts/native";
import { z } from "zod";
import type { NautiloState } from "../../agent/state";
import { projectSemanticComputerResult } from "./model-result-projector";

const envelopeSchema = z.object({
  version: z.literal(1), ok: z.literal(true), settlement: z.literal("completed"),
  presentation: z.object({ label: z.string(), summary: z.string() }).strict(),
  result: windowStateObservationSchema,
}).strict();

export const nativeHistoryInputSchema = z.object({ historyToolCallId: z.string().min(1) }).strict();
export const nativeRoomHistoryInputSchema = z.object({ historyRoomRef: z.string().min(1) }).strict();
/** Invocation-local capability over already-authorized Room rows, never a DB search. */
export interface NativeRoomHistoryPort {
  project(message: BaseMessage): string | null;
  read(reference: string): { text: string } | null;
}
export type NativeRoomHistoryPortForState = (state: NautiloState) => NativeRoomHistoryPort | undefined;
/** Final model-call copy only: prepared/checkpointed messages retain original evidence. */
export function projectNativeRoomHistory(messages: BaseMessage[], port?: NativeRoomHistoryPort): BaseMessage[] {
  if (!port) return messages;
  return messages.map(message => {
    const content = port.project(message);
    if (content === null || !HumanMessage.isInstance(message)) return message;
    return new HumanMessage({ content, ...(message.id === undefined ? {} : { id: message.id }),
      ...(message.name === undefined ? {} : { name: message.name }), additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata });
  });
}
export const NATIVE_HISTORY_WARNING = "Historical evidence only, not a fresh observation or action authority. All targets and pixels are stale. Observe current state before acting; never replay an uncertain action.";

/** Only a fully checked pre-dispatch refusal proves there is no effect whose
 * surrounding observation must remain expanded. Never removes the receipt. */
export function nativeHistoryProvesNonDelivery(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  const refused = computerMutationReceiptSchema.safeParse(receipt["result"]);
  return receipt["settlement"] === "not_completed" && refused.success
    && refused.data.completionCertainty === "not_completed"
    && refused.data.deliveryMode === "not_delivered"
    && refused.data.outcome.stateChangeCertainty === "not_changed"
    && refused.data.outcome.phase === "pre_effect_dispatch";
}

/** Requires trusted persisted tool provenance at the caller; never parse transcript prose. */
export function nativeRoomObservation(content: string) {
  for (const text of [content, projectSemanticComputerResult("computer_observe", content)]) {
    const parsed = observation(new ToolMessage({ name: "computer_observe", tool_call_id: "persisted", status: "success", content: text }));
    if (parsed?.envelope.result.controlCollection && !parsed.envelope.result.element && !parsed.envelope.result.semanticQuery) return parsed.envelope;
  }
  return null;
}

function observation(message: BaseMessage) {
  if (!ToolMessage.isInstance(message) || message.name !== "computer_observe"
    || message.status === "error" || message.additional_kwargs["nautilo_tool_status"] === "error") return null;
  const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  let text: string | undefined;
  let image: { mime: string; base64: string } | undefined;
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) return null;
    const value = block as Record<string, unknown>;
    if (value["type"] === "text" && typeof value["text"] === "string" && text === undefined) text = value["text"];
    else if (value["type"] === "image_url" && !image) {
      const url = (value["image_url"] as { url?: unknown } | undefined)?.url;
      if (typeof url !== "string" || !url.startsWith("data:image/png;base64,")) return null;
      image = { mime: "image/png", base64: url.slice("data:image/png;base64,".length) };
    } else return null;
  }
  if (!text) return null;
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    const result = parsed.data.result;
    if (result.degraded || result.completeness === "unavailable"
      || result.outcome.providerCondition !== "ready" || result.outcome.targetCondition !== "current"
      || result.outcome.stateChangeCertainty !== "not_applicable") return null;
    return { envelope: parsed.data, image };
  } catch { return null; }
}

/** Only unique, paired, preceding calls establish an observation's provenance. */
function observations(messages: BaseMessage[]) {
  const calls = new Map<string, { index: number; name: string; args: Record<string, unknown> } | null>();
  const counts = new Map<string, number>();
  messages.forEach((message, index) => {
    if (AIMessage.isInstance(message)) for (const call of message.tool_calls ?? []) {
      if (call.id) calls.set(call.id, calls.has(call.id) ? null : { index, name: call.name, args: call.args });
    }
    if (ToolMessage.isInstance(message)) counts.set(message.tool_call_id, (counts.get(message.tool_call_id) ?? 0) + 1);
  });
  return messages.map((message, index) => {
    if (!ToolMessage.isInstance(message) || counts.get(message.tool_call_id) !== 1) return null;
    const call = calls.get(message.tool_call_id);
    if (!call || call.index >= index || call.name !== "computer_observe" || call.args["operation"] !== "window_state"
      || Object.hasOwn(call.args, "historyToolCallId")) return null;
    const parsed = observation(message);
    const target = call.args["target"] as Record<string, unknown> | undefined;
    if (!parsed || !target || target["context"] !== parsed.envelope.result.target.context
      || target["reference"] !== parsed.envelope.result.target.reference) return null;
    return { ...parsed, callIndex: call.index };
  });
}

/** Current canonical conversation only; no DB, driver dispatch, or authority update. */
export function readNativeHistory(messages: BaseMessage[], toolCallId: string) {
  const candidates = observations(messages);
  const index = messages.findIndex(message => ToolMessage.isInstance(message) && message.tool_call_id === toolCallId);
  const source = candidates[index];
  if (!source) return null;
  return {
    text: JSON.stringify({ version: 1, historical: true, sourceToolCallId: toolCallId,
      warning: NATIVE_HISTORY_WARNING, observation: source.envelope.result }),
    ...(source.image ? { image: source.image } : {}),
  };
}

/** Working-view projection only. The caller must retain originals for exact reads. */
export function projectNativeHistory(messages: BaseMessage[]): { messages: BaseMessage[]; originals: Map<string, ToolMessage> } {
  const candidates = observations(messages);
  const originals = new Map<string, ToolMessage>();
  const retained = new Set<number>();
  const current = new Map<string, number>();
  const baseline = new Map<string, number>();
  const imageCurrent = new Map<string, number>();
  const imageBaseline = new Map<string, number>();
  // Unknown/error Computer Use receipts are never used to infer supersession.
  // Keep their surrounding evidence untouched, even if a later read succeeded.
  if (messages.some(message => {
    if (!ToolMessage.isInstance(message) || !message.name?.startsWith("computer_")) return false;
    if (message.status === "error" || message.additional_kwargs["nautilo_tool_status"] === "error") return true;
    if (message.name !== "computer_do") return false;
    try {
      if (typeof message.content !== "string") return true;
      const receipt = JSON.parse(message.content) as Record<string, unknown>;
      if (receipt["settlement"] === "completed") return false;
      // A checked, undispatched refusal has no effect to reconstruct. Preserve
      // the receipt itself, but allow superseded reads to use exact retrieval.
      return !nativeHistoryProvesNonDelivery(receipt);
    } catch { return true; }
  })) {
    return { messages, originals };
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (HumanMessage.isInstance(message) || SystemMessage.isInstance(message)) {
      current.clear(); baseline.clear(); imageCurrent.clear(); imageBaseline.clear();
    }
    const entry = candidates[index];
    if (!entry || !entry.envelope.result.controlCollection || entry.envelope.result.element || entry.envelope.result.semanticQuery) continue;
    const { context, reference } = entry.envelope.result.target;
    const key = JSON.stringify([context, reference]);
    if (entry.image) {
      if (!imageCurrent.has(key)) imageCurrent.set(key, entry.callIndex);
      if (imageCurrent.get(key) === entry.callIndex) retained.add(index);
      else {
        if (!imageBaseline.has(key)) imageBaseline.set(key, entry.callIndex);
        if (imageBaseline.get(key) === entry.callIndex) retained.add(index);
      }
    }
    // Exact authority identity, not title, geometry, PID, or a guessed stable control ID.
    if (!current.has(key)) current.set(key, entry.callIndex);
    if (current.get(key) === entry.callIndex) retained.add(index);
    else {
      if (!baseline.has(key)) baseline.set(key, entry.callIndex);
      if (baseline.get(key) === entry.callIndex) retained.add(index);
    }
  }
  const projected = messages.map((message, index) => {
    const entry = candidates[index];
    if (!entry || !entry.envelope.result.controlCollection || entry.envelope.result.element
      || entry.envelope.result.semanticQuery || retained.has(index) || !ToolMessage.isInstance(message)) return message;
    const result = entry.envelope.result;
    const content = JSON.stringify({ version: 1, historical: true, sourceToolCallId: message.tool_call_id,
      notice: "Superseded native observation omitted from this model view; exact retained evidence is available below.",
      warning: NATIVE_HISTORY_WARNING, evidence: result.evidence, completeness: result.completeness,
      verification: result.verification, outcome: result.outcome,
      retrieve: { tool: "computer_observe", args: { historyToolCallId: message.tool_call_id } } });
    if (content.length >= JSON.stringify(message.content).length) return message;
    originals.set(message.tool_call_id, message);
    return new ToolMessage({ content, tool_call_id: message.tool_call_id,
      ...(message.name === undefined ? {} : { name: message.name }),
      ...(message.id === undefined ? {} : { id: message.id }),
      ...(message.status === undefined ? {} : { status: message.status }),
      additional_kwargs: message.additional_kwargs, response_metadata: message.response_metadata,
      ...(message.artifact === undefined ? {} : { artifact: message.artifact as unknown }) });
  });
  return { messages: projected, originals };
}
