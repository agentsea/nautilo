import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../agent/state";
import { deriveResearchWorkContext } from "./research-work-context";

/** Select an epoch from protection-adjusted history, never from raw canonical
 * bytes. Canonical indices remain append-stable for exact source retrieval.
 * Unknown transformed messages and their complete tool cycles stay visible. */
export function prepareResearchRoleHistory(state: NautiloState, history: readonly BaseMessage[]): BaseMessage[] {
  const context = deriveResearchWorkContext(state);
  if (!context) return [...history];
  const byObject = new Map(state.messages.map((message, index) => [message, index]));
  const byId = new Map<string, number | null>();
  state.messages.forEach((message, index) => {
    if (message.id) byId.set(message.id, byId.has(message.id) ? null : index);
  });
  const keep = new Set<BaseMessage>();
  for (let position = 0; position < history.length; position++) {
    const message = history[position]!;
    const index = byObject.get(message) ?? (message.id ? byId.get(message.id) ?? undefined : undefined);
    // Runtime correction belongs to the role that received it. Keep actual
    // Human instructions across every role, but do not carry an obsolete
    // investigator/reviewer correction into the coordinator's next workspace.
    if (index !== undefined && index < context.startIndex && HumanMessage.isInstance(message)
      && message.additional_kwargs["nautilo_research_continuation"] === true) continue;
    if (!SystemMessage.isInstance(message) && !HumanMessage.isInstance(message)
      && index !== undefined && index < context.startIndex) continue;
    keep.add(message);
    if (!AIMessage.isInstance(message) && !ToolMessage.isInstance(message)) continue;
    let start = position;
    if (ToolMessage.isInstance(message)) {
      while (start > 0 && ToolMessage.isInstance(history[start]!)) start--;
      if (!AIMessage.isInstance(history[start]!)) start = position;
    }
    let end = start + 1;
    while (end < history.length && ToolMessage.isInstance(history[end]!)) end++;
    for (let member = start; member < end; member++) keep.add(history[member]!);
  }
  return history.filter((message) => keep.has(message));
}
