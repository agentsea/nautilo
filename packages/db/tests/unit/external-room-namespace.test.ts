import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { rooms } from "../../src/schema/rooms";
import { namespaceSubsetPredicate, privateNamespaceBoundarySql, createNamespaceBoundaryProjection } from "../../src/queries/namespace-access";

test("ordinary Human-set containment cannot retrieve an external Namespace", () => {
  const dialect = new PgDialect();
  for (const predicate of [namespaceSubsetPredicate(["same-human"], false), namespaceSubsetPredicate(["same-human"], true), privateNamespaceBoundarySql(rooms.namespaceId)]) {
    const rendered = dialect.sqlToQuery(predicate);
    expect(rendered.sql).toContain("NOT EXISTS");
    expect(rendered.sql).toContain("external_boundary_room.external_context = true");
    expect(rendered.sql).toContain('external_boundary_room.namespace_id = "rooms"."namespace_id"');
  }
});
test("subthreads inherit the persistent boundary through an alias-safe Namespace join", () => {
  const db = drizzle({ client: { options: { parsers: {}, serializers: {} } } as never });
  const boundary = createNamespaceBoundaryProjection();
  const query = db.select({ externalRoom: boundary.externalBoundaryRoomId }).from(boundary.sourceRoom)
    .leftJoin(boundary.externalBoundaryRoom, boundary.externalBoundaryJoin).toSQL();
  expect(query.sql).toContain('"external_boundary_room"."namespace_id" = "namespace_source_room"."namespace_id"');
  expect(query.sql).not.toContain('"namespace_id" = "namespace_id"');
  expect(query.params).toEqual([true]);
});
