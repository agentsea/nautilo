import { expect, test } from "bun:test";
import { buildStaticArtifactDocument } from "./static-html-document";

function render(source: string) {
  const result = buildStaticArtifactDocument(source);
  if (result.kind !== "ready") throw new Error(result.message);
  return result;
}

test("authored static CSS, layout and readable semantic content survive", () => {
  const result = render('<html><head><style>.hero{display:grid;color:#246;font-size:32px}</style></head><body><article class="hero" style="padding:24px"><h1>Our work</h1><table><tr><td>Today</td></tr></table></article></body></html>');
  expect(result.html).toContain(".hero{display:grid;color:#246;font-size:32px}");
  expect(result.html).toContain('<article class="hero" style="padding:24px">');
  expect(result.html).toContain("<td>Today</td>");
  expect(result.warnings).toEqual([]);
});

test("scripts, refresh, inherited origins, event handlers and live forms are not admitted", () => {
  const result = render('<base href="https://secret.invalid"><meta http-equiv="refresh" content="0;url=https://secret.invalid"><script>fetch("/secret")</script><form action="https://secret.invalid"><input value="Readable"><button>Submit</button></form><p onclick="steal()">Hello</p><iframe src="https://secret.invalid"></iframe>');
  for (const text of ["<base", "refresh", "<script", "onclick", "<form", "<iframe", "secret.invalid"]) expect(result.html).not.toContain(text);
  expect(result.html).toContain("Readable");
  expect(result.html).toContain("Hello");
  expect(result.html).toContain("Content-Security-Policy");
  expect(result.warnings.length).toBeGreaterThan(0);
});

test("network and SVG images have visible placeholders; links retain only explicit safe destinations", () => {
  const result = render('<img src="https://private.invalid/image" alt="Team portrait"><img src="data:image/svg+xml,svg"><a href="javascript:steal()">Unsafe</a><a href="https://example.com/">Read more</a><svg><script>steal()</script></svg>');
  expect(result.html).toContain("Team portrait — image unavailable");
  expect(result.html).not.toContain("private.invalid");
  expect(result.html).not.toContain("javascript:");
  expect(result.html).not.toContain("<svg");
  expect(result.html).toContain('href="https://example.com/"');
});

test("CSS resource URLs are confined by the first CSP while authored CSS stays intact", () => {
  const result = render('<style>@import "https://example.com/font.css";p{background:url(https://example.com/pixel)}</style><p>Readable</p>');
  expect(result.html.indexOf("Content-Security-Policy")).toBeLessThan(result.html.indexOf("@import"));
  expect(result.html).toContain("default-src 'none'");
  expect(result.warnings.some((warning) => warning.code === "unsupported_style")).toBe(true);
});

test("malformed Writer envelopes never fall through to misleading generic HTML", () => {
  expect(buildStaticArtifactDocument('<script type="application/vnd.nautilo.document+json">broken</script><p>Not the document</p>').kind).toBe("malformed");
});

test("misnested HTML is repaired by the HTML parser and comments cannot introduce active content", () => {
  const result = render('<table><p>Introduction</p><tr><td>Cell</table><!-- <script>alert(1)</script> -->');
  expect(result.html).toContain("Introduction");
  expect(result.html).toContain("Cell");
  expect(result.html).not.toContain("<script");
});
