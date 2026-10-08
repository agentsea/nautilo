import type { ServerEvent } from "@nautilo/types";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  appendTranscriptMessages,
  createDeepResearchGraph,
  DeepResearchUnavailableError,
  fromAdmittedDeepResearchModelPlan,
  fromDeepResearchConfig,
  getCapabilityFundingSession,
  getUsageContext,
  parseDeepResearchTaskMetadataValue,
  runWithDeepResearchFunding,
  type AdmittedDeepResearchTaskMetadata,
  runWithUsageContext,
  validateDeepResearchModelPlan,
} from "@nautilo/agent";
import { log, warn } from "@nautilo/logger";
import { eventBus } from "../event-bus";

interface DeepResearchReturnRoute {
  ownerId: string;
  requestorId: string;
  roomId: string;
  laneKey: string;
  agentId: string;
  graphThreadId: string;
}

function readReturnRoute(input: Record<string, unknown>): DeepResearchReturnRoute | null {
  const value = input["deep_research_return_context"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const route = value as Record<string, unknown>;
  const ownerId = typeof route["ownerId"] === "string" ? route["ownerId"] : "";
  const requestorId = typeof route["requestorId"] === "string" ? route["requestorId"] : "";
  const roomId = typeof route["roomId"] === "string" ? route["roomId"] : "";
  const laneKey = typeof route["laneKey"] === "string" ? route["laneKey"] : "";
  const agentId = typeof route["agentId"] === "string" ? route["agentId"] : "";
  const graphThreadId = typeof route["graphThreadId"] === "string" ? route["graphThreadId"] : "";
  if (!ownerId || !requestorId || !roomId || !agentId || !graphThreadId || laneKey !== `room:${roomId}`) {
    return null;
  }
  return { ownerId, requestorId, roomId, laneKey, agentId, graphThreadId };
}

function sameDeepResearchModelPlan(
  admitted: AdmittedDeepResearchTaskMetadata["modelPlan"],
  value: unknown,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join(",") !== "compressionModel,finalReportModel,researchModel,summarizationModel,supervisorModel,version") return false;
  return candidate["version"] === 1
    && candidate["supervisorModel"] === admitted.supervisorModel
    && candidate["researchModel"] === admitted.researchModel
    && candidate["summarizationModel"] === admitted.summarizationModel
    && candidate["compressionModel"] === admitted.compressionModel
    && candidate["finalReportModel"] === admitted.finalReportModel;
}

type AppendTranscript = typeof appendTranscriptMessages;

/** Deep-Research-only durable delivery. The stable message id makes retries idempotent. */
export async function deliverDeepResearchReport(
  jobId: string,
  report: string,
  route: DeepResearchReturnRoute,
  dependencies: {
    append?: AppendTranscript;
    emit?: (event: ServerEvent) => void;
  } = {},
): Promise<boolean> {
  const append = dependencies.append ?? appendTranscriptMessages;
  const emit = dependencies.emit ?? ((event: ServerEvent) => eventBus.emit(event));
  const result = await append(
    route.graphThreadId,
    route.ownerId,
    "owner",
    [new AIMessage({ content: report, id: `deep-research-result:${jobId}` })],
    { agentId: route.agentId, roomId: route.roomId },
  );
  const row = result.insertedRows[0];
  if (!row) return false;
  emit({
    type: "message.new",
    laneKey: route.laneKey,
    messageId: row.id,
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    role: "ai",
    content: report,
    authorAgentId: route.agentId,
  });
  return true;
}

export function resolveDeepResearchExecutorConfiguration(
  input: Record<string, unknown>,
  env?: NodeJS.ProcessEnv,
): ReturnType<typeof fromDeepResearchConfig> {
  const admitted = readAdmittedFunding(input);
  const storedPlan = input["deep_research_model_plan"];
  let configuration: ReturnType<typeof fromDeepResearchConfig>;
  if (admitted) {
    if (!getCapabilityFundingSession()) throw new DeepResearchFundingUnavailableError();
    const inputPlan = storedPlan === undefined ? admitted.modelPlan : storedPlan;
    if (!sameDeepResearchModelPlan(admitted.modelPlan, inputPlan)) {
      throw new DeepResearchFundingUnavailableError();
    }
    configuration = fromAdmittedDeepResearchModelPlan(
      admitted.modelPlan,
      undefined,
      env ?? process.env,
    );
  } else if (storedPlan === undefined) {
    configuration = fromDeepResearchConfig(undefined, env === undefined ? {} : { env });
  } else {
    const modelPlan = validateDeepResearchModelPlan(storedPlan, env);
    configuration = fromDeepResearchConfig(undefined, {
      ...(env === undefined ? {} : { env }),
      modelPlan,
    });
  }
  const environment = env ?? process.env;
  if (!admitted && configuration.search_api === "tavily" && !environment["TAVILY_API_KEY"]?.trim()) {
    throw new DeepResearchSearchUnavailableError();
  }
  return configuration;
}

