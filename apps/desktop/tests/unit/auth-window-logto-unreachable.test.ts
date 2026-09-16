/**
 * D154 Phase 7 — classifier + friendly-page HTML pins (pure helpers) +
 * regression string pins on `auth-window.ts` wiring.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Window } from "happy-dom";
import {
  classifyAuthWindowLoadFailure,
  renderLogtoUnreachablePageHtml,
  safeHttpRetryUrl,
} from "../../electron/auth/logto-unreachable-friendly-page";

/**
 * Parse the rendered page through happy-dom and return the retry
 * button so tests can inspect attributes via the real DOM parser.
 * This is the right primitive for XSS checks — string regexes on
 * raw HTML can be confused by attribute-value substrings (e.g.
 * `autofocus` appearing inside the value of `data-retry-url`),
 * whereas a parsed-attribute check sees what the browser sees.
 */
function parseRetryButton(html: string): {
  retry: Element;
  allButtons: Element[];
  doc: Document;
} {
  const w = new Window({ url: "data:text/html,foo" });
  w.document.documentElement.innerHTML = html;
  const retry = w.document.getElementById("nautilo-retry");
  if (!retry) throw new Error("nautilo-retry button not found in rendered page");
  return {
    retry: retry as unknown as Element,
    allButtons: Array.from(w.document.querySelectorAll("button")) as unknown as Element[],
    doc: w.document as unknown as Document,
  };
}

describe("classifyAuthWindowLoadFailure", () => {
  test("-102 (connection refused) → logto-unreachable (load-bearing)", () => {
    expect(classifyAuthWindowLoadFailure(-102, "ERR_CONNECTION_REFUSED")).toBe(
      "logto-unreachable",
    );
  });

  test("-105 (DNS) → logto-unreachable", () => {
    expect(classifyAuthWindowLoadFailure(-105, "ERR_NAME_NOT_RESOLVED")).toBe(
      "logto-unreachable",
    );
  });

  test("-118 (timeout) → logto-unreachable", () => {
    expect(classifyAuthWindowLoadFailure(-118, "ERR_CONNECTION_TIMED_OUT")).toBe(
      "logto-unreachable",
    );
  });

  test("-3 (ABORTED) → other (suppress false-positive)", () => {
    expect(classifyAuthWindowLoadFailure(-3, "ERR_ABORTED")).toBe("other");
  });

  test("404 → other (defensive — not a net navigation code)", () => {
    expect(classifyAuthWindowLoadFailure(404, "HTTP 404")).toBe("other");
  });

  test("vacuous guard: predicate is load-bearing at helper boundary", () => {
    // If this were `() => "other"`, the -102 case above would fail.
    expect(classifyAuthWindowLoadFailure(-102, "")).not.toBe("other");
  });
});

