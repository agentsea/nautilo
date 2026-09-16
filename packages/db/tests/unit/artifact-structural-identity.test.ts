import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { artifacts } from "../../src/schema/artifacts";
import { findArtifactInternalIdByPublicId } from "../../src/queries/artifacts";

test("public Artifact identity resolution selects no authored content or storage fields", async () => {
  let selection: unknown;
  let predicate: SQL | undefined;
  const connection = { select: (fields: unknown) => {
    selection = fields;
    return { from: () => ({ where: async (query: SQL) => {
      predicate = query;
      return [{ id: "internal-id" }];
    } }) };
  } } as unknown as NonNullable<Parameters<typeof findArtifactInternalIdByPublicId>[1]>;
  expect(await findArtifactInternalIdByPublicId("public-id", connection)).toBe("internal-id");
  expect(selection).toEqual({ id: artifacts.id });
  const query = new PgDialect().sqlToQuery(predicate!);
  expect(query.params).toEqual(["public-id"]);
  expect(query.sql).toContain('"artifacts"."deleted_at" is null');
});
