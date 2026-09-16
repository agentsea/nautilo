import { describe, expect, test } from "bun:test";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { BASELINE_REGISTRY } from "../../baseline/existing-debt";

const BADGE_PREFERENCE_ROUTE =
  "http:request_response:PUT /api/push/installations/:bindingId/badge-preference";

describe("PR 945 push badge preference security decisions", () => {
  test("classifies the device badge preference as bounded metadata", () => {
    for (const locator of [
      "public.push_installation_bindings.badge_enabled",
      BADGE_PREFERENCE_ROUTE,
    ]) {
      const entry = BASELINE_REGISTRY.entries.find((candidate) =>
        candidate.locator === locator
      );
      expect(entry).toMatchObject({
        classification: "bounded_metadata",
        migrationState: "not_applicable",
      });
      if (entry?.classification !== "bounded_metadata") {
        throw new Error(`${locator} must remain bounded metadata`);
      }
      expect(entry.plaintextReason).toContain("notification copy");
    }
  });

  test("pins the badge-preference route to its closed DTO shape", () => {
    expect(DTO_BASELINE_DECLARATIONS.find((candidate) =>
      candidate.locator === BADGE_PREFERENCE_ROUTE
    )).toEqual({
      observationId:
        "wire.http.request.response.put.api.push.installations.bindingid.badge.preference.1xywv1u",
      locator: BADGE_PREFERENCE_ROUTE,
      structuralSignatures: [
        "request.params:{bindingId:string}",
        "response.body:{bindingId:string;enabled:boolean;tokenGeneration:number;version:1}",
      ],
      arbitraryPayloads: [],
    });
  });
});
