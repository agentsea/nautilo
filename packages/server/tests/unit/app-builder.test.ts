import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAgentToolModuleSource } from "../../src/apps/app-agent-tool-build";
import { TEST_MINI_APP_MANIFEST } from "../helpers/test-mini-app-manifest";
import { buildMiniApp } from "../../src/apps/app-builder";
import { computeAppSourceHash, scanInstalledApps } from "../../src/apps/app-registry";
import { seedFirstPartyApps } from "../../src/apps/seed-first-party-apps";

const FIRST_PARTY_ROOT = join(import.meta.dirname, "../../../../packages/first-party-apps");

let appsRoot = "";

afterEach(async () => {
  if (appsRoot) {
    await rm(appsRoot, { recursive: true, force: true });
    appsRoot = "";
  }
});

async function makeAppsRoot(): Promise<string> {
  appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-builder-"));
  return appsRoot;
}

function testCanvasApp(apps: Awaited<ReturnType<typeof scanInstalledApps>>) {
  const app = apps.find((entry) => entry.id === "test-canvas");
  if (!app) throw new Error("expected seeded test-canvas app");
  return app;
}

function designApp(apps: Awaited<ReturnType<typeof scanInstalledApps>>) {
  const app = apps.find((entry) => entry.id === "nautilo-design");
  if (!app) throw new Error("expected seeded Nautilo Design app");
  return app;
}

function writerApp(apps: Awaited<ReturnType<typeof scanInstalledApps>>) {
  const app = apps.find((entry) => entry.id === "nautilo-writer");
  if (!app) throw new Error("expected seeded Nautilo Writer app");
  return app;
}

function videoApp(apps: Awaited<ReturnType<typeof scanInstalledApps>>) {
  const app = apps.find((entry) => entry.id === "nautilo-video");
  if (!app) throw new Error("expected seeded nautilo-video app");
  return app;
}