function readAdmittedFunding(input: Record<string, unknown>): AdmittedDeepResearchTaskMetadata | null {
  if (input["deep_research_funding"] === undefined) return null;
  const metadata = parseDeepResearchTaskMetadataValue(input["deep_research_funding"]);
  if (metadata.version !== 2) throw new DeepResearchFundingUnavailableError();
  return metadata;
}

export class DeepResearchFundingUnavailableError extends Error {
  readonly code = "deep_research_funding_unavailable" as const;
  constructor() {
    super("Deep Research cannot resume because its admitted funding authority is unavailable.");
    this.name = "DeepResearchFundingUnavailableError";
  }
}

export class DeepResearchSearchUnavailableError extends Error {
  readonly code = "deep_research_search_unavailable" as const;

  constructor() {
    super(
      "Deep Research is unavailable because Tavily is not configured. " +
      "Ask a server operator to configure Tavily, then try again.",
    );
    this.name = "DeepResearchSearchUnavailableError";
  }
}

export interface DeepResearchExecutionProgress {
  readonly phase: string;
  readonly detail?: string;
}

export type DeepResearchReportStream = AsyncGenerator<
  DeepResearchExecutionProgress,
  string
>;

export interface DeepResearchUsageAttribution {
  readonly roomId: string | null;
  readonly taskId: string;
  readonly taskRunId: string;
  readonly agentId: string;
}

type DeepResearchReportStreamFactory = (
  input: Record<string, unknown>,
  executionId: string,
  signal: AbortSignal,
) => DeepResearchReportStream;

type DeepResearchEventStreamFactory = (
  graph: ReturnType<typeof createDeepResearchGraph>,
  input: Record<string, unknown>,
  config: Record<string, unknown>,
) => AsyncIterable<unknown>;

let reportStreamOverrideForTests: DeepResearchReportStreamFactory | null = null;
let eventStreamOverrideForTests: DeepResearchEventStreamFactory | null = null;

/** Test-only seam shared by Task integration tests; production always runs the real graph. */
export function _setDeepResearchReportStreamForTests(
  factory: DeepResearchReportStreamFactory | null,
): void {
  reportStreamOverrideForTests = factory;
}

/** Test-only seam for proving eager LangGraph stream construction retains funding scope. */
export function _setDeepResearchEventStreamForTests(
  factory: DeepResearchEventStreamFactory | null,
): void {
  eventStreamOverrideForTests = factory;
}

async function* runDeepResearchReportStream(
  input: Record<string, unknown>,
  executionId: string,
  signal: AbortSignal,
): DeepResearchReportStream {
  const researchBrief =
    typeof input["research_brief"] === "string" ? input["research_brief"] : "";

  if (!researchBrief) {
    yield { phase: "Error", detail: "No research brief provided" };
    throw new TypeError("Deep Research job has no research brief");
  }

  let researchConfiguration: ReturnType<typeof fromDeepResearchConfig>;
  let admittedFunding: AdmittedDeepResearchTaskMetadata | null = null;
  try {
    admittedFunding = readAdmittedFunding(input);
    researchConfiguration = resolveDeepResearchExecutorConfiguration(input);
  } catch (error) {
    const detail = error instanceof DeepResearchUnavailableError
      || error instanceof DeepResearchSearchUnavailableError
      || error instanceof DeepResearchFundingUnavailableError
      ? error.message
      : "Deep Research model configuration is unavailable.";
    yield { phase: "Unavailable", detail };
    throw error;
  }

  log(`[deep-research-executor] Starting background research: "${researchBrief.slice(0, 80)}..."`);
  yield { phase: "Starting deep research..." };

  const graph = createDeepResearchGraph(undefined, researchConfiguration);
  const threadId = `bg-research:${executionId}`;
  let finalReport = "";

  try {
    const reportLanguage =
      typeof input["report_language"] === "string" ? input["report_language"] : "English";
    const streamConfig: Record<string, unknown> = {
      configurable: { thread_id: threadId },
      signal,
      version: "v2",
    };

    const researchFunding = admittedFunding ? {
      modelFunding: admittedFunding.modelFunding,
      tavilyFunding: admittedFunding.tavilyFunding,
    } : undefined;
    const eventIterator = runWithDeepResearchFunding(researchFunding, () => {
      const eventStream = (eventStreamOverrideForTests
        ?? ((targetGraph, graphInput, graphConfig) => targetGraph.streamEvents(graphInput, graphConfig)))(
        graph,
        {
          messages: [new HumanMessage(researchBrief)],
          research_brief: researchBrief,
          report_language: reportLanguage,
        },
        streamConfig,
      );
      return eventStream[Symbol.asyncIterator]();
    });
    let eventStreamComplete = false;
    try {
      for (;;) {
        const next = await runWithDeepResearchFunding(
          researchFunding,
          () => eventIterator.next(),
        );
        if (next.done) {
          eventStreamComplete = true;
          break;
        }
        const ev = next.value;
        if (signal.aborted) return "";

        if (!ev || typeof ev !== "object") continue;
        const eventObj = ev as Record<string, unknown>;
        const event = typeof eventObj["event"] === "string" ? eventObj["event"] : "";
        const name = typeof eventObj["name"] === "string" ? eventObj["name"] : "";
        const data = eventObj["data"] as Record<string, unknown> | undefined;

        if (event === "on_custom_event" && name === "job.progress" && data) {
          const phase = typeof data["phase"] === "string" ? data["phase"] : "Processing...";
          yield { phase };
        }

        if (event === "on_chain_end" && data) {
          const output = data["output"] as Record<string, unknown> | undefined;
          if (output && typeof output["final_report"] === "string") {
            finalReport = output["final_report"];
          }
        }
      }
    } finally {
      if (!eventStreamComplete && eventIterator.return) {
        await runWithDeepResearchFunding(researchFunding, () => eventIterator.return!());
      }
    }

    if (!finalReport.trim()) {
      throw new Error("Deep Research completed without a report");
    }
    log(`[deep-research-executor] Research complete, report length: ${finalReport.length}`);
    return finalReport.trim();
  } catch (error) {
    if (signal.aborted) return "";
    const msg = error instanceof Error ? error.message : String(error);
    warn(`[deep-research-executor] Research failed: ${msg}`);
    yield {
      phase: "Error",
      detail: "Deep Research could not complete. Please try again.",
    };
    throw error;
  }
}

