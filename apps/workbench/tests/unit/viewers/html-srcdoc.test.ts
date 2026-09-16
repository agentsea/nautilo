import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import { buildSrcdoc } from "../../../src/viewers/html/srcdoc";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimePath = path.join(
  here,
  "../../../../../packages/workbench-components/dist/runtime.js",
);

describe("buildSrcdoc (D121 runtime seam)", () => {
  test("wraps fragment, injects CSP meta, and inlines optional runtime module", () => {
    const html = buildSrcdoc("<p>x</p>", `default-src 'none'`, "console.log(1)");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain(`content="default-src 'none'"`);
    expect(html).toContain('<script type="module">');
    expect(html).toContain("console.log(1)");
  });

  test("escapes closing script sequences inside inlined runtime", () => {
    const html = buildSrcdoc("<p>x</p>", "d", "</script><script>evil()");
    expect(html).not.toContain("</script><script>evil");
    expect(html).toContain("<\\/script>");
  });

  test("does not interpret $` / $$ in runtime as String.replace special patterns (regression: Lit bundle's lit$${…}$` template literals)", () => {
    // The Lit minified bundle contains sequences like `lit$${…}$` —
    // template-literal markers and a literal `$` before the closing
    // backtick. `String.prototype.replace` with a string replacement
    // interprets `$$` as a literal `$` and `` $` `` as "portion before
    // the match", which spliced the artifact's `<!doctype html>\n`
    // prefix INTO the middle of the runtime bundle and caused a
    // parse-time SyntaxError. The function-replacement form bypasses
    // special-pattern processing. Test pins both branches (<head> and
    // <html>) against a representative substring.
    const dangerousRuntime = "var x=`lit$${a}$`,y=`<${z}>`;";
    const fullDoc = "<!doctype html><html><body><p>x</p></body></html>";
    const out = buildSrcdoc(fullDoc, "default-src 'none'", dangerousRuntime);
    // The runtime substring must survive verbatim in the output —
    // neither $$ nor $` should be processed.
    expect(out).toContain("var x=`lit$${a}$`,y=`<${z}>`;");
    // And the artifact body prefix (`<!doctype html>`) MUST NOT appear
    // inside the script tag — that's exactly the corruption the bug
    // produced. The doctype legitimately appears at the start of the
    // document; we scope the assertion to the script-body slice.
    const scriptOpen = '<script type="module">';
    const scriptClose = "</script>";
    const scriptStart = out.indexOf(scriptOpen);
    const scriptEnd = out.indexOf(scriptClose, scriptStart + scriptOpen.length);
    expect(scriptStart).toBeGreaterThan(-1);
    expect(scriptEnd).toBeGreaterThan(scriptStart);
    const inlinedScriptBody = out.slice(scriptStart + scriptOpen.length, scriptEnd);
    expect(inlinedScriptBody).not.toContain("<!doctype html>");
  });

  test("same regression but with <head>-already-present branch", () => {
    const dangerousRuntime = "var x=`lit$${a}$`;";
    const docWithHead =
      "<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>";
    const out = buildSrcdoc(docWithHead, "default-src 'none'", dangerousRuntime);
    expect(out).toContain("var x=`lit$${a}$`;");
    const scriptOpen = '<script type="module">';
    const scriptClose = "</script>";
    const scriptStart = out.indexOf(scriptOpen);
    const scriptEnd = out.indexOf(scriptClose, scriptStart + scriptOpen.length);
    const inlinedScriptBody = out.slice(scriptStart + scriptOpen.length, scriptEnd);
    expect(inlinedScriptBody).not.toContain("<!doctype html>");
  });

  test("P4.7 — injects default body theme so dark workbench bg doesn't bleed through unstyled artifacts", () => {
    const out = buildSrcdoc("<p>x</p>", `default-src 'none'`);
    // The theme must appear and target html,body only (never bare element rules).
    expect(out).toContain("html,body{background:#ffffff;color:#0f172a");
    expect(out).toContain("padding:1rem 1.25rem");
  });

  test("P4.7 — default theme is placed BEFORE user <head> content so author styles win", () => {
    const userDoc =
      `<!doctype html><html><head>` +
      `<style>body{background:black;color:white;}</style>` +
      `</head><body><p>x</p></body></html>`;
    const out = buildSrcdoc(userDoc, `default-src 'none'`);
    const defaultThemeIdx = out.indexOf(
      "html,body{background:#ffffff;color:#0f172a",
    );
    const userStyleIdx = out.indexOf("body{background:black;color:white;}");
    expect(defaultThemeIdx).toBeGreaterThan(-1);
    expect(userStyleIdx).toBeGreaterThan(-1);
    // Default first → user style later → user style wins on equal specificity.
    expect(defaultThemeIdx).toBeLessThan(userStyleIdx);
  });

  // The runtime bundle is build output (gitignored), not source. CI builds
  // it before tests run; fresh local clones don't have it until someone runs
  // `bun run build` in `packages/workbench-components`. Skip instead of
  // hard-throwing so a missing bundle doesn't masquerade as a regression
  // failure during local dev.
  test.skipIf(!existsSync(runtimePath))("when built, wraps nw-smoke fixture with runtime bundle", () => {
    const fragment = readFileSync(
      path.join(here, "../../fixtures/nw-smoke.html"),
      "utf8",
    );
    const runtime = readFileSync(runtimePath, "utf8");
    const doc = buildSrcdoc(
      fragment,
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      runtime,
    );
    expect(doc).toContain("<nw-doc>");
    expect(doc.length).toBeGreaterThan(runtime.length);
  });
});
