import { describe, expect, test } from "bun:test";
import { buildMiniAppRuntimeSrcDoc } from "../../src/apps/app-runtime-html";

describe("buildMiniAppRuntimeSrcDoc", () => {
  test("Video admits host-issued media schemes for playback and waveform decoding without network access", () => {
    const html = buildMiniAppRuntimeSrcDoc({ appId: "nautilo-video", html: "<div></div>", styles: [], bundleJs: "export {};" });
    expect(html).toContain("media-src nautilo-media: blob:");
    expect(html).toContain("connect-src nautilo-media: blob:");
    expect(html).toContain("img-src data: blob: nautilo-media:");
    expect(html).not.toMatch(/(?:connect-src|media-src)[^;]*(?:https?:|file:|\*)/);
    expect(html).toContain("default-src 'none'");
    const other = buildMiniAppRuntimeSrcDoc({ appId: "other", html: "<div></div>", styles: [], bundleJs: "export {};" });
    expect(other).toContain("connect-src 'none'");
    expect(other).not.toContain("img-src data: blob: nautilo-media:");
  });
  test("wraps fragment into full document with CSP theme bootstrap styles and bundle", () => {
    const srcDoc = buildMiniAppRuntimeSrcDoc({
      appId: "test-canvas",
      html: `<div id="app">hello</div>`,
      styles: [{ path: "./styles.css", content: "#app { color: red; }" }],
      bundleJs: `console.log("bundle");`,
    });

    expect(srcDoc.toLowerCase()).toContain("<!doctype html>");
    expect(srcDoc).toContain("Content-Security-Policy");
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).toContain("media-src nautilo-media:");
    expect(srcDoc).toContain("background:#ffffff");
    expect(srcDoc).toContain("#app { color: red; }");
    expect(srcDoc).toContain('window.nautiloApp=Object.freeze({version:1,appId:"test-canvas"})');
    expect(srcDoc).toContain('<script type="module">');
    expect(srcDoc).toContain('console.log("bundle");');
    expect(srcDoc).toContain('<div id="app">hello</div>');
  });

  test("injects into existing head and preserves authored body", () => {
    const srcDoc = buildMiniAppRuntimeSrcDoc({
      appId: "test-canvas",
      html: `<!DOCTYPE html><html><head><title>App</title></head><body><main>body</main></body></html>`,
      styles: [],
      bundleJs: "export {};",
    });

    expect(srcDoc).toContain("<title>App</title>");
    expect(srcDoc).toContain("<main>body</main>");
    expect(srcDoc).toContain("connect-src 'none'");
  });

  test("escapes </script> in inline bundle source", () => {
    const srcDoc = buildMiniAppRuntimeSrcDoc({
      appId: "test-canvas",
      html: "<div></div>",
      styles: [],
      bundleJs: `const x = "</script><script>alert(1)</script>";`,
    });

    expect(srcDoc).toContain("<\\/script");
    expect(srcDoc).not.toContain(`"</script><script>`);
  });

  test("escapes </style> in declared stylesheet content", () => {
    const srcDoc = buildMiniAppRuntimeSrcDoc({
      appId: "test-canvas",
      html: "<div></div>",
      styles: [{ path: "./styles.css", content: `body::before{content:"</style><script>alert(1)</script>"}` }],
      bundleJs: "export {};",
    });

    expect(srcDoc).toContain("<\\/style>");
    expect(srcDoc).not.toContain("</style><script>alert(1)</script>");
  });

  test("escapes CSP meta attribute safely", () => {
    const srcDoc = buildMiniAppRuntimeSrcDoc({
      appId: "test-canvas",
      html: "<div></div>",
      styles: [],
      bundleJs: "export {};",
    });

    expect(srcDoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).not.toContain('content=<');
  });

  test("generated srcDoc has no builder cache path fields", () => {
    const srcDoc = buildMiniAppRuntimeSrcDoc({
      appId: "test-canvas",
      html: "<div id=\"app\"></div>",
      styles: [{ path: "./styles.css", content: "#app {}" }],
      bundleJs: "export {};",
    });

    expect(srcDoc).not.toContain(".cache/");
    expect(srcDoc).not.toContain("first-party-apps");
  });
});
