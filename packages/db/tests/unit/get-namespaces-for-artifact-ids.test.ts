/**
 * M088C item 7 — coverage for the batched namespace-lookup helper used
 * by the workspace-artifacts LIST route. Pure shape test against a
 * Drizzle-call stub; integration coverage of the actual SQL lives in
 * the workspace-artifacts integration suite.
 */

import { describe, expect, test } from "bun:test";
import { getNamespacesForArtifactIds } from "../../src/queries/artifacts";
import type { Database } from "../../src/config/database";

interface CapturedQuery {
  args: unknown[];
}

function buildStubConn(rows: Array<{ artifactId: string; namespaceId: string }>): {
  conn: Database;
  captured: CapturedQuery;
} {
  const captured: CapturedQuery = { args: [] };
  const conn = {
    select(fields: unknown) {
      captured.args.push({ select: fields });
      return {
        from(table: unknown) {
          captured.args.push({ from: table });
          return {
            where(predicate: unknown) {
              captured.args.push({ where: predicate });
              return Promise.resolve(rows);
            },
          };
        },
      };
    },
  } as unknown as Database;
  return { conn, captured };
}

describe("getNamespacesForArtifactIds", () => {
  test("empty input → empty map and no DB call", async () => {
    const { conn, captured } = buildStubConn([]);
    const out = await getNamespacesForArtifactIds([], conn);
    expect(out.size).toBe(0);
    expect(captured.args.length).toBe(0);
  });

  test("one artifact with one namespace", async () => {
    const { conn } = buildStubConn([{ artifactId: "a1", namespaceId: "ns1" }]);
    const out = await getNamespacesForArtifactIds(["a1"], conn);
    expect(out.size).toBe(1);
    expect(out.get("a1")).toEqual(["ns1"]);
  });

  test("one artifact with multiple namespaces", async () => {
    const { conn } = buildStubConn([
      { artifactId: "a1", namespaceId: "ns1" },
      { artifactId: "a1", namespaceId: "ns2" },
      { artifactId: "a1", namespaceId: "ns3" },
    ]);
    const out = await getNamespacesForArtifactIds(["a1"], conn);
    expect(out.get("a1")).toEqual(["ns1", "ns2", "ns3"]);
    expect(out.size).toBe(1);
  });

  test("multiple artifacts grouped by id", async () => {
    const { conn } = buildStubConn([
      { artifactId: "a1", namespaceId: "ns1" },
      { artifactId: "a2", namespaceId: "ns2" },
      { artifactId: "a1", namespaceId: "ns3" },
      { artifactId: "a3", namespaceId: "ns4" },
    ]);
    const out = await getNamespacesForArtifactIds(["a1", "a2", "a3"], conn);
    expect(out.size).toBe(3);
    expect(out.get("a1")).toEqual(["ns1", "ns3"]);
    expect(out.get("a2")).toEqual(["ns2"]);
    expect(out.get("a3")).toEqual(["ns4"]);
  });

  test("artifacts not in the query result are absent from the map", async () => {
    const { conn } = buildStubConn([{ artifactId: "a1", namespaceId: "ns1" }]);
    const out = await getNamespacesForArtifactIds(["a1", "a2"], conn);
    expect(out.has("a2")).toBe(false);
    expect(out.get("a1")).toEqual(["ns1"]);
  });

  test("issues exactly one DB round-trip regardless of input size", async () => {
    const { conn, captured } = buildStubConn([
      { artifactId: "a1", namespaceId: "ns1" },
      { artifactId: "a2", namespaceId: "ns2" },
    ]);
    await getNamespacesForArtifactIds(["a1", "a2"], conn);
    const fromCalls = captured.args.filter(
      (op): op is { from: unknown } =>
        typeof op === "object" && op !== null && "from" in op,
    );
    expect(fromCalls.length).toBe(1);
  });
});
