import { afterEach, describe, expect, test } from "bun:test";
import {
  getTrustedModelCatalogPublicKey,
  resetTrustedModelCatalogKeysForTests,
  setTrustedModelCatalogKeysForTests,
} from "../../src/config/model-catalog/trusted-keys";
import {
  getTrustedExplainerCatalogPublicKey,
  resetTrustedExplainerCatalogKeysForTests,
  setTrustedExplainerCatalogKeysForTests,
} from "../../src/media/explainer-catalog/trusted-keys";

const PRODUCTION_SIGNING_KEY_ID = "catalog-2026-07-17";
const PRODUCTION_PUBLIC_KEY_B64 =
  "MCowBQYDK2VwAyEAX9Kq7L0rqQVJJw9Mau3fmr9nbKDC1iTDEWoWNVJZCAo=";

afterEach(() => {
  resetTrustedModelCatalogKeysForTests();
  resetTrustedExplainerCatalogKeysForTests();
});

describe("D429 Phase 8 — checked-in catalog trusted keys", () => {
  test("model catalog registry resolves the production key by id", () => {
    expect(getTrustedModelCatalogPublicKey(PRODUCTION_SIGNING_KEY_ID)).toBe(
      PRODUCTION_PUBLIC_KEY_B64,
    );
    expect(getTrustedModelCatalogPublicKey("unknown-key-id")).toBeUndefined();
  });

  test("explainer catalog registry resolves the production key by id", () => {
    expect(getTrustedExplainerCatalogPublicKey(PRODUCTION_SIGNING_KEY_ID)).toBe(
      PRODUCTION_PUBLIC_KEY_B64,
    );
    expect(getTrustedExplainerCatalogPublicKey("unknown-key-id")).toBeUndefined();
  });

  test("test injection replaces the checked-in model catalog registry", () => {
    setTrustedModelCatalogKeysForTests({ "test-only": "dGVzdA==" });
    expect(getTrustedModelCatalogPublicKey(PRODUCTION_SIGNING_KEY_ID)).toBeUndefined();
    expect(getTrustedModelCatalogPublicKey("test-only")).toBe("dGVzdA==");
  });

  test("test injection replaces the checked-in explainer catalog registry", () => {
    setTrustedExplainerCatalogKeysForTests({ "test-only": "dGVzdA==" });
    expect(getTrustedExplainerCatalogPublicKey(PRODUCTION_SIGNING_KEY_ID)).toBeUndefined();
    expect(getTrustedExplainerCatalogPublicKey("test-only")).toBe("dGVzdA==");
  });
});
