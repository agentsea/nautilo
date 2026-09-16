import { describe, expect, test } from "bun:test";

import {
  REVIEWED_WAVE_7_SOURCE_ALARMS,
} from "../../baseline/reviewed-wave-7-source-alarms";
import {
  REVIEWED_WAVE_7_COVERAGE_ENTRIES,
  REVIEWED_WAVE_7_DATABASE_WRITER_ENTRIES,
} from "../../baseline/reviewed-wave-7";
import { validateCoverageEntry } from "../../src/model";

const EXPECTED_PROTECTED_LOCATORS = new Set([
  "public.crypto_delivery_messages",
  "public.crypto_delivery_messages.payload_bytes",
  "public.crypto_domain_transition_namespaces",
  "public.crypto_domain_transition_namespaces.candidate_ai_keyring_envelope_bytes",
  "public.crypto_domain_transition_namespaces.candidate_human_keyring_envelope_bytes",
  "public.crypto_domain_transition_namespaces.candidate_signed_binding_bytes",
  "public.crypto_human_membership_transitions",
  "public.crypto_human_membership_transitions.candidate_ai_keyring_envelope_bytes",
  "public.crypto_human_membership_transitions.candidate_human_keyring_envelope_bytes",
  "public.crypto_human_membership_transitions.candidate_signed_binding_bytes",
]);

describe("Wave 7 encryption inventory closure", () => {
  test("classifies exact opaque bytes as protected and all other fields as bounded public crypto metadata", () => {
    const protectedEntries = REVIEWED_WAVE_7_COVERAGE_ENTRIES.filter(
      (entry) => entry.classification === "protected",
    );
    expect(new Set(protectedEntries.map((entry) => entry.locator))).toEqual(
      EXPECTED_PROTECTED_LOCATORS,
    );
    expect(
      REVIEWED_WAVE_7_COVERAGE_ENTRIES.every(
        (entry) => validateCoverageEntry(entry).ok,
      ),
    ).toBe(true);
    expect(
      REVIEWED_WAVE_7_COVERAGE_ENTRIES
        .filter((entry) => !EXPECTED_PROTECTED_LOCATORS.has(entry.locator))
        .every((entry) => entry.classification === "bounded_metadata"),
    ).toBe(true);
  });

  test("reviews every raw Delivery Service writer as an implemented isolated crypto boundary", () => {
    expect(REVIEWED_WAVE_7_DATABASE_WRITER_ENTRIES).toHaveLength(63);
    expect(
      REVIEWED_WAVE_7_DATABASE_WRITER_ENTRIES.every((entry) =>
        entry.locator.startsWith("packages/lattice-bridge/src/server/")
        && entry.locator.includes(":raw_sql:")
        && entry.classification === "protected"
        && validateCoverageEntry(entry).ok
      ),
    ).toBe(true);
  });

  test("declares encrypted vault persistence and excludes only synthetic harness or scanner lookalikes", () => {
    expect(REVIEWED_WAVE_7_SOURCE_ALARMS).toHaveLength(11);
    const vaultWrites = REVIEWED_WAVE_7_SOURCE_ALARMS.filter((review) =>
      review.locator.startsWith(
        "packages/lattice-bridge/src/client/file-vault.ts",
      )
    );
    expect(vaultWrites).toHaveLength(2);
    expect(
      vaultWrites.every((review) => review.closure === "declaration"),
    ).toBe(true);
    expect(
      REVIEWED_WAVE_7_SOURCE_ALARMS.some((review) =>
        review.locator.includes("postgres-device-delivery-fetch-repository")
        && review.closure === "reviewed_exclusion"
      ),
    ).toBe(true);
  });
});
