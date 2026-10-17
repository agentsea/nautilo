import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import type { DirectDatabase } from "../../src/config/direct-database";
import {
  findReflectionMemoryNamespaceIdsWith,
  REFLECTION_MEMORY_NAMESPACE_PROOF_LIMIT,
} from "../../src/queries/reflection-sources";

function database(rows: readonly Readonly<{
  namespaceId: string;
  selectedNamespacePresent: boolean;
}>[]): Readonly<{
  db: DirectDatabase;
  limit: () => number | undefined;
}> {
  let observedLimit: number | undefined;
  const builder = {
    from() { return this; },
    where() { return this; },
    orderBy() { return this; },
    limit(value: number) {
      observedLimit = value;
      return Promise.resolve(rows);
    },
  };
  return {
    db: { select: () => builder } as unknown as DirectDatabase,
    limit: () => observedLimit,
  };
}

describe("reflection Memory Namespace proof bound", () => {
  test("checks the selected edge in the same bounded query snapshot", async () => {
    const failure = await findReflectionMemoryNamespaceIdsWith(
      drizzle.mock() as unknown as DirectDatabase,
      "memory-a",
      "namespace-selected",
    ).catch((error: unknown) => error) as Readonly<{
      query: string;
      params: readonly unknown[];
    }>;

    expect(failure.query).toBe(
      "select \"namespace_id\", exists (select \"memory_id\" from \"memory_namespaces\" \"selected_memory_namespaces\" where (\"selected_memory_namespaces\".\"memory_id\" = \"memory_namespaces\".\"memory_id\" and \"selected_memory_namespaces\".\"namespace_id\" = $1)) from \"memory_namespaces\" where \"memory_namespaces\".\"memory_id\" = $2 order by \"memory_namespaces\".\"namespace_id\" limit $3",
    );
    expect(failure.params).toEqual([
      "namespace-selected",
      "memory-a",
      REFLECTION_MEMORY_NAMESPACE_PROOF_LIMIT + 1,
    ]);
  });

  test("retains 256 exact edges and reports 257 as proof overflow", async () => {
    const withinBound = Array.from(
      { length: REFLECTION_MEMORY_NAMESPACE_PROOF_LIMIT },
      (_, index) => ({
        namespaceId: `namespace-${index}`,
        selectedNamespacePresent: true,
      }),
    );
    const complete = database(withinBound);

    expect(await findReflectionMemoryNamespaceIdsWith(
      complete.db,
      "memory-a",
      "namespace-selected",
    )).toEqual(withinBound.map((row) => row.namespaceId));
    expect(complete.limit()).toBe(REFLECTION_MEMORY_NAMESPACE_PROOF_LIMIT + 1);

    const overflow = database([
      ...withinBound,
      {
        namespaceId: "namespace-overflow",
        selectedNamespacePresent: true,
      },
    ]);
    expect(await findReflectionMemoryNamespaceIdsWith(
      overflow.db,
      "memory-a",
      "namespace-selected",
    )).toBeNull();
    expect(overflow.limit()).toBe(REFLECTION_MEMORY_NAMESPACE_PROOF_LIMIT + 1);

    const selectedEdgeLost = database([
      ...withinBound,
      {
        namespaceId: "namespace-overflow",
        selectedNamespacePresent: false,
      },
    ].map((row) => ({ ...row, selectedNamespacePresent: false })));
    expect(await findReflectionMemoryNamespaceIdsWith(
      selectedEdgeLost.db,
      "memory-a",
      "namespace-selected",
    )).toEqual([]);
  });
});
