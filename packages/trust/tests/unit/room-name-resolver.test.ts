import { describe, expect, test } from "bun:test";
import {
  MAX_ROOM_NAME_CANDIDATES,
  ROOM_NAME_QUERY_CANDIDATE_LIMIT,
  normalizeRoomName,
  resolveAuthorizedRoomName,
  type AuthorizedRoomNameResolverDependencies,
  type RoomChoiceTokenCodec,
} from "../../src/room-name-resolver";
import {
  authorizedRoomNameLookupStages,
  type AuthorizedRoomNameCandidateRow,
} from "../../src/queries";

const REQUESTER_USER_ID = "user-requester";
const REQUESTER_ACTOR_ID = "actor-requester";

function room(
  overrides: Partial<AuthorizedRoomNameCandidateRow> & Pick<AuthorizedRoomNameCandidateRow, "id" | "label">,
): AuthorizedRoomNameCandidateRow {
  const { id, label, ...rest } = overrides;
  return {
    id,
    label,
    namespaceId: `namespace-for-${id}`,
    normalizedLabel: normalizeRoomName(label),
    memberCount: 2,
    kind: "open",
    audienceFingerprint: `audience-for-${id}`,
    ...rest,
  };
}

/** Test-only deterministic codec. Production must inject a server-owned signer. */
function fakeCodec(): RoomChoiceTokenCodec {
  let next = 0;
  const issued = new Map<string, { requesterUserId: string; normalizedQuery: string; roomId: string }>();
  return {
    issue({ requesterUserId, normalizedQuery, roomId }) {
      const token = `choice-${++next}`;
      issued.set(token, { requesterUserId, normalizedQuery, roomId });
      return token;
    },
    verify({ token, requesterUserId, normalizedQuery, candidateRoomIds }) {
      const bound = issued.get(token);
      if (
        !bound
        || bound.requesterUserId !== requesterUserId
        || bound.normalizedQuery !== normalizedQuery
        || !candidateRoomIds.includes(bound.roomId)
      ) return null;
      return bound.roomId;
    },
  };
}

function deps(
  rooms: readonly AuthorizedRoomNameCandidateRow[],
  options: Readonly<{ capable?: boolean; codec?: RoomChoiceTokenCodec }> = {},
): AuthorizedRoomNameResolverDependencies {
  return {
    findAuthorizedRoomNameCandidates: async ({ requesterUserId, requesterActorId }) => (
      requesterUserId === REQUESTER_USER_ID && requesterActorId === REQUESTER_ACTOR_ID ? [...rooms] : []
    ),
    userHasCapability: async (userId, slug) => userId === REQUESTER_USER_ID && slug === "manage_memories" && options.capable !== false,
    ...(options.codec ? { choiceTokenCodec: options.codec } : {}),
  };
}

function input(targetRoomName: string, roomChoiceToken?: string) {
  return {
    requesterUserId: REQUESTER_USER_ID,
    requesterActorId: REQUESTER_ACTOR_ID,
    targetRoomName,
    ...(roomChoiceToken ? { roomChoiceToken } : {}),
  };
}

