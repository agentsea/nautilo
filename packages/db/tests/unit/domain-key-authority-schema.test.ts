import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DOMAIN_KEY_AUTHORITY_BYTE_LIMITS,
  DOMAIN_KEY_AUTHORITY_TABLE_NAMES,
  DOMAIN_KEY_AUTHORITY_TABLE_PRIVILEGES,
} from "../../src/schema/domain-key-authority.ts";
import { CRYPTO_TABLE_PRIVILEGES } from
  "../../src/utils/crypto-role-contract.ts";
import { SENSITIVE_TABLES } from "../../src/utils/agent-role-grants.ts";
import { M301_DOMAIN_KEY_AUTHORITY_MARKER } from "../../scripts/finalize-m301-domain-key-authority.ts";

const schemaSource = readFileSync(
  resolve(import.meta.dir, "../../src/schema/domain-key-authority.ts"),
  "utf8",
);
const migration = readFileSync(
  resolve(import.meta.dir, "../../src/migrations/0216_awesome_avengers.sql"),
  "utf8",
);

describe("M301 Domain-key authority schema", () => {
  test("persists one fixed head and one recipient operation without inventories", () => {
    expect(DOMAIN_KEY_AUTHORITY_TABLE_NAMES).toEqual([
      "domain_key_publication_operations",
      "domain_key_heads",
      "domain_key_recipient_requests",
      "domain_key_recipient_envelopes",
      "domain_key_envelope_acknowledgements",
      "namespace_domain_key_bindings",
      "namespace_domain_key_heads",
    ]);
    expect(schemaSource).not.toContain("participantSetBytes");
    expect(schemaSource).not.toContain("recipientCount");
    expect(schemaSource).not.toContain("recipientSetDigest");
    expect(schemaSource).not.toContain("aggregateEnvelope");
    expect(schemaSource).not.toMatch(/participantsPerDomain|totalRecipients/);
  });

  test("uses class-bound keys and bounded ciphertext bytes only", () => {
    expect(DOMAIN_KEY_AUTHORITY_BYTE_LIMITS).toEqual({
      id: 128,
      hash: 32,
      head: 8 * 1024,
      envelope: 16 * 1024,
      authorization: 32 * 1024,
      delivery: 8 * 1024,
      namespaceBundle: 512 * 1024,
    });
    expect(schemaSource).toContain("in ('human', 'ai')");
    expect(schemaSource).not.toMatch(/domainKey:|domain_key"/);
    expect(schemaSource).toContain("envelopeBytes");
    expect(schemaSource).toContain("bindingBytes");
  });

  test("denies the Agent role and grants only the crypto role", () => {
    for (const table of DOMAIN_KEY_AUTHORITY_TABLE_NAMES) {
      expect(SENSITIVE_TABLES).toContain(table);
      expect(DOMAIN_KEY_AUTHORITY_TABLE_PRIVILEGES[table]).not.toContain("DELETE");
      expect(CRYPTO_TABLE_PRIVILEGES).toHaveProperty(
        table,
        DOMAIN_KEY_AUTHORITY_TABLE_PRIVILEGES[table],
      );
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ON TABLE "${table}" TO "nautilo_crypto"`);
    }
    expect(migration).toContain(
      'FROM PUBLIC, "nautilo", "nautilo_agent", "nautilo_crypto"',
    );
  });

  test("keeps forced-RLS V2 relations joined by exact validators, not internal RI queries", () => {
    for (const constraint of [
      "domain_key_pub_domain_fk",
      "domain_key_pub_issuer_human_fk",
      "domain_key_pub_issuer_device_fk",
      "domain_key_heads_domain_fk",
      "domain_key_heads_issuer_human_fk",
      "domain_key_heads_issuer_device_fk",
      "domain_key_heads_publication_fk",
      "domain_key_requests_human_fk",
      "domain_key_requests_head_fk",
      "domain_key_envelopes_recipient_fk",
      "domain_key_envelopes_issuer_human_fk",
      "domain_key_envelopes_issuer_device_fk",
      "domain_key_envelopes_head_fk",
      "domain_key_envelopes_request_fk",
      "domain_key_acks_device_fk",
      "domain_key_acks_envelope_fk",
      "namespace_domain_key_bindings_namespace_fk",
      "namespace_domain_key_bindings_issuer_human_fk",
      "namespace_domain_key_bindings_issuer_device_fk",
      "namespace_domain_key_bindings_head_fk",
      "namespace_domain_key_heads_namespace_fk",
      "namespace_domain_key_heads_domain_fk",
      "namespace_domain_key_heads_binding_fk",
    ]) expect(schemaSource).not.toContain(constraint);
    for (const validator of [
      "validate_domain_key_head",
      "validate_domain_key_request",
      "validate_domain_key_envelope",
      "validate_namespace_domain_key_head",
    ]) expect(migration).toContain(validator);
  });

  test("generated migration removes only product ceilings and installs V2 guards", () => {
    expect(migration).toContain(M301_DOMAIN_KEY_AUTHORITY_MARKER);
    expect(migration).toContain(
      'DROP CONSTRAINT "crypto_domains_participants_count"',
    );
    expect(migration).toContain(
      'CHECK (cardinality("crypto_domains"."participants") >= 1)',
    );
    expect(migration).not.toContain("grant_domain_heads_participant_count\" DROP");
    expect(migration).toContain("validate_domain_key_head");
    expect(migration).toContain("protect_domain_key_request");
    expect(migration).toContain("validate_namespace_domain_key_head");
  });
});
