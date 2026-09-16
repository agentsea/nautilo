import type { HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { NautiloState } from "../../agent/state";
import type { ResearchNoteDraft } from "./research-note-draft";

type Node = (state: NautiloState, config?: RunnableConfig) => Promise<Partial<NautiloState>>;

/** Keep advisory bytes outside every graph update/checkpoint. */
export function researchNoteDraftNodes(input: {
  helper?: ResearchNoteDraft;
  prepare: Node;
  agent: (state: NautiloState, config?: RunnableConfig, draft?: HumanMessage) => Promise<Partial<NautiloState>>;
}): { prepare: Node; agent: Node } {
  return {
    async prepare(state, config) {
      const update = await input.prepare(state, config);
      input.helper?.observePrepared({ ...state, ...update });
      return update;
    },
    async agent(state, config) {
      return input.agent(state, config, input.helper?.takePrepared(state));
    },
  };
}
