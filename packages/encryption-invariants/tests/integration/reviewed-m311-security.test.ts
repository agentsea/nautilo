import { describe, expect, test } from "bun:test";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";
import {
  REVIEWED_M311_COVERAGE_ENTRIES,
} from "../../baseline/reviewed-m311-coverage";

describe("M311 foreground entity gateway inventory", () => {
  test("classifies repair provenance as bounded metadata", () => {
    expect(REVIEWED_M311_COVERAGE_ENTRIES.map((entry) => entry.locator)).toEqual([
      "public.session_message_crypto_revisions.repair_attestation_digest",
      "public.session_message_crypto_revisions.repair_identity_digest",
      "public.session_message_crypto_revisions.repair_publisher_id",
      "public.session_message_crypto_revisions.repair_publisher_kind",
    ]);

    for (const entry of REVIEWED_M311_COVERAGE_ENTRIES) {
      if (entry.classification !== "bounded_metadata") {
        throw new Error(`unexpected M311 classification: ${entry.classification}`);
      }
      expect(entry.metadataAllowlist).toEqual([
        entry.locator.slice(entry.locator.lastIndexOf(".") + 1),
      ]);
      expect(entry.testEvidence).toHaveLength(2);
      expect(BASELINE_REGISTRY.entries).toContainEqual(entry);
    }
  });

  test("keeps foreground context progress closed and content-free", () => {
    const declaration = DTO_BASELINE_DECLARATIONS.find((candidate) =>
      candidate.locator === "http:request_response:GET /api/tasks/pending-attention"
    );

    expect(declaration).toBeDefined();
    expect(declaration?.structuralSignatures?.join("\n")).toContain(
      'kind?:"deep-research"|"foreground-context"',
    );
    expect(declaration?.arbitraryPayloads ?? []).not.toContainEqual(
      expect.objectContaining({ path: "response.body[].job.progress" }),
    );
  });
});
