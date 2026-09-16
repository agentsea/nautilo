import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import {
  invokeChatModelWithFallback,
  resolveModelRole,
  runWithUsageContext,
} from "@nautilo/agent";

/**
 * M135 P5 — production Floor Manager model invoker. Resolves the configured
 * conductor model (using the automatic auxiliary-role preference when empty) and
 * invokes it through the D141 fallback chain. Returns the raw text response.
 *
 * Throws on model/timeout error so the caller (`runFloorManager`) degrades to
 * silence. NEVER escalates to a bigger model beyond the user's own fallback
 * chain.
 */
export function resolveConductorModelId(configuredModelId: string): string {
  const trimmed = configuredModelId.trim();
  return resolveModelRole("conductor", {
    ...(trimmed.length > 0 ? { configuredId: trimmed } : {}),
  });
}

/** Shared precedence for server-owned Room-side model lanes. */
export function resolveRoomSideModelId(input: {
  serverConfiguredModelId: string | null | undefined;
  runtimeConfiguredModelId: string;
}): string {
  const serverConfigured = input.serverConfiguredModelId?.trim() ?? "";
  return resolveConductorModelId(
    serverConfigured.length > 0
      ? serverConfigured
      : input.runtimeConfiguredModelId,
  );
}

/** M219 — explicit Stenographer selection, otherwise inherit Conductor. */
export function resolveStenographerModelId(input: {
  serverConfiguredModelId: string | null | undefined;
  serverConfiguredConductorModelId: string | null | undefined;
  runtimeConfiguredConductorModelId: string;
}): string {
  const stenographer = input.serverConfiguredModelId?.trim() ?? "";
  return stenographer.length > 0
    ? resolveModelRole("stenographer", { configuredId: stenographer })
    : resolveRoomSideModelId({
        serverConfiguredModelId: input.serverConfiguredConductorModelId,
        runtimeConfiguredModelId: input.runtimeConfiguredConductorModelId,
      });
}

/** Memory inherits Conductor, while retaining its stronger tools requirement. */
export function resolveMemoryReviewModelId(input: {
  serverConfiguredModelId: string | null | undefined;
  serverConfiguredConductorModelId: string | null | undefined;
  runtimeConfiguredConductorModelId: string;
}): string {
  const configuredId = input.serverConfiguredModelId?.trim() || resolveRoomSideModelId({
    serverConfiguredModelId: input.serverConfiguredConductorModelId,
    runtimeConfiguredModelId: input.runtimeConfiguredConductorModelId,
  });
  return resolveModelRole("memoryReview", { configuredId });
}

/** M271 — explicit Reflection/Sleep selection, otherwise inherit Stenographer. */
export function resolveReflectionModelId(input: {
  serverConfiguredModelId: string | null | undefined;
  resolvedStenographerModelId: string;
}): string {
  const reflection = input.serverConfiguredModelId?.trim() ?? "";
  return reflection.length > 0
    ? resolveModelRole("stenographer", { configuredId: reflection })
    : input.resolvedStenographerModelId;
}

function extractText(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && "text" in part
            ? String((part as { text: unknown }).text)
            : "",
      )
      .join("");
  }
  return "";
}

export function createConductorModelInvoker(opts: {
  modelId: string;
  userId: string;
  agentId: string | null;
  laneKey: string | null;
  /**
   * D421 Phase 2 — exact-model evaluations pass `"none"` so the reported
   * model is the model actually scored. Production callers omit this and keep
   * the existing per-agent fallback-chain behavior.
   */
  modelFallbackMode?: "agent_chain" | "none";
}): (prompt: string) => Promise<string> {
  const modelId = resolveConductorModelId(opts.modelId);
  const roomId = opts.laneKey?.startsWith("room:") ? opts.laneKey.slice(5) : null;
  return async (prompt: string) => {
    // Costs dashboard (D405): attribute Floor Manager spend as `conductor`.
    const { response } = await runWithUsageContext(
      { callType: "conductor", userId: opts.userId, roomId },
      () =>
        invokeChatModelWithFallback(
          [new HumanMessage(prompt)],
          [],
          modelId,
          opts.userId,
          opts.agentId,
          opts.laneKey,
          undefined,
          {
            reasoningOutput: false,
            modelFallbackMode: opts.modelFallbackMode ?? "agent_chain",
          },
        ),
    );
    return extractText(response);
  };
}