describe("renderLogtoUnreachablePageHtml", () => {
  test("contains heading, body with endpoint, three buttons, retry URL (Phase 6.9.2 shape: data-retry-url + addEventListener, NOT inline onclick)", () => {
    const html = renderLogtoUnreachablePageHtml({
      logtoEndpoint: "https://logto.example",
      retryUrl: "https://logto.example/sign-in",
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Sign-in service unreachable");
    expect(html).toContain("https://logto.example");
    expect(html).toContain("Retry");
    expect(html).toContain("Pick a different server");
    expect(html).toContain("Cancel");
    // Phase 6.9.2 shape: URL on data-attribute, click wiring in
    // <script> via addEventListener. Pre-fix was inline
    // `onclick="window.location.href=${JSON.stringify(retryUrl)}"`
    // — which is the BLOCK High-#2 finding this fix addresses.
    expect(html).toContain('data-retry-url="https://logto.example/sign-in"');
    expect(html).toContain('id="nautilo-retry"');
    expect(html).toContain("addEventListener");
  });

  test("HTML-escapes endpoint injection (no raw script tag from endpoint)", () => {
    const html = renderLogtoUnreachablePageHtml({
      logtoEndpoint: "https://logto.example?xss=<script>alert(1)</script>",
      retryUrl: "https://logto.example/sign-in",
    });
    expect(html).not.toContain("https://logto.example?xss=<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("REGRESSION Phase 6.9.2: normal URL with query params (containing \") does NOT break attribute shape", () => {
    // Pre-fix used `onclick=\"window.location.href=${JSON.stringify(url)}\"`.
    // JSON.stringify produces `\"http://...?foo=bar\"` which when
    // interpolated INSIDE `onclick=\"...\"` closes the attribute
    // prematurely and corrupts the markup. Even a normal URL with
    // ? & = chars is enough — never mind hostile content.
    const html = renderLogtoUnreachablePageHtml({
      logtoEndpoint: "https://logto.example",
      retryUrl: "https://logto.example/sign-in?app_id=abc123&state=xyz",
    });
    // The URL appears as the data attribute (escapeHtml'd & escaped).
    expect(html).toContain(
      'data-retry-url="https://logto.example/sign-in?app_id=abc123&amp;state=xyz"',
    );
    // No inline onclick assignments anywhere.
    expect(html).not.toMatch(/onclick\s*=/);
    // Real DOM check: parse the rendered page and verify the retry
    // button has exactly one URL-bearing attribute (`data-retry-url`),
    // and that the parsed value round-trips the URL with the
    // unescaped `&` (the browser unescapes &amp; for us).
    const { retry } = parseRetryButton(html);
    expect(retry.getAttribute("data-retry-url")).toBe(
      "https://logto.example/sign-in?app_id=abc123&state=xyz",
    );
    // No onclick, no autofocus, no JS-execution attributes.
    for (const a of retry.attributes) {
      expect(a.name.startsWith("on")).toBe(false);
    }
  });

  test("REGRESSION Phase 6.9.2: hostile retryUrl with double-quote injection is escaped + dropped at click-time", () => {
    const html = renderLogtoUnreachablePageHtml({
      logtoEndpoint: "https://logto.example",
      retryUrl: '" autofocus onfocus="alert(1)',
    });
    // escapeHtml turns the hostile " into &quot; so attribute shape
    // stays valid. The literal payload appears in the source as
    // ONE data-retry-url attribute value, NOT as a parsed sibling
    // attribute.
    expect(html).toContain(
      'data-retry-url="&quot; autofocus onfocus=&quot;alert(1)"',
    );
    // Real DOM check: parse via happy-dom and verify the button has
    // ONLY the expected attributes. If escapeHtml were dropped, the
    // string-regex-based "autofocus appears in raw HTML" check would
    // also fire — but the regex approach has false positives on
    // attribute-value substrings, so we parse instead.
    const { retry } = parseRetryButton(html);
    const attrNames = Array.from(retry.attributes).map((a) => a.name).sort();
    expect(attrNames).toEqual([
      "class",
      "data-retry-url",
      "id",
      "type",
    ]);
    // Specifically: NO autofocus, NO onfocus, NO on* event-handler
    // attributes on the parsed button.
    expect(retry.hasAttribute("autofocus")).toBe(false);
    expect(retry.hasAttribute("onfocus")).toBe(false);
    for (const a of retry.attributes) {
      expect(a.name.startsWith("on")).toBe(false);
    }
    // The hostile payload IS the value of data-retry-url (browser
    // returns the unescaped form via getAttribute), which the
    // click handler will then validate via safeHttpRetryUrl and
    // drop because it's not a valid http/https URL.
    expect(retry.getAttribute("data-retry-url")).toBe(
      '" autofocus onfocus="alert(1)',
    );
    expect(safeHttpRetryUrl(retry.getAttribute("data-retry-url") || "")).toBeNull();
  });

  test("REGRESSION Phase 6.9.2: javascript:-scheme retryUrl gets dropped by safeHttpRetryUrl at click-time (belt-and-suspenders)", () => {
    // The click handler re-validates via safeHttpRetryUrl. If a
    // hostile URL slipped past escapeHtml somehow, the click would
    // be a no-op rather than executing javascript: in the
    // privileged auth-window context.
    expect(safeHttpRetryUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpRetryUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHttpRetryUrl("file:///etc/passwd")).toBeNull();
    expect(safeHttpRetryUrl("about:blank")).toBeNull();
    expect(safeHttpRetryUrl("")).toBeNull();
    expect(safeHttpRetryUrl("not-a-url")).toBeNull();
    // Positive cases still work:
    expect(safeHttpRetryUrl("http://logto.local/sign-in")).toBe("http://logto.local/sign-in");
    expect(safeHttpRetryUrl("https://logto.example/sign-in?app_id=x")).toBe("https://logto.example/sign-in?app_id=x");
  });

  test("static contract: source has zero inline onclick= attributes (regression pin for Phase 6.9.2)", () => {
    const html = renderLogtoUnreachablePageHtml({
      logtoEndpoint: "https://logto.example",
      retryUrl: "https://logto.example/sign-in",
    });
    // If a future refactor reintroduces `onclick="..."` (the pre-fix
    // shape), this regex catches it. LOAD-BEARING — fails under any
    // inline-onclick reintroduction.
    expect(html).not.toMatch(/onclick\s*=\s*["']/);
  });
});

describe("auth-window.ts wiring (static)", () => {
  test("did-fail-load + renderLogtoUnreachablePageHtml in listener body", () => {
    const p = path.join(import.meta.dir, "../../electron/auth/auth-window.ts");
    const src = fs.readFileSync(p, "utf8");
    expect(src).toContain("did-fail-load");
    expect(src).toContain("renderLogtoUnreachablePageHtml({");
  });
});
