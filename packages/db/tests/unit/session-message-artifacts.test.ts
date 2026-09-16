/**
 * D424 — ArtifactOpenCard persistence/hydrate query shape tests.
 *
 * Pure Drizzle-call stub tests (no Postgres) mirroring
 * `get-namespaces-for-artifact-ids.test.ts`. Integration coverage of the
 * actual SQL lives in the migration-safety integration suite (gated on the
 * orchestrator-generated migration).
 */
import { describe, expect, test } from "bun:test";
import {
  basenameFromPath,
  findArtifactInternalIdsForCanonicalNamespace,
  getRoomNamespaceId,
  hydrateMessageArtifacts,
  recordMessageArtifacts,
} from "../../src/queries/session-message-artifacts";
import type { Database } from "../../src/config/database";
import type { DirectDatabase } from "../../src/config/direct-database";

type AnyDb = Database | DirectDatabase;

/**
 * A thenable that is ALSO chainable: `await` resolves to `rows`, and every
 * Drizzle chain method (`from`, `innerJoin`, `where`, `orderBy`, `limit`)
 * returns the same chain so the stub composes regardless of where the real
 * query terminates the chain.
 */
function chain(rows: unknown[]): unknown {
  const c = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
    from: () => c,
    innerJoin: () => c,
    where: () => c,
    orderBy: () => c,
    limit: () => c,
  };
  return c;
}
function selectChain(rows: unknown[]): AnyDb {
  return { select: () => chain(rows) } as unknown as AnyDb;
}

function insertChain(): { conn: AnyDb; capturedValues: unknown[] } {
  const capturedValues: unknown[] = [];
  const terminal = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
    onConflictDoNothing: () => terminal,
  };
  const values = (rows: unknown) => {
    capturedValues.push(rows);
    return terminal;
  };
  const stub = {
    insert: () => ({ values }),
  };
  return { conn: stub as unknown as AnyDb, capturedValues };
}

describe("basenameFromPath", () => {
  test("strips directory components, keeps trailing segment", () => {
    expect(basenameFromPath("reports/2026/q3.pdf")).toBe("q3.pdf");
    expect(basenameFromPath("a\\b\\c.txt")).toBe("c.txt");
    expect(basenameFromPath("/abs/path/to/file.md")).toBe("file.md");
  });
  test("empty / null / whitespace → ''", () => {
    expect(basenameFromPath("")).toBe("");
    expect(basenameFromPath(null)).toBe("");
    expect(basenameFromPath(undefined)).toBe("");
    expect(basenameFromPath("   ")).toBe("");
  });
  test("trims surrounding whitespace before splitting", () => {
    expect(basenameFromPath("  dir/name.txt  ")).toBe("name.txt");
  });
});

describe("getRoomNamespaceId", () => {
  test("empty roomId → null and no DB call", async () => {
    const conn = selectChain([{ namespaceId: "ns-x" }]);
    expect(await getRoomNamespaceId("", conn as Database)).toBe(null);
  });
  test("returns the room's canonical namespace id", async () => {
    const conn = selectChain([{ namespaceId: "ns-canonical" }]);
    expect(await getRoomNamespaceId("room-1", conn as Database)).toBe("ns-canonical");
  });
  test("missing room row → null", async () => {
    const conn = selectChain([]);
    expect(await getRoomNamespaceId("room-gone", conn as Database)).toBe(null);
  });
});

describe("findArtifactInternalIdsForCanonicalNamespace", () => {
  test("empty external ids → empty map, no DB call", async () => {
    const conn = selectChain([{ artifactId: "a", internalId: "i" }]);
    const out = await findArtifactInternalIdsForCanonicalNamespace({
      externalArtifactIds: [],
      canonicalRoomNamespaceId: "ns",
      conn: conn as Database,
    });
    expect(out.size).toBe(0);
  });
  test("missing canonical namespace id → empty map", async () => {
    const conn = selectChain([{ artifactId: "a", internalId: "i" }]);
    const out = await findArtifactInternalIdsForCanonicalNamespace({
      externalArtifactIds: ["a"],
      canonicalRoomNamespaceId: "",
      conn: conn as Database,
    });
    expect(out.size).toBe(0);
  });
  test("maps external id → internal id for canonical-namespace artifacts", async () => {
    const conn = selectChain([
      { artifactId: "ext-a", internalId: "int-a" },
      { artifactId: "ext-b", internalId: "int-b" },
    ]);
    const out = await findArtifactInternalIdsForCanonicalNamespace({
      externalArtifactIds: ["ext-a", "ext-b", "ext-missing"],
      canonicalRoomNamespaceId: "ns-canonical",
      conn: conn as Database,
    });
    expect(out.get("ext-a")).toBe("int-a");
    expect(out.get("ext-b")).toBe("int-b");
    expect(out.has("ext-missing")).toBe(false);
  });
  test("first duplicate external id wins", async () => {
    const conn = selectChain([
      { artifactId: "ext-a", internalId: "int-a-1" },
      { artifactId: "ext-a", internalId: "int-a-2" },
    ]);
    const out = await findArtifactInternalIdsForCanonicalNamespace({
      externalArtifactIds: ["ext-a"],
      canonicalRoomNamespaceId: "ns",
      conn: conn as Database,
    });
    expect(out.get("ext-a")).toBe("int-a-1");
  });
});

