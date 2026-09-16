import { describe, expect, test } from "bun:test";
import { buildMiniAppRuntimeSrcDoc } from "../../src/apps/app-runtime-html";

/**
 * D377 spike: CanvasKit is a browser WASM renderer. This test intentionally
 * does not import CanvasKit itself; it probes the two platform properties a
 * CanvasKit-backed mini-app would need from Nautilo's runtime:
 *
 * 1. CSP permission to instantiate WebAssembly.
 * 2. A first-class way to locate binary assets such as canvaskit.wasm.
 *
 * Today the runtime is a strict srcdoc bundle with no app asset route/profile,
 * so the expected result is "not CanvasKit-ready yet." This is a guardrail for
 * future work: when we add a first-party WASM/canvas profile, update this test
 * alongside the implementation.
 */
describe("CanvasKit mini-app runtime spike", () => {
  test("current mini-app srcdoc policy is not first-class WASM/CanvasKit ready", () => {
    const wasmProbe = `
      const minimalWasm = new Uint8Array([
        0x00, 0x61, 0x73, 0x6d,
        0x01, 0x00, 0x00, 0x00
      ]);
      await WebAssembly.compile(minimalWasm);
      document.body.dataset.wasm = "ok";
    `;

    const srcDoc = buildMiniAppRuntimeSrcDoc({
      appId: "canvaskit-spike",
      html: `<canvas id="surface"></canvas>`,
      styles: [],
      bundleJs: wasmProbe,
    });

    expect(srcDoc).toContain("WebAssembly.compile");
    expect(srcDoc).toContain("Content-Security-Policy");
    expect(srcDoc).toContain("script-src 'unsafe-inline'");
    expect(srcDoc).not.toContain("wasm-unsafe-eval");
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).not.toContain("canvaskit.wasm");
    expect(srcDoc).not.toContain("/api/apps/canvaskit-spike/assets/");
  });

  test("Bun itself can compile the minimal WASM probe used by the spike", () => {
    const minimalWasm = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d,
      0x01, 0x00, 0x00, 0x00,
    ]);

    expect(new WebAssembly.Module(minimalWasm)).toBeInstanceOf(WebAssembly.Module);
  });
});
