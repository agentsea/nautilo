import type { ServerEvent } from "@nautilo/types";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  appendTranscriptMessages,
  createDeepResearchGraph,
  DeepResearchUnavailableError,
  fromDeepResearchConfig,
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
  const storedPlan = input["deep_research_model_plan"];
  let configuration: ReturnType<typeof fromDeepResearchConfig>;
  if (storedPlan === undefined) {
    configuration = fromDeepResearchConfig(undefined, env === undefined ? {} : { env });
  } else {
    const modelPlan = validateDeepResearchModelPlan(storedPlan, env);
    configuration = fromDeepResearchConfig(undefined, {
      ...(env === undefined ? {} : { env }),
      modelPlan,
    });
  }
  const environment = env ?? process.env;
  if (configuration.search_api === "tavily" && !environment["TAVILY_API_KEY"]?.trim()) {
    throw new DeepResearchSearchUnavailableError();
  }
  return configuration;
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

type DeepResearchReportStreamFactory = (
  input: Record<string, unknown>,
  executionId: string,
  signal: AbortSignal,
) => DeepResearchReportStream;

let reportStreamOverrideForTests: DeepResearchReportStreamFactory | null = null;

/** Test-only seam shared by Task integration tests; production always runs the real graph. */
export function _setDeepResearchReportStreamForTests(
  factory: DeepResearchReportStreamFactory | null,
): void {
  reportStreamOverrideForTests = factory;
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
  try {
    researchConfiguration = resolveDeepResearchExecutorConfiguration(input);
  } catch (error) {
    const detail = error instanceof DeepResearchUnavailableError
      || error instanceof DeepResearchSearchUnavailableError
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

    const eventStream = graph.streamEvents(
      {
        messages: [new HumanMessage(researchBrief)],
        research_brief: researchBrief,
        report_language: reportLanguage,
      },
      streamConfig,
    );

    for await (const ev of eventStream) {
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
): DeepResearchReportStream {
  const source = (reportStreamOverrideForTests ?? runDeepResearchReportStream)(
    input,
    executionId,
    signal,
  );
  const humanUserId = initiatingHumanUserId?.trim() ?? "";
  return (async function* (): DeepResearchReportStream {
    for (;;) {
      const next = await runWithUsageContext(
        {
          callType: "subagent",
          userId: humanUserId,
          metadata: { executionId, operation: "deep_research" },
        },
        () => source.next(),
      );
      if (next.done) return next.value;
      yield next.value;
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
  for (;;) {
    const next = await stream.next();
    if (next.done) {
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
  if (signal.aborted) return;
  const returnRoute = readReturnRoute(input);
  if (!returnRoute || returnRoute.laneKey !== laneKey) {
    throw new Error("Deep Research return route is unavailable");
  }
  await deliverDeepResearchReport(jobId, finalReport, returnRoute);
  yield { type: "worker.complete", jobId, result: "success" };
}
