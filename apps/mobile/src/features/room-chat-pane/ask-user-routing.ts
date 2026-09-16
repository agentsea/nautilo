import type { RoomMemberDto } from "@nautilo/types";

/** A server-issued candidate. Its actor id is the only id that may be sent. */
export type AskUserOption = {
  botActorId: string;
  handle: string;
};

export type AskUserRoutingScope = {
  serverId: string;
  viewerUserId: string;
  viewerActorId: string;
  roomId: string;
};

export type AskUserRoutingState = AskUserRoutingScope & {
  messageId: string;
  resumeTurnId: string | null;
  options: readonly AskUserOption[];
  /** The persisted message text; never accept a replacement draft here. */
  originalContent: string | null;
  selectingActorId: string | null;
  retryable: boolean;
};

/** Shared safe subset of both conductor.ask_user and conductor.decision. */
export type AskUserRoutingPayload = {
  roomId: string;
  userId: string;
  userActorId: string;
  messageId: string | null;
  humanTurnId?: string | null;
  options?: readonly AskUserOption[];
};

export type AskUserCandidate = AskUserOption & {
  displayName: string;
  displayHandle: string;
  agentId?: string;
  agentAvatar?: RoomMemberDto["agentAvatar"];
};

export type AskUserResumeBody = {
  content: string;
  uiSelectedBotActorId: string;
  resumeTurnId?: string;
  resumeMessageId: number;
};

const ASK_USER_SEARCH_THRESHOLD = 6;

export function isSearchableAskUserChoice(optionCount: number): boolean {
  return optionCount >= ASK_USER_SEARCH_THRESHOLD;
}

function normalizedHandle(handle: string): string {
  const trimmed = handle.trim();
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

/** A resume can only identify a real persisted Human row. */
export function isResumeMessageId(messageId: string | null | undefined): messageId is string {
  return typeof messageId === "string" && /^[1-9]\d*$/.test(messageId);
}

/**
 * Keep server relevance ordering. Roster data only enriches the exact issued
 * options; it can never add a room agent to the chooser.
 */
export function resolveAskUserCandidates(
  options: readonly AskUserOption[],
  members: readonly RoomMemberDto[],
): AskUserCandidate[] {
  return options.map((option) => {
    const member = members.find(
      (candidate) => candidate.kind === "agent" && candidate.actorId === option.botActorId,
    );
    const displayHandle = normalizedHandle(option.handle);
    return {
      ...option,
      displayName: member?.displayName?.trim() || displayHandle,
      displayHandle: member?.handle?.trim() ? normalizedHandle(member.handle) : displayHandle,
      ...(member?.agentId ? { agentId: member.agentId } : {}),
      ...(member?.agentAvatar ? { agentAvatar: member.agentAvatar } : {}),
    };
  });
}

export function filterAskUserCandidates(
  candidates: readonly AskUserCandidate[],
  query: string,
): AskUserCandidate[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...candidates];
  return candidates.filter((candidate) =>
    candidate.displayName.toLocaleLowerCase().includes(needle) ||
    candidate.displayHandle.toLocaleLowerCase().includes(needle),
  );
}

export function askUserCorrelationKey(state: Pick<
  AskUserRoutingState,
  "serverId" | "viewerUserId" | "viewerActorId" | "roomId" | "messageId" | "resumeTurnId"
>): string {
  return [
    state.serverId,
    state.viewerUserId,
    state.viewerActorId,
    state.roomId,
    state.messageId,
    state.resumeTurnId ?? "",
  ].join("\u001f");
}

export function isCurrentAskUserScope(
  state: AskUserRoutingState,
  scope: AskUserRoutingScope | null,
): boolean {
  return scope !== null &&
    state.serverId === scope.serverId &&
    state.viewerUserId === scope.viewerUserId &&
    state.viewerActorId === scope.viewerActorId &&
    state.roomId === scope.roomId;
}

/**
 * Project either canonical ask_user transport into one local recovery state.
 * A same-correlation counterpart/replay returns the current object exactly,
 * preserving the synchronous selection fence rather than reopening the sheet.
 */
export function projectAskUserRoutingState(
  payload: AskUserRoutingPayload,
  scope: AskUserRoutingScope,
  originalContent: string | null,
  current: AskUserRoutingState | null,
): AskUserRoutingState | null {
  if (
    payload.roomId !== scope.roomId ||
    payload.userId !== scope.viewerUserId ||
    payload.userActorId !== scope.viewerActorId ||
    !isResumeMessageId(payload.messageId) ||
    !payload.options ||
    payload.options.length < 2
  ) return null;
  const next: AskUserRoutingState = {
    ...scope,
    messageId: payload.messageId,
    resumeTurnId: payload.humanTurnId ?? null,
    options: payload.options.map((option) => ({ ...option })),
    originalContent,
    selectingActorId: null,
    retryable: false,
  };
  return current && askUserCorrelationKey(current) === askUserCorrelationKey(next)
    ? current
    : next;
}

/**
 * The resume request is intentionally narrower than an ordinary composer
 * send: it is an instruction to route the exact persisted Human message, not
 * permission to apply the current draft, model, reply target, or attachments.
 */
export function buildAskUserResumeBody(
  choice: Pick<AskUserRoutingState, "messageId" | "resumeTurnId" | "originalContent">,
  botActorId: string,
): AskUserResumeBody | null {
  if (!choice.originalContent || !isResumeMessageId(choice.messageId) || !botActorId) return null;
  return {
    content: choice.originalContent,
    uiSelectedBotActorId: botActorId,
    ...(choice.resumeTurnId ? { resumeTurnId: choice.resumeTurnId } : {}),
    resumeMessageId: Number(choice.messageId),
  };
}
