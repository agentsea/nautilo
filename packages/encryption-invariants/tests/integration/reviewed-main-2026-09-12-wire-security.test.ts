import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { CURRENT_FROZEN_BASELINE_DEBT } from "../../baseline/existing-debt";
import {
  REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS,
  REVIEWED_MAIN_2026_09_12_NEW_DTO_DECLARATIONS,
  SUPERSEDED_MAIN_2026_09_12_DTO_LOCATORS,
} from "../../baseline/reviewed-main-2026-09-12-dto";
import {
  REVIEWED_MAIN_2026_09_12_WIRE_COVERAGE_ENTRIES,
  REVIEWED_MAIN_2026_09_12_WIRE_DEBT_LINKS,
} from "../../baseline/reviewed-main-2026-09-12-wire";
import { validateCoverageEntry } from "../../src/model";
import {
  auditDtoDeclarations,
  discoverDtoInventory,
} from "../../src/node/dto-inventory";

const repoRoot = resolve(import.meta.dir, "../../../..");

describe("current-main September 12 wire review", () => {
  test("keeps every reviewed DTO snapshot exact and every open path explicit", async () => {
    expect(SUPERSEDED_MAIN_2026_09_12_DTO_LOCATORS.size).toBe(13);
    expect(REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS).toHaveLength(13);
    expect(REVIEWED_MAIN_2026_09_12_NEW_DTO_DECLARATIONS).toHaveLength(23);

    const declarations = [
      ...REVIEWED_MAIN_2026_09_12_DTO_REPLACEMENTS,
      ...REVIEWED_MAIN_2026_09_12_NEW_DTO_DECLARATIONS,
    ];
    const locators = new Set(declarations.map((entry) => entry.locator));
    const observations = (await discoverDtoInventory(repoRoot)).filter((entry) =>
      locators.has(entry.locator)
    );
    expect(auditDtoDeclarations({ observations, declarations }).ok).toBe(true);

    const bridgeOptions = declarations.find((entry) =>
      entry.locator.endsWith("#AppBridgeOptions")
    );
    expect(bridgeOptions?.arbitraryPayloads).toContainEqual({
      path: "recovery",
      schema: "AppDraftRecoveryPort",
    });
    expect(bridgeOptions?.arbitraryPayloads).toContainEqual({
      path: "templates",
      schema: "AppSlideTemplateLibrary",
    });
    const bridgeRequest = declarations.find((entry) =>
      entry.locator.endsWith("#AppBridgeRequest")
    );
    expect(bridgeRequest?.arbitraryPayloads).toContainEqual({
      path: "key",
      schema: "AppPreferenceKey",
    });
    expect(bridgeRequest?.arbitraryPayloads).toContainEqual({
      path: "input",
      schema: "AppRecoveryWrite",
    });
  }, 60_000);

  test("keeps template bytes and identity presentation on exact frozen debt", () => {
    const frozenIds = new Set(CURRENT_FROZEN_BASELINE_DEBT.map((entry) => entry.id));
    expect(REVIEWED_MAIN_2026_09_12_WIRE_DEBT_LINKS).toHaveLength(9);
    for (const link of REVIEWED_MAIN_2026_09_12_WIRE_DEBT_LINKS) {
      expect(link.targetDebtIds.every((id) => frozenIds.has(id))).toBe(true);
      expect(REVIEWED_MAIN_2026_09_12_WIRE_COVERAGE_ENTRIES.some((entry) =>
        entry.locator === link.locator
      )).toBe(false);
    }
    for (const locator of [
      "http:request_response:GET /api/apps/nautilo-presentation/slide-templates",
      "http:request_response:GET /api/content-access",
      "http:request_response:POST /api/content-access/prepare",
      "http:request_response:GET /api/event-feed",
    ]) {
      expect(REVIEWED_MAIN_2026_09_12_WIRE_DEBT_LINKS.some((entry) =>
        entry.locator === locator
      )).toBe(true);
    }
  });

  test("separates device-local draft custody from Namespace protection", () => {
    const recoveryEntries = REVIEWED_MAIN_2026_09_12_WIRE_COVERAGE_ENTRIES
      .filter((entry) => entry.classification === "device_local");
    expect(recoveryEntries).toHaveLength(6);
    expect(recoveryEntries.every((entry) =>
      entry.classification === "device_local"
    )).toBe(true);
    const recoveryLocators = new Set(recoveryEntries.map((entry) => entry.locator));
    expect(REVIEWED_MAIN_2026_09_12_WIRE_COVERAGE_ENTRIES.some((entry) =>
      recoveryLocators.has(entry.locator) && entry.classification === "protected"
    )).toBe(false);
  });

  test("registers closed metadata and recipient-sealed authorization separately", async () => {
    expect(REVIEWED_MAIN_2026_09_12_WIRE_COVERAGE_ENTRIES).toHaveLength(32);
    for (const entry of REVIEWED_MAIN_2026_09_12_WIRE_COVERAGE_ENTRIES) {
      expect(validateCoverageEntry(entry)).toEqual({ ok: true });
    }

    const list = REVIEWED_MAIN_2026_09_12_WIRE_COVERAGE_ENTRIES.find((entry) =>
      entry.locator.endsWith("/background-authorization/requests/list")
    );
    expect(list?.classification).toBe("bounded_metadata");
    const respond = REVIEWED_MAIN_2026_09_12_WIRE_COVERAGE_ENTRIES.find((entry) =>
      entry.locator.endsWith("/background-authorization/respond")
    );
    expect(respond).toMatchObject({
      classification: "protected",
      keyFamily: "namespace_ai",
      migrationState: "ciphertext_only",
    });

    const cryptoSource = await Bun.file(resolve(
      repoRoot,
      "packages/lattice-crypto/src/background/processor-authorization-v2.ts",
    )).text();
    expect(cryptoSource).toContain(
      "crypto.sealTo(descriptor.recipientPublicKey, secret)",
    );
    expect(cryptoSource).toContain("verifyBackgroundAuthorizationResponseV2");
    expect(cryptoSource).toContain("signer?.privateKey.fill(0)");
    expect(cryptoSource).toContain("secret?.fill(0)");
  });

  test("records Fastify bodyless GET as a framework contract, not arbitrary plaintext", () => {
    for (const locator of [
      "http:request_response:GET /api/rooms/:roomId/content-access-recovery#request.body",
      "http:request_response:GET /api/tasks/:id/content-access-recovery#request.body",
    ]) {
      const declaration = REVIEWED_MAIN_2026_09_12_NEW_DTO_DECLARATIONS.find((entry) =>
        entry.locator === locator.replace(/#request[.]body$/u, "")
      );
      expect(declaration?.arbitraryPayloads).toContainEqual({
        path: "request.body",
        schema: "FastifyBodylessGetRequest",
      });
      expect(REVIEWED_MAIN_2026_09_12_WIRE_COVERAGE_ENTRIES.find((entry) =>
        entry.locator === locator
      )).toMatchObject({ classification: "bounded_metadata" });
    }
  });
});
