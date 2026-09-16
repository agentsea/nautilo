import type { EventFeed } from "@nautilo/event-feed";

export type CommittedHumanMembershipChange = Readonly<{
  type: "room.member_joined" | "room.member_left";
  roomId: string;
  subjectUserId: string;
  initiatorActorId: string;
  initiatorUserId: string;
  membershipMessageId?: number | undefined;
  membershipOccurrenceId?: string | undefined;
}>;

export type HumanMembershipEventProducer = (
  change: CommittedHumanMembershipChange,
) => void | Promise<void>;

export interface MembershipEventProducerDeps {
  readonly feed: Pick<EventFeed, "recordBestEffort">;
  readonly listHumanUserIdsInRoom: (roomId: string) => Promise<string[]>;
  readonly warn?: (message: string) => void;
}

function warnBestEffort(warn: MembershipEventProducerDeps["warn"], message: string): void {
  try {
    warn?.(message);
  } catch {
    // Diagnostics cannot affect an already committed membership mutation.
  }
}

/**
 * Projects one committed top-level Human membership transition into the
 * personal feed. Audience discovery and recording are both deliberately
 * subordinate to the already successful business mutation.
 */
export function createHumanMembershipEventProducer(
  deps: MembershipEventProducerDeps,
): HumanMembershipEventProducer {
  return async (change) => {
    const occurrenceId = change.membershipOccurrenceId?.trim()
      || (change.membershipMessageId === undefined
        ? undefined
        : String(change.membershipMessageId));
    if (occurrenceId === undefined) return;

    let roomUserIds: string[];
    try {
      roomUserIds = await deps.listHumanUserIdsInRoom(change.roomId);
    } catch {
      warnBestEffort(deps.warn, "membership audience resolution failed");
      return;
    }

    const recipientUserIds = [
      ...new Set(
        roomUserIds.filter(
          (userId) =>
            userId !== change.subjectUserId && userId !== change.initiatorUserId,
        ),
      ),
    ];

    try {
      await deps.feed.recordBestEffort({
        key: [
          "room-membership",
          occurrenceId,
          change.type,
          change.roomId,
          change.subjectUserId,
        ].join(":"),
        type: change.type,
        actorKind: "human",
        actorId: change.initiatorActorId,
        recipientUserIds,
        data: { roomId: change.roomId, userId: change.subjectUserId },
      });
    } catch {
      // The shared feed already contains its own best-effort boundary. Keep a
      // final guard here for injected substitutes and future implementations.
      warnBestEffort(deps.warn, "membership event recording failed");
    }
  };
}
