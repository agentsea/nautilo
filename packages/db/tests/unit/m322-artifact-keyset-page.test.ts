import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "../../src/config/database";
import { listArtifactPageForNamespaces } from "../../src/queries/artifacts";

function artifactRow(id: string, createdAtCursor: string) {
  return {
    id,
    artifactId: `public-${id}`,
    path: `${id}.md`,
    mimeType: "text/markdown",
    size: 1,
    storageUri: `file:///fixture/${id}.md`,
    revision: 1,
    createdAt: new Date("2026-01-01T00:00:00.123Z"),
    createdAtCursor,
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    deletedAt: null,
  };
}

function stubConnection(rows: ReturnType<typeof artifactRow>[]) {
  const captured: { limit?: number; orderByCount?: number; where?: SQL } = {};
  const terminal = {
    limit(value: number) {
      captured.limit = value;
      return Promise.resolve(rows);
    },
  };
  const conn = {
    selectDistinct() {
      return {
        from() {
          return {
            innerJoin() {
              return {
                where(value: unknown) {
                  captured.where = value as SQL;
                  return {
                    orderBy(...values: unknown[]) {
                      captured.orderByCount = values.length;
                      return terminal;
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
  return { conn, captured };
}

describe("M322 Artifact keyset page", () => {
  test("fetches one lookahead row and preserves exact microseconds in the cursor", async () => {
    const firstId = "20000000-0000-4000-8000-000000000002";
    const secondId = "10000000-0000-4000-8000-000000000001";
    const rows = [
      artifactRow(firstId, "2026-01-01T00:00:00.123457Z"),
      artifactRow(secondId, "2026-01-01T00:00:00.123456Z"),
    ];
    const { conn, captured } = stubConnection(rows);
    const snapshotAt = new Date("2026-02-01T00:00:00.000Z");

    const page = await listArtifactPageForNamespaces({
      readableNamespaceIds: ["ns-a"],
      limit: 1,
      snapshotAt,
    }, conn);

    expect(page.artifacts.map((artifact) => artifact.id)).toEqual([firstId]);
    expect(page.next).toEqual({
      createdAt: "2026-01-01T00:00:00.123457Z",
      id: firstId,
      snapshotAt,
    });
    expect(captured.limit).toBe(2);
    expect(captured.orderByCount).toBe(2);
  });

  test("an empty authority set performs no query", async () => {
    const { conn, captured } = stubConnection([]);
    expect(await listArtifactPageForNamespaces({
      readableNamespaceIds: [],
      limit: 500,
      snapshotAt: new Date("2026-02-01T00:00:00.000Z"),
    }, conn)).toEqual({ artifacts: [], next: null });
    expect(captured.limit).toBeUndefined();
  });

  test("the continuation compares exact creation time then id for equal-millisecond rows", async () => {
    const { conn, captured } = stubConnection([]);
    const createdAt = "2026-01-01T00:00:00.123456Z";
    const id = "10000000-0000-4000-8000-000000000001";
    await listArtifactPageForNamespaces({
      readableNamespaceIds: ["ns-a"],
      limit: 10,
      snapshotAt: new Date("2026-02-01T00:00:00.000Z"),
      after: { createdAt, id },
    }, conn);

    const compiled = new PgDialect().sqlToQuery(captured.where!);
    expect(compiled.sql).toContain('"created_at" <');
    expect(compiled.sql).toContain('"created_at" =');
    expect(compiled.sql).toContain('"id" <');
    expect(compiled.params.filter((value) => value === createdAt)).toHaveLength(2);
    expect(compiled.params).toContain(id);
  });
});
