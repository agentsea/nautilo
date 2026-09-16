import { describe, expect, test } from "bun:test";
import { renderWorkbenchNotServedPage } from "../../../src/friendly-errors/workbench-not-served";

describe("renderWorkbenchNotServedPage (D171)", () => {
  test("escapes all four dynamic fields for XSS", () => {
    const malicious =
      '<script>alert(1)</script>"\'&' + "path" + String.fromCharCode(0x202e);
    const html = renderWorkbenchNotServedPage({
      workbenchDistEnv: malicious,
      indexHtmlExists: false,
      serverVersion: malicious,
      instanceId: malicious,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&#39;");
    expect(html).toContain("&amp;");
  });

  test("diagnostics use <unset> label when workbenchDistEnv is undefined", () => {
    const html = renderWorkbenchNotServedPage({
      workbenchDistEnv: undefined,
      indexHtmlExists: false,
      serverVersion: "0.9.0",
      instanceId: "(default)",
    });
    expect(html).toContain("NAUTILO_WORKBENCH_DIST");
    expect(html).toContain("&lt;unset&gt;");
    expect(html).toContain("dist/index.html");
    expect(html).toContain("missing");
  });

  test("diagnostics show real path when workbenchDistEnv is set", () => {
    const html = renderWorkbenchNotServedPage({
      workbenchDistEnv: "/opt/nautilo/workbench/dist",
      indexHtmlExists: true,
      serverVersion: "1.0.0",
      instanceId: "prod",
    });
    expect(html).toContain("/opt/nautilo/workbench/dist");
    expect(html).not.toContain("&lt;unset&gt;");
    expect(html).toContain("present");
  });

  test("zero external resource URLs (no remote img/link)", () => {
    const html = renderWorkbenchNotServedPage({
      workbenchDistEnv: undefined,
      indexHtmlExists: false,
      serverVersion: "0.1.0",
      instanceId: "x",
    });
    expect(html.toLowerCase()).not.toMatch(/<img[^>]+src=["']https?:\/\//i);
    expect(html.toLowerCase()).not.toMatch(/<link[^>]+href=["']https?:\/\//i);
  });

  test("does not embed bare Fastify 404 JSON phrase (D161 pin coupling)", () => {
    const html = renderWorkbenchNotServedPage({
      workbenchDistEnv: "/tmp",
      indexHtmlExists: false,
      serverVersion: "0.1.0",
      instanceId: "local",
    });
    const headAndBody = html.split("<details")[0] ?? html;
    expect(headAndBody.includes("Route GET:/ not found")).toBe(false);
  });
});
