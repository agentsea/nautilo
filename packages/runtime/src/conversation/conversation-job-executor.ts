import type { ServerEvent } from "@nautilo/types";

import type { JobExecutor } from "../job";
import {
  resolveConversationExecutionServices,
  type ConversationComposition,
} from "./conversation-composition";
import type {
  ConversationExecutionServices,
  ProtectedConversationExecutionServices,
} from "./conversation-execution-services";
import type {
  ProtectedConversationProductReadAuthorization,
} from "./active-conversation-repository";

export type ProtectedConversationInvocation = Readonly<{
  readonly sessionId: string;
  readonly namespaceId: string;
  readonly productReadAuthorization:
    ProtectedConversationProductReadAuthorization;
}>;

export type ConversationJobRunner = (
  input: Record<string, unknown>,
  jobId: string,
  laneKey: string | null,
  signal: AbortSignal,
  services: ProtectedConversationExecutionServices,
  invocation: ProtectedConversationInvocation,
) => AsyncGenerator<ServerEvent>;

export type ProtectedConversationInvocationResolver = (
  input: Readonly<Record<string, unknown>>,
) =>
  | ProtectedConversationInvocation
  | null
  | PromiseLike<ProtectedConversationInvocation | null>;

function isForkJob(input: Readonly<Record<string, unknown>>): boolean {
  const forkRun = input["forkRun"];
  return typeof forkRun === "object"
    && forkRun !== null
    && "mode" in forkRun
    && forkRun.mode === "fork";
}

/**
 * Selects the existing executor by identity when protected composition is
 * absent. This preserves JobManager's legacy singleton comparison and all
 * disabled-path behavior.
 *
 * A protected executor must route forks itself: JobManager deliberately
 * reuses a custom thread executor for fork jobs instead of replacing it with
 * the global fork singleton.
 */
export function resolveConversationJobExecutor(input: Readonly<{
  readonly defaultLegacyExecutor: JobExecutor;
  readonly defaultLegacyForkExecutor?: JobExecutor;
  readonly defaultLegacyServices: ConversationExecutionServices;
  readonly composition?: ConversationComposition;
  readonly resolveProtectedInvocation?:
    ProtectedConversationInvocationResolver;
  readonly protectedRunners?: Readonly<{
    readonly main: ConversationJobRunner;
    readonly fork: ConversationJobRunner;
  }>;
}>): JobExecutor {
  if (input.composition === undefined) {
    return input.defaultLegacyExecutor;
  }
  if (input.composition.mode === "legacy") {
    resolveConversationExecutionServices({
      defaultLegacyServices: input.defaultLegacyServices,
      composition: input.composition,
      origin: { entrypointId: "foreground.main" },
      resolvedNamespaceId: null,
    });
    return input.defaultLegacyExecutor;
  }
  const protectedComposition = input.composition;
  const runners = input.protectedRunners;
  if (runners === undefined) {
    throw new TypeError(
      "Protected test shadow composition requires protected job runners",
    );
  }
  const resolveProtectedInvocation = input.resolveProtectedInvocation;
  if (resolveProtectedInvocation === undefined) {
    throw new TypeError(
      "Protected test shadow composition requires an invocation resolver",
    );
  }
  const legacyForkExecutor = input.defaultLegacyForkExecutor;
  if (legacyForkExecutor === undefined) {
    throw new TypeError(
      "Protected test shadow composition requires the legacy fork executor",
    );
  }

  return async function* (
    jobInput,
    jobId,
    laneKey,
    signal,
  ): AsyncGenerator<ServerEvent> {
    const fork = isForkJob(jobInput);
    const invocation = await resolveProtectedInvocation(jobInput);
    const selection = resolveConversationExecutionServices({
      defaultLegacyServices: input.defaultLegacyServices,
      composition: protectedComposition,
      origin: {
        entrypointId: fork ? "foreground.fork" : "foreground.main",
      },
      resolvedNamespaceId: invocation?.namespaceId ?? null,
    });
    if (selection.mode === "legacy") {
      yield* (fork ? legacyForkExecutor : input.defaultLegacyExecutor)(
        jobInput,
        jobId,
        laneKey,
        signal,
      );
      return;
    }
    if (invocation === null) {
      throw new TypeError(
        "Protected conversation selection lost its invocation binding",
      );
    }
    yield* (fork ? runners.fork : runners.main)(
      jobInput,
      jobId,
      laneKey,
      signal,
      selection.services,
      invocation,
    );
  };
}
