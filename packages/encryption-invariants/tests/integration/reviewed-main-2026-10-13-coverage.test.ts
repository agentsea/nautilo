import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  BASELINE_REGISTRY,
  CURRENT_FROZEN_BASELINE_DEBT,
} from "../../baseline/existing-debt";
import {
  RETIRED_MAIN_2026_10_13_FROZEN_DEBT,
  REVIEWED_MAIN_2026_10_13_COVERAGE_ENTRIES,
  REVIEWED_MAIN_2026_10_13_DEBT_LINKS,
  REVIEWED_MAIN_2026_10_13_UNRESOLVED_LOCATORS,
} from "../../baseline/reviewed-main-2026-10-13-coverage";
import { validateCoverageEntry } from "../../src/model";
import { reviewedDebtLinkErrors } from "../../src/registry";

const repoRoot = resolve(import.meta.dir, "../../../..");

function key(surface: string, locator: string): string {
  return `${surface}:${locator}`;
}

describe("current-main October 13 coverage review", () => {
  test("classifies 212 evidenced observations and leaves 13 authority decisions unresolved", () => {
    expect(REVIEWED_MAIN_2026_10_13_COVERAGE_ENTRIES).toHaveLength(139);
    expect(REVIEWED_MAIN_2026_10_13_DEBT_LINKS).toHaveLength(73);
    expect(REVIEWED_MAIN_2026_10_13_UNRESOLVED_LOCATORS).toEqual(
      new Set([
        "public.invites.token",
        "public.invite_redemptions.join_message",
        "public.moderation_actions",
        "public.moderation_actions.private_note",
        "public.moderation_actions.reason",
        "http:request_response:GET /api/invites/:id/share",
        "http:request_response:GET /api/invites/:token/enrollment-review",
        "http:request_response:GET /api/moderation/enrollment",
        "http:request_response:GET /api/moderation/person",
        "http:request_response:GET /join",
        "http:request_response:POST /api/invites/:token/enrollment-review",
        "http:request_response:POST /api/moderation/actions",
        "http:request_response:POST /api/moderation/actions#request.body",
      ]),
    );

    const reviewed = new Set([
      ...REVIEWED_MAIN_2026_10_13_COVERAGE_ENTRIES.map((entry) =>
        key(entry.surface, entry.locator)
      ),
      ...REVIEWED_MAIN_2026_10_13_DEBT_LINKS.map((entry) =>
        key(entry.surface, entry.locator)
      ),
    ]);
    expect(reviewed.size).toBe(212);
    expect([...reviewed].filter((entry) => entry.startsWith("db:"))).toHaveLength(142);
    expect([...reviewed].filter((entry) => entry.startsWith("wire:"))).toHaveLength(70);
    for (const locator of REVIEWED_MAIN_2026_10_13_UNRESOLVED_LOCATORS) {
      const surface = locator.startsWith("public.") ? "db" : "wire";
      expect(reviewed.has(key(surface, locator))).toBe(false);
    }

    for (const entry of REVIEWED_MAIN_2026_10_13_COVERAGE_ENTRIES) {
      expect(validateCoverageEntry(entry)).toEqual({ ok: true });
    }
    expect(reviewedDebtLinkErrors(
      BASELINE_REGISTRY,
      CURRENT_FROZEN_BASELINE_DEBT,
    )).toEqual([]);
  });

  test("keeps credentials, unresolved Human text, and Relay content out of metadata", () => {
    const entries = new Map(
      REVIEWED_MAIN_2026_10_13_COVERAGE_ENTRIES.map((entry) => [entry.locator, entry]),
    );
    for (const locator of [
      "public.personal_provider_credentials",
      "public.personal_provider_credentials.auth_tag_base64",
      "public.personal_provider_credentials.ciphertext_base64",
      "public.personal_provider_credentials.key_id",
      "public.personal_provider_credentials.nonce_base64",
      "http:request_response:PUT /api/account/provider-credentials/:provider",
    ]) {
      expect(entries.get(locator)?.classification).toBe("operator_secret");
    }
    for (const locator of [
      "public.invite_redemptions.join_message",
      "public.moderation_actions",
      "public.moderation_actions.private_note",
      "public.moderation_actions.reason",
      "http:request_response:GET /api/moderation/enrollment",
      "http:request_response:GET /api/moderation/person",
      "http:request_response:POST /api/moderation/actions",
      "http:request_response:POST /api/moderation/actions#request.body",
    ]) {
      expect(entries.has(locator)).toBe(false);
      expect(REVIEWED_MAIN_2026_10_13_DEBT_LINKS.some((link) =>
        link.locator === locator
      )).toBe(false);
      expect(REVIEWED_MAIN_2026_10_13_UNRESOLVED_LOCATORS.has(locator)).toBe(true);
    }

    const relayLinks = REVIEWED_MAIN_2026_10_13_DEBT_LINKS.filter((link) =>
      link.locator.startsWith("relay:")
    );
    expect(relayLinks).toHaveLength(35);
    expect(relayLinks.every((link) =>
      link.targetDebtIds.length === 1
      && link.targetDebtIds[0] === "debt.wire.relay.server.to.client.relay.dispatch.lnqowy"
    )).toBe(true);
    expect(REVIEWED_MAIN_2026_10_13_COVERAGE_ENTRIES.some((entry) =>
      entry.locator.startsWith("relay:")
    )).toBe(false);
  });

  test("does not reuse an unrelated bearer debt for unresolved invite-token surfaces", () => {
    for (const locator of [
      "public.invites.token",
      "http:request_response:GET /api/invites/:id/share",
      "http:request_response:GET /api/invites/:token/enrollment-review",
      "http:request_response:GET /join",
      "http:request_response:POST /api/invites/:token/enrollment-review",
    ]) {
      expect(REVIEWED_MAIN_2026_10_13_UNRESOLVED_LOCATORS.has(locator)).toBe(true);
      expect(REVIEWED_MAIN_2026_10_13_DEBT_LINKS.some((link) =>
        link.locator === locator
      )).toBe(false);
    }
  });

  test("classifies content-free moderation receipts and decisions as bounded metadata", () => {
    const entries = new Map(
      REVIEWED_MAIN_2026_10_13_COVERAGE_ENTRIES.map((entry) => [entry.locator, entry]),
    );
    for (const locator of [
      "http:request_response:GET /api/moderation/actions/:operationId",
      "http:request_response:POST /api/moderation/enrollment/decision",
    ]) {
      const entry = entries.get(locator);
      expect(entry?.classification).toBe("bounded_metadata");
      if (entry?.classification !== "bounded_metadata") throw new Error("Reviewed metadata classification is unavailable");
      expect(entry.metadataAllowlist).toEqual([locator]);
      expect(REVIEWED_MAIN_2026_10_13_DEBT_LINKS.some((link) =>
        link.locator === locator
      )).toBe(false);
    }
  });

  test("grounds the closed Reflection failure detail and encrypted credential custody", async () => {
    const reflectionSource = await Bun.file(resolve(
      repoRoot,
      "packages/db/src/schema/reflection-records.ts",
    )).text();
    expect(reflectionSource).toContain(
      "REFLECTION_RECORD_SEMANTIC_WORK_FAILURE_DETAILS",
    );
    expect(reflectionSource).toContain("failure_detail");
    expect(reflectionSource).toContain(
      "REFLECTION_RECORD_SEMANTIC_WORK_FAILURE_DETAILS_SQL",
    );

    for (const entry of REVIEWED_MAIN_2026_10_13_COVERAGE_ENTRIES.filter(
      (candidate) => candidate.locator.includes("reflection_record"),
    )) {
      expect(entry.classification).toBe("bounded_metadata");
    }

    const custodyTest = await Bun.file(resolve(
      repoRoot,
      "packages/db/tests/integration/personal-provider-credentials.integration.test.ts",
    )).text();
    expect(custodyTest).toContain("ciphertextBase64");
    expect(custodyTest).toContain("authTagBase64");
    expect(custodyTest).not.toContain("apiKey: \"sk-live-secret\"");
  });

  test("retires only the removed app-runtime input schema observation", () => {
    expect(RETIRED_MAIN_2026_10_13_FROZEN_DEBT).toEqual([
      expect.objectContaining({ debtId: "debt.wire.arbitrary.19gu260" }),
    ]);
  });
});
