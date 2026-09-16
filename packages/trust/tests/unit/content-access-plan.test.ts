import { describe, expect, test } from "bun:test";

import {
  ContentAccessPlanError,
  planContentAccessChange,
  type AuthorizedContentAttachmentSnapshot,
  type ContentAccessPlanInput,
} from "../../src/content-access-plan";

const object = Object.freeze({ kind: "artifact" as const, id: "artifact-1", revision: "7" });
const sourceContext = Object.freeze({ roomId: "room-ab", humanActorIds: ["b", "a"] });

function attachment(
  namespaceId: string,
  roomId: string,
  kind: "access" | "dynamic",
  humanActorIds: readonly string[],
  mutable = true,
): AuthorizedContentAttachmentSnapshot {
  return { namespaceId, roomId, kind, humanActorIds, mutable };
}

function plan(
  change: ContentAccessPlanInput["change"],
  attachments: readonly AuthorizedContentAttachmentSnapshot[],
  extra: Partial<Pick<ContentAccessPlanInput, "privateDestination" | "sourceContext">> = {},
) {
  return planContentAccessChange({
    object,
    requesterActorId: "a",
    sourceContext: extra.sourceContext ?? sourceContext,
    attachments,
    ...(extra.privateDestination === undefined
      ? {}
      : { privateDestination: extra.privateDestination }),
    change,
  });
}

