import { describe, expect, test } from "bun:test";

import {
  PUBLIC_PRODUCT_LINKS,
  publicProductLinkErrors,
} from "../../src/public-product-links";

describe("public product links", () => {
  test("pins the approved Privacy, email contact, and store support destinations", () => {
    expect(PUBLIC_PRODUCT_LINKS).toEqual({
      privacyPolicyUrl: "https://nautilo.ai/privacy",
      supportContactUrl: "mailto:support@kentauros.ai",
      storeSupportUrl: "https://nautilo.ai/docs/use/mobile",
    });
    expect(publicProductLinkErrors(PUBLIC_PRODUCT_LINKS)).toEqual([]);
  });

  test("rejects missing, insecure, credential-bearing, placeholder, and malformed destinations", () => {
    expect(publicProductLinkErrors({})).toHaveLength(3);
    expect(publicProductLinkErrors({
      privacyPolicyUrl: "http://nautilo.ai/privacy",
      supportContactUrl: "https://nautilo.ai/support",
      storeSupportUrl: "https://placeholder.nautilo.ai/support",
    })).toHaveLength(3);
    expect(publicProductLinkErrors({
      privacyPolicyUrl: "https://user:secret@nautilo.ai/privacy",
      supportContactUrl: "mailto:not-an-email",
      storeSupportUrl: "not a URL",
    })).toHaveLength(3);
  });
});
