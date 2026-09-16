import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_AUTHORING_MAX_FILE_COUNT,
  APP_AUTHORING_MAX_FILE_BYTES,
  AppAuthoringConflictError,
  AppAuthoringManifestError,
  AppAuthoringPayloadError,
  applyMiniAppSourceBatch,
  createMiniAppSource,
  validateMiniAppSource,
} from "../../src/apps/app-authoring-store";
import type { MiniAppManifest } from "../../src/apps/app-manifest";
import { buildMiniApp } from "../../src/apps/app-builder";
import { scanInstalledApps } from "../../src/apps/app-registry";
import {
  AppSourceConflictError,
  AppSourcePathError,
  readAppSourceFile,
} from "../../src/apps/app-source-store";
import {
  clearAppSourceEventListenersForTests,
  subscribeAppSourceEvents,
  type AppSourceEvent,
} from "../../src/apps/app-source-events";

let appsRoot = "";

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export const PAINT_DEMO_MANIFEST: MiniAppManifest = {
  id: "paint-demo",
  name: "Paint Demo",
  version: "0.1.0",
  entry: "./main.ts",
  html: "./index.html",
  styles: ["./styles.css"],
  fileAssociations: {
    extensions: [],
    mimeTypes: [],
  },
  capabilities: {
    document: {
      artifact: "readwrite",
    },
    state: "readwrite",
  },
  createActions: [
    {
      id: "blank-paint",
      label: "Blank Canvas",
      defaultFilename: "canvas.html",
      mimeType: "text/html",
      targetSurfaces: ["workspace"],
      template: {
        kind: "file",
        path: "./templates/blank-paint.html",
      },
    },
  ],
};

export function paintDemoSourceFiles(): Array<{ path: string; content: string }> {
  return [
    {
      path: "app.json",
      content: `${JSON.stringify(PAINT_DEMO_MANIFEST, null, 2)}\n`,
    },
    {
      path: "index.html",
      content: `<!DOCTYPE html><html><body><canvas id="paint-canvas"></canvas></body></html>\n`,
    },
    {
      path: "main.ts",
      content: `const canvas = document.getElementById("paint-canvas") as HTMLCanvasElement | null;
if (canvas) {
  const ctx = canvas.getContext("2d");
  ctx?.fillRect(0, 0, 10, 10);
}
`,
    },
    {
      path: "styles.css",
      content: `#paint-canvas { border: 1px solid #ccc; }\n`,
    },
    {
      path: "templates/blank-paint.html",
      content: `<!DOCTYPE html><html><body><canvas id="doc-canvas"></canvas></body></html>\n`,
    },
  ];
}

async function writeExistingPaintDemo(root: string): Promise<void> {
  const appDir = join(root, "paint-demo");
  await mkdir(join(appDir, "templates"), { recursive: true });
  for (const file of paintDemoSourceFiles()) {
    await writeFile(join(appDir, file.path), file.content);
  }
}

afterEach(async () => {
  clearAppSourceEventListenersForTests();
  if (appsRoot) {
    await rm(appsRoot, { recursive: true, force: true });
    appsRoot = "";
  }
});

