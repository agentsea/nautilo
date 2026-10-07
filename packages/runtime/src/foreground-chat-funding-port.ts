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
  readonly hasImages?: boolean;
}

export interface ImageAssistanceSession {
  readonly modelId: string;
  readonly fundingSession: ForegroundChatFundingSession;
}

export interface ForegroundChatFundingPort {
  openImageAssistance?(
    input: ForegroundChatFundingOpenInput & { readonly fundingKind?: "server" | "personal" },
  ): Promise<ImageAssistanceSession | null>;

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
  protectedTurn?: boolean;
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

  const session = await installedPort.openSession({
    humanUserId,
    modelId: input.modelId,
    roomId: input.roomId,
    agentId: input.agentId,
    entrypoint: input.entrypoint,
    hasImages: Array.isArray(input.jobInput["multimodalImages"]) && input.jobInput["multimodalImages"].length > 0,
  });
  const imageIds = new Set(Array.isArray(input.jobInput["multimodalImages"])
    ? input.jobInput["multimodalImages"].flatMap((image: unknown) =>
      image && typeof image === "object" && typeof (image as Record<string, unknown>)["attachmentId"] === "string"
        ? [(image as Record<string, unknown>)["attachmentId"] as string] : []) : []);
  const hasUnrelatedFocus = Array.isArray(input.jobInput["focusedResources"])
    && input.jobInput["focusedResources"].some((resource: unknown) => {
      if (!resource || typeof resource !== "object") return true;
      const row = resource as Record<string, unknown>;
      const locator = row["locator"];
      return row["kind"] !== "message-attachment" || !locator || typeof locator !== "object"
        || !imageIds.has((locator as Record<string, unknown>)["attachmentId"] as string);
    });
  const hasResources = [
    "attachmentTextBlocks", "artifactRefs",
  ].some((field) => Array.isArray(input.jobInput[field]) && input.jobInput[field].length > 0)
    || (Array.isArray(input.jobInput["retainedAttachmentIds"])
      && input.jobInput["retainedAttachmentIds"].some((id) =>
        !Array.isArray(input.jobInput["multimodalImages"])
        || !input.jobInput["multimodalImages"].some((image: { attachmentId?: unknown }) => image.attachmentId === id)))
    || hasUnrelatedFocus
    || input.jobInput["activeMiniApp"] != null
    || input.jobInput["liveMiniAppSession"] != null;
  assertForegroundChatFundingWorkloadSupported(session, {
    hasImages: Array.isArray(input.jobInput["multimodalImages"])
      && input.jobInput["multimodalImages"].length > 0,
    voiceRequested: input.jobInput["voiceMode"] === true,
    hasResources,
    protectedTurn: input.protectedTurn === true,
  });
  return session;
}

/** Refuse unsupported paid auxiliaries before vision, voice, or chat dispatch. */
export function assertForegroundChatFundingWorkloadSupported(
  session: ForegroundChatFundingSession | null,
  input: Readonly<{
    hasImages: boolean;
    voiceRequested: boolean;
    hasResources?: boolean;
    protectedTurn?: boolean;
  }>,
): void {
  if (
    session?.kind === "personal"
    && (input.voiceRequested || input.hasResources || input.protectedTurn)
  ) throw new ForegroundChatFundingUnsupportedWorkloadError();
}

/** Reuse the accepted Human authority; Job content alone cannot authorize spend. */
export async function openImageAssistanceForInvocation(
  input: Parameters<typeof openForegroundChatFundingSessionForInvocation>[0] & {
    fundingKind?: "server" | "personal";
  },
): Promise<ImageAssistanceSession | null> {
  if (!installedPort?.openImageAssistance || !input.authority || !input.entrypoint
    || hasUnsupportedForegroundFundingShape(input.jobInput)) return null;
  const humanUserId = getAcceptedInvocationAuthoritySubject(input.authority);
  if (!humanUserId || input.jobInput["requestorId"] !== humanUserId
    || input.causalHumanUserId !== humanUserId) throw new ForegroundChatFundingAuthorityError();
  return installedPort.openImageAssistance({
    humanUserId, modelId: input.modelId, roomId: input.roomId,
    agentId: input.agentId, entrypoint: input.entrypoint,
    ...(input.fundingKind ? { fundingKind: input.fundingKind } : {}),
  });
}
