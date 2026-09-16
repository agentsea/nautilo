/**
 * D527 — transcript-local visibility for message action rails.
 *
 * The transcript model stays oldest-first; this reducer deliberately knows
 * nothing about FlatList inversion or rows. A room change always clears the
 * older-message reveal, and only one older row may be open at a time.
 */
export type MessageActionRevealState = Readonly<{
  roomId: string | null;
  revealedMessageId: string | null;
}>;

export type MessageActionRevealAction =
  | Readonly<{ type: "scope"; roomId: string | null }>
  | Readonly<{ type: "reveal"; messageId: string }>
  | Readonly<{ type: "dismiss" }>;

export const initialMessageActionRevealState: MessageActionRevealState = {
  roomId: null,
  revealedMessageId: null,
};

export function messageActionRevealReducer(
  state: MessageActionRevealState,
  action: MessageActionRevealAction,
): MessageActionRevealState {
  switch (action.type) {
    case "scope":
      return state.roomId === action.roomId
        ? state
        : { roomId: action.roomId, revealedMessageId: null };
    case "reveal":
      return state.revealedMessageId === action.messageId
        ? { ...state, revealedMessageId: null }
        : { ...state, revealedMessageId: action.messageId };
    case "dismiss":
      return state.revealedMessageId == null ? state : { ...state, revealedMessageId: null };
  }
}

/** A deferred list tap may only dismiss the exact unconsumed touch that scheduled it. */
export function shouldDismissTranscriptTap(input: Readonly<{
  currentGeneration: number;
  scheduledGeneration: number;
  interactionConsumed: boolean;
}>): boolean {
  return input.currentGeneration === input.scheduledGeneration && !input.interactionConsumed;
}