describe("app-authoring-store createMiniAppSource", () => {
  test("happy path creates dependency-free paint-demo app as ready", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-authoring-"));
    const result = await createMiniAppSource(appsRoot, {
      appId: "paint-demo",
      files: paintDemoSourceFiles(),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ready");
    expect(result.appId).toBe("paint-demo");
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.filesWritten.length).toBeGreaterThan(0);

    const appStat = await stat(join(appsRoot, "paint-demo"));
    expect(appStat.isDirectory()).toBe(true);
    const manifest = await readFile(join(appsRoot, "paint-demo", "app.json"), "utf8");
    expect(manifest).toContain('"paint-demo"');

    const installed = await scanInstalledApps(appsRoot);
    expect(installed.some((entry) => entry.id === "paint-demo" && entry.status === "ready")).toBe(
      true,
    );
  });

  test("rejects existing app id", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-authoring-"));
    await writeExistingPaintDemo(appsRoot);

    expect(
      createMiniAppSource(appsRoot, {
        appId: "paint-demo",
        files: paintDemoSourceFiles(),
      }),
    ).rejects.toBeInstanceOf(AppAuthoringConflictError);
  });

  test("rejects manifest id mismatch and leaves no app dir", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-authoring-"));
    const files = paintDemoSourceFiles();
    files[0] = {
      path: "app.json",
      content: `${JSON.stringify({ ...PAINT_DEMO_MANIFEST, id: "other-id" }, null, 2)}\n`,
    };

    expect(
      createMiniAppSource(appsRoot, { appId: "paint-demo", files }),
    ).rejects.toBeInstanceOf(AppAuthoringManifestError);

    expect(stat(join(appsRoot, "paint-demo"))).rejects.toThrow();
  });

  test("rejects missing app.json and leaves no app dir", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-authoring-"));
    const files = paintDemoSourceFiles().filter((file) => file.path !== "app.json");

    expect(
      createMiniAppSource(appsRoot, { appId: "paint-demo", files }),
    ).rejects.toBeInstanceOf(AppAuthoringManifestError);

    expect(stat(join(appsRoot, "paint-demo"))).rejects.toThrow();
  });

  test("rejects dependency sections in package.json", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-authoring-"));
    const files = [
      ...paintDemoSourceFiles(),
      {
        path: "package.json",
        content: `${JSON.stringify({ dependencies: { lodash: "^4.0.0" } }, null, 2)}\n`,
      },
    ];

    expect(
      createMiniAppSource(appsRoot, { appId: "paint-demo", files }),
    ).rejects.toBeInstanceOf(AppAuthoringManifestError);

    expect(stat(join(appsRoot, "paint-demo"))).rejects.toThrow();
  });

  test("rejects invalid paths", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-authoring-"));
    const base = paintDemoSourceFiles();

    const cases = [
      { path: "/etc/passwd", content: "x\n" },
      { path: "../escape.txt", content: "x\n" },
      { path: ".hidden/secret.txt", content: "x\n" },
      { path: "node_modules/pkg/index.js", content: "x\n" },
      { path: "main\u0000.ts", content: "x\n" },
    ];

    for (const bad of cases) {
      const root = await mkdtemp(join(tmpdir(), "nautilo-app-authoring-"));
      try {
        expect(
          createMiniAppSource(root, {
            appId: "paint-demo",
            files: [...base, bad],
          }),
        ).rejects.toBeInstanceOf(AppSourcePathError);
        expect(stat(join(root, "paint-demo"))).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("rejects payload file count cap", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-authoring-"));
    const files = paintDemoSourceFiles();
    for (let i = 0; i <= APP_AUTHORING_MAX_FILE_COUNT; i++) {
      files.push({ path: `extra/file-${i}.txt`, content: "x\n" });
    }

    expect(
      createMiniAppSource(appsRoot, { appId: "paint-demo", files }),
    ).rejects.toBeInstanceOf(AppAuthoringPayloadError);
  });

  test("rejects oversized file content", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-authoring-"));
    const files = [
      ...paintDemoSourceFiles(),
      { path: "big.txt", content: "x".repeat(APP_AUTHORING_MAX_FILE_BYTES + 1) },
    ];

    expect(
      createMiniAppSource(appsRoot, { appId: "paint-demo", files }),
    ).rejects.toMatchObject({ name: "AppSourceTooLargeError" });
  });
});

