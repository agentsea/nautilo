import { Annotation } from "@langchain/langgraph";
import type { BaseMessageLike } from "@langchain/core/messages";
import { overrideListReducer } from "../shared/utils";

export const SupervisorStateAnnotation = Annotation.Root({
  supervisor_messages: Annotation<BaseMessageLike[]>({
    value: overrideListReducer,
    default: () => [],
  }),
  research_brief: Annotation<string>({
    value: (_x, y) => y,
    default: () => "",
  }),
  notes: Annotation<string[]>({
    value: overrideListReducer,
    default: () => [],
  }),
  research_iterations: Annotation<number>({
    value: (_x, y) => y,
    default: () => 0,
  }),
  raw_notes: Annotation<string[]>({
    value: overrideListReducer,
    default: () => [],
  }),
});

