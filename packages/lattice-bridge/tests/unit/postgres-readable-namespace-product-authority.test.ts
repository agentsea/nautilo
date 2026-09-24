import { describe, expect, test } from "bun:test";
import { accessRevision, humanId, namespaceId } from "@nautilo/lattice-crypto";
import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeExecutor,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import {
  inspectNamespaceProductAuthoritySnapshot,
  PostgresNamespaceProductAuthority,
  type NamespaceProductAuthoritySnapshot,
} from "../../src/server/delivery/postgres-namespace-product-authority.ts";

const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "10000000-0000-4000-8000-000000000002";
const PEER = "10000000-0000-4000-8000-000000000003";
const AGENT = "10000000-0000-4000-8000-000000000004";
const ROOM = "10000000-0000-4000-8000-000000000005";
const NAMESPACE = "10000000-0000-4000-8000-000000000006";
const OTHER_ROOM = "10000000-0000-4000-8000-000000000007";
const OTHER_NAMESPACE = "10000000-0000-4000-8000-000000000008";
const members = [HUMAN, PEER].map((actor_id) => ({ actor_id, kind: "user" }));
const membersWithAgent = [...members, { actor_id: AGENT, kind: "agent" }];

function fixture(options: Readonly<{
  room?: PostgresJsBridgeRow;
  sourceMembers?: readonly PostgresJsBridgeRow[];
  targetMembers?: readonly PostgresJsBridgeRow[];
  readablePolicyNamespaceIds?: readonly string[];
  setTargets?: readonly PostgresJsBridgeRow[];
  setTargetMembers?: readonly PostgresJsBridgeRow[];
}> = {}) {
  const row = {
    source_room_id: ROOM, source_access_allowed: true,
    source_namespace_id: NAMESPACE,
    source_kind: "private",
    source_parent_room_id: null,
    source_archived_at: null,
    source_human_actor_ids: [HUMAN, PEER], effective_source_human_actor_ids: [HUMAN, PEER],
    target_room_id: ROOM,
    target_namespace_id: NAMESPACE,
    target_kind: "private",
    target_parent_room_id: null,
    target_archived_at: null,
    target_access_revision: 3,
    target_human_actor_ids: [HUMAN, PEER], effective_target_human_actor_ids: [HUMAN, PEER],
    subject_user_id: USER,
    ...options.room,
  };
  const statements: string[] = [];
  const queries: Array<Readonly<{
    statement: string;
    parameters: readonly unknown[];
  }>> = [];
  const setTargets = options.setTargets ?? [{
    room_id: row.target_room_id,
    namespace_id: row.target_namespace_id,
    parent_room_id: row.target_parent_room_id,
    namespace_access_revision: row.target_access_revision,
    human_actor_ids: row.target_human_actor_ids, effective_human_actor_ids: row.target_human_actor_ids,
  }];
  let transactionActive = false;
  const executor: PostgresJsBridgeExecutor = {
    query: async <Row extends PostgresJsBridgeRow>(
      statement: string,
      parameters: readonly unknown[] = [],
    ) => {
      statements.push(statement);
      queries.push({ statement, parameters });
      expect(transactionActive).toBe(true);
      let result: readonly PostgresJsBridgeRow[];
      if (statement.startsWith("select \"id\" from \"rooms\" where") && statement.includes(" limit ")) {
        result = [{ id: row.target_room_id }];
      }
      else if (statement.includes('order by "rooms"."parent_room_id" nulls first')) {
        result = parameters.flat().map((id) => ({ id: String(id) }));
      } else if (statement.includes("m290_namespace_key_readable_actor")) result = [row];
      else if (statement.includes("m290_namespace_key_readable_rooms")) result = [row];
      else if (statement.includes("m290_namespace_key_source_members")) {
        result = options.sourceMembers ?? members;
      } else if (statement.includes("m290_namespace_key_target_room")) {
        result = [row];
      } else if (statement.includes("m290_namespace_key_target_members")) {
        result = options.targetMembers ?? members;
      } else if (statement.includes("m291_namespace_key_readable_set_target_candidates")) {
        result = setTargets.map((target) => ({
          room_id: String(target["room_id"]),
          namespace_id: String(target["namespace_id"]),
        }));
      } else if (statement.includes("m291_namespace_key_readable_set_actor")) {
        result = [row];
      } else if (statement.includes("m291_namespace_key_readable_set_source_members")) {
        result = options.sourceMembers ?? members;
      } else if (statement.includes("m291_namespace_key_readable_set_source")) {
        result = [{
          source_room_id: ROOM, source_access_allowed: true,
          kind: row.source_kind,
          parent_room_id: row.source_parent_room_id,
          archived_at: row.source_archived_at,
          human_actor_ids: row.source_human_actor_ids, effective_human_actor_ids: row.source_human_actor_ids,
          subject_user_id: row.subject_user_id,
        }];
      } else if (statement.includes("m291_namespace_key_readable_set_targets")) {
        result = setTargets;
      } else if (statement.includes("m291_namespace_key_readable_set_target_members")) {
        result = options.setTargetMembers ?? (options.targetMembers ?? members).map(
          (member) => ({ ...member, room_id: row.target_room_id }),
        );
      } else if (
        statement.startsWith(
          "select \"rooms\".\"namespace_id\" from \"rooms\" inner join \"rooms\" \"namespace_source_room\"",
        )
      ) {
        const readable = new Set(
          options.readablePolicyNamespaceIds
            ?? setTargets.map((target) => String(target["namespace_id"])),
        );
        const requestedNamespaces = parameters.find(Array.isArray) ?? [];
        result = requestedNamespaces
          .filter((parameter): parameter is string =>
            typeof parameter === "string" && readable.has(parameter)
          )
          .filter((parameter, index, values) => values.indexOf(parameter) === index)
          .sort()
          .map((namespace_id) => ({ namespace_id: String(namespace_id) }));
      } else throw new Error(`Unexpected authority query: ${statement}`);
      return result as readonly Row[];
    },
  };
  const connection: PostgresJsBridgeConnection = {
    query: executor.query,
    transaction: async () => { throw new Error("Must not retry the authority callback"); },
    transactionOnce: async (use, options) => {
      expect(options?.isolationLevel).toBe("serializable");
      transactionActive = true;
      try { return await use(executor); }
      finally { transactionActive = false; }
    },
  };
  return {
    authority: new PostgresNamespaceProductAuthority(connection),
    statements,
    queries,
    transactionActive: () => transactionActive,
  };
}