describe("app-authoring-store applyMiniAppSourceBatch", () => {
  test("updates multiple files and recomputes hash", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-authoring-"));
    await createMiniAppSource(appsRoot, {
      appId: "paint-demo",
      files: paintDemoSourceFiles(),
    });

    const before = await scanInstalledApps(appsRoot);
    const app = before.find((entry) => entry.id === "paint-demo")!;
    const mainBefore = await readAppSourceFile(appsRoot, "paint-demo", "main.ts");
    const cssBefore = await readAppSourceFile(appsRoot, "paint-demo", "styles.css");
    const nextMain = "export const updated = true;\n";
    const nextCss = "body { margin: 0; }\n";

    const batchInput: Parameters<typeof applyMiniAppSourceBatch>[1] = {
      appId: "paint-demo",
      writes: [
        { path: "main.ts", content: nextMain, baseSha256: mainBefore.sha256 },
        { path: "styles.css", content: nextCss, baseSha256: cssBefore.sha256 },
      ],
    };
    if (app.sourceHash) {
      batchInput.expectedSourceHash = app.sourceHash;
    }
    const result = await applyMiniAppSourceBatch(appsRoot, batchInput);

    expect(result.ok).toBe(true);
    expect(result.filesWritten).toEqual(["main.ts", "styles.css"]);
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceHash).not.toBe(app.sourceHash);

    expect(await readFile(join(appsRoot, "paint-demo", "main.ts"), "utf8")).toBe(nextMain);
    expect(await readFile(join(appsRoot, "paint-demo", "styles.css"), "utf8")).toBe(nextCss);
  });

  test("stale baseSha256 modifies nothing", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-authoring-"));
    await createMiniAppSource(appsRoot, {
      appId: "paint-demo",
      files: paintDemoSourceFiles(),
    });

    const current = await readAppSourceFile(appsRoot, "paint-demo", "main.ts");
    const staleBase = sha256Hex("stale");

    expect(
      applyMiniAppSourceBatch(appsRoot, {
        appId: "paint-demo",
        writes: [{ path: "main.ts", content: "export {};\n", baseSha256: staleBase }],
      }),
    ).rejects.toMatchObject({
      name: "AppSourceConflictError",
      currentSha256: current.sha256,
    } satisfies Partial<AppSourceConflictError>);

    const after = await readAppSourceFile(appsRoot, "paint-demo", "main.ts");
    expect(after.content).toBe(current.content);
  });
});

describe("app-authoring-store validateMiniAppSource", () => {
  test("reports runtime build failure without root path leak", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-authoring-"));
    await createMiniAppSource(appsRoot, {
      appId: "paint-demo",
      files: paintDemoSourceFiles(),
    });

    await rm(join(appsRoot, "paint-demo", "index.html"));

    const result = await validateMiniAppSource(appsRoot, "paint-demo", { buildRuntime: true });
    const runtimeBuild = result.runtimeBuild;
    expect(runtimeBuild?.ok).toBe(false);
    if (!runtimeBuild || runtimeBuild.ok) return;
    expect(runtimeBuild.message).not.toContain(appsRoot);
    expect(runtimeBuild.message).not.toContain("/Users/");
  });
});

describe("app-authoring-store side effects", () => {
  test("successful mutation publishes app source events", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-authoring-"));
    const events: AppSourceEvent[] = [];
    subscribeAppSourceEvents((event) => {
      events.push(event);
    });

    await createMiniAppSource(appsRoot, {
      appId: "paint-demo",
      files: paintDemoSourceFiles(),
    });

    expect(events.some((event) => event.type === "changed" && event.appId === "paint-demo")).toBe(
      true,
    );
  });

  test("registration failure is returned as warning, not thrown", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-authoring-"));
    const result = await createMiniAppSource(
      appsRoot,
      {
        appId: "paint-demo",
        files: paintDemoSourceFiles(),
      },
      {
        registerAppTools: async () => {
          throw new Error("catalog exploded");
        },
      },
    );

    expect(result.registration).toEqual({
      status: "warning",
      message: "catalog exploded",
    });
  });
});

describe("paint-demo runtime build proof", () => {
  test("dependency-free paint-demo fixture builds runtime", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-authoring-"));
    await createMiniAppSource(appsRoot, {
      appId: "paint-demo",
      files: paintDemoSourceFiles(),
    });

    const [app] = await scanInstalledApps(appsRoot);
    const result = await buildMiniApp(app!, appsRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain("paint-canvas");
    expect(result.bundleJs.length).toBeGreaterThan(0);
  });
});
