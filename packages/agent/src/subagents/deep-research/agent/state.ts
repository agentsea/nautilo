import { Annotation } from "@langchain/langgraph";
import type { BaseMessageLike } from "@langchain/core/messages";
import { overrideListReducer } from "../shared/utils";

export const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessageLike[]>({
    value: (x, y) => x.concat(y),
    default: () => [],
  }),
  supervisor_messages: Annotation<BaseMessageLike[]>({
    value: overrideListReducer,
    default: () => [],
  }),
  research_brief: Annotation<string | undefined>({
    value: (_x, y) => y,
    default: () => undefined,
  }),
  report_language: Annotation<string | undefined>({
    value: (_x, y) => y,
    default: () => undefined,
  }),
  raw_notes: Annotation<string[]>({
    value: overrideListReducer,
    default: () => [],
  }),
  notes: Annotation<string[]>({
    value: overrideListReducer,
    default: () => [],
  }),
  final_report: Annotation<string | undefined>({
    value: (_x, y) => y,
    default: () => undefined,
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;
