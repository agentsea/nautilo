import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = "0171_d525_media_generations";
const migrations = resolve(import.meta.dir, "../../src/migrations");
const migration = readFileSync(resolve(migrations, `${tag}.sql`), "utf8");
const journal = JSON.parse(readFileSync(resolve(migrations, "meta/_journal.json"), "utf8")) as {
  entries: readonly { idx: number; tag: string; when: number }[];
};

describe("D525 media generation migration", () => {
  test("remains additive before later work and keeps internal requests separate", () => {
    const index = journal.entries.findIndex((entry) => entry.tag === tag);
    expect(journal.entries[index]).toMatchObject({ idx: 171, tag });
    expect(journal.entries[index + 1]).toMatchObject({
      idx: 172,
      tag: "0172_wandering_baron_zemo",
    });
    expect(migration).toContain('CREATE TABLE "media_generations"');
    expect(migration).not.toMatch(/(?:"prompt"|"lyrics"|"download_url"|"signed_url"|"api_key"|"authorization")\s+(?:text|jsonb|varchar)/u);
    expect(migration).toContain('"provider_queue_id" text');
    expect(migration).toContain('"admission_token" uuid');
    expect(migration).toContain('"admission_started_at" timestamp with time zone');
    expect(migration).toContain('"request_payload" jsonb NOT NULL');
    expect(migration).toContain('"media_generations_room_namespace_fk"');
    expect(migration).toContain('"media_generations_request_payload_shape"');
    // PostgreSQL ARE repetition bounds may not exceed 255. Model length is
    // already bound to 1-256 bytes by the exact provider-model equality check.
    expect(migration).toContain(`"request_payload"->>'model' ~ '^[A-Za-z0-9._:+-]+$'`);
    expect(migration).not.toContain("{1,256}");
    expect(migration).not.toContain("referenceAssetCount");
  });

  test("uses current Human Room membership, not the Room owner, for authority", () => {
    expect(migration).toContain('FROM public.room_members membership');
    expect(migration).toContain('INNER JOIN public.actors actor ON actor.id = membership.actor_id');
    expect(migration).toContain("actor.owner_id = NEW.owner_id");
    expect(migration).toContain("actor.kind = 'user'");
    expect(migration).not.toContain("room.owner_id = NEW.owner_id");
  });

  test("makes the receipt authority-bound, revisioned, and safe to reconcile", () => {
    for (const phrase of [
      'Media generation owner/Room/Namespace binding is invalid',
      'Media generation revision must advance exactly once',
      'Illegal media generation lifecycle transition',
      'Accepted provider queue identity is immutable',
      'Media generation admission proof is immutable',
      'NEW.request_payload',
      'FOR ALL TO "nautilo"',
      'FORCE ROW LEVEL SECURITY',
    ]) expect(migration).toContain(phrase);
    expect(migration).toContain("'normalizedSettings'");
    expect(migration).toContain("'inputSummary'");
    expect(migration).toContain('"idx_media_generations_reconcile_due"');
    expect(migration).toContain('"idx_media_generations_cleanup_due"');
    expect(migration).toContain("OLD.state = 'prequeue' AND NEW.state in ('admitting', 'needs_action', 'failed')");
    expect(migration).toContain("OLD.state = 'admitting' AND NEW.state in ('queued', 'unknown', 'needs_action', 'failed')");
    const admittingEdges = migration.match(/OLD\.state = 'admitting' AND NEW\.state in \(([^)]+)\)/u);
    expect(admittingEdges?.[1]?.match(/'[^']+'/gu)).toEqual([
      "'queued'", "'unknown'", "'needs_action'", "'failed'",
    ]);
    expect(migration).toContain("NEW.revision <> OLD.revision + 1");
    expect(migration).toContain("NEW.admission_token IS DISTINCT FROM OLD.admission_token");
    expect(migration).toContain("NEW.admission_started_at IS DISTINCT FROM OLD.admission_started_at");
    expect(migration).not.toContain("OLD.state = 'prequeue' AND NEW.state in ('queued'");
    const reconcileIndex = migration.match(/CREATE INDEX "idx_media_generations_reconcile_due"[^;]+/u)?.[0];
    expect(reconcileIndex).not.toContain("admitting");
  });
});
