import type { DeepResearchModelPlan } from "./model-plan";

const DEEP_RESEARCH_TASK_METADATA_KEY = "deepResearch";

export interface DeepResearchTaskMetadata {
  readonly version: 1;
  readonly reportLanguage: string;
  readonly modelPlan: DeepResearchModelPlan;
  /** Chat-model attribution retained while the research graph owns its own model roles. */
  readonly invokingModelId: string | null;
}

export function deepResearchTaskMetadata(input: {
  readonly reportLanguage: string;
  readonly modelPlan: DeepResearchModelPlan;
  readonly invokingModelId: string | null;
}): Record<string, unknown> {
  return {
    [DEEP_RESEARCH_TASK_METADATA_KEY]: {
      version: 1,
      reportLanguage: input.reportLanguage,
      modelPlan: input.modelPlan,
      invokingModelId: input.invokingModelId,
    } satisfies DeepResearchTaskMetadata,
  };
}

export function readDeepResearchTaskMetadata(
  metadata: unknown,
): DeepResearchTaskMetadata | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  if (!Object.hasOwn(record, DEEP_RESEARCH_TASK_METADATA_KEY)) return null;
  const value = record[DEEP_RESEARCH_TASK_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Deep Research Task metadata is malformed");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate["version"] !== 1 ||
    typeof candidate["reportLanguage"] !== "string" ||
    !candidate["modelPlan"] ||
    typeof candidate["modelPlan"] !== "object" ||
    Array.isArray(candidate["modelPlan"]) ||
    !(candidate["invokingModelId"] === null || typeof candidate["invokingModelId"] === "string")
  ) {
    throw new TypeError("Deep Research Task metadata is malformed");
  }
  return candidate as unknown as DeepResearchTaskMetadata;
}