describe("D476 authorized Room-name resolver", () => {
  test("normalizes Unicode, case, whitespace, and separators", () => {
    expect(normalizeRoomName("  P\u{ff55}B—Room  ")).toBe("pub room");
    expect(normalizeRoomName("İstanbul")).toBe("istanbul");
    expect(normalizeRoomName("i\u0307stanbul")).toBe("istanbul");
    expect(normalizeRoomName("ΣΟΣ")).toBe("σοσ");
    expect(normalizeRoomName("σος")).toBe("σοσ");
    expect(normalizeRoomName("C++ 😀 Lounge")).toBe("c lounge");
  });

  test("never plans trigram work for one- or two-character names", () => {
    expect(authorizedRoomNameLookupStages("p")).toEqual(["exact", "prefix"]);
    expect(authorizedRoomNameLookupStages("pu")).toEqual(["exact", "prefix"]);
    expect(authorizedRoomNameLookupStages("pub")).toEqual(["exact", "prefix", "fuzzy"]);
    // Length is Unicode code points, not UTF-16 units.
    expect(authorizedRoomNameLookupStages("🛟")).toEqual(["exact", "prefix"]);
  });

  test("resolves one case-insensitive exact visible Room without a choice token", async () => {
    const result = await resolveAuthorizedRoomName(
      input("PUB-ROOM"),
      deps([room({ id: "room-public", label: "pub-room" })]),
    );
    expect(result).toEqual({
      status: "resolved",
      destination: {
        roomId: "room-public",
        namespaceId: "namespace-for-room-public",
        label: "pub-room",
        kind: "open",
        memberCount: 2,
        audienceFingerprint: "audience-for-room-public",
      },
    });
  });

  test("resolves a unique normalized label after case-insensitive equality", async () => {
    const result = await resolveAuthorizedRoomName(
      input("pub room"),
      deps([room({ id: "room-public", label: "pub-room" })]),
    );
    expect(result.status).toBe("resolved");
  });

  test("treats case- and separator-normalized labels as one ambiguous exact class", async () => {
    const result = await resolveAuthorizedRoomName(
      input("pub room"),
      deps([
        room({ id: "room-a", label: "Pub Room" }),
        room({ id: "room-b", label: "pub-room" }),
      ], { codec: fakeCodec() }),
    );
    expect(result.status).toBe("needs_disambiguation");
    if (result.status !== "needs_disambiguation") return;
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.label).sort()).toEqual(["Pub Room", "pub-room"].sort());
    expect(JSON.stringify(result.candidates)).not.toContain("room-a");
    expect(JSON.stringify(result.candidates)).not.toContain("room-b");
  });

  test("weak matches always require an explicit selection and candidates cap at five", async () => {
    const rooms = Array.from({ length: 7 }, (_, index) => room({
      id: `room-${index}`,
      label: `Project ${index}`,
    }));
    const result = await resolveAuthorizedRoomName(input("project"), deps(rooms, { codec: fakeCodec() }));
    expect(result.status).toBe("needs_disambiguation");
    if (result.status !== "needs_disambiguation") return;
    expect(result.candidates).toHaveLength(MAX_ROOM_NAME_CANDIDATES);
  });

  test("asks the bounded query to cross-check the authenticated Human and actor", async () => {
    const capture: {
      value?: Parameters<AuthorizedRoomNameResolverDependencies["findAuthorizedRoomNameCandidates"]>[0];
    } = {};
    const result = await resolveAuthorizedRoomName(
      input("pub-room"),
      {
        findAuthorizedRoomNameCandidates: async (query) => {
          capture.value = query;
          return [room({ id: "room-public", label: "pub-room" })];
        },
        userHasCapability: async () => true,
      },
    );
    expect(result.status).toBe("resolved");
    if (!capture.value) throw new Error("expected the authorized candidate query");
    expect(capture.value).toEqual({
      requesterUserId: REQUESTER_USER_ID,
      requesterActorId: REQUESTER_ACTOR_ID,
      normalizedTargetRoomName: "pub room",
      limit: ROOM_NAME_QUERY_CANDIDATE_LIMIT,
    });
  });

  test("does not disclose an inaccessible Room as distinct from a missing Room", async () => {
    const result = await resolveAuthorizedRoomName(input("secret room"), deps([]));
    expect(result).toEqual({ status: "not_found" });
  });

  test("fails closed when requester lacks manage_memories", async () => {
    const result = await resolveAuthorizedRoomName(
      input("pub-room"),
      deps([room({ id: "room-public", label: "pub-room" })], { capable: false }),
    );
    expect(result).toEqual({ status: "forbidden" });
  });

  test("relies on the existing top-level Room directory filters for archived, task, access, and subthread targets", async () => {
    const visible = room({ id: "room-visible", label: "Visible Room" });
    const result = await resolveAuthorizedRoomName(input("task room"), deps([visible]));
    expect(result).toEqual({ status: "not_found" });
  });

  test("requires a codec rather than silently selecting an ambiguous Room", async () => {
    const result = await resolveAuthorizedRoomName(input("pub room"), deps([
      room({ id: "room-a", label: "Pub Room" }),
      room({ id: "room-b", label: "PUB ROOM" }),
    ]));
    expect(result).toEqual({ status: "choice_token_codec_required" });
  });

  test("accepts a selected opaque token only for its bound requester and normalized query", async () => {
    const codec = fakeCodec();
    const options = { codec };
    const rooms = [
      room({ id: "room-a", label: "Pub Room" }),
      room({ id: "room-b", label: "PUB ROOM" }),
    ];
    const first = await resolveAuthorizedRoomName(input("pub room"), deps(rooms, options));
    expect(first.status).toBe("needs_disambiguation");
    if (first.status !== "needs_disambiguation") return;
    const token = first.candidates[0]!.choiceToken;

    const selected = await resolveAuthorizedRoomName(input("PUB—ROOM", token), deps(rooms, options));
    expect(selected.status).toBe("resolved");

    const replayAgainstOtherQuery = await resolveAuthorizedRoomName(input("pub", token), deps(rooms, options));
    expect(replayAgainstOtherQuery).toEqual({ status: "not_found" });

    const crossUserReplay = await resolveAuthorizedRoomName(
      { ...input("pub room", token), requesterUserId: "user-other" },
      {
        ...deps(rooms, options),
        userHasCapability: async (_userId, slug) => slug === "manage_memories",
      },
    );
    expect(crossUserReplay).toEqual({ status: "not_found" });
  });

  test("rejects a tampered token", async () => {
    const result = await resolveAuthorizedRoomName(
      input("pub room", "choice:user-requester:pub room:room-not-a-candidate"),
      deps([
        room({ id: "room-a", label: "Pub Room" }),
        room({ id: "room-b", label: "PUB ROOM" }),
      ], { codec: fakeCodec() }),
    );
    expect(result).toEqual({ status: "not_found" });
  });
});
