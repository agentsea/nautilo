import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  M237_RUNTIME_SIGNER_AUTHORITY_MARKER,
  finalizeM237LifecycleMigration,
} from "../../scripts/finalize-m237-message-crypto-lifecycle.ts";

const migrations = resolve(import.meta.dirname, "../../src/migrations");
const journal = JSON.parse(
  readFileSync(resolve(migrations, "meta/_journal.json"), "utf8"),
) as {
  entries: readonly { idx: number; tag: string }[];
};
const migrationEntry = journal.entries.find((entry) => entry.idx === 135);
const migration = migrationEntry === undefined
  ? ""
  : readFileSync(
    resolve(migrations, `${migrationEntry.tag}.sql`),
    "utf8",
  );

describe("M237 Agent Runtime signer history", () => {
  test("creates bounded append-only signer evidence without data rewrites", () => {
    expect(migrationEntry?.idx).toBe(135);
    expect(migration).toContain(
      'CREATE TABLE "agent_crypto_runtime_signers"',
    );
    for (const constraint of [
      "agent_crypto_runtime_signers_agent_id_runtime_generation_pk",
      "uq_agent_crypto_runtime_signers_key_id",
      "uq_agent_crypto_runtime_signers_operation",
      "agent_crypto_runtime_signers_state_fk",
      "agent_crypto_runtime_signers_transition_generation_coherent",
      "agent_crypto_runtime_signers_public_key_size",
      "agent_crypto_runtime_signers_publication_size",
    ]) {
      expect(migration).toContain(`"${constraint}"`);
    }
    expect(migration).toContain(
      'ALTER TABLE "agent_crypto_runtime_signers" ENABLE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ALTER TABLE "agent_crypto_runtime_signers" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto"',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "agent_crypto_runtime_signers"',
    );
    expect(migration).not.toMatch(
      /^\s*(?:DELETE|UPDATE|INSERT|TRUNCATE)\s+/im,
    );
  });

  test("finalizer appends signer authority exactly once", () => {
    const generated = [
      'CREATE TABLE "agent_crypto_runtime_signers" ("agent_id" text NOT NULL);',
      "",
    ].join("\n");
    const once = finalizeM237LifecycleMigration(generated);

    expect(finalizeM237LifecycleMigration(once)).toBe(once);
    expect(
      once.match(new RegExp(M237_RUNTIME_SIGNER_AUTHORITY_MARKER, "g")),
    ).toHaveLength(1);
  });
});
