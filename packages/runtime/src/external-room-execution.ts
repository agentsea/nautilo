import { AsyncLocalStorage } from "node:async_hooks";
import type { ExternalMessageOrigin, JobStatus } from "@nautilo/types";
import type { AcceptedInvocationAuthority } from "@nautilo/trust";
import type { JobExecutor } from "./job";

import type { ExternalRoomJobReference, ExternalRoomExecutionClaim } from "@nautilo/db";
export type { ExternalRoomJobReference } from "@nautilo/db";

/** Process-local authority reconstructed by Server from the exact durable receipt. */
export interface ExternalRoomExecutionContext {
  readonly operatorControl?: "operator_control_v1";
  readonly origin: ExternalMessageOrigin;
  readonly reference: ExternalRoomJobReference;
  readonly sponsorUserId: string;
  assertSponsorship(): Promise<void>;
  complete(finalText: string): Promise<void>;
}

const executionStorage = new AsyncLocalStorage<ExternalRoomExecutionContext>();

export function getCurrentExternalRoomExecution(): ExternalRoomExecutionContext | undefined {
  return executionStorage.getStore();
}

/** An already committed Job, never a request to mint a second Job or acceptance. */
export interface ExternalRoomExecutionCandidate {
  readonly jobId: string;
  readonly reference: ExternalRoomJobReference;
  readonly sponsorUserId: string;
  readonly invocationAuthority: AcceptedInvocationAuthority;
  verifyPersisted(): Promise<void>;
  linkAcceptance(): Promise<void>;
  updateStatus(status: JobStatus, reason?: "user_stop" | "maintenance" | "authority_withdrawn", executionClaim?: ExternalRoomExecutionClaim): Promise<JobStatus>;
  hydrate(): Promise<{ input: Record<string, unknown>; context: ExternalRoomExecutionContext }>;
}

export function externalRoomExecutor(
  candidate: ExternalRoomExecutionCandidate,
  executor: JobExecutor,
): JobExecutor {
  return async function* (_input, jobId, laneKey, signal) {
    if (jobId !== candidate.jobId) throw new Error("external_room_job_mismatch");
    signal.throwIfAborted();
    const loaded = await candidate.hydrate();
    await loaded.context.assertSponsorship();
    signal.throwIfAborted();
    const events = executor(loaded.input, jobId, laneKey, signal);
    try {
      while (true) {
        const next = await executionStorage.run(loaded.context, () => events.next());
        if (next.done) return;
        if (!loaded.context.operatorControl) yield next.value;
      }
    } finally {
      await executionStorage.run(loaded.context, () => events.return(undefined));
    }
  };
}
