import { describe, expect, test } from "bun:test";
import type { PublicMiniAppDto } from "../../src/apps/app-routes";
import {
  appsDetailWeakETagFromProjection,
  appsListWeakETagFromProjection,
  canonicalAppsListProjectionForHash,
} from "../../src/apps/apps-conditional-http";

function sampleApp(overrides: Partial<PublicMiniAppDto> = {}): PublicMiniAppDto {
  return {
    id: "test-canvas",
    name: "Test Canvas",
    description: "Neutral document fixture",
    display: null,
    version: "0.1.0",
    status: "ready",
    installedAt: "2026-01-01T00:00:00.000Z",
    sourceHash: "abc123def4567890abc123def4567890abc123def4567890abc123def4567890",
    enabled: true,
    fileAssociations: null,
    createActions: [{
      id: "new-spreadsheet",
      label: "New spreadsheet",
      defaultFilename: "spreadsheet.html",
      mimeType: "text/html",
      targetSurfaces: ["workspace"],
      template: { kind: "file", path: "t.html" },
    }],
    contentAssociations: null,
    conversions: null,
    agentToolsDeclared: true,
    canEditSource: false,
    ...overrides,
  };
}

describe("appsListWeakETagFromProjection (M213 Phase 8/9)", () => {
  test("ETag is opaque weak W/\"base64url\" with no plain app or capability tokens", () => {
    const etag = appsListWeakETagFromProjection(0, { apps: [sampleApp()] });
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(etag).not.toContain("test-canvas");
    expect(etag).not.toContain("manage_server_settings");
    expect(etag).not.toContain("abc123");
  });

  test("stable across permuted list order (hash-only sort)", () => {
    const a = { apps: [sampleApp({ id: "z-app" }), sampleApp({ id: "a-app" })] };
    const b = { apps: [sampleApp({ id: "a-app" }), sampleApp({ id: "z-app" })] };
    expect(appsListWeakETagFromProjection(1, a)).toBe(appsListWeakETagFromProjection(1, b));
    expect(a.apps[0]?.id).toBe("z-app");
    expect(b.apps[0]?.id).toBe("a-app");
  });

  test("changes when registry generation changes", () => {
    const body = { apps: [sampleApp()] };
    expect(appsListWeakETagFromProjection(0, body)).not.toBe(
      appsListWeakETagFromProjection(1, body),
    );
  });

  test("changes when authorized projection changes (canEditSource)", () => {
    const base = { apps: [sampleApp()] };
    const baseEtag = appsListWeakETagFromProjection(0, base);
    expect(
      appsListWeakETagFromProjection(0, {
        apps: [sampleApp({ canEditSource: true })],
      }),
    ).not.toBe(baseEtag);
  });

  test("canonicalAppsListProjectionForHash does not mutate the live body", () => {
    const body = {
      apps: [sampleApp({ id: "z-app" }), sampleApp({ id: "a-app" })],
    };
    const idsBefore = body.apps.map((app) => app.id);
    canonicalAppsListProjectionForHash(body);
    expect(body.apps.map((app) => app.id)).toEqual(idsBefore);
  });
});

describe("appsDetailWeakETagFromProjection (M213 Phase 8/9)", () => {
  test("changes when registry generation or authorized detail projection changes", () => {
    const app = sampleApp();
    const baseEtag = appsDetailWeakETagFromProjection(0, app);
    expect(appsDetailWeakETagFromProjection(1, app)).not.toBe(baseEtag);
    expect(appsDetailWeakETagFromProjection(0, { ...app, enabled: false })).not.toBe(baseEtag);
    expect(appsDetailWeakETagFromProjection(0, { ...app, canEditSource: true })).not.toBe(
      baseEtag,
    );
  });
});
