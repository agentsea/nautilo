import { describe, expect, test } from "bun:test";

import {
  renderMobileWebNotServedPage,
  type MobileWebNotServedReason,
} from "../../../src/friendly-errors/mobile-web-not-served";

describe("renderMobileWebNotServedPage (D515)", () => {
  const reasons: readonly MobileWebNotServedReason[] = [
    "not-configured",
    "index-missing",
    "invalid-export",
    "inspection-failed",
  ];

  test("offers bounded recovery and a relative Full Workbench link for every failure reason", () => {
    for (const reason of reasons) {
      const html = renderMobileWebNotServedPage(reason);
      expect(html).toContain("Mobile Web isn&apos;t available on this server");
      expect(html).toContain('href="/?nautilo-interface=workbench"');
      expect(html).toContain("Open Full Workbench");
      expect(html).toContain("bun run --cwd apps/mobile export:web");
      expect(html).toContain("NAUTILO_MOBILE_WEB_DIST");
    }
  });

  test("uses no remote resources or request/configuration values", () => {
    const html = renderMobileWebNotServedPage("invalid-export");
    expect(html.toLowerCase()).not.toMatch(/<img[^>]+src=["']https?:\/\//);
    expect(html.toLowerCase()).not.toMatch(/<link[^>]+href=["']https?:\/\//);
    expect(html).not.toContain("/srv/");
    expect(html).not.toContain("non-fingerprinted");
  });
});
