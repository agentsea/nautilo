import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { bolterReviewedTextFingerprint } from "../../src/queries/bolter-bridge";
import { finalizeBolterReviewedShareMigration } from "../../scripts/finalize-bolter-reviewed-share";
import { buildBolterBridgeRoleGrantsSql } from "../../src/utils/agent-role-grants";
describe("Bolter explicit Human sharing", () => {
  test("reviewed-share migrations preserve SQL bytes and follow the complete schema ancestry", () => {
    const directory = resolve(import.meta.dir, "../../src/migrations");
    const journal = JSON.parse(readFileSync(resolve(directory, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string; when: number }[] };
    const identities = [
      [350, "0350_gigantic_whistler", "70cdb08e7b09df2d4f6789c51e779c00da5a8df2a5e5adc3b6e56b53c36c7ec7"],
      [351, "0351_bolter_reviewed_share_guard", "d65ec78ea55f5346b29cb65dcb6e602d300a21da1652c1e2e2980c2c38bf0057"],
    ] as const;
    type Snapshot = { id: string; prevId: string; tables: Record<string, unknown> };
    for (const [idx, tag, hash] of identities) {
      const entry = journal.entries.find(row => row.idx === idx)!;
      const previous = journal.entries.find(row => row.idx === idx - 1)!;
      expect(entry.tag).toBe(tag);
      expect(entry.when).toBeGreaterThan(previous.when);
      expect(createHash("sha256").update(readFileSync(resolve(directory, `${tag}.sql`))).digest("hex")).toBe(hash);
      const snapshot = JSON.parse(readFileSync(resolve(directory, `meta/${String(idx).padStart(4, "0")}_snapshot.json`), "utf8")) as Snapshot;
      const previousSnapshot = JSON.parse(readFileSync(resolve(directory, `meta/${String(previous.idx).padStart(4, "0")}_snapshot.json`), "utf8")) as Snapshot;
      expect(snapshot.prevId).toBe(previousSnapshot.id);
      expect(snapshot.tables["public.media_generations"]).toEqual(previousSnapshot.tables["public.media_generations"]);
      expect(snapshot.tables["public.bolter_explicit_shares"]).toBeDefined();
    }
  });

  test("review request fingerprint binds exact text, destination and request", () => {
    const digest = bolterReviewedTextFingerprint("binding", "request", "exact text");
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(bolterReviewedTextFingerprint("binding", "request", "exact text")).toBe(digest);
    for (const parts of [["other", "request", "exact text"], ["binding", "other", "exact text"], ["binding", "request", "exact text "]]) {
      expect(bolterReviewedTextFingerprint(parts[0]!, parts[1]!, parts[2]!)).not.toBe(digest);
    }
  });
  test("generated authority admits exact Human grant while retaining causal reply checks", () => {
    const generated = 'CREATE TABLE "bolter_explicit_shares" ("id" uuid);';
    const sql = finalizeBolterReviewedShareMigration(generated);
    expect(sql.startsWith(generated)).toBe(true);
    expect(finalizeBolterReviewedShareMigration(sql)).toBe(sql);
    for (const required of ["g.user_id = NEW.user_id", "g.binding_revision = NEW.binding_revision", "g.connection_generation = NEW.connection_generation",
      "g.session_message_id = NEW.session_message_id", "NOT m.external_authorship", "m.role = 'user'", "m.human_turn_id IS NOT NULL",
      "m.metadata->'bolterReviewedShare'", "Bolter reviewed share is immutable", "j.status <> 'completed'", "m.human_turn_id IS NULL",
      "FORCE ROW LEVEL SECURITY", "GRANT SELECT, INSERT ON TABLE public.bolter_explicit_shares TO nautilo_agent"]) expect(sql).toContain(required);
    expect(sql).not.toContain("GRANT SELECT, INSERT, UPDATE ON TABLE public.bolter_explicit_shares");
  });
  test("role repair retains append-only agent grants and structural account deletion privileges", () => {
    const sql = buildBolterBridgeRoleGrantsSql();
    expect(sql).toContain("GRANT SELECT, INSERT ON TABLE public.bolter_explicit_shares TO nautilo_agent");
    expect(sql).toContain("SELECT(id,user_id,binding_id,session_message_id), UPDATE(id), DELETE ON TABLE public.bolter_explicit_shares TO nautilo");
  });
});

test("file sharing binds exact order, names, MIME, byte count and content checksum while preserving text-only digests", () => {
  const file = { id: "10000000-0000-4000-8000-000000000001", filename: "brief.txt", mimeType: "text/plain", sizeBytes: 5, sha256: "a".repeat(64) };
  const text = bolterReviewedTextFingerprint("binding", "request", "text");
  expect(bolterReviewedTextFingerprint("binding", "request", "text", [])).toBe(text);
  const digest = bolterReviewedTextFingerprint("binding", "request", "text", [file]);
  expect(digest).not.toBe(text);
  for (const patch of [{ filename: "other.txt" }, { mimeType: "application/json" }, { sizeBytes: 6 }, { sha256: "b".repeat(64) }]) {
    expect(bolterReviewedTextFingerprint("binding", "request", "text", [{ ...file, ...patch }])).not.toBe(digest);
  }
});
