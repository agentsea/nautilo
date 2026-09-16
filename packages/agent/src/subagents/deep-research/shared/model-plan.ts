import { z } from "zod";
import type { ModelRole } from "@nautilo/config";
import { resolveModelRole } from "../../../config/model-role-resolution";
import type { Configuration } from "./config";

const ModelIdSchema = z.string().trim().min(1).max(512);

export const DeepResearchModelPlanSchema = z.object({
  version: z.literal(1),
  supervisorModel: ModelIdSchema,
  researchModel: ModelIdSchema,
  summarizationModel: ModelIdSchema,
  compressionModel: ModelIdSchema,
  finalReportModel: ModelIdSchema,
}).strict();

export type DeepResearchModelPlan = z.infer<typeof DeepResearchModelPlanSchema>;
export type DeepResearchModelLane =
  | "supervisor"
  | "research"
  | "summarization"
  | "compression"
  | "final-report";

export class DeepResearchUnavailableError extends Error {
  readonly code = "deep_research_model_unavailable" as const;

  constructor(
    readonly lane: DeepResearchModelLane,
    options?: { cause?: unknown },
  ) {
    super(`Deep Research is unavailable because the ${lane} model lane has no signed, credentialed model.`, options);
    this.name = "DeepResearchUnavailableError";
  }
}

export interface DeepResearchConfiguredModels {
  supervisorModel?: string | null;
  researchModel?: string | null;
  summarizationModel?: string | null;
  compressionModel?: string | null;
  finalReportModel?: string | null;
}

export interface ResolveDeepResearchModelPlanOptions {
  configured?: DeepResearchConfiguredModels;
  env?: NodeJS.ProcessEnv;
}

function resolveLane(
  lane: DeepResearchModelLane,
  role: ModelRole,
  configuredId: string | null | undefined,
  env: NodeJS.ProcessEnv | undefined,
): string {
  try {
    return resolveModelRole(role, {
      ...(configuredId === undefined ? {} : { configuredId }),
      ...(env === undefined ? {} : { env }),
    });
  } catch (cause) {
    throw new DeepResearchUnavailableError(lane, { cause });
  }
}

export function resolveDeepResearchModelPlan(
  options: ResolveDeepResearchModelPlanOptions = {},
): DeepResearchModelPlan {
  const { configured = {}, env } = options;
  return {
    version: 1,
    supervisorModel: resolveLane(
      "supervisor",
      "deepResearchSupervisor",
      configured.supervisorModel,
      env,
    ),
    researchModel: resolveLane(
      "research",
      "deepResearchResearcher",
      configured.researchModel,
      env,
    ),
    summarizationModel: resolveLane(
      "summarization",
      "deepResearchSynthesis",
      configured.summarizationModel,
      env,
    ),
    compressionModel: resolveLane(
      "compression",
      "deepResearchSynthesis",
      configured.compressionModel,
      env,
    ),
    finalReportModel: resolveLane(
      "final-report",
      "deepResearchFinalReport",
      configured.finalReportModel,
      env,
    ),
  };
}

export function validateDeepResearchModelPlan(
  value: unknown,
  env?: NodeJS.ProcessEnv,
): DeepResearchModelPlan {
  let plan: DeepResearchModelPlan;
  try {
    plan = DeepResearchModelPlanSchema.parse(value);
  } catch (cause) {
    throw new DeepResearchUnavailableError("supervisor", { cause });
  }
  return resolveDeepResearchModelPlan({
    ...(env === undefined ? {} : { env }),
    configured: {
      supervisorModel: plan.supervisorModel,
      researchModel: plan.researchModel,
      summarizationModel: plan.summarizationModel,
      compressionModel: plan.compressionModel,
      finalReportModel: plan.finalReportModel,
    },
  });
}

export function deepResearchModelPlanFromConfiguration(
  configuration: Configuration,
): DeepResearchModelPlan {
  return DeepResearchModelPlanSchema.parse({
    version: 1,
    supervisorModel: configuration.supervisor_model,
    researchModel: configuration.research_model,
    summarizationModel: configuration.summarization_model,
    compressionModel: configuration.compression_model,
    finalReportModel: configuration.final_report_model,
  });
}
