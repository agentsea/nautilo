/* eslint-disable @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- This security test deliberately executes the page's extracted inline script inside happy-dom. */
/**
 * Stack 19 Phase 6.9.1 CRITICAL — `cold-boot-picker.html` XSS prevention.
 *
 * Pre-fix this page built recovery UI via `innerHTML` template strings
 * from unescaped URLSearchParams (`server`, `paired`, `found`). The
 * page has the Electron preload bridge attached (`nautiloDesktop` /
 * `desktopAPI`) — so a malicious or compromised paired-server identity
 * could become arbitrary JS in a privileged renderer with full
 * `desktopAPI` surface access. Reviewer's BLOCK Critical-#1 finding on
 * PR #188 (2026-05-16T17:30Z).
 *
 * This test exercises the page's inline `<script>` against three
 * hostile payload classes under happy-dom and asserts the constructed
 * DOM stays inert. Static-grep complements: the source must NOT
 * contain template-literal `innerHTML` assignment of user data, and
 * must NOT contain inline `onclick="..."` attributes.
 *
 * Pinned scenarios:
 *   1. `server=javascript:alert(1)` (disconnected mode) — display-only
 *      attack surface; must NOT become `location.href`, a network target,
 *      or an unsafe `<a href>`.
 *   2. `server=<script>alert(1)</script>` (disconnected mode) —
 *      innerHTML injection; must appear in DOM as escaped text only.
 *   3. `wrong-server` mode with hostile `paired`/`found` — identity receipts
 *      are not projected to the renderer at all.
 *   4. Static-grep contract: source has zero template-literal
 *      `innerHTML = ` assignments AND zero `onclick="` attribute
 *      authors AND has the `safeHttpUrl()` URL validator.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HTML_PATH = join(
  import.meta.dir,
  "../../electron/cold-boot-picker.html",
);

function readHtml(): string {
  return readFileSync(HTML_PATH, "utf8");
}

function extractInlineScript(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("inline <script> not found in cold-boot-picker.html");
  return match[1] ?? "";
}

interface FakeColdBootApi {
  retry: () => void;
  pairToDifferentServer: () => void;
  useThisServerAnyway: () => void;
  quit: () => void;
}

interface RunResult {
  window: Window;
  body: string;
  panelInnerHTML: string;
  panelTextContent: string;
  buttonLabels: string[];
  scriptTagsInPanel: number;
  hrefAttributesInPanel: string[];
  api: FakeColdBootApi;
  apiCalls: Record<keyof FakeColdBootApi, number>;
}

function runColdBootScript(searchParams: string): RunResult {
  const html = readHtml();
  const script = extractInlineScript(html);
  const window = new Window({ url: `http://nautilo-cold-boot/?${searchParams}` });
  // Provide the privileged bridge a real renderer would have.
  const apiCalls: Record<keyof FakeColdBootApi, number> = {
    retry: 0,
    pairToDifferentServer: 0,
    useThisServerAnyway: 0,
    quit: 0,
  };
  const api: FakeColdBootApi = {
    retry: () => {
      apiCalls.retry++;
    },
    pairToDifferentServer: () => {
      apiCalls.pairToDifferentServer++;
    },
    useThisServerAnyway: () => {
      apiCalls.useThisServerAnyway++;
    },
    quit: () => {
      apiCalls.quit++;
    },
  };
  (window as unknown as { nautiloDesktop: { coldBoot: FakeColdBootApi } }).nautiloDesktop = {
    coldBoot: api,
  };
  // Bare-bones DOM the script expects (mirrors the static <body> in
  // the HTML file but skips the surrounding chrome so we focus on the
  // dynamic injection point).
  const doc = window.document;
  const panel = doc.createElement("div");
  panel.id = "panel";
  doc.body.appendChild(panel);
  // Execute the inline script with the happy-dom window's bindings
  // injected as explicit parameters. We can't use `with (window) { ... }`
  // because happy-dom's window proxy shadows native globals like
  // String/URL/setInterval and breaks the script. Native globals like
  // String, Object, Math, Promise, JSON resolve through the test's own
  // execution context (which is sufficient for this script's needs).
  const runner = new Function(
    "window",
    "document",
    "URL",
    "URLSearchParams",
    "AbortSignal",
    "fetch",
    "setInterval",
    "setTimeout",
    "clearInterval",
    "clearTimeout",
    script,
  );
  runner(
    window,
    doc,
    window.URL,
    window.URLSearchParams,
    window.AbortSignal,
    (...args: unknown[]) => (window.fetch as (...a: unknown[]) => unknown)(...args),
    (...args: unknown[]) => (window.setInterval as (...a: unknown[]) => unknown)(...args),
    (...args: unknown[]) => (window.setTimeout as (...a: unknown[]) => unknown)(...args),
    (h: unknown) => (window.clearInterval as (x: unknown) => unknown)(h),
    (h: unknown) => (window.clearTimeout as (x: unknown) => unknown)(h),
  );
  return {
    window,
    body: doc.body.innerHTML,
    panelInnerHTML: panel.innerHTML,
    panelTextContent: panel.textContent || "",
    buttonLabels: Array.from(panel.querySelectorAll("button")).map((b) => b.textContent || ""),
    scriptTagsInPanel: panel.querySelectorAll("script").length,
    hrefAttributesInPanel: Array.from(panel.querySelectorAll("[href]")).map(
      (e) => (e as HTMLAnchorElement).getAttribute("href") || "",
    ),
    api,
    apiCalls,
  };
}

describe("cold-boot-picker.html XSS hardening (Stack 19 Phase 6.9.1)", () => {
  test("REGRESSION: server=<script>alert(1)</script> → NO script tags injected; payload appears as text only", () => {
    const r = runColdBootScript(
      `mode=disconnected&server=${encodeURIComponent("<script>alert(1)</script>")}`,
    );
    // LOAD-BEARING: zero script tags. Pre-fix `panel.innerHTML = ...${server}...`
    // would parse the payload as a real <script> child of #panel here.
    expect(r.scriptTagsInPanel).toBe(0);
    // The payload should be present as ESCAPED text inside the page
    // (we display it back to the operator so they can see what was
    // attempted), but never as parsed HTML.
    expect(r.panelTextContent).toContain("<script>alert(1)</script>");
    expect(r.panelInnerHTML).not.toContain("<script>alert(1)</script>");
    expect(r.panelInnerHTML).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("REGRESSION: server=javascript:alert(1) → no auto-navigation, no /health polling (hostile URL is silently dropped)", async () => {
    const r = runColdBootScript(
      `mode=disconnected&server=${encodeURIComponent("javascript:alert(1)")}`,
    );
    // Display: hostile string appears escaped in the .mono span.
    expect(r.panelTextContent).toContain("javascript:alert(1)");
    // The display-server text node appears via textContent — does NOT
    // become an executable href anywhere.
    for (const href of r.hrefAttributesInPanel) {
      expect(href.startsWith("http://")).toBe(true);
    }
    // Critical contract: location.href MUST NOT have been set to the hostile
    // URL. D514 removed the renderer polling loop; main owns every retry.
    expect(r.window.location.href).toBe(
      `http://nautilo-cold-boot/?mode=disconnected&server=javascript%3Aalert(1)`,
    );
  });

  test("REGRESSION: wrong-server mode ignores hostile paired/found identity receipts", () => {
    const r = runColdBootScript(
      [
        `mode=wrong-server`,
        `server=http%3A//evil.example.com`,
        `paired=${encodeURIComponent("<img src=x onerror=alert(1)>")}`,
        `found=${encodeURIComponent("\"><script>alert(2)</script>")}`,
      ].join("&"),
    );
    expect(r.scriptTagsInPanel).toBe(0);
    // Real DOM check: NO <img> element parsed from the payload.
    // Under textContent assignment the payload stays as text inside
    // a <span> (which is allowed structure), but the parser should
    // NEVER have created an <img> node from the hostile string.
    expect(r.window.document.querySelectorAll("img").length).toBe(0);
    // Real DOM check: NO onerror= attribute on ANY element. The
    // panel innerHTML contains the literal text "onerror=alert(1)"
    // inside escaped &lt;…&gt; which is harmless; the attack would
    // be a parsed attribute, which `[onerror]` would find.
    expect(r.window.document.querySelectorAll("[onerror]").length).toBe(0);
    // Identity receipts are deliberately not database-fields-as-UI. The
    // recovery copy names the decision without leaking either receipt.
    expect(r.panelTextContent).not.toContain("<img src=x onerror=alert(1)>");
    expect(r.buttonLabels).toEqual([
      "Retry",
      "Pair to a different server",
      "Use this anyway",
      "Quit",
    ]);
    const buttons = Array.from(r.window.document.querySelectorAll("#panel button")) as unknown as Array<{
      click: () => void;
    }>;
    buttons[0]?.click();
    buttons[1]?.click();
    buttons[2]?.click();
    buttons[3]?.click();
    expect(r.apiCalls.retry).toBe(1);
    expect(r.apiCalls.pairToDifferentServer).toBe(1);
    expect(r.apiCalls.useThisServerAnyway).toBe(1);
    expect(r.apiCalls.quit).toBe(1);
    expect(r.panelTextContent).not.toContain('"><script>alert(2)</script>');
  });

  test("normal http URL still wires Retry → Pair → Quit buttons; click handlers invoke desktop bridge", () => {
    const r = runColdBootScript(
      `mode=disconnected&server=${encodeURIComponent("http://127.0.0.1:6801")}`,
    );
    expect(r.buttonLabels).toEqual([
      "Retry",
      "Pair to a different server",
      "Quit",
    ]);
    expect(r.panelTextContent).toContain("Choose Retry to try again.");
    expect(r.panelTextContent).not.toContain("Trying to reconnect");
    // Verify click handlers wire correctly through the bridge.
    const buttons = Array.from(r.window.document.querySelectorAll("#panel button")) as unknown as Array<{
      click: () => void;
    }>;
    buttons[0]?.click();
    buttons[1]?.click();
    buttons[2]?.click();
    expect(r.apiCalls.retry).toBe(1);
    expect(r.apiCalls.pairToDifferentServer).toBe(1);
    expect(r.apiCalls.quit).toBe(1);
  });

  test("static-grep contract: source has zero template-literal innerHTML interpolation AND zero inline onclick= attributes", () => {
    const html = readHtml();
    const script = extractInlineScript(html);
    // Strip both block comments AND line comments before grepping so
    // the comments that describe the pre-fix patterns (e.g. "pre-fix:
    // <button ... onclick=...") don't false-positive.
    const stripped = script
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    // Pre-fix shape: `panel.innerHTML = \`...${server}...\``. Reject any
    // template-literal `${` inside an `innerHTML = ` assignment.
    const innerHtmlWithInterpolation = /\.innerHTML\s*=\s*`[^`]*\$\{/g;
    const matches = stripped.match(innerHtmlWithInterpolation) || [];
    expect(matches).toEqual([]);
    // Pre-fix shape: `<button ... onclick="window.__d154Retry()">`.
    // Reject any inline onclick= attribute author in the script body.
    expect(stripped).not.toMatch(/onclick\s*=\s*["']/);
    // Forward contract: the URL validator MUST exist and be called
    // before any navigation/fetch. Grep for its definition + use.
    expect(script).toContain("function safeHttpUrl");
    expect(script).toContain("safeHttpUrl(");
  });

  test("static-grep contract: URL allowlist forbids javascript:/data:/file: schemes", () => {
    const html = readHtml();
    const script = extractInlineScript(html);
    // safeHttpUrl must constrain to http: / https: explicitly. If a
    // refactor relaxes this (e.g. allows file: or removes the protocol
    // check), this test catches it.
    expect(script).toMatch(/u\.protocol\s*!==?\s*["']http:["']/);
    expect(script).toMatch(/u\.protocol\s*!==?\s*["']https:["']/);
  });
});
