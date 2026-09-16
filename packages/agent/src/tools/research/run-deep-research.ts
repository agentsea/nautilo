import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { warn } from "@nautilo/logger";
import { getDeepResearchReturnContext } from "../../runtime/deep-research-return-context";
import { getTaskToolRuntime, type TaskToolCreateInput } from "../tasks/task-tool-runtime";
import {
  DeepResearchUnavailableError,
  deepResearchModelPlanFromConfiguration,
} from "../../subagents/deep-research/shared/model-plan";
import { fromRuntimeConfig } from "../../subagents/deep-research/shared/config";
import { deepResearchTaskMetadata } from "../../subagents/deep-research/shared/task-metadata";

function unavailableMessage(error: unknown): string | null {
  if (!(error instanceof DeepResearchUnavailableError)) return null;
  return `${error.message} Ask a server operator to configure an eligible model credential, then try again.`;
}

export class DeepResearchAdmissionError extends Error {
  readonly code = "deep_research_admission_failed" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DeepResearchAdmissionError";
  }
}

interface DeepResearchToolDependencies {
  resolveConfiguration?: typeof fromRuntimeConfig;
  hasSearchCredential?: () => boolean;
  createTask?: (
    input: TaskToolCreateInput,
  ) => Promise<{ taskId: string; status: string; nextFireAt?: Date | undefined }>;
}

export function createRunDeepResearchTool(
  dependencies: DeepResearchToolDependencies = {},
) {
  const resolveConfiguration = dependencies.resolveConfiguration ?? fromRuntimeConfig;
  const createTask = dependencies.createTask ?? ((input: TaskToolCreateInput) =>
    getTaskToolRuntime().createTask(input));
  return new DynamicStructuredTool({
    name: "run_deep_research",
    description: `Invoke the Deep Research Agent for comprehensive, multi-step research.

Use this tool when the user needs:
- Thorough analysis of complex, multi-faceted topics
- Comprehensive reports with multiple sources and citations
- Deep investigation requiring parallel research across sub-topics
- Anything explicitly described as "deep research" or "comprehensive report"

Do NOT use for simple factual questions — use run_web_search instead.
Deep research always runs as a background Task and requires Tavily. Return the task acknowledgement promptly; the report will be delivered when ready. Inform the user it will take time.

IMPORTANT: After receiving the report from this tool, do NOT run additional web searches to verify or supplement it. The report already contains sources and citations from thorough multi-step research. Simply share the report with the user — a brief intro is fine, but do not re-research.`,
    schema: z.object({
      research_brief: z.string().describe("Clear, detailed description of what to research. Be specific about scope and focus areas."),
      report_language: z.string().optional().describe("Language for the final report. Detect from the user's message — if they wrote in English, use 'English'; if French, 'French'; etc. Defaults to English if unclear."),
    }),
    func: async (
      { research_brief, report_language }: { research_brief: string; report_language?: string },
    ) => {
      if (!(dependencies.hasSearchCredential ?? (() => Boolean(process.env["TAVILY_API_KEY"]?.trim())))()) {
        throw new DeepResearchAdmissionError(
          "Deep research is unavailable because Tavily is not configured. Ask a server operator to configure Tavily, then try again.",
        );
      }
      const language = report_language || "English";
      let researchConfiguration: ReturnType<typeof fromRuntimeConfig>;
      try {
        researchConfiguration = resolveConfiguration();
      } catch (error) {
        const message = unavailableMessage(error);
        if (message) throw new DeepResearchAdmissionError(message, { cause: error });
        warn(`[deep-research] Model configuration admission failed: ${error instanceof Error ? error.message : String(error)}`);
        throw new DeepResearchAdmissionError(
          "Deep research model configuration could not be validated. Ask a server operator to review the configured research models, then try again.",
          { cause: error },
        );
      }
      const modelPlan = deepResearchModelPlanFromConfiguration(researchConfiguration);

      try {
        const returnContext = getDeepResearchReturnContext();
        if (!returnContext) {
          throw new DeepResearchAdmissionError(
            "Deep Research requires an active foreground Room. Start it from the Room where you want the report delivered.",
          );
        }
        const task = await createTask({
          ownerId: returnContext.ownerId,
          requestorId: returnContext.requestorId,
          agentId: returnContext.agentId,
          prompt: research_brief,
          preset: "in_background",
          scheduleKind: "now",
          useScope: false,
          targetChat: "orphan",
          resultDelivery: "raw_and_wake",
          awaitResponse: false,
          callingRoomId: returnContext.roomId,
          targetUserIds: [returnContext.requestorId],
          toolsMode: "none",
          depth: 0,
          ...(returnContext.modelId ? { requestedModelId: returnContext.modelId } : {}),
          metadata: deepResearchTaskMetadata({
            reportLanguage: language,
            modelPlan,
            invokingModelId: returnContext.modelId,
          }),
        });
        return `I've started deep research on "${research_brief.slice(0, 80)}${research_brief.length > 80 ? "..." : ""}" in the background. You can keep chatting — I'll share the results when they're ready. (Task ID: ${task.taskId})`;
      } catch (e) {
        if (e instanceof DeepResearchAdmissionError) throw e;
        warn(`[deep-research] Background task creation failed: ${e instanceof Error ? e.message : String(e)}`);
        throw new DeepResearchAdmissionError(
          "Deep research could not confirm that its background Task started. Check Tasks before retrying.",
          { cause: e },
        );
      }
    },
  });
}
