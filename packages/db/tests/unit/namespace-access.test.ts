import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { rooms } from "../../src/schema/rooms";
import {
  createNamespaceBoundaryProjection,
  namespaceSubsetPredicate,
  privateNamespaceBoundarySql,
  publicNamespaceBoundarySql,
} from "../../src/queries/namespace-access";

const dialect = new PgDialect();

describe("M227 Namespace effective-audience SQL", () => {
  test("selected boundary projection keeps both Namespace operands qualified", () => {
    const db = drizzle({
      client: {
        options: { parsers: {}, serializers: {} },
      } as never,
    });
    const boundary = createNamespaceBoundaryProjection();
    const rendered = db
      .select({
        sourceRoomId: boundary.sourceRoom.id,
        publicBoundaryRoomId: boundary.publicBoundaryRoomId,
      })
      .from(boundary.sourceRoom)
      .leftJoin(
        boundary.publicBoundaryRoom,
        boundary.publicBoundaryJoin,
      )
      .toSQL();

    expect(rendered.sql).toContain(
      `"public_boundary_room"."namespace_id" = "namespace_source_room"."namespace_id"`,
    );
    expect(rendered.sql).not.toContain(`"namespace_id" = "namespace_id"`);
    expect(rendered.params).toEqual(["open"]);
  });

  test("public boundary is derived from an open Room sharing the Namespace", () => {
    const rendered = dialect.sqlToQuery(
      publicNamespaceBoundarySql(rooms.namespaceId),
    );

    expect(rendered.sql).toContain("EXISTS");
    expect(rendered.sql).toContain("public_boundary_room.namespace_id");
    expect(rendered.sql).toContain(`"rooms"."namespace_id"`);
    expect(rendered.sql).toContain("public_boundary_room.kind = 'open'");
    expect(rendered.params).toEqual([]);
  });

  test("human-only audience resolvers negate the same public projection", () => {
    const rendered = dialect.sqlToQuery(
      privateNamespaceBoundarySql(rooms.namespaceId),
    );

    expect(rendered.sql).toContain("NOT EXISTS");
    expect(rendered.sql).toContain("public_boundary_room.kind = 'open'");
  });

  test("private source keeps ordinary containment without a kind filter", () => {
    const rendered = dialect.sqlToQuery(
      namespaceSubsetPredicate(["actor-a", "actor-b"], false),
    );

    expect(rendered.sql).toContain(`"rooms"."human_actor_ids" @> ARRAY[$1, $2]::uuid[]`);
    expect(rendered.sql).not.toContain(`"rooms"."kind"`);
    expect(rendered.params).toEqual(["actor-a", "actor-b"]);
  });

  test("public source keeps containment and requires an open candidate", () => {
    const rendered = dialect.sqlToQuery(
      namespaceSubsetPredicate(["actor-a"], true),
    );

    expect(rendered.sql).toContain(`"rooms"."human_actor_ids" @> ARRAY[$1]::uuid[]`);
    expect(rendered.sql).toContain(`"rooms"."kind" = $2`);
    expect(rendered.params).toEqual(["actor-a", "open"]);
  });
});
