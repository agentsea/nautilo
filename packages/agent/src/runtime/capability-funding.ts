import { AsyncLocalStorage } from "node:async_hooks";
import type { TaskFundingBinding } from "@nautilo/types";
import type { ForegroundChatFundingSession } from "./foreground-chat-funding";
import type { UsageFundingProvenance } from "../usage/usage-context";

import type { PersonalCapabilityRole } from "@nautilo/types";
export type { PersonalCapabilityRole } from "@nautilo/types";

export interface CapabilityModelSelection {
  readonly modelId: string;
  readonly preferenceRevision: number;
}

export interface AdmittedCapabilityModel {
  readonly binding: TaskFundingBinding;
  readonly fundingSession: ForegroundChatFundingSession;
}

export interface AdmittedCapabilityService {
  readonly binding: TaskFundingBinding;
  runAttempt<T>(callback: (attempt: {
    readonly apiKey: string;
    readonly usageFunding: UsageFundingProvenance;
  }) => Promise<T>): Promise<T>;
}

/**
 * Installed only by the execution owner after binding the causal Human and
 * supported Room/Task shape. Each child operation is admitted independently;
 * its returned binding pins later attempts and durable continuation.
 * This process-local authority must never be placed in graph configuration.
 */
export interface CapabilityFundingSession {
  readonly humanUserId: string;
  readonly parentFundingKind?: "personal" | "server";
  /** Pre-admitted default decision model for honest synchronous tool exposure. */
  readonly decisionModelId?: string | null;
  resolveModel(role: PersonalCapabilityRole, configuredId?: string | null): Promise<CapabilityModelSelection>;
  openModel(modelId: string, workload: "research" | "decision", prior?: TaskFundingBinding): Promise<AdmittedCapabilityModel>;
  openService(provider: "tavily", prior?: TaskFundingBinding): Promise<AdmittedCapabilityService>;
}

const scope = new AsyncLocalStorage<CapabilityFundingSession>();

export function runWithCapabilityFundingSession<T>(session: CapabilityFundingSession | undefined, run: () => T): T {
  return session ? scope.run(session, run) : scope.exit(run);
}

export function getCapabilityFundingSession(): CapabilityFundingSession | undefined {
  return scope.getStore();
}