const coordinates = {
  subjectUserId: USER,
  subjectHumanId: HUMAN,
  sourceRoomId: ROOM,
  namespaceId: NAMESPACE,
  keyClass: "human" as const,
};

describe("Human-only Room Domain-key product authority", () => {
  for (const kind of ["private", "group"]) {
    test(`permits own Human Namespace in a ${kind} Room without an Agent`, async () => {
      const state = fixture({ room: { source_kind: kind, target_kind: kind } });
      let handle: NamespaceProductAuthoritySnapshot | undefined;
      const result = await state.authority.withCurrentReadableNamespace({
        ...coordinates,
        use: async (snapshot) => {
          handle = snapshot;
          expect(state.transactionActive()).toBe(true);
          const facts = inspectNamespaceProductAuthoritySnapshot(snapshot);
          expect(facts.roomId).toBe(ROOM);
          expect(facts.namespaceId).toBe(namespaceId(NAMESPACE));
          expect(facts.participantHumanIds).toEqual([humanId(HUMAN), humanId(PEER)]);
          expect(facts.accessRevision).toBe(accessRevision(3));
          facts.audienceFingerprint.fill(0);
          return "human_keys_permitted";
        },
      });
      expect(result).toBe("human_keys_permitted");
      expect(state.statements).toHaveLength(8);
      expect(state.statements.map((statement) =>
        /\/\*\s+(m29\d_[a-z_]+)/.exec(statement)?.[1])).toEqual([
        undefined,
        undefined,
        "m290_namespace_key_readable_rooms",
        "m290_namespace_key_readable_actor",
        "m290_namespace_key_source_members",
        "m290_namespace_key_target_room",
        "m290_namespace_key_target_members",
        undefined,
      ]);
      expect(state.statements[0]).toStartWith(
        "select \"id\" from \"rooms\" where",
      );
      expect(state.statements[0]).not.toContain("FOR UPDATE");
      expect(state.statements[1]).toContain('order by "rooms"."parent_room_id" nulls first, "rooms"."id" asc for update of "rooms"');
      expect(state.statements[2]).toContain("FOR UPDATE OF source");
      expect(state.statements[3]).toContain("FOR UPDATE OF actor");
      expect(() => inspectNamespaceProductAuthoritySnapshot(handle!)).toThrow();
    });
  }

  test("permits own AI recipient servicing in a Human-only Room", async () => {
    let used = false;
    expect(await fixture().authority.withCurrentReadableNamespace({
      ...coordinates,
      keyClass: "ai",
      use: async () => { used = true; return "ai_keys_permitted"; },
    })).toBe("ai_keys_permitted");
    expect(used).toBe(true);
  });

  for (const keyClass of ["human", "ai"] as const) {
    test(`permits own ${keyClass} recipient servicing in an open Room`, async () => {
      expect(await fixture({ room: { source_kind: "open", target_kind: "open" } })
        .authority.withCurrentReadableNamespace({
          ...coordinates,
          keyClass,
          use: async () => "open_room_recipient_service",
        })).toBe("open_room_recipient_service");
    });
  }

  for (const keyClass of ["human", "ai"] as const) {
    test(`permits inherited ${keyClass} Namespace custody with both Subthread and parent membership`, async () => {
      const state = fixture({room: {
        source_kind: "subthread", source_parent_room_id: OTHER_ROOM,
        target_room_id: OTHER_ROOM,
      }});
      const result = await state.authority.withCurrentReadableNamespace({
        ...coordinates, keyClass,
        use: async snapshot => {
          expect(state.transactionActive()).toBe(true);
          const facts = inspectNamespaceProductAuthoritySnapshot(snapshot);
          expect(facts.roomId).toBe(OTHER_ROOM);
          expect(facts.namespaceId).toBe(namespaceId(NAMESPACE));
          expect(facts.accessRevision).toBe(accessRevision(3));
          expect(facts.participantHumanIds).toEqual([humanId(HUMAN), humanId(PEER)]);
          facts.audienceFingerprint.fill(0);
          return "inherited_keys";
        },
      });
      expect(result).toBe("inherited_keys");
      expect(state.statements[1]).toContain('order by "rooms"."parent_room_id" nulls first, "rooms"."id" asc for update of "rooms"');
      expect(state.statements[4]).toContain("FOR UPDATE OF member");
      expect(state.statements[6]).toContain("FOR UPDATE OF member");
    });

    test(`permits inherited public ${keyClass} Namespace custody`, async () => {
      expect(await fixture({room: {
        source_kind: "subthread",
        source_parent_room_id: OTHER_ROOM,
        target_room_id: OTHER_ROOM,
        target_kind: "open",
      }}).authority.withCurrentReadableNamespace({
        ...coordinates,
        keyClass,
        use: async () => "inherited_public_keys",
      })).toBe("inherited_public_keys");
    });
  }

  const invalidInheritedStates = [
    ["another Namespace", {room: {source_namespace_id: OTHER_NAMESPACE}}],
    ["another parent", {room: {source_parent_room_id: PEER}}],
    ["archived parent", {room: {target_archived_at: new Date()}}],
    ["parent itself a Subthread", {room: {target_parent_room_id: PEER}}],
    ["removed child membership", {sourceMembers: [members[1]!]}],
    ["removed parent membership", {targetMembers: [members[1]!]}],
    ["stale child roster", {room: {source_human_actor_ids: [HUMAN], effective_source_human_actor_ids: [HUMAN]}}],
    ["stale parent roster", {room: {target_human_actor_ids: [HUMAN], effective_target_human_actor_ids: [HUMAN]}}],
    ["foreign account", {room: {subject_user_id: PEER}}],
  ] as const;
  for (const [label, options] of invalidInheritedStates) {
    test(`denies inherited custody with ${label}`, async () => {
      const state = fixture({...options, room: {
        source_kind: "subthread", source_parent_room_id: OTHER_ROOM,
        target_room_id: OTHER_ROOM, ...("room" in options ? options.room : {}),
      }});
      let used = false;
      expect(await state.authority.withCurrentReadableNamespace({
        ...coordinates, keyClass: "ai",
        use: async () => {used = true; return "forbidden";},
      })).toBeNull();
      expect(used).toBe(false);
    });
  }

  test("does not allow an Agent-bearing public source to nominate a private Namespace", async () => {
    const state = fixture({
      room: {
        source_kind: "open",
        target_room_id: OTHER_ROOM,
        target_namespace_id: OTHER_NAMESPACE,
        target_kind: "private",
      },
      sourceMembers: membersWithAgent,
      readablePolicyNamespaceIds: [],
    });
    expect(await state.authority.withCurrentReadableNamespace({
      ...coordinates,
      namespaceId: OTHER_NAMESPACE,
      keyClass: "ai",
      use: async () => "forbidden",
    })).toBeNull();
    expect(state.queries.some(({ statement }) =>
      statement.includes('left join "rooms" "public_boundary_room"')
    )).toBe(true);
  });

  test("denies an Agent cross-read when the public target omits a source Human", async () => {
    const state = fixture({
      room: {
        source_kind: "open",
        target_room_id: OTHER_ROOM,
        target_namespace_id: OTHER_NAMESPACE,
        target_kind: "open",
        target_human_actor_ids: [HUMAN], effective_target_human_actor_ids: [HUMAN],
      },
      sourceMembers: membersWithAgent,
      targetMembers: [{ actor_id: HUMAN, kind: "user" }],
      readablePolicyNamespaceIds: [],
    });
    let used = false;
    expect(await state.authority.withCurrentReadableNamespace({
      ...coordinates,
      namespaceId: OTHER_NAMESPACE,
      keyClass: "ai",
      use: async () => { used = true; return "forbidden"; },
    })).toBeNull();
    expect(used).toBe(false);
    const policyQuery = state.queries.find(({ statement }) =>
      statement.startsWith('select "rooms"."namespace_id" from "rooms"')
    );
    expect(policyQuery?.statement).toContain(
      '"public_boundary_room"."id" is not null',
    );
    expect(policyQuery?.statement).toContain(
      'public.moderation_effective_humans("rooms"."human_actor_ids", "rooms"."id") @>',
    );
  });

  for (const [sourceKind, label] of [
    ["private", "private-to-public"],
    ["open", "public-to-public"],
  ] as const) {
    test(`permits ${label} Agent cross-read when the public target contains the source Humans`, async () => {
      const state = fixture({
        room: {
          source_kind: sourceKind,
          source_human_actor_ids: [HUMAN], effective_source_human_actor_ids: [HUMAN],
          target_room_id: OTHER_ROOM,
          target_namespace_id: OTHER_NAMESPACE,
          target_kind: "open",
          target_human_actor_ids: [HUMAN, PEER], effective_target_human_actor_ids: [HUMAN, PEER],
        },
        sourceMembers: [members[0]!, { actor_id: AGENT, kind: "agent" }],
      });
      expect(await state.authority.withCurrentReadableNamespace({
        ...coordinates,
        namespaceId: OTHER_NAMESPACE,
        keyClass: "ai",
        use: async () => "qualified_public_read",
      })).toBe("qualified_public_read");

      const policyQuery = state.queries.find(({ statement }) =>
        statement.startsWith('select "rooms"."namespace_id" from "rooms"')
      );
      expect(policyQuery?.statement).toContain(
        'inner join "rooms" "namespace_source_room" on "namespace_source_room"."id" = $1',
      );
      expect(policyQuery?.statement).toContain(
        'left join "rooms" "public_boundary_room" on ("public_boundary_room"."namespace_id" = "namespace_source_room"."namespace_id"',
      );
      expect(policyQuery?.statement).toContain(
        '"rooms"."parent_room_id" is null and "rooms"."archived_at" is null',
      );
      expect(policyQuery?.statement).toContain(
        '"public_boundary_room"."id" is null and public.moderation_effective_humans("rooms"."human_actor_ids", "rooms"."id") @> $8::uuid[]',
      );
      expect(policyQuery?.statement).toContain(
        '"public_boundary_room"."id" is not null and ("rooms"."kind" = $9 and public.moderation_effective_humans("rooms"."human_actor_ids", "rooms"."id") @> $10::uuid[])',
      );
      expect(policyQuery?.parameters).toEqual([
        ROOM,
        "open",
        [OTHER_NAMESPACE],
        "private",
        "group",
        "open",
        "access",
        [HUMAN],
        "open",
        [HUMAN],
      ]);
      expect(policyQuery?.statement).toContain(
        '"rooms"."namespace_id" = ANY($3::uuid[])',
      );
      expect(policyQuery?.parameters.filter(Array.isArray)).toEqual([
        [OTHER_NAMESPACE], [HUMAN], [HUMAN],
      ]);
    });
  }

  test("preserves generic access-Room authority for its exact Namespace", async () => {
    expect(await fixture({ room: {
      source_kind: "access",
      target_kind: "access",
    } }).authority.withCurrentReadableNamespace({
      ...coordinates,
      keyClass: "human",
      use: async () => "exact_access_namespace",
    })).toBe("exact_access_namespace");
  });

  test("does not allow a Human-only Room to nominate another readable Room", async () => {
    let used = false;
    const state = fixture({ room: {
      target_room_id: OTHER_ROOM,
      target_namespace_id: OTHER_NAMESPACE,
    } });
    expect(await state.authority.withCurrentReadableNamespace({
      ...coordinates,
      namespaceId: OTHER_NAMESPACE,
      use: async () => { used = true; return "forbidden"; },
    })).toBeNull();
    expect(used).toBe(false);
  });

  test("does not permit a mismatched source Namespace even with a matching Room id", async () => {
    expect(await fixture({ room: { source_namespace_id: OTHER_NAMESPACE } })
      .authority.withCurrentReadableNamespace({
        ...coordinates,
        use: async () => "forbidden",
      })).toBeNull();
  });

  test("leaves the Agent readable-set/grant boundary closed in a Human-only Room", async () => {
    let used = false;
    expect(await fixture().authority.withCurrentReadableNamespaceSet({
      subjectUserId: USER,
      subjectHumanId: HUMAN,
      sourceRoomId: ROOM,
      namespaceIds: [NAMESPACE],
      use: async () => { used = true; return "forbidden"; },
    })).toBeNull();
    expect(used).toBe(false);
  });

  for (const [sourceKind, label] of [
    ["private", "private-to-public"],
    ["open", "public-to-public"],
  ] as const) {
    test(`permits the ${label} readable-set counterpart`, async () => {
      const state = fixture({
        room: {
          source_kind: sourceKind,
          source_human_actor_ids: [HUMAN], effective_source_human_actor_ids: [HUMAN],
        },
        sourceMembers: [members[0]!, { actor_id: AGENT, kind: "agent" }],
        setTargets: [{
          room_id: OTHER_ROOM,
          namespace_id: OTHER_NAMESPACE,
          parent_room_id: null,
          namespace_access_revision: 8,
          human_actor_ids: [HUMAN, PEER], effective_human_actor_ids: [HUMAN, PEER],
        }],
        setTargetMembers: members.map((member) => ({
          ...member,
          room_id: OTHER_ROOM,
        })),
      });

      expect(await state.authority.withCurrentReadableNamespaceSet({
        subjectUserId: USER,
        subjectHumanId: HUMAN,
        sourceRoomId: ROOM,
        namespaceIds: [OTHER_NAMESPACE],
        use: async (entries) => {
          expect(entries).toHaveLength(1);
          const facts = inspectNamespaceProductAuthoritySnapshot(
            entries[0]!.authority,
          );
          expect(facts.roomId).toBe(OTHER_ROOM);
          expect(facts.namespaceId).toBe(namespaceId(OTHER_NAMESPACE));
          expect(facts.participantHumanIds).toEqual([
            humanId(HUMAN),
            humanId(PEER),
          ]);
          expect(facts.accessRevision).toBe(accessRevision(8));
          facts.audienceFingerprint.fill(0);
          return "qualified_public_set";
        },
      })).toBe("qualified_public_set");
      // The maximum accepted set plus its source must not become one bind
      // parameter per Room and exceed PostgreSQL's parameter-count boundary.
      expect(state.queries[1]?.parameters).toEqual([[ROOM, OTHER_ROOM]]);
    });
  }

  test("denies the public-to-private readable-set counterpart at canonical policy", async () => {
    const state = fixture({
      room: { source_kind: "open" },
      sourceMembers: membersWithAgent,
      setTargets: [{
        room_id: OTHER_ROOM,
        namespace_id: OTHER_NAMESPACE,
        parent_room_id: null,
        namespace_access_revision: 8,
        human_actor_ids: [HUMAN, PEER], effective_human_actor_ids: [HUMAN, PEER],
      }],
      setTargetMembers: members.map((member) => ({
        ...member,
        room_id: OTHER_ROOM,
      })),
      readablePolicyNamespaceIds: [],
    });
    let used = false;
    expect(await state.authority.withCurrentReadableNamespaceSet({
      subjectUserId: USER,
      subjectHumanId: HUMAN,
      sourceRoomId: ROOM,
      namespaceIds: [OTHER_NAMESPACE],
      use: async () => { used = true; return "forbidden"; },
    })).toBeNull();
    expect(used).toBe(false);
    expect(state.queries.some(({ statement }) =>
      statement.startsWith('select "rooms"."namespace_id" from "rooms"')
    )).toBe(true);
  });

  test("denies the public readable-set counterpart when a target omits a source Human", async () => {
    const state = fixture({
      room: { source_kind: "open" },
      sourceMembers: membersWithAgent,
      setTargets: [{
        room_id: OTHER_ROOM,
        namespace_id: OTHER_NAMESPACE,
        parent_room_id: null,
        namespace_access_revision: 8,
        human_actor_ids: [HUMAN], effective_human_actor_ids: [HUMAN],
      }],
      setTargetMembers: [{
        room_id: OTHER_ROOM,
        actor_id: HUMAN,
        kind: "user",
      }],
      readablePolicyNamespaceIds: [],
    });
    let used = false;
    expect(await state.authority.withCurrentReadableNamespaceSet({
      subjectUserId: USER,
      subjectHumanId: HUMAN,
      sourceRoomId: ROOM,
      namespaceIds: [OTHER_NAMESPACE],
      use: async () => { used = true; return "forbidden"; },
    })).toBeNull();
    expect(used).toBe(false);
  });

  for (const keyClass of ["human", "ai"] as const) {
    test(`preserves ${keyClass} cross-Namespace access from an Agent Room`, async () => {
      const state = fixture({
        room: { target_room_id: OTHER_ROOM, target_namespace_id: OTHER_NAMESPACE },
        sourceMembers: [...members, { actor_id: AGENT, kind: "agent" }],
      });
      expect(await state.authority.withCurrentReadableNamespace({
        ...coordinates,
        namespaceId: OTHER_NAMESPACE,
        keyClass,
        use: async (snapshot) => {
          const facts = inspectNamespaceProductAuthoritySnapshot(snapshot);
          expect(facts.roomId).toBe(OTHER_ROOM);
          facts.audienceFingerprint.fill(0);
          return "readable";
        },
      })).toBe("readable");
    });
  }

  const invalidStates = [
    ["foreign account", { room: { subject_user_id: PEER } }],
    ["removed source Human", { sourceMembers: [members[1]!] }],
    ["removed target Human", { targetMembers: [members[1]!] }],
    ["stale source audience", { room: { source_human_actor_ids: [HUMAN], effective_source_human_actor_ids: [HUMAN] } }],
    ["stale target audience", { room: { target_human_actor_ids: [HUMAN], effective_target_human_actor_ids: [HUMAN] } }],
    ["archived source", { room: { source_archived_at: new Date() } }],
    ["public source", { room: { source_kind: "public" } }],
    ["source subthread", { room: { source_parent_room_id: OTHER_ROOM } }],
    ["target subthread", { room: { target_parent_room_id: OTHER_ROOM } }],
  ] as const;
  for (const [label, options] of invalidStates) {
    test(`denies ${label} without entering the key repository`, async () => {
      let used = false;
      expect(await fixture(options).authority.withCurrentReadableNamespace({
        ...coordinates,
        use: async () => { used = true; return "forbidden"; },
      })).toBeNull();
      expect(used).toBe(false);
    });
  }
});