describe("recordMessageArtifacts", () => {
  test("empty internal ids → no insert", async () => {
    const { conn, capturedValues } = insertChain();
    await recordMessageArtifacts({ messageId: 7, artifactInternalIds: [], conn: conn as Database });
    expect(capturedValues.length).toBe(0);
  });
  test("assigns stable positions in input order and dedupes", async () => {
    const { conn, capturedValues } = insertChain();
    await recordMessageArtifacts({
      messageId: 7,
      artifactInternalIds: ["int-a", "int-b", "int-a", "int-c"],
      conn: conn as Database,
    });
    expect(capturedValues.length).toBe(1);
    expect(capturedValues[0]).toEqual([
      { messageId: 7, artifactId: "int-a", position: 0 },
      { messageId: 7, artifactId: "int-b", position: 1 },
      { messageId: 7, artifactId: "int-c", position: 2 },
    ]);
  });
  test("falsy internal ids are skipped", async () => {
    const { conn, capturedValues } = insertChain();
    await recordMessageArtifacts({
      messageId: 7,
      artifactInternalIds: ["int-a", "", "int-b"],
      conn: conn as Database,
    });
    expect(capturedValues[0]).toEqual([
      { messageId: 7, artifactId: "int-a", position: 0 },
      { messageId: 7, artifactId: "int-b", position: 1 },
    ]);
  });
});

describe("hydrateMessageArtifacts", () => {
  test("empty message ids / missing namespace / missing roomId → empty map", async () => {
    const conn = selectChain([
      { messageId: 1, position: 0, internalId: "i", path: "a/b.txt", mimeType: "text/plain", size: 10 },
    ]);
    expect((await hydrateMessageArtifacts({ messageIds: [], canonicalRoomNamespaceId: "ns", roomId: "r", conn: conn as unknown as DirectDatabase })).size).toBe(0);
    expect((await hydrateMessageArtifacts({ messageIds: [1], canonicalRoomNamespaceId: "", roomId: "r", conn: conn as unknown as DirectDatabase })).size).toBe(0);
    expect((await hydrateMessageArtifacts({ messageIds: [1], canonicalRoomNamespaceId: "ns", roomId: "", conn: conn as unknown as DirectDatabase })).size).toBe(0);
  });
  test("groups refs by message id and projects safe fields", async () => {
    const conn = selectChain([
      { messageId: 10, position: 0, internalId: "int-a", path: "reports/q3.pdf", mimeType: "application/pdf", size: 2048 },
      { messageId: 10, position: 1, internalId: "int-b", path: "notes/plan.md", mimeType: "text/markdown", size: 64 },
      { messageId: 11, position: 0, internalId: "int-c", path: "img.png", mimeType: "image/png", size: 999 },
    ]);
    const out = await hydrateMessageArtifacts({
      messageIds: [10, 11],
      canonicalRoomNamespaceId: "ns-canonical",
      roomId: "room-1",
      conn: conn as unknown as DirectDatabase,
    });
    expect(out.size).toBe(2);
    expect(out.get(10)).toEqual([
      { artifactInternalId: "int-a", roomId: "room-1", basename: "q3.pdf", mimeType: "application/pdf", sizeBytes: 2048 },
      { artifactInternalId: "int-b", roomId: "room-1", basename: "plan.md", mimeType: "text/markdown", sizeBytes: 64 },
    ]);
    expect(out.get(11)).toEqual([
      { artifactInternalId: "int-c", roomId: "room-1", basename: "img.png", mimeType: "image/png", sizeBytes: 999 },
    ]);
  });
  test("null mimeType coerced to application/octet-stream; numeric size coerced", async () => {
    const conn = selectChain([
      { messageId: 5, position: 0, internalId: "int-x", path: "bin", mimeType: null, size: "42" as unknown as number },
    ]);
    const out = await hydrateMessageArtifacts({
      messageIds: [5],
      canonicalRoomNamespaceId: "ns",
      roomId: "r",
      conn: conn as unknown as DirectDatabase,
    });
    expect(out.get(5)?.[0]).toEqual({
      artifactInternalId: "int-x",
      roomId: "r",
      basename: "bin",
      mimeType: "application/octet-stream",
      sizeBytes: 42,
    });
  });
});
