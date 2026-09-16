import { Annotation } from "@langchain/langgraph";
import type { BaseMessageLike } from "@langchain/core/messages";
import { overrideListReducer } from "../shared/utils";

export const ResearcherStateAnnotation = Annotation.Root({
  researcher_messages: Annotation<BaseMessageLike[]>({
    value: (x, y) => x.concat(y),
    default: () => [],
  }),
  tool_call_iterations: Annotation<number>({
    value: (_x, y) => y,
    default: () => 0,
  }),
  tool_call_count: Annotation<number>({
    value: (_x, y) => y,
    default: () => 0,
  }),
  search_call_count: Annotation<number>({
    value: (_x, y) => y,
    default: () => 0,
  }),
  research_topic: Annotation<string>({
    value: (_x, y) => y,
    default: () => "",
  }),
  compressed_research: Annotation<string | undefined>({
    value: (_x, y) => y,
    default: () => undefined,
  }),
  research_complete_called: Annotation<boolean>({
    value: (_x, y) => y,
    default: () => false,
  }),
  raw_notes: Annotation<string[]>({
    value: overrideListReducer,
    default: () => [],
  }),
  research_brief: Annotation<string | undefined>({
    value: (_x, y) => y,
    default: () => undefined,
  }),
  supervisor_directive: Annotation<string | undefined>({
    value: (_x, y) => y,
    default: () => undefined,
  }),
});

