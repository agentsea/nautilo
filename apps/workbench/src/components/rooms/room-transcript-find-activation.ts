import type {
  ConversationJumpOptions,
  ConversationJumpOutcome,
} from "../conversation-navigation";

export type RoomFindActivationState =
  | { state: "idle" }
  | { state: "hydrating"; messageId: number }
  | { state: "not-found"; messageId: number }
  | { state: "failed"; messageId: number };

export interface RoomFindActivationRequest {
  roomId: string;
  generation: number;
  messageId: string;
}

function requestKey(request: RoomFindActivationRequest): string {
  return `${request.roomId}:${request.generation}:${request.messageId}`;
}

/**
 * Binds transcript-find selection to the already canonical conversation jump
 * coordinator. It does not know about transcript rows or history: one selected
 * result means one `jumpToMessage` call, and stale completions are ignored.
 */
export function createRoomFindActivationController(args: {
  jumpToMessage: (
    messageId: number,
    options?: ConversationJumpOptions,
  ) => Promise<ConversationJumpOutcome>;
  isCurrent: (request: RoomFindActivationRequest) => boolean;
  onState: (state: RoomFindActivationState) => void;
}) {
  let latestRequestKey: string | null = null;
  let pendingRequestKey: string | null = null;
  let sequence = 0;

  const activate = async (request: RoomFindActivationRequest, retry = false): Promise<void> => {
    const messageId = Number(request.messageId);
    if (!Number.isInteger(messageId) || messageId <= 0 || !args.isCurrent(request)) return;
    const key = requestKey(request);
    if (pendingRequestKey === key || (!retry && latestRequestKey === key)) return;
    latestRequestKey = key;
    pendingRequestKey = key;
    const currentSequence = ++sequence;
    args.onState({ state: "hydrating", messageId });
    // Scrolling/highlighting search results must not interrupt query entry.
    const outcome = await args.jumpToMessage(messageId, { focusTarget: false });
    if (currentSequence !== sequence || !args.isCurrent(request)) return;
    pendingRequestKey = null;
    if (outcome.status === "completed") {
      args.onState({ state: "idle" });
    } else if (outcome.status === "not-found") {
      args.onState({ state: "not-found", messageId });
    } else if (outcome.status === "failed") {
      args.onState({ state: "failed", messageId });
    } else {
      args.onState({ state: "idle" });
    }
  };

  return {
    activate,
    retry: (request: RoomFindActivationRequest) => activate(request, true),
    supersede: () => {
      sequence += 1;
      pendingRequestKey = null;
      args.onState({ state: "idle" });
    },
  };
}
