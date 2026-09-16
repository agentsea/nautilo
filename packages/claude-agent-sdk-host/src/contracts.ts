import type { CanUseTool, Query } from "@anthropic-ai/claude-agent-sdk";
import type { RelayClaudeFact, ClaudePermissionDetail } from "@nautilo/relay";

export const CLAUDE_AGENT_SDK_VERSION = "0.3.235" as const;
export const CLAUDE_AGENT_SDK_COMPATIBLE_CLAUDE_CODE_VERSION = "2.1.235" as const;
export const REVIEWED_CLAUDE_CODE_VERSIONS = Object.freeze([
  CLAUDE_AGENT_SDK_COMPATIBLE_CLAUDE_CODE_VERSION,
] as const);

export function isReviewedClaudeCodeVersion(version: string): boolean {
  return (REVIEWED_CLAUDE_CODE_VERSIONS as readonly string[]).includes(version);
}

/**
 * Kept stable for Desktop's ambient-executable resolver. Execution only needs
 * the account/catalog, interrupt, and switch-model review facts.
 */
export interface ClaudeRuntimeFeatures {
  readonly accountInfo: boolean;
  readonly supportedModels: boolean;
  readonly interrupt: boolean;
  readonly modelRefusalFallback: boolean;
  readonly modelRefusalNoFallback: boolean;
  readonly servingModelIdentity: boolean;
  readonly switchModelsOnFlag: boolean;
}

export interface ResolvedClaudeExecutable {
  readonly path: string;
  readonly version: string;
  readonly features: ClaudeRuntimeFeatures;
}

export interface ClaudeExecutableResolver {
  resolve(): Promise<ResolvedClaudeExecutable | null>;
}

export interface ClaudeAgentSdk {
  query(parameters: Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0]): Query;
}

export interface ClaudeLaunchRequest {
  readonly prompt: string;
  readonly workingDirectory: string;
  /** Provider-owned selection. Observed aliases/models are intentionally not compared to it. */
  readonly model: string;
}

export interface ClaudeDiscoveryRequest {
  readonly workingDirectory: string;
  readonly signal?: AbortSignal;
}

export type ClaudeExecutionObservation =
  | Readonly<{ kind: "activity"; activity: "setup" | "hook" | "tool"; state: "started" | "progress" | "completed" | "requested"; toolName?: string }>
  | Readonly<{ kind: "initialized"; model: string; claudeCodeVersion: string }>
  /** Lossless root-assistant stream; the result event proves it is complete. */
  | Readonly<{ kind: "output_delta"; text: string }>
  | Readonly<{ kind: "result"; outcome: "succeeded" }>
  | Readonly<{ kind: "result"; outcome: "failed" | "interrupted" }>
  | Readonly<{ kind: "settled"; settlement: "eof" | "rejected"; afterResult: boolean }>;

export type ClaudeInteraction =
  | Readonly<{ kind: "permission"; interactionRef: string; toolName: string; scope: "root"; allowSession: false; detail?: ClaudePermissionDetail }>
  | Readonly<{
    kind: "question";
    interactionRef: string;
    scope: "root";
    questions: readonly Readonly<{
      text: string;
      header: string;
      multiSelect: boolean;
      allowOther: true;
      options: readonly Readonly<{ label: string; description: string }>[];
    }>[];
  }>;

/** The question answer keys are the exact observed provider question texts. */
export type ClaudeInteractionDecision =
  | Readonly<{ kind: "allow_once" }>
  | Readonly<{ kind: "deny" }>
  | Readonly<{ kind: "answers"; answers: Readonly<Record<string, string>> }>;

export type ClaudeInteractionAuthority = (
  interaction: ClaudeInteraction,
  signal: AbortSignal,
) => Promise<ClaudeInteractionDecision>;

export type ClaudeInterruptOutcome = Readonly<{ outcome: "acknowledged" | "uncertain" }>;
export type ClaudeSteerOutcome = Readonly<{ outcome: "accepted" | "rejected" }>;

export interface ClaudeLaunchHandle {
  readonly available: boolean;
  readonly observations: AsyncIterable<ClaudeExecutionObservation>;
  readonly interrupt: () => Promise<ClaudeInterruptOutcome>;
  /** Delivers one direction to this exact live root Query; it never queues a turn. */
  readonly steer: (prompt: string) => Promise<ClaudeSteerOutcome>;
  readonly close: () => void;
}

export interface ClaudeAgentSdkHostOptions {
  readonly executableResolver: ClaudeExecutableResolver;
  readonly sdk: ClaudeAgentSdk;
  /** Existing discovery-only compatibility callback. */
  readonly onFact: (fact: RelayClaudeFact) => void;
  readonly interactionAuthority?: ClaudeInteractionAuthority;
}

export type ClaudeHostFailure =
  | "CLAUDE_RUNTIME_UNAVAILABLE"
  | "CLAUDE_RUNTIME_INCOMPATIBLE"
  | "CLAUDE_SDK_FAILURE";

export class ClaudeHostError extends Error {
  public constructor(readonly code: ClaudeHostFailure) {
    super(code);
    this.name = "ClaudeHostError";
  }
}

export type ClaudeCanUseTool = CanUseTool;
