import { describe, expect, mock, test } from "bun:test";
import type { EventFeed } from "@nautilo/event-feed";
import {
  createHumanMembershipEventProducer,
  type CommittedHumanMembershipChange,
} from "../../src/event-feed/membership-producer";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const SUBJECT_USER_ID = "22222222-2222-4222-8222-222222222222";
const INITIATOR_USER_ID = "33333333-3333-4333-8333-333333333333";
const INITIATOR_ACTOR_ID = "44444444-4444-4444-8444-444444444444";
const RECIPIENT_A = "55555555-5555-4555-8555-555555555555";
const RECIPIENT_B = "66666666-6666-4666-8666-666666666666";

function change(
  overrides: Partial<CommittedHumanMembershipChange> = {},
): CommittedHumanMembershipChange {
  return {
    type: "room.member_joined",
    roomId: ROOM_ID,
    subjectUserId: SUBJECT_USER_ID,
    initiatorActorId: INITIATOR_ACTOR_ID,
    initiatorUserId: INITIATOR_USER_ID,
    membershipMessageId: 47,
    ...overrides,
  };
}

describe("Human membership event producer", () => {
  test("records the committed occurrence for other current Humans with distinct subject and initiator", async () => {
    const recordBestEffort = mock(async () => ({ status: "stored" as const, eventId: ROOM_ID }));
    const producer = createHumanMembershipEventProducer({
      feed: { recordBestEffort } as Pick<EventFeed, "recordBestEffort">,
      listHumanUserIdsInRoom: async () => [
        SUBJECT_USER_ID,
        RECIPIENT_A,
        INITIATOR_USER_ID,
        RECIPIENT_A,
        RECIPIENT_B,
      ],
    });

    await producer(change());

    expect(recordBestEffort).toHaveBeenCalledWith({
      key: `room-membership:47:room.member_joined:${ROOM_ID}:${SUBJECT_USER_ID}`,
      type: "room.member_joined",
      actorKind: "human",
      actorId: INITIATOR_ACTOR_ID,
      recipientUserIds: [RECIPIENT_A, RECIPIENT_B],
      data: { roomId: ROOM_ID, userId: SUBJECT_USER_ID },
    });
  });

  test("uses the same key on callback replay and a new receipt for a later transition", async () => {
    const inputs: unknown[] = [];
    const producer = createHumanMembershipEventProducer({
      feed: {
        recordBestEffort: async (input) => {
          inputs.push(input);
          return { status: "duplicate", eventId: ROOM_ID };
        },
      },
      listHumanUserIdsInRoom: async () => [RECIPIENT_A],
    });

    await producer(change());
    await producer(change());
    await producer(change({ type: "room.member_left", membershipMessageId: 48 }));

    expect(inputs).toHaveLength(3);
    expect((inputs[0] as { key: string }).key).toBe((inputs[1] as { key: string }).key);
    expect((inputs[2] as { key: string }).key).toBe(
      `room-membership:48:room.member_left:${ROOM_ID}:${SUBJECT_USER_ID}`,
    );
  });

  test("uses a canonical non-message occurrence identity for invitation acceptance", async () => {
    const inputs: Array<Parameters<EventFeed["recordBestEffort"]>[0]> = [];
    const producer = createHumanMembershipEventProducer({
      feed: {
        recordBestEffort: async (input) => {
          inputs.push(input);
          return { status: "stored", eventId: ROOM_ID };
        },
      },
      listHumanUserIdsInRoom: async () => [RECIPIENT_A],
    });

    await producer(change({
      membershipMessageId: undefined,
      membershipOccurrenceId: `invite-redemption:invite-9:${SUBJECT_USER_ID}`,
    }));

    expect(inputs[0]?.key).toBe(
      `room-membership:invite-redemption:invite-9:${SUBJECT_USER_ID}:room.member_joined:${ROOM_ID}:${SUBJECT_USER_ID}`,
    );
  });

  test("missing receipt skips audience resolution and recording", async () => {
    const list = mock(async () => [RECIPIENT_A]);
    const recordBestEffort = mock(async () => ({ status: "stored" as const, eventId: ROOM_ID }));
    const producer = createHumanMembershipEventProducer({
      feed: { recordBestEffort } as Pick<EventFeed, "recordBestEffort">,
      listHumanUserIdsInRoom: list,
    });

    await producer(change({
      membershipMessageId: undefined,
      membershipOccurrenceId: undefined,
    }));

    expect(list).not.toHaveBeenCalled();
    expect(recordBestEffort).not.toHaveBeenCalled();
  });

  test("empty remaining audience is passed to the shared feed as a harmless no-op", async () => {
    const recordedInputs: Array<Parameters<EventFeed["recordBestEffort"]>[0]> = [];
    const recordBestEffort = mock(
      async (input: Parameters<EventFeed["recordBestEffort"]>[0]) => {
        recordedInputs.push(input);
        return {
          status: "skipped" as const,
          code: "empty_audience" as const,
        };
      },
    );
    const producer = createHumanMembershipEventProducer({
      feed: { recordBestEffort } as Pick<EventFeed, "recordBestEffort">,
      listHumanUserIdsInRoom: async () => [SUBJECT_USER_ID, INITIATOR_USER_ID],
    });

    await producer(change());

    expect(recordedInputs[0]?.recipientUserIds).toEqual([]);
  });

  test("audience and injected recording failures never escape", async () => {
    const warnings: string[] = [];
    const recordBestEffort = mock(async () => {
      throw new Error("record unavailable");
    });
    const failedListProducer = createHumanMembershipEventProducer({
      feed: { recordBestEffort } as Pick<EventFeed, "recordBestEffort">,
      listHumanUserIdsInRoom: async () => {
        throw new Error("list unavailable");
      },
      warn: (message) => warnings.push(message),
    });
    const failedRecordProducer = createHumanMembershipEventProducer({
      feed: { recordBestEffort } as Pick<EventFeed, "recordBestEffort">,
      listHumanUserIdsInRoom: async () => [RECIPIENT_A],
      warn: (message) => warnings.push(message),
    });

    await failedListProducer(change());
    await failedRecordProducer(change());
    expect(warnings).toEqual([
      "membership audience resolution failed",
      "membership event recording failed",
    ]);
  });
});
