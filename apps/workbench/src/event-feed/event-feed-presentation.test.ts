import { describe, expect, test } from "bun:test";
import type { ArtifactDto } from "@nautilo/api-client/browser";
import type { EventFeedItem, RoomDetailResponse } from "@nautilo/types";
import { presentEventFeedItem } from "./event-feed-presentation";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const SUBJECT_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const ARTIFACT_ID = "66666666-6666-4666-8666-666666666666";

const artifact: ArtifactDto = {
  id: ARTIFACT_ID,
  artifactId: "public/report",
  path: "reports/Quarterly report.md",
  mimeType: "text/markdown",
  size: 42,
  revision: 1,
  updatedAt: "2026-09-09T09:00:00.000Z",
  createdAt: "2026-09-09T09:00:00.000Z",
  namespaceIds: [],
  canWrite: false,
};

const room: RoomDetailResponse = {
  id: ROOM_ID,
  label: "Launch",
  type: "group",
  graphThreadId: "thread-launch",
  createdAt: "2026-09-09T08:00:00.000Z",
  kind: "group",
  conductorMode: "standard",
  members: [{
    actorId: ADMIN_ACTOR_ID,
    kind: "user",
    userId: "44444444-4444-4444-8444-444444444444",
    displayName: "Ada",
    roomRole: "admin",
  }],
};

function membershipEvent(type: "room.member_joined" | "room.member_left"): EventFeedItem {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    type,
    actorKind: "human",
    actorId: ADMIN_ACTOR_ID,
    data: { roomId: ROOM_ID, userId: SUBJECT_ID },
    createdAt: "2026-09-09T09:00:00.000Z",
    readAt: null,
  };
}

describe("event feed presentation", () => {
  test("distinguishes administrator add/remove wording from self transitions", () => {
    const inputs = {
      humansById: new Map([[SUBJECT_ID, { userId: SUBJECT_ID, displayName: "Ben" }]]),
      roomsById: new Map([[ROOM_ID, room]]),
      artifactsById: new Map(),
      viewerActorId: null,
    };

    expect(presentEventFeedItem({ event: membershipEvent("room.member_joined"), ...inputs }).text)
      .toBe("Ada added Ben to Launch");
    expect(presentEventFeedItem({ event: membershipEvent("room.member_left"), ...inputs }).text)
      .toBe("Ada removed Ben from Launch");
  });

  test("uses safe placeholders when current authorization cannot resolve names", () => {
    const event = { ...membershipEvent("room.member_left"), actorId: null };
    const presentation = presentEventFeedItem({
      event,
      humansById: new Map(),
      roomsById: new Map([[ROOM_ID, null]]),
      artifactsById: new Map(),
      viewerActorId: null,
    });

    expect(presentation.text).toBe("Someone is no longer a member of an unavailable Room");
    expect(presentation.roomUnavailable).toBe(true);
    expect(presentation.roomLabel).toBeNull();
  });

  test("does not mistake an enriched self-leave label for administrator identity", () => {
    const presentation = presentEventFeedItem({
      event: {
        ...membershipEvent("room.member_left"),
        actorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        actorDisplayName: "Ben",
      },
      humansById: new Map([[SUBJECT_ID, { userId: SUBJECT_ID, displayName: "Ben" }]]),
      roomsById: new Map([[ROOM_ID, room]]),
      artifactsById: new Map(),
      viewerActorId: null,
    });

    expect(presentation.text).toBe("Ben is no longer a member of Launch");
  });

  test("presents Artifact additions and person/Room shares with the true actor", () => {
    const base = {
      actorKind: "agent" as const,
      actorId: ADMIN_ACTOR_ID,
      actorDisplayName: "Nova",
      createdAt: "2026-09-09T09:00:00.000Z",
      readAt: null,
    };
    const inputs = {
      humansById: new Map(),
      roomsById: new Map([[ROOM_ID, room]]),
      artifactsById: new Map([[ARTIFACT_ID, artifact]]),
      viewerActorId: null,
    };
    const added: EventFeedItem = {
      ...base,
      id: "77777777-7777-4777-8777-777777777777",
      type: "artifact.added",
      data: { artifactId: ARTIFACT_ID, roomId: ROOM_ID },
    };
    const personShare: EventFeedItem = {
      ...base,
      id: "88888888-8888-4888-8888-888888888888",
      type: "artifact.shared",
      data: { artifactId: ARTIFACT_ID, destination: { kind: "person", userId: SUBJECT_ID } },
    };
    const roomShare: EventFeedItem = {
      ...base,
      id: "99999999-9999-4999-8999-999999999999",
      type: "artifact.shared",
      data: { artifactId: ARTIFACT_ID, destination: { kind: "room", roomId: ROOM_ID } },
    };

    expect(presentEventFeedItem({ event: added, ...inputs }).text)
      .toBe("Nova added Quarterly report.md in Launch");
    expect(presentEventFeedItem({ event: personShare, ...inputs }).text)
      .toBe("Nova shared Quarterly report.md with you");
    expect(presentEventFeedItem({ event: roomShare, ...inputs }).text)
      .toBe("Nova shared Quarterly report.md with Launch");
  });

  test("keeps Artifact and Room availability independent", () => {
    const event: EventFeedItem = {
      id: "88888888-8888-4888-8888-888888888888",
      type: "artifact.shared",
      actorKind: "human",
      actorId: ADMIN_ACTOR_ID,
      actorDisplayName: "Ada",
      data: { artifactId: ARTIFACT_ID, destination: { kind: "room", roomId: ROOM_ID } },
      createdAt: "2026-09-09T09:00:00.000Z",
      readAt: null,
    };
    const presentation = presentEventFeedItem({
      event,
      humansById: new Map(),
      roomsById: new Map([[ROOM_ID, null]]),
      artifactsById: new Map([[ARTIFACT_ID, artifact]]),
      viewerActorId: null,
    });

    expect(presentation.text).toBe("Ada shared Quarterly report.md with an unavailable Room");
    expect(presentation.artifactUnavailable).toBe(false);
    expect(presentation.roomUnavailable).toBe(true);
  });
});
