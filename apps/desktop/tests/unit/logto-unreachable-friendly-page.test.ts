/**
 * ISSUE-D158 — XSS-safety pins for `renderLogtoUnreachablePageHtml` (escapeHtml
 * on operator-controlled `logtoEndpoint` + `retryUrl` before they enter HTML).
 *
 * String-level assertions only (no happy-dom): `happy-dom` is a root devDependency
 * but Bun does not resolve it from this package path when running this file alone.
 */
import { describe, expect, test } from "bun:test";
import {
  renderLogtoUnreachablePageHtml,
  safeHttpRetryUrl,
} from "../../electron/auth/logto-unreachable-friendly-page";
import { ELECTRON_PRE_AUTH_INLINE_COLORS } from "../../electron/auth/pre-auth-inline-css";

describe("renderLogtoUnreachablePageHtml XSS-safety (escapeHtml)", () => {
  test("escapes <script> in logtoEndpoint so raw tag does not appear in HTML", () => {
    const html = renderLogtoUnreachablePageHtml({
      logtoEndpoint: "https://evil.example?q=<script>alert(1)</script>",
      retryUrl: "https://logto.example/sign-in",
    });
    expect(html).not.toContain("https://evil.example?q=<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("escapes & and \" in retryUrl inside data-retry-url attribute value", () => {
    const html = renderLogtoUnreachablePageHtml({
      logtoEndpoint: "https://logto.example",
      retryUrl: "https://logto.example/oidc/auth?app_id=a&state=s\"x",
    });
    expect(html).toContain(
      'data-retry-url="https://logto.example/oidc/auth?app_id=a&amp;state=s&quot;x"',
    );
    expect(html).not.toMatch(/onclick\s*=/);
  });

  test("hostile retryUrl is fully contained in one escaped data-retry-url value", () => {
    const payload = '" autofocus onfocus="alert(1)';
    const html = renderLogtoUnreachablePageHtml({
      logtoEndpoint: "https://logto.example",
      retryUrl: payload,
    });
    expect(html).toContain(
      'data-retry-url="&quot; autofocus onfocus=&quot;alert(1)"',
    );
    // Must not introduce a second attribute on the retry button line (would mean broken quotes).
    const retryLine = html
      .split("\n")
      .find((l) => l.includes('id="nautilo-retry"') && l.includes("data-retry-url"));
    expect(retryLine).toBeDefined();
    expect(retryLine!.match(/class=/g)?.length).toBe(1);
    expect(retryLine!.match(/id=/g)?.length).toBe(1);
    expect(retryLine!.match(/type=/g)?.length).toBe(1);
    expect(safeHttpRetryUrl(payload)).toBeNull();
  });

  test("escapes HTML metacharacters in logtoEndpoint inside body copy", () => {
    const html = renderLogtoUnreachablePageHtml({
      logtoEndpoint: `https://x.example/&<>"'`,
      retryUrl: "https://logto.example/sign-in",
    });
    expect(html).toContain("https://x.example/&amp;&lt;&gt;&quot;&#39;");
    expect(html).not.toContain(`https://x.example/&<>"'`);
  });

  test("uses token-derived Electron pre-auth colors", () => {
    const html = renderLogtoUnreachablePageHtml({
      logtoEndpoint: "https://logto.example",
      retryUrl: "https://logto.example/sign-in",
    });

    expect(html).toContain(`background: ${ELECTRON_PRE_AUTH_INLINE_COLORS.background}`);
    expect(html).toContain(`background: ${ELECTRON_PRE_AUTH_INLINE_COLORS.primary}`);
    expect(html).not.toContain("#ea580c");
  });
});
