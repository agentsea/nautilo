/**
 * Stack 208 P3 — deterministic `StubScript` builders for the long-run and
 * no-progress integration tests. No framework mocks: these only construct
 * the plain response queues consumed by `createStubProvider` (see
 * `helpers/stub-provider.ts`), so the graph still runs the real LangGraph
 * executor, the real tools node, and the real checkpoint saver.
 *
 * Two builders:
 *   - {@link buildSequentialToolRounds}: N sequential successful
 *     model→tool→model rounds (one tool_call per model response) plus a
 *     final sentinel text response. Drives the >100-superstep long-run
 *     path.
 *   - {@link buildRepeatedFailureRounds}: an activation preamble, then N
 *     identical `file.read` failure rounds, plus an unused final sentinel
 *     text response. Drives the no-progress breaker end-to-end.
 */

import type { StubScript } from "./stub-provider";

/** A single scripted model response (mirrors `StubScript.responses[i]`). */
export type StubResponse = NonNullable<StubScript["responses"][number]>;

export interface SequentialToolRoundsOptions {
  /** Number of sequential successful model→tool→model rounds. */
  rounds: number;
  /** Always-eligible cloud tool to call every round. */
  toolName: string;
  /** Args for every tool call. Defaults to a benign `discover_tools` query. */
  toolArgs?: Record<string, unknown>;
  /** Final sentinel text emitted after the last tool round. */
  finalSentinel: string;
  /** Optional tool-call id prefix; ids are suffixed with the round index. */
  toolCallIdPrefix?: string;
}

/**
 * Build a script of N sequential successful tool rounds + one final text
 * sentinel. Each model response carries exactly ONE tool_call (the
 * requirement forbids emitting all N calls in a single response), so the
 * graph executes N real model→tool→model superstep cycles before the
 * final assistant text.
 */
export function buildSequentialToolRounds(
  opts: SequentialToolRoundsOptions,
): { script: StubScript; expectedToolCalls: number; expectedInvocations: number } {
  if (!Number.isInteger(opts.rounds) || opts.rounds < 1) {
    throw new Error(`buildSequentialToolRounds: rounds must be a positive integer (got ${opts.rounds})`);
  }
  const prefix = opts.toolCallIdPrefix ?? `stub-${opts.toolName}-`;
  const args = opts.toolArgs ?? { query: "filesystem" };
  const responses: StubResponse[] = [];
  for (let i = 1; i <= opts.rounds; i++) {
    responses.push({
      type: "tool_call",
      name: opts.toolName,
      args,
      id: `${prefix}${i}`,
    });
  }
  responses.push({ type: "text", content: opts.finalSentinel });
  return {
    script: { responses },
    expectedToolCalls: opts.rounds,
    expectedInvocations: opts.rounds + 1,
  };
}

export interface RepeatedFailureRoundsOptions {
  /** Number of identical `file.read` failure rounds. */
  rounds: number;
  /** Tool to activate before the failure rounds (defaults to `file`). */
  activateToolName?: string;
  /** Identical args for every failure round. */
  failureArgs: Record<string, unknown>;
  /** Final sentinel text that must NOT be consumed (the breaker stops first). */
  unusedSentinel: string;
  /** Optional tool-call id prefixes. */
  activateCallId?: string;
  failureCallIdPrefix?: string;
}

/**
 * Build a script of one activation preamble + N identical `file.read`
 * failure rounds + one unused final sentinel. The breaker fires after the
 * limit, so the final sentinel is never consumed by the model.
 */
export function buildRepeatedFailureRounds(
  opts: RepeatedFailureRoundsOptions,
): {
  script: StubScript;
  expectedConsumedInvocations: number;
  expectedRemaining: number;
  expectedFailureRounds: number;
} {
  if (!Number.isInteger(opts.rounds) || opts.rounds < 1) {
    throw new Error(`buildRepeatedFailureRounds: rounds must be a positive integer (got ${opts.rounds})`);
  }
  const activate = opts.activateToolName ?? "file";
  const activateId = opts.activateCallId ?? `activate-${activate}`;
  const failPrefix = opts.failureCallIdPrefix ?? `fail-${activate}-`;
  const responses: StubResponse[] = [
    {
      type: "tool_call",
      name: "activate_tools",
      args: { names: [activate], families: [] },
      id: activateId,
    },
  ];
  for (let i = 1; i <= opts.rounds; i++) {
    responses.push({
      type: "tool_call",
      name: activate,
      args: opts.failureArgs,
      id: `${failPrefix}${i}`,
    });
  }
  responses.push({ type: "text", content: opts.unusedSentinel });
  return {
    script: { responses },
    // The breaker stops on the Nth failure; the N failure responses +
    // the activation preamble are consumed, the sentinel is not.
    expectedConsumedInvocations: opts.rounds + 1,
    expectedRemaining: 1,
    expectedFailureRounds: opts.rounds,
  };
}
