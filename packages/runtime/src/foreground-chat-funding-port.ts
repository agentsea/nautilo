import type { ForegroundChatFundingSession } from "@nautilo/agent";
import {
  getAcceptedInvocationAuthoritySubject,
  type AcceptedInvocationAuthority,
} from "@nautilo/trust";

export type ForegroundChatFundingEntrypoint =
  | "foreground.main"
  | "foreground.fork";

export interface ForegroundChatFundingOpenInput {
  readonly humanUserId: string;
  readonly modelId: string;
  readonly roomId: string;
  readonly agentId: string;
  readonly entrypoint: ForegroundChatFundingEntrypoint;
}

export interface ForegroundChatFundingPort {
  openSession(
    input: ForegroundChatFundingOpenInput,
  ): Promise<ForegroundChatFundingSession | null>;
}

export class ForegroundChatFundingAuthorityError extends Error {
  readonly code = "foreground_chat_funding_authority_mismatch" as const;

  constructor() {
    super("Foreground chat funding authority is unavailable for this request.");
    this.name = "ForegroundChatFundingAuthorityError";
  }
}

export class ForegroundChatFundingUnsupportedWorkloadError extends Error {
  readonly code = "personal_funding_unsupported_workload" as const;

  constructor() {
    super("Personal funding currently supports foreground text chat only.");
    this.name = "ForegroundChatFundingUnsupportedWorkloadError";
  }
}

let installedPort: ForegroundChatFundingPort | undefined;

export function installForegroundChatFundingPort(
  port: ForegroundChatFundingPort,
): void {
  if (installedPort !== undefined && installedPort !== port) {
    throw new Error("foreground_chat_funding_port_already_installed");
  }
  installedPort = port;
}

export function uninstallForegroundChatFundingPort(): void {
  installedPort = undefined;
}

export function hasForegroundChatFundingPort(): boolean {
  return installedPort !== undefined;
}

function hasUnsupportedForegroundFundingShape(
  input: Readonly<Record<string, unknown>>,
): boolean {
  const metadata = input["metadata"] as Readonly<Record<string, unknown>> | undefined;
  return input["taskRun"] === true
    || input["subagentRun"] === true
    || typeof input["currentTaskId"] === "string"
    || typeof input["currentTaskRunId"] === "string"
    || input["taskReportBackContinuation"] != null
    || metadata?.["originatedBy"] === "task"
    || metadata?.["originatedBy"] === "connected_web_operation";
}

/**
 * Open a request-local funding session only from the opaque Human authority
 * accepted by JobManager. Durable Job input is a consistency check, never the
 * source of payer identity.
 */
export async function openForegroundChatFundingSessionForInvocation(input: Readonly<{
  authority: AcceptedInvocationAuthority | undefined;
  jobInput: Readonly<Record<string, unknown>>;
  causalHumanUserId: string | null;
  entrypoint: ForegroundChatFundingEntrypoint | null;
  modelId: string;
  roomId: string;
  agentId: string;
}>): Promise<ForegroundChatFundingSession | null> {
  if (
    installedPort === undefined
    || input.authority === undefined
    || input.entrypoint === null
    || hasUnsupportedForegroundFundingShape(input.jobInput)
  ) return null;

  const humanUserId = getAcceptedInvocationAuthoritySubject(input.authority);
  const requestorId = typeof input.jobInput["requestorId"] === "string"
    ? input.jobInput["requestorId"]
    : "";
  if (
    !humanUserId
    || requestorId !== humanUserId
    || input.causalHumanUserId !== humanUserId
  ) throw new ForegroundChatFundingAuthorityError();

  return installedPort.openSession({
    humanUserId,
    modelId: input.modelId,
    roomId: input.roomId,
    agentId: input.agentId,
    entrypoint: input.entrypoint,
  });
}

/** Refuse unsupported paid auxiliaries before vision, voice, or chat dispatch. */
export function assertForegroundChatFundingWorkloadSupported(
  session: ForegroundChatFundingSession | null,
  input: Readonly<{ hasImages: boolean; voiceRequested: boolean }>,
): void {
  if (
    session?.kind === "personal"
    && (input.hasImages || input.voiceRequested)
  ) throw new ForegroundChatFundingUnsupportedWorkloadError();
}
