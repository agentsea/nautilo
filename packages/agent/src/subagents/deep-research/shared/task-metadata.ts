import { parseTaskFundingBinding, type TaskFundingBinding } from "@nautilo/types";
import { DeepResearchModelPlanSchema, type DeepResearchModelPlan } from "./model-plan";

const DEEP_RESEARCH_TASK_METADATA_KEY = "deepResearch";

export const DEEP_RESEARCH_FUNDING_LANES = [
  "supervisor", "research", "summarization", "compression", "finalReport",
] as const;
export type DeepResearchFundingLane = (typeof DEEP_RESEARCH_FUNDING_LANES)[number];

export interface LegacyDeepResearchTaskMetadata {
  readonly version: 1;
  readonly reportLanguage: string;
  readonly modelPlan: DeepResearchModelPlan;
  /** Chat-model attribution retained while the research graph owns its own model roles. */
  readonly invokingModelId: string | null;
}

export interface AdmittedDeepResearchTaskMetadata {
  readonly version: 2;
  readonly reportLanguage: string;
  readonly modelPlan: DeepResearchModelPlan;
  readonly invokingModelId: string | null;
  readonly preferenceRevisions: Readonly<Record<DeepResearchFundingLane, number>>;
  readonly modelFunding: Readonly<Record<DeepResearchFundingLane, TaskFundingBinding>>;
  readonly tavilyFunding: TaskFundingBinding;
}

export type DeepResearchTaskMetadata = LegacyDeepResearchTaskMetadata | AdmittedDeepResearchTaskMetadata;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function parseInvokingModelId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError("Deep Research Task metadata is malformed");
  return value;
}

function parsePreferenceRevisions(value: unknown): Readonly<Record<DeepResearchFundingLane, number>> {
  if (!isRecord(value) || !hasExactKeys(value, DEEP_RESEARCH_FUNDING_LANES)) {
    throw new TypeError("Deep Research Task metadata is malformed");
  }
  const parsed = {} as Record<DeepResearchFundingLane, number>;
  for (const lane of DEEP_RESEARCH_FUNDING_LANES) {
    const revision = value[lane];
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
      throw new TypeError("Deep Research Task metadata is malformed");
    }
    parsed[lane] = revision as number;
  }
  return Object.freeze(parsed);
}

function parseModelFunding(value: unknown): Readonly<Record<DeepResearchFundingLane, TaskFundingBinding>> {
  if (!isRecord(value) || !hasExactKeys(value, DEEP_RESEARCH_FUNDING_LANES)) {
    throw new TypeError("Deep Research Task metadata is malformed");
  }
  const parsed = {} as Record<DeepResearchFundingLane, TaskFundingBinding>;
  for (const lane of DEEP_RESEARCH_FUNDING_LANES) parsed[lane] = parseTaskFundingBinding(value[lane]);
  return Object.freeze(parsed);
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

export function admittedDeepResearchTaskMetadata(
  input: Omit<AdmittedDeepResearchTaskMetadata, "version">,
): Record<string, unknown> {
  return { [DEEP_RESEARCH_TASK_METADATA_KEY]: { version: 2, ...input } satisfies AdmittedDeepResearchTaskMetadata };
}

export function parseDeepResearchTaskMetadataValue(value: unknown): DeepResearchTaskMetadata {
  if (!isRecord(value) || typeof value["reportLanguage"] !== "string" || !value["reportLanguage"].trim()) {
    throw new TypeError("Deep Research Task metadata is malformed");
  }
  if (value["version"] === 1) {
    if (!hasExactKeys(value, ["version", "reportLanguage", "modelPlan", "invokingModelId"])) {
      throw new TypeError("Deep Research Task metadata is malformed");
    }
    return Object.freeze({ version: 1, reportLanguage: value["reportLanguage"],
      modelPlan: DeepResearchModelPlanSchema.parse(value["modelPlan"]),
      invokingModelId: parseInvokingModelId(value["invokingModelId"]) });
  }
  if (value["version"] === 2) {
    if (!hasExactKeys(value, ["version", "reportLanguage", "modelPlan", "invokingModelId",
      "preferenceRevisions", "modelFunding", "tavilyFunding"])) {
      throw new TypeError("Deep Research Task metadata is malformed");
    }
    return Object.freeze({ version: 2, reportLanguage: value["reportLanguage"],
      modelPlan: DeepResearchModelPlanSchema.parse(value["modelPlan"]),
      invokingModelId: parseInvokingModelId(value["invokingModelId"]),
      preferenceRevisions: parsePreferenceRevisions(value["preferenceRevisions"]),
      modelFunding: parseModelFunding(value["modelFunding"]),
      tavilyFunding: parseTaskFundingBinding(value["tavilyFunding"]) });
  }
  throw new TypeError("Deep Research Task metadata is malformed");
}

export function readDeepResearchTaskMetadata(
  metadata: unknown,
): DeepResearchTaskMetadata | null {
  if (!isRecord(metadata)) return null;
  if (!Object.hasOwn(metadata, DEEP_RESEARCH_TASK_METADATA_KEY)) return null;
  return parseDeepResearchTaskMetadataValue(metadata[DEEP_RESEARCH_TASK_METADATA_KEY]);
}