export function streamDeepResearchReport(
  input: Record<string, unknown>,
  executionId: string,
  signal: AbortSignal,
  initiatingHumanUserId?: string,
  attribution?: DeepResearchUsageAttribution,
): DeepResearchReportStream {
  const originatingUsageContext = getUsageContext();
  const source = (reportStreamOverrideForTests ?? runDeepResearchReportStream)(
    input,
    executionId,
    signal,
  );
  const humanUserId = initiatingHumanUserId?.trim() ?? "";
  return (async function* (): DeepResearchReportStream {
    const usageContext = {
      callType: "subagent" as const,
      userId: humanUserId,
      ...(attribution
        ? { roomId: attribution.roomId }
        : originatingUsageContext?.roomId === undefined
          ? {}
          : { roomId: originatingUsageContext.roomId }),
      metadata: {
        ...(originatingUsageContext?.metadata ?? {}),
        ...(attribution ? {
          taskId: attribution.taskId,
          taskRunId: attribution.taskRunId,
          agentId: attribution.agentId,
        } : {}),
        executionId,
        operation: "deep_research",
      },
    };
    let sourceComplete = false;
    try {
      for (;;) {
        const next = await runWithUsageContext(usageContext, () => source.next());
        if (next.done) {
          sourceComplete = true;
          return next.value;
        }
        yield next.value;
      }
    } finally {
      if (!sourceComplete) {
        await runWithUsageContext(usageContext, () => source.return(""));
      }
    }
  })();
}

/**
 * Background executor for deep research jobs.
 * Runs the deep-research 3-tier graph and yields ServerEvents for progress + results.
 */
export async function* deepResearchExecutor(
  input: Record<string, unknown>,
  jobId: string,
  laneKey: string | null,
  signal: AbortSignal,
): AsyncGenerator<ServerEvent> {
  const routed = <T extends ServerEvent>(event: T): T => (
    laneKey ? { ...event, laneKey } : event
  );
  const stream = streamDeepResearchReport(
    input,
    jobId,
    signal,
    readReturnRoute(input)?.requestorId,
  );
  let finalReport = "";
  let streamComplete = false;
  try {
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        streamComplete = true;
        finalReport = next.value;
        break;
      }
      yield routed({
        type: "job.progress",
        kind: "deep-research",
        jobId,
        phase: next.value.phase,
        ...(next.value.detail ? { detail: next.value.detail } : {}),
      });
    }
  } finally {
    if (!streamComplete) {
      await stream.return("");
    }
  }
  if (signal.aborted) return;
  const returnRoute = readReturnRoute(input);
  if (!returnRoute || returnRoute.laneKey !== laneKey) {
    throw new Error("Deep Research return route is unavailable");
  }
  await deliverDeepResearchReport(jobId, finalReport, returnRoute);
  yield { type: "worker.complete", jobId, result: "success" };
}
