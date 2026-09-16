import type { BaseMessageLike } from "@langchain/core/messages";

export type AgentState = {
  messages: BaseMessageLike[];
  supervisor_messages: BaseMessageLike[];
  research_brief?: string;
  raw_notes: string[];
  notes: string[];
  final_report?: string;
};

export type SupervisorState = {
  supervisor_messages: BaseMessageLike[];
  research_brief: string;
  notes: string[];
  research_iterations: number;
  raw_notes: string[];
};

export type ResearcherState = {
  researcher_messages: BaseMessageLike[];
  tool_call_iterations: number;
  research_topic: string;
  compressed_research?: string;
  raw_notes: string[];
  research_brief?: string;
  supervisor_directive?: string;
};

export function toSupervisorState(agent: AgentState): SupervisorState {
  return {
    supervisor_messages: agent.supervisor_messages ?? [],
    research_brief: agent.research_brief ?? "",
    notes: agent.notes ?? [],
    research_iterations: 0,
    raw_notes: agent.raw_notes ?? [],
  };
}

export function toResearcherState(
  _supervisor: SupervisorState,
  topic: string,
  extra?: { research_brief?: string; supervisor_directive?: string },
): ResearcherState {
  const out: ResearcherState = {
    researcher_messages: [],
    tool_call_iterations: 0,
    research_topic: topic,
    raw_notes: [],
  };
  if (typeof extra?.research_brief === "string") out.research_brief = extra.research_brief;
  if (typeof extra?.supervisor_directive === "string") out.supervisor_directive = extra.supervisor_directive;
  return out;
}

