import { describe, expect, test } from "bun:test";

import {
  REVIEWED_WAVE_9_COVERAGE_ENTRIES,
  REVIEWED_WAVE_9_DEBT_LINKS,
} from "../../baseline/reviewed-wave-9";

describe("Wave 9 reviewed coverage registry", () => {
  test("classifies every new database surface without calling content metadata", () => {
    const databaseEntries = REVIEWED_WAVE_9_COVERAGE_ENTRIES.filter(
      (entry) => entry.surface === "db",
    );

    expect(databaseEntries).toHaveLength(60);
    expect(
      databaseEntries.every(
        (entry) => entry.classification === "bounded_metadata",
      ),
    ).toBeTrue();
    expect(
      databaseEntries.map((entry) => entry.locator),
    ).toContain("public.session_messages.crypto_object_id");
    expect(
      databaseEntries.map((entry) => entry.locator),
    ).toContain("public.agent_crypto_runtime_signers.publication_bytes");
    expect(JSON.stringify(databaseEntries)).not.toContain("private_key");
    expect(JSON.stringify(databaseEntries)).not.toContain("message_content");
  });

  test("keeps label-bearing notifications and document mutations as inherited debt", () => {
    expect(REVIEWED_WAVE_9_DEBT_LINKS.map((link) => link.locator)).toEqual([
      "ws:server_to_client:document.mutation.committed",
      "ws:server_to_client:notification.message.important",
    ]);
    expect(
      REVIEWED_WAVE_9_COVERAGE_ENTRIES.some(
        (entry) =>
          entry.locator ===
            "ws:server_to_client:notification.message.important",
      ),
    ).toBeFalse();
  });

  test("allows only label-free notification counters as bounded wire metadata", () => {
    const wireEntries = REVIEWED_WAVE_9_COVERAGE_ENTRIES.filter(
      (entry) => entry.surface === "wire",
    );

    expect(wireEntries).toHaveLength(2);
    expect(wireEntries.every(
      (entry) => entry.classification === "bounded_metadata",
    )).toBeTrue();
    const allowlists = wireEntries.flatMap((entry) =>
      entry.classification === "bounded_metadata"
        ? entry.metadataAllowlist
        : []
    );
    expect(JSON.stringify(allowlists)).not.toContain("displayName");
    expect(JSON.stringify(allowlists)).not.toContain("roomLabel");
    expect(JSON.stringify(allowlists)).not.toContain("content");
    expect(JSON.stringify(allowlists)).not.toContain("preview");
  });
});
