import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { buildCsp, HTML_VIEWER_CDN_HOSTS } from "../../../src/viewers/html/csp";
import { buildSrcdoc } from "../../../src/viewers/html/srcdoc";

const EXPECTED_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://esm.sh https://cdnjs.cloudflare.com https://d3js.org https://ajax.googleapis.com; style-src 'unsafe-inline'; img-src data: blob: https://cdn.jsdelivr.net https://unpkg.com https://esm.sh https://cdnjs.cloudflare.com https://d3js.org https://ajax.googleapis.com; font-src data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

let nextBlob: Blob = new Blob(["<p>ok</p>"], { type: "text/html" });
const bytesMock = mock(async () => nextBlob);

mock.module("../../../src/lib/api", () => ({
  apiClient: {
    getWorkspaceArtifactBytes: bytesMock,
  },
}));

const statMock = mock(async () => ({ exists: true, size: 100 }));
const readFileMock = mock(async () => "<p>fs</p>");

mock.module("../../../src/lib/desktop", () => ({
  isDesktop: true,
  desktopAPI: {
    fs: {
      stat: statMock,
      readFile: readFileMock,
    },
  },
  // Stack 19 Phase 6.9.6 fix: partial mocks of lib/desktop omit Stack
  // 19's new runtime exports under Bun's mock-hoisting → other tests
  // importing them get `Export named 'X' not found`. Stubs MUST
  // call-through to `window.nautiloDesktop` (see forgot-password
  // sibling for full rationale).
  getShellStateOnBoot: () => {
    if (typeof window === "undefined") return null;
    const api = (window as unknown as { nautiloDesktop?: { shellStateOnBoot?: () => unknown } }).nautiloDesktop;
    if (!api?.shellStateOnBoot) return null;
    try { return api.shellStateOnBoot() ?? null; } catch { return null; }
  },
  computeInitialLastOpenAtSeed: (input: { hasEverBeenOpen: boolean; shellStateOnBoot: unknown; now: number }) => {
    const base = input.hasEverBeenOpen ? input.now : null;
    if (input.shellStateOnBoot != null && input.shellStateOnBoot !== "live" && base === null) return input.now;
    return base;
  },
}));

const { htmlViewerAdapter, HTML_VIEWER_MAX_BYTES } = await import("../../../src/viewers/html/adapter");

describe("htmlViewerAdapter canView", () => {
  test("artifact: text/html and application/xhtml+xml", () => {
    expect(
      htmlViewerAdapter.canView({
        kind: "artifact",
        id: "1",
        path: "x.bin",
        mimeType: "text/html",
      }),
    ).toBe(true);
    expect(
      htmlViewerAdapter.canView({
        kind: "artifact",
        id: "1",
        path: "x.bin",
        mimeType: "application/xhtml+xml",
      }),
    ).toBe(true);
  });

  test("artifact: path suffix when mime is not HTML", () => {
    expect(
      htmlViewerAdapter.canView({
        kind: "artifact",
        id: "1",
        path: "deck.nwx.html",
        mimeType: "application/octet-stream",
      }),
    ).toBe(true);
  });

  test("fs: .html .htm .nwx.html", () => {
    expect(htmlViewerAdapter.canView({ kind: "fs", path: "/w/a.html", rootPath: "/w" })).toBe(true);
    expect(htmlViewerAdapter.canView({ kind: "fs", path: "/w/a.htm", rootPath: "/w" })).toBe(true);
    expect(htmlViewerAdapter.canView({ kind: "fs", path: "/w/a.nwx.html", rootPath: "/w" })).toBe(true);
  });

  test("rejects non-html", () => {
    expect(htmlViewerAdapter.canView({ kind: "fs", path: "/w/a.txt", rootPath: "/w" })).toBe(false);
    expect(
      htmlViewerAdapter.canView({
        kind: "artifact",
        id: "1",
        path: "x.txt",
        mimeType: "text/plain",
      }),
    ).toBe(false);
  });
});

describe("buildCsp", () => {
  test("returns frozen v1 policy string", () => {
    expect(buildCsp()).toBe(EXPECTED_CSP);
  });

  test("CDN host list matches v1 allowlist", () => {
    expect([...HTML_VIEWER_CDN_HOSTS]).toEqual([
      "cdn.jsdelivr.net",
      "unpkg.com",
      "esm.sh",
      "cdnjs.cloudflare.com",
      "d3js.org",
      "ajax.googleapis.com",
    ]);
  });
});

describe("buildSrcdoc", () => {
  test("wraps body fragment in doctype html and injects CSP meta in head", () => {
    const doc = buildSrcdoc("<p>hi</p>", EXPECTED_CSP);
    expect(doc.toLowerCase().startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("<body><p>hi</p></body>");
  });

  test("injects CSP after <head> for full documents", () => {
    const body = "<!DOCTYPE html><html><head><title>t</title></head><body>x</body></html>";
    const doc = buildSrcdoc(body, "default-src 'none'");
    const lower = doc.toLowerCase();
    const headPos = lower.indexOf("<head");
    const metaPos = lower.indexOf("content-security-policy");
    expect(headPos).toBeGreaterThanOrEqual(0);
    expect(metaPos).toBeGreaterThan(headPos);
  });
});

describe("htmlViewerAdapter load", () => {
  beforeEach(() => {
    bytesMock.mockClear();
    statMock.mockClear();
    readFileMock.mockClear();
    nextBlob = new Blob(["<p>ok</p>"], { type: "text/html" });
  });

  test("artifact over-cap returns too_large (.html)", async () => {
    nextBlob = new Blob([new Uint8Array(HTML_VIEWER_MAX_BYTES + 1)], { type: "text/html" });
    const r = await htmlViewerAdapter.load(
      { kind: "artifact", id: "big", path: "a.html", mimeType: "text/html" },
      { maxTextBytes: 1000 },
    );
    expect(r.kind).toBe("too_large");
    if (r.kind === "too_large") {
      expect(r.sizeBytes).toBeGreaterThan(r.maxBytes);
    }
  });

  test("artifact missing mimeType returns error", async () => {
    const r = await htmlViewerAdapter.load(
      { kind: "artifact", id: "a", path: "f.html" } as never,
      { maxTextBytes: 1000 },
    );
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("Invalid");
  });

  test("invalid kind returns error", async () => {
    const r = await htmlViewerAdapter.load({ kind: "other" } as never, { maxTextBytes: 1000 });
    expect(r.kind).toBe("error");
  });

  test("happy artifact path returns ready srcDoc", async () => {
    const r = await htmlViewerAdapter.load(
      { kind: "artifact", id: "id1", path: "a.html", mimeType: "text/html" },
      { maxTextBytes: 1000 },
    );
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      const srcDoc = (r.data as { srcDoc: string }).srcDoc;
      expect(srcDoc.toLowerCase()).toContain("<!doctype html>");
      expect(srcDoc).toContain('<script type="module">');
    }
  });
});

afterAll(() => {
  mock.restore();
});
