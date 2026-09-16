import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DirectDatabase } from "../../src/config/direct-database";
import { listWorkspaceRoomDocumentHistory } from "../../src/queries/workspace-document-history";

test("human UI history query binds Room, exact artifact and agent, not the initiating human; preserves full ordered lineage", async () => {
  const clauses: SQL[] = [];
  let order: SQL[] = [];
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: (condition: SQL) => { clauses.push(condition); return chain; },
    orderBy: (...conditions: SQL[]) => { order = conditions; return Promise.resolve([]); },
  };
  const db = { select: () => chain } as unknown as DirectDatabase;
  expect(await listWorkspaceRoomDocumentHistory(db, {
    agentId: "agent", roomId: "private-room", artifactInternalId: "exact-artifact",
  })).toEqual([]);
  const dialect = new PgDialect();
  const predicate = dialect.sqlToQuery(clauses[0]!);
  expect(predicate.params).toEqual([true, "agent", "private-room", "exact-artifact"]);
  expect(predicate.sql).not.toContain('"owner_id"');
  expect(predicate.sql).toContain('"workspace_document_mutations"."room_id"');
  expect(predicate.sql).toContain('"workspace_document_mutation_entries"."artifact_internal_id"');
  expect(order.map((part) => dialect.sqlToQuery(part).sql)).toEqual([
    '"workspace_document_mutations"."created_at" desc',
    '"workspace_document_mutations"."id" desc',
    '"workspace_document_mutation_entries"."sequence" desc',
    '"workspace_document_mutation_entries"."id" desc',
  ]);
});

test("blank disclosure scope never reaches the database", async () => {
  const db = { select: () => { throw new Error("must not query"); } } as unknown as DirectDatabase;
  for (const key of ["agentId", "roomId", "artifactInternalId"] as const) {
    const error = await listWorkspaceRoomDocumentHistory(db, {
      agentId: "agent", roomId: "room", artifactInternalId: "artifact", [key]: " ",
    }).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/scope|Room/);
  }
});
