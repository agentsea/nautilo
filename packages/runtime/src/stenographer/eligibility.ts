export interface JournalEligibilityInput {
  roomKind: string;
  agentMemberCount: number;
  hasTranscriptRowsAfterCursor: boolean;
  /** Deliberately ignored: response mode governs speech, not journaling. */
  agentResponseModes?: readonly string[];
}

export type JournalIneligibilityReason =
  | "non_conversational_room"
  | "no_agent_member"
  | "no_pending_transcript";

export type JournalEligibility =
  | { eligible: true }
  | { eligible: false; reason: JournalIneligibilityReason };

export function classifyJournalEligibility(
  input: JournalEligibilityInput,
): JournalEligibility {
  if (input.roomKind === "task" || input.roomKind === "access") {
    return { eligible: false, reason: "non_conversational_room" };
  }
  if (input.agentMemberCount < 1) {
    return { eligible: false, reason: "no_agent_member" };
  }
  if (!input.hasTranscriptRowsAfterCursor) {
    return { eligible: false, reason: "no_pending_transcript" };
  }
  return { eligible: true };
}

export interface MembershipTransitionRoom {
  roomId: string;
  agentCountBefore: number;
  agentCountAfter: number;
  committedTranscriptHead: number;
}

export type JournalMembershipTransition =
  | {
      roomId: string;
      action: "resume";
      cursorMessageId: number;
      clearSuspended: true;
      invalidateExtractionLease: false;
    }
  | {
      roomId: string;
      action: "suspend";
      cursorMessageId: number;
      clearSuspended: false;
      invalidateExtractionLease: true;
    }
  | {
      roomId: string;
      action: "none";
      invalidateExtractionLease: false;
    };

function assertMembershipTransitionRoom(room: MembershipTransitionRoom): void {
  if (
    !Number.isInteger(room.agentCountBefore) ||
    room.agentCountBefore < 0 ||
    !Number.isInteger(room.agentCountAfter) ||
    room.agentCountAfter < 0
  ) {
    throw new RangeError("agent member counts must be non-negative integers");
  }
  if (
    !Number.isInteger(room.committedTranscriptHead) ||
    room.committedTranscriptHead < 0
  ) {
    throw new RangeError(
      "committed transcript head must be a non-negative integer",
    );
  }
}

export function planJournalMembershipTransition(
  room: MembershipTransitionRoom,
): JournalMembershipTransition {
  assertMembershipTransitionRoom(room);

  if (room.agentCountBefore === 0 && room.agentCountAfter > 0) {
    return {
      roomId: room.roomId,
      action: "resume",
      cursorMessageId: room.committedTranscriptHead,
      clearSuspended: true,
      invalidateExtractionLease: false,
    };
  }
  if (room.agentCountBefore > 0 && room.agentCountAfter === 0) {
    return {
      roomId: room.roomId,
      action: "suspend",
      cursorMessageId: room.committedTranscriptHead,
      clearSuspended: false,
      invalidateExtractionLease: true,
    };
  }
  return {
    roomId: room.roomId,
    action: "none",
    invalidateExtractionLease: false,
  };
}

/**
 * Membership propagation already supplies the affected parent and child Rooms;
 * applying the same planner to each prevents a parent-only reconciliation.
 */
export function planJournalMembershipTransitions(
  affectedRooms: readonly MembershipTransitionRoom[],
): JournalMembershipTransition[] {
  return affectedRooms.map(planJournalMembershipTransition);
}

export interface JournalLeasePublicationInput {
  presentedLeaseToken: string;
  currentLeaseToken: string | null;
  suspended: boolean;
  hasAgentMember: boolean;
}

export function canPublishJournalLease(
  input: JournalLeasePublicationInput,
): boolean {
  return (
    !input.suspended &&
    input.hasAgentMember &&
    input.currentLeaseToken !== null &&
    input.presentedLeaseToken === input.currentLeaseToken
  );
}
