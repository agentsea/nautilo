import { describe, expect, test } from "bun:test";
import { namespaceId } from "@nautilo/lattice-crypto";
import { memoryNativeAccessEntryMatchesBindingRow } from
  "../../src/server/memory/native-memory-access-authority";

const NS = "10000000-0000-4000-8000-000000000001";

function fixture() {
  const digest = new Uint8Array(32).fill(0x31);
  return {
    entry: {
      namespaceId: namespaceId(NS), keyGeneration: 0,
      namespaceAccessRevision: 2, headDigest: digest.slice(),
      publicationDigest: digest.slice(), publicationSetDigest: digest.slice(),
      audienceFingerprint: digest.slice(), envelopeHash: new Uint8Array(32).fill(0x41),
    },
    row: {
      namespace_id: NS, namespace_access_revision: 2,
      namespace_current_generation: 0,
      retained_authority_set_digest: digest.slice(),
    },
  };
}

describe("native Memory access authority", () => {
  test("accepts generation zero with the exact native digest tuple", () => {
    const { entry, row } = fixture();
    expect(memoryNativeAccessEntryMatchesBindingRow(entry, row)).toBe(true);
  });

  test("rejects a forged publication digest", () => {
    const { entry, row } = fixture();
    entry.publicationDigest[0] = entry.publicationDigest[0]! ^ 1;
    expect(memoryNativeAccessEntryMatchesBindingRow(entry, row)).toBe(false);
  });

  test("rejects stale access coordinates", () => {
    const { entry, row } = fixture();
    row.namespace_access_revision = 3;
    expect(memoryNativeAccessEntryMatchesBindingRow(entry, row)).toBe(false);
  });
});
