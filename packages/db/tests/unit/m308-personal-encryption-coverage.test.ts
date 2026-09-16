import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  PERSONAL_ENCRYPTION_COVERAGE_FAMILIES,
  buildPersonalEncryptionCoverageQuery,
  readPersonalEncryptionCoverageFamily,
} from "../../src/queries/personal-encryption-coverage";

const NS_A = "11111111-1111-4111-8111-111111111111";
const NS_B = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

function render(family: (typeof PERSONAL_ENCRYPTION_COVERAGE_FAMILIES)[number]) {
  const query = new PgDialect().sqlToQuery(buildPersonalEncryptionCoverageQuery({
    family,
    readableNamespaceIds: [NS_A, NS_B],
    userId: USER_ID,
  }));
  return { ...query, sql: query.sql.toLowerCase() };
}

describe("M308 personal encryption coverage aggregates", () => {
  test("keeps the closed family registry in product order", () => {
    expect(PERSONAL_ENCRYPTION_COVERAGE_FAMILIES).toEqual([
      "message",
      "memory",
      "journal_event",
      "reflection_record",
      "artifact",
      "task",
    ]);
  });

  test("scopes measured families to server-resolved Namespace parameters", () => {
    for (const family of PERSONAL_ENCRYPTION_COVERAGE_FAMILIES) {
      if (family === "task") continue;
      const query = render(family);
      expect(query.sql).toContain("count(distinct");
      expect(query.sql).toContain("encrypted_counterpart");
      expect(query.params).toContain(NS_A);
      expect(query.params).toContain(NS_B);
      expect(query.params).not.toContain(USER_ID);
    }
    expect(render("message").sql).toContain("room.namespace_id = any");
    expect(render("memory").sql).toContain("memory_namespaces");
    expect(render("artifact").sql).toContain("artifact_namespaces");
    expect(render("journal_event").sql).toContain("event.status = 'active'");
    expect(render("reflection_record").sql).toContain(
      "reflection_record_authority_alternatives",
    );
  });

  test("counts current authenticated Message mappings without requiring independent parity", () => {
    const message = render("message").sql;
    expect(message).toContain("revision.edit_revision = message.edit_revision");
    expect(message).toContain("revision.disposition = 'mapped'");
    const protectedStates = message.match(
      /revision\.parity_status in \(([^)]*)\)/u,
    )?.[1];
    expect(protectedStates).toContain("'server_verified'");
    expect(protectedStates).toContain("'client_verified'");
    expect(protectedStates).toContain("'server_authenticated'");
    expect(protectedStates).toContain("'client_authenticated'");
    expect(protectedStates).not.toContain("'pending'");
  });

  test("keeps non-Message protected predicates unchanged", () => {
    const message = render("message").sql;
    expect(message).toContain("revision.completion = 'complete'");

    const memory = render("memory").sql;
    expect(memory).toContain("revision.content_revision = memory.content_revision");
    expect(memory).toContain("memory.crypto_required_namespace_fingerprint is not null");
    expect(memory).not.toContain(
      "revision.required_namespace_fingerprint = memory.crypto_required_namespace_fingerprint",
    );

    const artifact = render("artifact").sql;
    expect(artifact).toContain("revision.artifact_revision = artifact.revision");
    expect(artifact).toContain("blob.blob_generation = artifact.blob_generation");
    expect(artifact).toContain("blob.state = 'published'");

    const record = render("reflection_record").sql;
    expect(record).toContain("head.current_representation_generation");
    expect(record).toContain("publication.state = 'complete'");
    expect(record).toContain("authority.current = true");
    expect(record).toContain("authority.processing_state = 'current'");
  });

  test("does not count an event protected while its current rollup is plaintext", () => {
    const journal = render("journal_event").sql;
    expect(journal).toContain("event.projection_kind = 'legacy'");
    expect(journal).toContain("event.projection_kind = 'native'");
    expect(journal).toContain("rollup.through_event_sequence >= event.sequence");
    expect(journal).toContain("rollup.crypto_object_id is null");
    expect(journal).toContain("order by current_rollup.through_event_sequence desc");
    expect(journal).toContain("current_rollup.created_at desc,");
    expect(journal).toContain("current_rollup.id");
  });

  test("returns measured zeroes without querying when authority is empty", async () => {
    let called = false;
    const result = await readPersonalEncryptionCoverageFamily({
      execute: async () => {
        called = true;
        return [];
      },
    } as never, {
      family: "memory",
      readableNamespaceIds: [],
      userId: USER_ID,
    });
    expect(called).toBe(false);
    expect(result).toEqual({
      family: "memory",
      measurement: "measured",
      accessible: 0n,
      plaintextPresent: 0n,
      encryptedCounterpart: 0n,
    });
  });

  test("returns truthful owner-only Task counts without fabricated protection", async () => {
    const db = {
      execute: async (statement: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        const query = new PgDialect().sqlToQuery(statement);
        expect(query.sql).toContain("task.owner_id = $1");
        expect(query.params).toEqual([USER_ID]);
        return [{ accessible: "34", plaintext_present: "34" }];
      },
    } as unknown as Parameters<typeof readPersonalEncryptionCoverageFamily>[0];
    expect(await readPersonalEncryptionCoverageFamily(db, {
      family: "task",
      readableNamespaceIds: [],
      userId: USER_ID,
    })).toEqual({
      family: "task",
      measurement: "unsupported",
      accessible: 34n,
      plaintextPresent: 34n,
    });
  });

  test("rejects missing or malformed aggregates instead of turning them into zero", () => {
    const missing = {
      execute: async () => [],
    } as unknown as Parameters<typeof readPersonalEncryptionCoverageFamily>[0];
    expect(readPersonalEncryptionCoverageFamily(missing, {
      family: "message",
      readableNamespaceIds: [NS_A],
      userId: USER_ID,
    })).rejects.toThrow("aggregate is unavailable");

    const malformed = {
      execute: async () => [{
        accessible: "1",
        plaintext_present: "1",
        encrypted_counterpart: "-1",
      }],
    } as unknown as Parameters<typeof readPersonalEncryptionCoverageFamily>[0];
    expect(readPersonalEncryptionCoverageFamily(malformed, {
      family: "message",
      readableNamespaceIds: [NS_A],
      userId: USER_ID,
    })).rejects.toThrow("encrypted counterpart");
  });
});