async function writeReadyTestApp(root: string): Promise<void> {
  const appDir = join(root, "test-canvas");
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "app.json"), `${JSON.stringify(TEST_MINI_APP_MANIFEST, null, 2)}\n`);
  await writeFile(
    join(appDir, "main.ts"),
    `const root = document.getElementById("app");\nif (root) root.textContent = "ok";\n`,
  );
  await writeFile(
    join(appDir, "index.html"),
    `<!DOCTYPE html><html><body><div id="app"></div></body></html>\n`,
  );
  await writeFile(join(appDir, "styles.css"), `#app { color: blue; }\n`);
  await writeFile(
    join(appDir, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  await writeFile(
    join(appDir, "agent-tools.ts"),
    `export function createFile() { return { ok: true }; }
export function inspectDocument() { return { ok: true }; }
export function setCells() { return { ok: true }; }
`,
  );
}

async function writeReadyTestAppWithoutAgentTools(root: string): Promise<void> {
  await writeReadyTestApp(root);
  const appDir = join(root, "test-canvas");
  await writeFile(
    join(appDir, "app.json"),
    `${JSON.stringify(
      {
        ...TEST_MINI_APP_MANIFEST,
        agent: {
          contextProvider: "testCanvas.activeContext",
        },
      },
      null,
      2,
    )}\n`,
  );
}

describe("buildMiniApp", () => {
  test("needs_dependencies app returns clean non-build result", async () => {
    const root = await makeAppsRoot();
    await writeReadyTestApp(root);
    await writeFile(
      join(root, "test-canvas", "package.json"),
      `${JSON.stringify(
        { private: true, type: "module", dependencies: { lodash: "^4.0.0" } },
        null,
        2,
      )}\n`,
    );
    const [app] = await scanInstalledApps(root);
    const result = await buildMiniApp(app!, root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe("needs_dependencies");
    expect(result.message).toBe("App dependencies are not installed.");
    expect(result.message).not.toContain(root);
  });

  test("invalid_manifest app returns invalid_manifest without building", async () => {
    const root = await makeAppsRoot();
    const appDir = join(root, "test-canvas");
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, "app.json"),
      `${JSON.stringify({ ...TEST_MINI_APP_MANIFEST, id: "BAD" }, null, 2)}\n`,
    );
    const [app] = await scanInstalledApps(root);
    const result = await buildMiniApp(app!, root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe("invalid_manifest");
    let statError: unknown;
    try {
      await stat(join(root, ".cache"));
    } catch (err) {
      statError = err;
    }
    expect(statError).toBeInstanceOf(Error);
  });

  test("invalid_manifest app error is sanitized before returning to route callers", async () => {
    const root = await makeAppsRoot();
    const appDir = join(root, "test-canvas");
    const result = await buildMiniApp(
      {
        id: "test-canvas",
        root: appDir,
        manifest: null,
        status: "invalid_manifest",
        sourceHash: null,
        installedAt: null,
        enabled: true,
        error: `failed to read app.json at ${join(appDir, "app.json")}`,
      },
      root,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe("invalid_manifest");
    expect(result.message).not.toContain(root);
    expect(result.message).toContain("<path>");
  });

  test("writes bundle only under appsRoot/.cache/<appId>/<sourceHash>/", async () => {
    const root = await makeAppsRoot();
    await writeReadyTestApp(root);
    const app = testCanvasApp(await scanInstalledApps(root));
    const result = await buildMiniApp(app, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.cacheDir).toBe(join(root, ".cache", "test-canvas", result.sourceHash));
    const cacheEntries = await readdir(result.cacheDir);
    expect(cacheEntries.some((name) => name.endsWith(".js"))).toBe(true);

    const appDirEntries = await readdir(join(root, "test-canvas"));
    expect(appDirEntries).not.toContain("main.js");
    expect(appDirEntries).not.toContain("dist");
  });

  test("cache path is deterministic for unchanged source", async () => {
    const root = await makeAppsRoot();
    await writeReadyTestApp(root);
    const app = testCanvasApp(await scanInstalledApps(root));
    const first = await buildMiniApp(app, root);
    const second = await buildMiniApp(app, root);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.cacheDir).toBe(second.cacheDir);
    expect(first.sourceHash).toBe(second.sourceHash);
  });

  test("unsafe manifest entry path returns sanitized build_failed", async () => {
    const root = await makeAppsRoot();
    await writeReadyTestApp(root);
    const appDir = join(root, "test-canvas");
    const sourceHash = await computeAppSourceHash(appDir);
    const crafted = {
      id: "test-canvas",
      root: appDir,
      manifest: { ...TEST_MINI_APP_MANIFEST, entry: "../escape.ts" },
      status: "ready" as const,
      sourceHash,
      installedAt: null,
      enabled: true,
    };
    const result = await buildMiniApp(crafted, root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe("build_failed");
    expect(result.message).not.toContain(root);
    expect(result.message).not.toContain("test-canvas");
  });

  test("missing html file returns sanitized build_failed", async () => {
    const root = await makeAppsRoot();
    await writeReadyTestApp(root);
    await writeFile(
      join(root, "test-canvas", "app.json"),
      `${JSON.stringify({ ...TEST_MINI_APP_MANIFEST, html: "./missing.html" }, null, 2)}\n`,
    );
    const [app] = await scanInstalledApps(root);
    const result = await buildMiniApp(app!, root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe("build_failed");
    expect(result.message).not.toContain(root);
  });

  test("ready test app builds html styles and bundle", async () => {
    const root = await makeAppsRoot();
    await writeReadyTestApp(root);
    const app = testCanvasApp(await scanInstalledApps(root));
    const result = await buildMiniApp(app, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('id="app"');
    expect(result.styles.length).toBeGreaterThanOrEqual(1);
    expect(result.styles.some((s) => s.content.includes("#app"))).toBe(true);
    expect(result.bundleJs.length).toBeGreaterThan(0);
    expect(result.bundleJs).not.toContain(root);
    expect(result.bundleJs).not.toContain("sourceMappingURL");
    expect(result.sourceHash).toBe(await computeAppSourceHash(join(root, "test-canvas")));
  });

  test("ready seeded Nautilo Design builds html styles and bundle", async () => {
    const root = await makeAppsRoot();
    await seedFirstPartyApps({
      appsRoot: root,
      sourceRoot: FIRST_PARTY_ROOT,
      appIds: ["nautilo-design"],
    });
    const app = designApp(await scanInstalledApps(root));
    const result = await buildMiniApp(app, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.html).toContain('id="app"');
    expect(result.styles.some((style) => style.content.includes(".design-app"))).toBe(true);
    expect(result.bundleJs.length).toBeGreaterThan(0);
    expect(result.bundleJs).not.toContain(root);
    expect(result.sourceHash).toBe(await computeAppSourceHash(join(root, "nautilo-design")));
    expect(result.agentToolsBuild.status).toBe("ok");
    if (result.agentToolsBuild.status !== "ok") return;
    expect(result.agentToolsBuild.toolNames).toContain(
      "app_nautilo_design__create_file",
    );
    expect(result.agentToolsBuild.toolNames).toContain(
      "app_nautilo_design__inspect_open_design",
    );
    expect(result.agentToolsBuild.toolNames).toContain(
      "app_nautilo_design__edit_open_design",
    );
    const toolBundle = await stat(join(result.cacheDir, "agent-tools.mjs"));
    expect(toolBundle.isFile()).toBe(true);
  });

  test("ready seeded Nautilo Writer builds standalone browser and agent bundles", async () => {
    const root = await makeAppsRoot();
    await seedFirstPartyApps({ appsRoot: root, sourceRoot: FIRST_PARTY_ROOT, appIds: ["nautilo-writer"] });
    const app = writerApp(await scanInstalledApps(root));
    const result = await buildMiniApp(app, root);
    expect(result.ok, result.ok ? undefined : result.message).toBe(true);
    if (!result.ok) return;

    expect(result.html).toContain('id="app"');
    expect(result.styles.some((style) => style.content.includes(".writer-app"))).toBe(true);
    expect(result.bundleJs.length).toBeGreaterThan(0);
    expect(result.bundleJs).not.toContain(root);
    expect(result.sourceHash).toBe(await computeAppSourceHash(join(root, "nautilo-writer")));
    expect(result.agentToolsBuild.status, result.agentToolsBuild.status === "failed" ? result.agentToolsBuild.message : undefined).toBe("ok");
    if (result.agentToolsBuild.status !== "ok") return;
    expect(result.agentToolsBuild.toolNames).toContain("app_nautilo_writer__edit_open_writer");
    expect(result.agentToolsBuild.toolNames).toContain("app_nautilo_writer__inspect_document");
    expect((await stat(join(result.cacheDir, "agent-tools.mjs"))).isFile()).toBe(true);
  });

  test("ready seeded Video builds html styles and bundle", async () => {
    const root = await makeAppsRoot();
    await seedFirstPartyApps({
      appsRoot: root,
      sourceRoot: FIRST_PARTY_ROOT,
      appIds: ["nautilo-video"],
    });
    const app = videoApp(await scanInstalledApps(root));
    const result = await buildMiniApp(app, root);
    expect(result.ok, result.ok ? undefined : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('id="app"');
    expect(result.styles.some((style) => style.content.includes(".video-app"))).toBe(true);
    expect(result.bundleJs.length).toBeGreaterThan(0);
    expect(result.bundleJs).not.toContain(root);
    expect(result.sourceHash).toBe(await computeAppSourceHash(join(root, "nautilo-video")));
    expect(result.agentToolsBuild.status, result.agentToolsBuild.status === "failed" ? result.agentToolsBuild.message : undefined).toBe("ok");
    if (result.agentToolsBuild.status !== "ok") return;
    expect(result.agentToolsBuild.toolNames).toContain("app_nautilo_video__manage_video_media");
    expect(result.agentToolsBuild.toolNames).toContain("app_nautilo_video__review_generation");
    expect((await stat(join(result.cacheDir, "agent-tools.mjs"))).isFile()).toBe(true);
  });

  test("source hash changes when main.ts changes", async () => {
    const root = await makeAppsRoot();
    await writeReadyTestApp(root);
    const appDir = join(root, "test-canvas");
    const beforeHash = await computeAppSourceHash(appDir);
    await writeFile(join(appDir, "main.ts"), "export const changed = 1;\n");
    const afterHash = await computeAppSourceHash(appDir);
    expect(afterHash).not.toBe(beforeHash);
  });

  test(".nautilo-seed.json does not affect source hash", async () => {
    const root = await makeAppsRoot();
    await writeReadyTestApp(root);
    const appDir = join(root, "test-canvas");
    const before = await computeAppSourceHash(appDir);
    await writeFile(join(appDir, ".nautilo-seed.json"), '{"seeded":true}\n');
    const after = await computeAppSourceHash(appDir);
    expect(after).toBe(before);
  });

  test("dependency-free paint-demo fixture builds runtime without path leaks", async () => {
    const root = await makeAppsRoot();
    const appDir = join(root, "paint-demo");
    await mkdir(join(appDir, "templates"), { recursive: true });
    await writeFile(
      join(appDir, "app.json"),
      `${JSON.stringify(
        {
          id: "paint-demo",
          name: "Paint Demo",
          version: "0.1.0",
          entry: "./main.ts",
          html: "./index.html",
          styles: ["./styles.css"],
          fileAssociations: { extensions: [], mimeTypes: [] },
          capabilities: {
            document: { artifact: "readwrite" },
            state: "readwrite",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(appDir, "index.html"),
      `<!DOCTYPE html><html><body><canvas id="paint-canvas"></canvas></body></html>\n`,
    );
    await writeFile(
      join(appDir, "main.ts"),
      `const canvas = document.getElementById("paint-canvas");\nif (canvas) canvas.getContext("2d");\n`,
    );
    await writeFile(join(appDir, "styles.css"), `#paint-canvas { border: 1px solid #ccc; }\n`);
    await writeFile(
      join(appDir, "templates", "blank-paint.html"),
      `<!DOCTYPE html><html><body></body></html>\n`,
    );

    const [app] = await scanInstalledApps(root);
    const result = await buildMiniApp(app!, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain("paint-canvas");
    expect(result.bundleJs).not.toContain(root);
  });
});

const VALID_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    filename: { type: "string" },
  },
  required: ["filename"],
} as const;

const SAMPLE_AGENT_TOOLS = [
  {
    id: "create-file",
    description: "Create a test document",
    runtime: "server" as const,
    module: "./agent-tools.ts",
    handler: "createFile",
    inputSchema: VALID_TOOL_INPUT_SCHEMA,
    impact: "high" as const,
    requiredCapability: "use_project_content" as const,
  },
  {
    id: "inspect-document",
    description: "Inspect a test document",
    runtime: "server" as const,
    module: "./agent-tools.ts",
    handler: "inspectDocument",
    inputSchema: VALID_TOOL_INPUT_SCHEMA,
    impact: "read-only" as const,
    requiredCapability: null,
  },
  {
    id: "set-cells",
    description: "Update bounded canvas items",
    runtime: "server" as const,
    module: "./agent-tools.ts",
    handler: "setCells",
    inputSchema: VALID_TOOL_INPUT_SCHEMA,
    impact: "high" as const,
    requiredCapability: "use_project_content" as const,
  },
];

async function writeReadyTestAppWithAgentTools(root: string, agentToolsSource: string): Promise<void> {
  await writeReadyTestApp(root);
  await writeFile(
    join(root, "test-canvas", "app.json"),
    `${JSON.stringify(
      {
        ...TEST_MINI_APP_MANIFEST,
        agent: {
          contextProvider: "testCanvas.activeContext",
          tools: SAMPLE_AGENT_TOOLS,
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, "test-canvas", "agent-tools.ts"), agentToolsSource);
}

describe("agent tool bundle build", () => {
  test("app with no agent.tools does not build a tool bundle", async () => {
    const root = await makeAppsRoot();
    await writeReadyTestAppWithoutAgentTools(root);
    const [app] = await scanInstalledApps(root);
    const result = await buildMiniApp(app!, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentToolsBuild).toEqual({ status: "none" });
    let statError: unknown;
    try {
      await stat(join(result.cacheDir, "agent-tools.mjs"));
    } catch (err) {
      statError = err;
    }
    expect(statError).toBeInstanceOf(Error);
  });

  test("app with agent.tools builds agent-tools.mjs under cache", async () => {
    const root = await makeAppsRoot();
    await writeReadyTestAppWithAgentTools(
      root,
      `export function createFile() { return { ok: true }; }
export function inspectDocument() { return { ok: true }; }
export function setCells() { return { ok: true }; }
`,
    );
    const [app] = await scanInstalledApps(root);
    const result = await buildMiniApp(app!, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentToolsBuild.status).toBe("ok");
    if (result.agentToolsBuild.status !== "ok") return;
    expect(result.agentToolsBuild.outputFile).toBe("agent-tools.mjs");
    expect(result.agentToolsBuild.toolCount).toBe(3);
    expect(result.agentToolsBuild.toolNames).toEqual([
      "app_test_canvas__create_file",
      "app_test_canvas__inspect_document",
      "app_test_canvas__set_cells",
    ]);
    const bundleStat = await stat(join(result.cacheDir, "agent-tools.mjs"));
    expect(bundleStat.isFile()).toBe(true);
  });

  test("forbidden import fails agent tool build but UI runtime still builds", async () => {
    const root = await makeAppsRoot();
    await writeReadyTestAppWithAgentTools(
      root,
      `import fs from "node:fs";
export function createFile() { return fs; }
export function inspectDocument() { return { ok: true }; }
export function setCells() { return { ok: true }; }
`,
    );
    const [app] = await scanInstalledApps(root);
    const result = await buildMiniApp(app!, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundleJs.length).toBeGreaterThan(0);
    expect(result.agentToolsBuild.status).toBe("failed");
    if (result.agentToolsBuild.status === "failed") {
      expect(result.agentToolsBuild.message).toContain("forbidden import");
      expect(result.agentToolsBuild.message).not.toContain(root);
    }
  });

  test("forbidden import in local dependency fails agent tool build", async () => {
    const root = await makeAppsRoot();
    await writeReadyTestAppWithAgentTools(
      root,
      `import { secret } from "./helper";
export function createFile() { return secret; }
export function inspectDocument() { return { ok: true }; }
export function setCells() { return { ok: true }; }
`,
    );
    await writeFile(join(root, "test-canvas", "helper.ts"), `import fs from "node:fs";\nexport const secret = fs;\n`);
    const [app] = await scanInstalledApps(root);
    const result = await buildMiniApp(app!, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentToolsBuild.status).toBe("failed");
    if (result.agentToolsBuild.status === "failed") {
      expect(result.agentToolsBuild.message).toContain("forbidden import");
      expect(result.agentToolsBuild.message).not.toContain(root);
    }
  });

  test("validateAgentToolModuleSource accepts ANTLR-shaped fetch methods", () => {
    const source = `
class BufferedTokenStream {
  fetch(n: number) { return n; }
  sync(n: number) { return this.fetch(n); }
}
`;
    expect(validateAgentToolModuleSource(source, "./antlr-runtime.ts")).toBeNull();
  });

  test("validateAgentToolModuleSource rejects process.env and ambient fetch access", () => {
    expect(validateAgentToolModuleSource("const x = process.env.API_KEY;", "./agent-tools.ts")).toContain(
      "process.env",
    );
    for (const source of [
      "await fetch('https://example.com');",
      "await globalThis.fetch('https://example.com');",
      "await window.fetch('https://example.com');",
      "const request = fetch; await request('https://example.com');",
    ]) {
      expect(validateAgentToolModuleSource(source, "./agent-tools.ts")).toContain("fetch");
    }
  });
});
