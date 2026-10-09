import { describe, expect, test } from "bun:test";
import type { DirectDatabase, SQL } from "@nautilo/db";
import { PgDialect } from "drizzle-orm/pg-core";

import { createProtectedTaskRequesterPrivateRoomResolver } from
  "../../src/routes/protected-task-requester-private-room";

const HUMAN = "10000000-0000-4000-8000-000000000001";
const PRIVATE_ROOM = "20000000-0000-4000-8000-000000000002";
const PRIVATE_NAMESPACE = "30000000-0000-4000-8000-000000000003";

function candidate(
  overrides: Partial<Readonly<{
    roomId: string;
    namespaceId: string;
    type: string;
    kind: string;
    graphThreadId: string;
    createdAt: Date;
    humanActorIds: readonly string[];
    memberCount: number;
    humanCount: number;
    agentCount: number;
  }>> = {},
) {
  return {
    roomId: PRIVATE_ROOM,
    namespaceId: PRIVATE_NAMESPACE,
    type: "private",
    kind: "private",
    graphThreadId: "app:default",
    createdAt: new Date(0),
    humanActorIds: [HUMAN],
    memberCount: 2,
    humanCount: 1,
    agentCount: 1,
    ...overrides,
  };
}

function database(
  humanRows: readonly Readonly<{ id: string }>[],
  roomRows: readonly ReturnType<typeof candidate>[],
  observation?: {
    where: SQL[];
    having: SQL[];
    orderBy: SQL[][];
    limit: number[];
  },
): DirectDatabase {
  let selection = 0;
  return {
    select() {
      const rows = selection++ === 0 ? humanRows : roomRows;
      const builder: Record<string, unknown> = {};
      builder["from"] = () => builder;
      builder["innerJoin"] = () => builder;
      builder["where"] = (condition: SQL) => {
        observation?.where.push(condition);
        return builder;
      };
      builder["groupBy"] = () => builder;
      builder["having"] = (condition: SQL) => {
        observation?.having.push(condition);
        return builder;
      };
      builder["orderBy"] = (...clauses: SQL[]) => {
        observation?.orderBy.push(clauses);
        return builder;
      };
      builder["limit"] = (value: number) => {
        observation?.limit.push(value);
        return Promise.resolve(rows);
      };
      return builder;
    },
  } as unknown as DirectDatabase;
}

describe("protected Task requester private Room resolver", () => {
  test("ignores a group-shaped first result and selects the exact private Room", async () => {
    const resolve = createProtectedTaskRequesterPrivateRoomResolver(database(
      [{ id: HUMAN }],
      [
        candidate({
          roomId: "40000000-0000-4000-8000-000000000004",
          namespaceId: "50000000-0000-4000-8000-000000000005",
          type: "shared",
          kind: "group",
          graphThreadId: "room:group",
        }),
        candidate(),
      ],
    ));

    expect(await resolve("user-1", "agent-1")).toEqual({
      roomId: PRIVATE_ROOM,
      namespaceId: PRIVATE_NAMESPACE,
    });
  });

  test("fails closed for wrong membership, kind, or Room type", async () => {
    for (const invalid of [
      candidate({ humanActorIds: ["other-human"] }),
      candidate({ memberCount: 3 }),
      candidate({ humanCount: 0 }),
      candidate({ agentCount: 0 }),
      candidate({ kind: "group" }),
      candidate({ type: "shared" }),
    ]) {
      const resolve = createProtectedTaskRequesterPrivateRoomResolver(
        database([{ id: HUMAN }], [invalid]),
      );
      expect(await resolve("user-1", "agent-1")).toBeNull();
    }
  });

  test("fails closed unless exactly one requester Human exists", async () => {
    for (const humans of [[], [{ id: HUMAN }, { id: "other-human" }]]) {
      const resolve = createProtectedTaskRequesterPrivateRoomResolver(
        database(humans, [candidate()]),
      );
      expect(await resolve("user-1", "agent-1")).toBeNull();
    }
  });

  test("queries the exact private boundary and canonical deterministic order", async () => {
    const observation = {
      where: [] as SQL[],
      having: [] as SQL[],
      orderBy: [] as SQL[][],
      limit: [] as number[],
    };
    const resolve = createProtectedTaskRequesterPrivateRoomResolver(database(
      [{ id: HUMAN }],
      [candidate()],
      observation,
    ));
    expect(await resolve("user-1", "agent-1", PRIVATE_NAMESPACE)).not.toBeNull();

    const dialect = new PgDialect();
    const roomWhere = dialect.sqlToQuery(observation.where[1]!);
    expect(roomWhere.sql).toContain('"rooms"."type" =');
    expect(roomWhere.sql).toContain('"rooms"."kind" =');
    expect(roomWhere.sql).toContain("NOT EXISTS");
    expect(roomWhere.sql).toContain('public_boundary_room.kind = \'open\'');
    expect(roomWhere.sql).toContain('"rooms"."namespace_id" =');
    expect(roomWhere.params).toEqual([
      "private",
      "private",
      PRIVATE_NAMESPACE,
    ]);

    const having = dialect.sqlToQuery(observation.having[0]!);
    expect(having.sql).toContain("count(*) = 2");
    expect(having.sql).toContain('"actors"."kind" = \'agent\'');
    expect(having.sql).toContain('"actors"."kind" = \'user\'');
    expect(having.sql).toContain('cardinality("rooms"."human_actor_ids") = 1');
    expect(having.params).toEqual(["agent-1", HUMAN, HUMAN]);

    const order = observation.orderBy[0]!.map((clause) =>
      dialect.sqlToQuery(clause)
    );
    expect(order[0]!.sql).toContain('"rooms"."graph_thread_id"');
    expect(order[0]!.params).toEqual([]);
    expect(order[0]!.sql).toContain("app:default");
    expect(order[1]!.sql).toBe('"rooms"."created_at" asc');
    expect(order[2]!.sql).toBe('"rooms"."id" asc');
    expect(observation.limit).toEqual([2, 2]);
  });

  test("pins an existing Task to one exact durable Namespace", async () => {
    const resolve = createProtectedTaskRequesterPrivateRoomResolver(database(
      [{ id: HUMAN }],
      [candidate()],
    ));
    expect(await resolve("user-1", "agent-1", PRIVATE_NAMESPACE)).toEqual({
      roomId: PRIVATE_ROOM,
      namespaceId: PRIVATE_NAMESPACE,
    });
    const wrong = createProtectedTaskRequesterPrivateRoomResolver(database(
      [{ id: HUMAN }],
      [candidate()],
    ));
    expect(await wrong(
      "user-1",
      "agent-1",
      "60000000-0000-4000-8000-000000000006",
    )).toBeNull();
  });

  test("rejects an ambiguous exact Namespace instead of remapping", async () => {
    const resolve = createProtectedTaskRequesterPrivateRoomResolver(database(
      [{ id: HUMAN }],
      [candidate(), candidate({
        roomId: "70000000-0000-4000-8000-000000000007",
        graphThreadId: "room:duplicate",
      })],
    ));
    expect(await resolve("user-1", "agent-1", PRIVATE_NAMESPACE)).toBeNull();
  });
});
