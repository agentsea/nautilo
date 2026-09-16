import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  buildSharedBrowserViewerPdfFixture,
  SHARED_BROWSER_VIEWER_PDF_FIXTURE_ID,
  SHARED_BROWSER_VIEWER_PDF_FIXTURE_PAGE_COUNT,
  SHARED_BROWSER_VIEWER_PDF_FIXTURE_SHA256,
} from "./shared-browser-viewer-pdf-fixture";

const mobileRoot = new URL("../../", import.meta.url);

describe("shared browser viewer PDF qualification", () => {
  test("builds the same ASCII one-page fixture with its declared hash", () => {
    const fixture = buildSharedBrowserViewerPdfFixture();
    expect(new TextDecoder().decode(fixture)).toMatch(/^%PDF-1\.4\n/);
    expect(new TextDecoder().decode(fixture)).toContain("/Count 1");
    expect([...fixture].every((byte) => byte === 10 || (byte >= 32 && byte <= 126))).toBe(true);
    expect(createHash("sha256").update(fixture).digest("hex")).toBe(SHARED_BROWSER_VIEWER_PDF_FIXTURE_SHA256);
    expect(SHARED_BROWSER_VIEWER_PDF_FIXTURE_ID).toBe("nautilo.shared-browser-viewer.pdf-fixture.v1");
    expect(SHARED_BROWSER_VIEWER_PDF_FIXTURE_PAGE_COUNT).toBe(1);
  });

  test("keeps the browser renderer source out of the native facade", async () => {
    const native = await Bun.file(new URL("src/components/shared-browser-viewer-pdf-qualification.native.tsx", mobileRoot)).text();
    const web = await Bun.file(new URL("src/components/shared-browser-viewer-pdf-qualification.web.tsx", mobileRoot)).text();
    expect(native).not.toMatch(/pdfjs|browser-document-viewer|Worker|window|document/i);
    expect(web).toContain('import("@nautilo/browser-document-viewer/pdf/renderer")');
    expect(web).toContain('import("@/lib/shared-browser-viewer-runtime/pdf-qualification.web")');
  });

  test("keeps the Chromium observation raw, in-memory, and outside product qualification", async () => {
    const web = await Bun.file(new URL("src/components/shared-browser-viewer-pdf-qualification.web.tsx", mobileRoot)).text();
    expect(web).toContain('"nautilo.shared-browser-viewer-pdf-observation.v1"');
    expect(web).toContain("physical: false");
    expect(web).toContain("eligible: false");
    expect(web).toContain('["non-physical-runtime", "in-memory-fixture"]');
    expect(web).toContain('acquisition: { status: "not-observed", reason: "in-memory-fixture" }');
    expect(web).toContain("Run Chromium observation");
    expect(web).toContain("shared-browser-viewer-pdf-observation-json");
    expect(web).toContain("rotation: 90");
    expect(web).toContain("cancellationAtRenderingStatus: true");
    expect(web).not.toContain("cancellationAfterRendering");
    expect(web).toContain("corruptFixtureParserFailure: true");
    expect(web).toContain("PDF_QUALIFICATION_POST_CLOSE_OBSERVATION_WAIT_MS");
    expect(web).toContain('setObservationJson("");');
    expect(web).toContain("const releaseActiveQualification = useCallback");
    expect(web).toContain("releaseActiveQualification();\n  }, [releaseActiveQualification]);");
    expect(web).toContain('cleanup("Preparing PDF fixture qualification render…");');
    expect(web).toContain('onPress={() => cleanup("PDF fixture qualification cleanup completed.")}');
    expect(web).toContain("replacementCanvas");
    expect(web).toContain('expectedSafeErrors: ["Document preview failed."]');
    expect(web).toContain("errors: []");
    expect(web).toContain('redirect: "error"');
    expect(web).toContain("function matrixRunOwner(run: MatrixRun)");
    expect(web).toContain("run.close();");
    expect(web).toContain("run.cleanup();");
    expect(web).not.toMatch(/sharedBrowserViewerQualificationEligibility|sharedBrowserViewerAvailability|redirectMode|content-length|authorized acquisition/i);
  });
});
