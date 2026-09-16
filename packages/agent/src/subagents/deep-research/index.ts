import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createDeepResearchGraph } from "./agent/graph";
import type { Configuration } from "./shared/config";

export interface DeepResearchAgentConfig {
  checkpointSaver?: PostgresSaver;
  configuration?: Configuration;
}

export function createDeepResearchAgent(config?: DeepResearchAgentConfig) {
  return createDeepResearchGraph(config?.checkpointSaver, config?.configuration);
}

export { createDeepResearchGraph } from "./agent/graph";
export { fromRuntimeConfig as fromDeepResearchConfig } from "./shared/config";
export type {
  Configuration as DeepResearchConfiguration,
  DeepResearchRuntimeConfigOptions,
} from "./shared/config";
export {
  DeepResearchUnavailableError,
  deepResearchModelPlanFromConfiguration,
  resolveDeepResearchModelPlan,
  validateDeepResearchModelPlan,
  type DeepResearchModelLane,
  type DeepResearchModelPlan,
} from "./shared/model-plan";
export type { AgentState as DeepResearchAgentState } from "./agent/state";
