import type { ServerEvent } from "@nautilo/types";

import {
  forkLanggraphExecutor,
} from "../executors/fork-langgraph-executor";
import {
  langgraphExecutor,
} from "../executors/langgraph-executor";
import type {
  ConversationJobRunner,
} from "./conversation-job-executor";
import {
  createProtectedConversationJobRunner,
  type ProtectedConversationAuthorizedCoreRunner,
} from "./protected-conversation-job-runner";

const mainCore: ProtectedConversationAuthorizedCoreRunner =
  async function* (
    input,
    jobId,
    laneKey,
    signal,
    services,
    _invocation,
    scope,
  ): AsyncGenerator<ServerEvent> {
    yield* langgraphExecutor(
      input,
      jobId,
      laneKey,
      signal,
      services,
      scope,
    );
  };

const forkCore: ProtectedConversationAuthorizedCoreRunner =
  async function* (
    input,
    jobId,
    laneKey,
    signal,
    services,
    _invocation,
    scope,
  ): AsyncGenerator<ServerEvent> {
    yield* forkLanggraphExecutor(
      input,
      jobId,
      laneKey,
      signal,
      services,
      scope,
    );
  };

/**
 * Concrete Wave-9 main/fork runners. They are inert until supplied to the
 * guarded non-production conversation composition.
 */
export function createProtectedConversationExecutorRunners(): Readonly<{
  main: ConversationJobRunner;
  fork: ConversationJobRunner;
}> {
  return Object.freeze({
    main: createProtectedConversationJobRunner({
      entrypointId: "foreground.main",
      run: mainCore,
    }),
    fork: createProtectedConversationJobRunner({
      entrypointId: "foreground.fork",
      run: forkCore,
    }),
  });
}
