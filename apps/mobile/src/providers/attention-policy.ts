import type { ServerEvent } from "@nautilo/types";

type AgentResumeAttentionType = Extract<
  ServerEvent["type"],
  "approval.ask" | "host.choice" | "prove_it.challenge" | "identity.challenge"
>;

const AGENT_RESUME_ATTENTION_TYPES: ReadonlySet<ServerEvent["type"]> = new Set<AgentResumeAttentionType>([
  "approval.ask",
  "host.choice",
  "prove_it.challenge",
  "identity.challenge",
]);

/** Passive message cleanup remains active; only Agent-resume prompts require authority. */
export function mayHandleAttentionEvent(
  eventType: ServerEvent["type"],
  canInvokeAgents: boolean,
): boolean {
  return canInvokeAgents || !AGENT_RESUME_ATTENTION_TYPES.has(eventType);
}
