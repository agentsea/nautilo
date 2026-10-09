import { expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { acquireExternalRoomExecutionClaimWith, releaseExternalRoomExecutionClaimWith, type ExternalRoomExecutionProductDatabase } from "../../src/queries/external-room-execution-claims";
import { finalizeExternalRoomExecutionMigration, EXTERNAL_ROOM_EXECUTION_MARKER, finalizeExternalRoomNamespaceClaimCorrection, EXTERNAL_ROOM_NAMESPACE_CLAIM_MARKER } from "../../scripts/finalize-bolter-execution";
const id = (n: number) => `${String(n).padStart(8, "0")}-1111-7111-8111-111111111111`;
const owner = id(1), roomId = id(2), jobId = id(3);
function fixture(rows: unknown[][]) {
  const calls: string[] = [];
  const chain = (table = "") => {
    const read = () => { calls.push(table); return rows.shift() ?? []; };
    const query = { from(t: never) { table = getTableName(t); return query; }, innerJoin() { return query; }, where() { return query; },
      values() { return query; }, limit() { return query; }, for() { calls.push(`lock:${table}`); return query; }, returning() { return query; },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve(read()).then(resolve); } };
    return query;
  };
  const tx = { execute: async () => [], select: () => chain(), insert: (t: never) => chain(getTableName(t)), delete: (t: never) => chain(getTableName(t)) };
  const db = { transaction: (run: (t: typeof tx) => unknown) => run(tx) } as unknown as ExternalRoomExecutionProductDatabase;
  return { db, calls };
}
test("a retained claim returns busy before locking the winner's Job", async () => {
  const f = fixture([[{ roomId, type: "foreground" }], [{ id: roomId, externalContext: true, archivedAt: null }], [{ jobId }]]);
  expect(await acquireExternalRoomExecutionClaimWith(f.db, { userId: owner }, jobId)).toEqual({ kind: "busy" });
  expect(f.calls).toEqual(["jobs", "lock:rooms", "rooms", "external_room_execution_claims"]);
});
test("legacy running work without a claim blocks acquisition", async () => {
  const f = fixture([[{ roomId, type: "foreground" }], [{ id: roomId, externalContext: true, archivedAt: null }], [], [{ id: id(4) }]]);
  expect(await acquireExternalRoomExecutionClaimWith(f.db, { userId: owner }, jobId)).toEqual({ kind: "busy" });
  expect(f.calls).not.toContain("lock:jobs");
});
test("new acquisition locks canonical queued Job after Room and retains opaque coordinates", async () => {
  const f = fixture([[{ roomId, type: "foreground" }], [{ id: roomId, externalContext: true, archivedAt: null }], [], [], [{ id: id(5) }], [{ id: jobId, status: "queued", startedAt: null, completedAt: null }], []]);
  const result = await acquireExternalRoomExecutionClaimWith(f.db, { userId: owner }, jobId);
  expect(result).toMatchObject({ kind: "claimed", roomId, jobId });
  expect(f.calls.indexOf("lock:rooms")).toBeLessThan(f.calls.indexOf("lock:jobs"));
});
test("exact release works without a surviving Job and deleted Room is already safe", async () => {
  const claim = { roomId, jobId, token: id(6) };
  const f = fixture([[{ id: roomId }], [{ roomId }]]);
  expect(await releaseExternalRoomExecutionClaimWith(f.db, { userId: owner }, claim)).toBe(true);
  expect(f.calls).not.toContain("jobs");
  expect(await releaseExternalRoomExecutionClaimWith(fixture([[]]).db, { userId: owner }, claim)).toBe(true);
});
test("release retry accepts absence but rejects another executor's retained claim", async () => {
  const claim = { roomId, jobId, token: id(6) };
  expect(await releaseExternalRoomExecutionClaimWith(fixture([[{ id: roomId }], [], []]).db, { userId: owner }, claim)).toBe(true);
  expect(await releaseExternalRoomExecutionClaimWith(fixture([[{ id: roomId }], [], [{ roomId }]]).db, { userId: owner }, claim)).toBe(false);
});
test("claim query errors are content-free and discard raw SQL causes", async () => {
  const db = { transaction() { throw new Error("Synthetic private parameters"); } } as unknown as ExternalRoomExecutionProductDatabase;
  try { await acquireExternalRoomExecutionClaimWith(db, { userId: owner }, jobId); throw new Error("Expected rejection"); }
  catch (error) { expect((error as Error).message).toBe("external_room_execution_claim_unavailable"); expect((error as Error).cause).toBeUndefined(); }
});
test("generated claim migration is reproducible, internal, and guards running INSERT and coordinate changes", () => {
  const sql = readFileSync(resolve(import.meta.dir, "../../src/migrations/0348_lumpy_spot.sql"), "utf8");
  const prefix = sql.slice(0, sql.indexOf(`\n--> statement-breakpoint\n${EXTERNAL_ROOM_EXECUTION_MARKER}`));
  expect(finalizeExternalRoomExecutionMigration(prefix)).toBe(sql);
  expect(finalizeExternalRoomExecutionMigration(sql)).toBe(sql);
  expect(sql).toContain("BEFORE INSERT OR UPDATE OF status, room_id, type, owner_id");
  expect(sql).toContain("SECURITY DEFINER SET search_path = pg_catalog");
  expect(sql).not.toContain("GRANT EXECUTE");
  expect(sql).not.toContain("REFERENCES \"public\".\"jobs\"");
  expect(sql).toContain("GRANT SELECT, INSERT, DELETE ON TABLE public.external_room_execution_claims TO nautilo");
});

test("namespace correction matches canonical inherited boundary without changing applied SQL", () => {
  const sql = readFileSync(resolve(import.meta.dir, "../../src/migrations/0349_external_room_namespace_claim.sql"), "utf8");
  const prefix = sql.slice(0, sql.indexOf(`\n--> statement-breakpoint\n${EXTERNAL_ROOM_NAMESPACE_CLAIM_MARKER}`));
  expect(finalizeExternalRoomNamespaceClaimCorrection(prefix)).toBe(sql);
  expect(finalizeExternalRoomNamespaceClaimCorrection(sql)).toBe(sql);
  expect(sql).toContain("boundary.namespace_id = r.namespace_id AND boundary.external_context");
  expect(sql).toContain("ancestor.kind <> 'subthread'");
  expect(sql).toContain("subject.disabled_at IS NULL");
  expect(sql).not.toContain("GRANT");
});
