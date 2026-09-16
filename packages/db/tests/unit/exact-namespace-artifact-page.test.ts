import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Database } from "../../src/config/database";
import {
  buildArtifactReconciliationIdentityQuery,
  buildExactNamespaceArtifactPageQuery,
} from "../../src/queries/artifacts";

describe("exact Namespace Artifact keyset page", () => {
  test("binds exact Namespace, prefix and MIME with deterministic keyset order", () => {
    const connection = drizzle.mock() as unknown as Database;
    const updatedAt = new Date("2026-09-11T10:00:00.000Z");
    const id = "10000000-0000-4000-8000-000000000001";
    const rendered = buildExactNamespaceArtifactPageQuery({
      namespaceId: "20000000-0000-4000-8000-000000000001",
      pathPrefix: "Design/My Templates/",
      mimeType: "application/vnd.nautilo.slide-template+html",
      pageSize: 501,
      cursor: { updatedAt, id },
    }, connection).toSQL();

    expect(rendered.sql).toContain('inner join "artifact_namespaces"');
    expect(rendered.sql).toContain('"artifact_namespaces"."namespace_id" = $');
    expect(rendered.sql).toContain('"artifacts"."path" like $');
    expect(rendered.sql).toContain('"artifacts"."mime_type" = $');
    expect(rendered.sql).toContain("not exists");
    expect(rendered.sql).toContain('"artifact_collection_other_edges"."namespace_id" <> $');
    expect(rendered.sql).toContain('"artifacts"."updated_at" < $');
    expect(rendered.sql).toContain('"artifacts"."updated_at" = $');
    expect(rendered.sql).toContain('"artifacts"."id" < $');
    expect(rendered.sql).toContain('order by "artifacts"."updated_at" desc, "artifacts"."id" desc');
    expect(rendered.sql).not.toContain(" offset ");
    expect(rendered.params).toContain("Design/My Templates/%");
    expect(rendered.params).toContain("application/vnd.nautilo.slide-template+html");
    expect(rendered.params).toContain(updatedAt.toISOString());
    expect(rendered.params).toContain(id);
    expect(rendered.params).toContain(501);
  });

  test("commit reconciliation finds the external identity across lifecycle and Namespace changes", () => {
    const connection = drizzle.mock() as unknown as Database;
    const id = "10000000-0000-4000-8000-000000000001";
    const rendered = buildArtifactReconciliationIdentityQuery(id, connection).toSQL();

    expect(rendered.sql).toContain('from "artifacts"');
    expect(rendered.sql).toContain('"artifacts"."artifact_id" = $1');
    expect(rendered.sql).not.toContain("artifact_namespaces");
    expect(rendered.sql).not.toContain('"deleted_at" is null');
    expect(rendered.params).toEqual([id, 1]);
  });
});
