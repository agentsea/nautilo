/**
 * M101 Phase 4 — pure-helper tests for Account-menu URL building +
 * paste-reset URL validation.
 *
 * Note: we intentionally do NOT import `electron/menu.ts` at runtime
 * here. CI bun (1.3.14+) statically validates named imports against
 * the resolved module, and `apps/desktop/electron/menu.ts` does
 * `import { …, shell } from "electron"`, which fails on CI's Linux
 * `electron` package (a CommonJS download stub with no named exports),
 * even when `mock.module("electron", …)` provides `shell` at runtime.
 * The Account-submenu shape is covered by the existing type-only
 * contract tests in `apps/desktop/tests/unit/menu.test.ts` plus manual
 * QA on the live menu (see ISSUE-M101 Phase 4 acceptance).
 */
import { describe, expect, test } from "bun:test";
import { buildAccountPageUrl } from "../../../electron/auth/account-page-url";
import { validatePasteResetUrl } from "../../../electron/auth/reset-paste-url";

describe("buildAccountPageUrl", () => {
  test("joins endpoint and path", () => {
    expect(buildAccountPageUrl("https://logto.test", "/account/password")).toBe(
      "https://logto.test/account/password",
    );
    expect(buildAccountPageUrl("https://logto.test/", "/account/password")).toBe(
      "https://logto.test/account/password",
    );
  });
});

describe("validatePasteResetUrl", () => {
  test("accepts https localhost reset URL with one_time_token", () => {
    expect(
      validatePasteResetUrl(
        "https://localhost:3301/reset?one_time_token=abc&foo=1",
      ),
    ).toBe(true);
  });
  test("rejects javascript:", () => {
    expect(validatePasteResetUrl("javascript:alert(1)")).toBe(false);
  });
  test("rejects file:", () => {
    expect(validatePasteResetUrl("file:///etc/passwd")).toBe(false);
  });
  test("rejects empty", () => {
    expect(validatePasteResetUrl("")).toBe(false);
    expect(validatePasteResetUrl("   ")).toBe(false);
  });
  test("allows http://localhost dev URLs", () => {
    expect(validatePasteResetUrl("http://localhost:3301/foo?one_time_token=x")).toBe(true);
  });
  test("rejects non-localhost http", () => {
    expect(validatePasteResetUrl("http://evil.test/reset")).toBe(false);
  });
  test("rejects http://localhost.evil.com spoof", () => {
    expect(validatePasteResetUrl("http://localhost.evil.com/reset")).toBe(false);
  });
});