describe("ordinary content access planning", () => {
  test("a hundred-person Room is one dynamic attachment, not a hundred personal grants", () => {
    const humanActorIds = Array.from({ length: 100 }, (_, index) => `person-${index}`);
    const result = plan({
      kind: "grant_room",
      targetRoom: { namespaceId: "ns-large", roomId: "room-large", humanActorIds },
    }, [attachment("ns-source", "room-ab", "dynamic", ["a", "b"])]);

    expect(result.attachDestinations).toHaveLength(1);
    expect(result.attachDestinations[0]).toEqual({
      kind: "room_namespace", purpose: "grant", namespaceId: "ns-large",
      roomId: "room-large", humanActorIds: [...humanActorIds].sort(),
    });
    expect(result.detachNamespaceIds).toEqual([]);
  });

  test("person grant uses only invoking A+B plus C and preserves unrelated A+D", () => {
    const result = plan(
      { kind: "grant_people", selectedActorIds: ["c"] },
      [
        attachment("ns-ab", "room-ab", "dynamic", ["a", "b"]),
        attachment("ns-ad", "room-ad", "access", ["a", "d"]),
      ],
    );

    expect(result.attachDestinations).toEqual([
      { kind: "immutable_human_set", humanActorIds: ["a", "b", "c"] },
    ]);
    expect(result.detachNamespaceIds).toEqual([]);
    expect(result.alreadyApplied).toBe(false);
  });

  test("all selected people form one normalized immutable destination", () => {
    const result = plan(
      { kind: "grant_people", selectedActorIds: ["e", "c", "c"] },
      [attachment("ns-ab", "room-ab", "dynamic", ["a", "b"])],
    );

    expect(result.attachDestinations).toEqual([
      { kind: "immutable_human_set", humanActorIds: ["a", "b", "c", "e"] },
    ]);
  });

  test("independent C and D plans never union each other's destination", () => {
    const attachments = [attachment("ns-ab", "room-ab", "dynamic", ["a", "b"])];
    const toC = plan({ kind: "grant_people", selectedActorIds: ["c"] }, attachments);
    const toD = plan({ kind: "grant_people", selectedActorIds: ["d"] }, attachments);

    expect(toC.attachDestinations[0]).toMatchObject({ humanActorIds: ["a", "b", "c"] });
    expect(toD.attachDestinations[0]).toMatchObject({ humanActorIds: ["a", "b", "d"] });
  });

  test("Room grant remains dynamic while a person grant snapshots Room members", () => {
    const attachments = [attachment("ns-source", "room-source", "dynamic", ["a", "b"])];
    const room = plan({
      kind: "grant_room",
      targetRoom: { namespaceId: "ns-target", roomId: "room-target", humanActorIds: ["d", "c"] },
    }, attachments);
    const people = plan({ kind: "grant_people", selectedActorIds: ["c"] }, attachments);

    expect(room.attachDestinations).toEqual([{
      kind: "room_namespace",
      purpose: "grant",
      namespaceId: "ns-target",
      roomId: "room-target",
      humanActorIds: ["c", "d"],
    }]);
    expect(people.attachDestinations).toEqual([{
      kind: "immutable_human_set",
      humanActorIds: ["a", "b", "c"],
    }]);
  });

  test("today's Room readability is not an immutable-person no-op", () => {
    const result = plan(
      { kind: "grant_people", selectedActorIds: ["c"] },
      [attachment("ns-abc-room", "room-abc", "dynamic", ["a", "b", "c"])],
    );

    expect(result.alreadyApplied).toBe(false);
    expect(result.attachDestinations[0]).toEqual({
      kind: "immutable_human_set",
      humanActorIds: ["a", "b", "c"],
    });
  });

  test("selects the same existing exact boundary independent of attachment order", () => {
    const first = attachment("ns-z", "access-a", "access", ["a", "b", "c"]);
    const selected = attachment("ns-a", "access-z", "access", ["c", "b", "a"]);
    const change = { kind: "grant_people" as const, selectedActorIds: ["c"] };

    for (const attachments of [[first, selected], [selected, first]]) {
      expect(plan(change, attachments).attachDestinations[0]).toEqual({
        kind: "immutable_human_set",
        humanActorIds: ["a", "b", "c"],
        existingNamespaceId: "ns-a",
        existingRoomId: "access-z",
      });
    }
  });

  test("direct removal rehomes mutable immutable access and reports residual Room access", () => {
    const result = plan(
      { kind: "remove_person", targetActorId: "c" },
      [
        attachment("ns-abc", "access-abc", "access", ["a", "b", "c"]),
        attachment("ns-room-ac", "room-ac", "dynamic", ["a", "c"]),
      ],
    );

    expect(result.detachNamespaceIds).toEqual(["ns-abc"]);
    expect(result.attachDestinations).toEqual([{
      kind: "immutable_human_set",
      humanActorIds: ["a", "b"],
    }]);
    expect(result.accounting.residualDynamicRoomIds).toEqual(["room-ac"]);
    expect(result.accounting.residualDynamicNamespaceIds).toEqual(["ns-room-ac"]);
  });

  test("Room detach removes only the authorized target attachment", () => {
    const result = plan(
      { kind: "detach_room", targetRoomId: "room-team" },
      [
        attachment("ns-source", "room-ab", "dynamic", ["a", "b"]),
        attachment("ns-team", "room-team", "dynamic", ["a", "c"]),
      ],
    );

    expect(result.detachNamespaceIds).toEqual(["ns-team"]);
    expect(result.attachDestinations).toEqual([]);
    expect(result.accounting.removedAttachmentCount).toBe(1);
  });

  test("Room detach rejects a hidden immutable access boundary", () => {
    expect(() => plan(
      { kind: "detach_room", targetRoomId: "access-abc" },
      [
        attachment("ns-source", "room-ab", "dynamic", ["a", "b"]),
        attachment("ns-abc", "access-abc", "access", ["a", "b", "c"]),
      ],
    )).toThrow("Room detach cannot remove an immutable access boundary");
  });

  test("partial make-private preserves unmodifiable attachments internally", () => {
    const result = plan(
      { kind: "make_private" },
      [
        attachment("ns-ab", "room-ab", "dynamic", ["a", "b"]),
        attachment("ns-locked", "access-locked", "access", ["a", "c"], false),
      ],
      {
        privateDestination: {
          namespaceId: "ns-private",
          roomId: "room-private",
          humanActorIds: ["a"],
        },
      },
    );

    expect(result.attachDestinations).toEqual([{
      kind: "room_namespace",
      purpose: "private",
      namespaceId: "ns-private",
      roomId: "room-private",
      humanActorIds: ["a"],
    }]);
    expect(result.detachNamespaceIds).toEqual(["ns-ab"]);
    expect(result.accounting).toMatchObject({
      removedAttachmentCount: 1,
      skippedAttachmentCount: 1,
      skippedNamespaceIds: ["ns-locked"],
      residualAccessNamespaceIds: ["ns-locked"],
    });
  });

  test("make-private requires an authorized personal destination", () => {
    try {
      plan(
        { kind: "make_private" },
        [
          attachment("ns-ab", "room-ab", "dynamic", ["a", "b"]),
          attachment("ns-locked", "room-locked", "dynamic", ["c", "d"], false),
        ],
      );
      throw new Error("expected private-destination rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ContentAccessPlanError);
      expect((error as ContentAccessPlanError).code).toBe("missing_private_destination");
    }
  });

  test("rejects missing invoking context, self removal, and last attachment detach", () => {
    try {
      plan(
        { kind: "grant_people", selectedActorIds: ["c"] },
        [attachment("ns-ab", "room-ab", "dynamic", ["a", "b"])],
        { sourceContext: { roomId: "room-b", humanActorIds: ["b"] } },
      );
      throw new Error("expected missing-context rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ContentAccessPlanError);
      expect((error as ContentAccessPlanError).code).toBe("missing_context");
    }
    expect(() => plan(
      { kind: "remove_person", targetActorId: "a" },
      [attachment("ns-ab", "access-ab", "access", ["a", "b"])],
    )).toThrow("requester cannot remove their own access");
    expect(() => plan(
      { kind: "detach_room", targetRoomId: "room-ab" },
      [attachment("ns-ab", "room-ab", "dynamic", ["a", "b"])],
    )).toThrow("last attachment");
  });

  test("returns recursively frozen plan collections", () => {
    const result = plan(
      { kind: "grant_people", selectedActorIds: ["c"] },
      [attachment("ns-ab", "room-ab", "dynamic", ["a", "b"])],
    );

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sourceContext.humanActorIds)).toBe(true);
    expect(Object.isFrozen(result.attachDestinations)).toBe(true);
    expect(Object.isFrozen(result.attachDestinations[0])).toBe(true);
    expect(Object.isFrozen(result.accounting)).toBe(true);
  });
});
