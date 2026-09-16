import { describe, expect, test } from "bun:test";
import type { MiniAppManifest } from "../../src/apps/app-manifest";
import type { RegisteredMiniApp } from "../../src/apps/app-registry";
import type { SuccessfulMiniAppBuild } from "../../src/apps/app-builder";
import { resolveFirstPartyHostCapabilities } from "../../src/apps/first-party-host-capabilities";

const manifest = {
  id: "nautilo-video",
  name: "Nautilo Video",
  version: "0.1.0",
  entry: "./main.ts",
  html: "./index.html",
  styles: ["./styles.css"],
  fileAssociations: { extensions: [".video.html"], mimeTypes: ["text/html"] },
  capabilities: {},
} as unknown as MiniAppManifest;

function app(id = "nautilo-video"): RegisteredMiniApp {
  return { id, root: `/apps/${id}`, manifest: { ...manifest, id }, status: "ready", sourceHash: "a".repeat(64), installedAt: null, enabled: true };
}

function build(bundleJs = "trusted", id = "nautilo-video"): SuccessfulMiniAppBuild {
  return {
    ok: true,
    appId: id,
    sourceHash: "a".repeat(64),
    appRoot: `/apps/${id}`,
    cacheDir: `/apps/${id}/.cache`,
    html: "<main></main>",
    styles: [{ path: "styles.css", content: "main{}" }],
    bundleJs,
    manifest: { ...manifest, id },
    agentToolsBuild: { status: "none" },
  };
}

describe("first-party host capability attestation", () => {
  test("grants raster access only for exact shipped runtime bytes", async () => {
    const canonical = app();
    const granted = await resolveFirstPartyHostCapabilities(app(), build(), {
      sourceRoot: "/source",
      scanApps: async () => [canonical],
      buildApp: async () => build(),
    });
    expect(granted).toEqual({ assetReadRaster: true, mediaProxy: true, videoGeneration: true });

    const altered = await resolveFirstPartyHostCapabilities(app(), build("altered"), {
      sourceRoot: "/source",
      scanApps: async () => [canonical],
      buildApp: async () => build(),
    });
    expect(altered).toBeUndefined();
  });

  test("an app id, manifest, or seed-like installation cannot self-grant", async () => {
    expect(await resolveFirstPartyHostCapabilities(app("third-party-video"), build("trusted", "third-party-video"), {
      scanApps: async () => [app("third-party-video")],
      buildApp: async () => build("trusted", "third-party-video"),
    })).toBeUndefined();

    expect(await resolveFirstPartyHostCapabilities({ ...app(), enabled: false }, build(), {
      scanApps: async () => [app()],
      buildApp: async () => build(),
    })).toBeUndefined();
  });
});
