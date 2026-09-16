import { afterEach, describe, expect, test } from "bun:test";
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { exportCanonicalMobileWeb } from "./export-mobile-web";
import {
  MOBILE_WEB_EXPO_HYDRATION_SCRIPT_BODY,
  REQUIRED_MOBILE_WEB_SHELLS,
  verifyMobileWebExport,
} from "./verify-mobile-web-export";

const temporaryRoots: string[] = [];
const fingerprint = "0123456789abcdef0123456789abcdef";
const scriptPath = `_expo/static/js/web/app-${fingerprint}.js`;
const assetPath = `assets/font.${fingerprint}.ttf`;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "nautilo-mobile-web-export-test-"));
  temporaryRoots.push(root);
  return root;
}

async function writeValidExport(output: string): Promise<void> {
  await mkdir(path.join(output, path.dirname(scriptPath)), { recursive: true });
  await mkdir(path.join(output, path.dirname(assetPath)), { recursive: true });
  await writeFile(path.join(output, scriptPath), "export const mobile = true;\n");
  await writeFile(path.join(output, assetPath), "font");
  const html = `<script type="module">${MOBILE_WEB_EXPO_HYDRATION_SCRIPT_BODY}</script><script src="/mobile/${scriptPath}"></script><img src="/mobile/${assetPath}">`;
  await Promise.all(REQUIRED_MOBILE_WEB_SHELLS.map(async (shell) => {
    const file = path.join(output, shell);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, html);
  }));
}

const acceptedViewer = async (): Promise<void> => undefined;

describe("canonical Mobile Web export", () => {
  test("promotes one clean export and removes a stale canonical dist", async () => {
    const appRoot = await fixtureRoot();
    await writeFile(path.join(appRoot, "dist"), "not a directory");
    await expect(exportCanonicalMobileWeb({ appRoot, exportWeb: writeValidExport, verifyViewer: acceptedViewer }))
      .rejects.toThrow("must be a real directory");
    await expect(readFile(path.join(appRoot, "dist"), "utf8")).resolves.toBe("not a directory");
    await rm(path.join(appRoot, "dist"));
    const symlinkTarget = path.join(appRoot, "outside-dist");
    await mkdir(symlinkTarget);
    await symlink(symlinkTarget, path.join(appRoot, "dist"));
    await expect(exportCanonicalMobileWeb({ appRoot, exportWeb: writeValidExport, verifyViewer: acceptedViewer }))
      .rejects.toThrow("must be a real directory");
    expect((await lstat(path.join(appRoot, "dist"))).isSymbolicLink()).toBe(true);
    await rm(path.join(appRoot, "dist"));
    await mkdir(path.join(appRoot, "dist"));
    await writeFile(path.join(appRoot, "dist", "stale.txt"), "old");
    await exportCanonicalMobileWeb({
      appRoot,
      exportWeb: writeValidExport,
      verifyViewer: acceptedViewer,
    });
    await expect(readFile(path.join(appRoot, "dist", "index.html"), "utf8")).resolves.toContain(scriptPath);
    await expect(access(path.join(appRoot, "dist", "stale.txt"))).rejects.toThrow();
  });

  test("removes canonical dist when the exporter fails after writing a partial stage", async () => {
    const appRoot = await fixtureRoot();
    await mkdir(path.join(appRoot, "dist"));
    await writeFile(path.join(appRoot, "dist", "stale.txt"), "old");
    await expect(exportCanonicalMobileWeb({
      appRoot,
      exportWeb: async (output) => {
        await mkdir(output, { recursive: true });
        await writeFile(path.join(output, "index.html"), "partial");
        throw new Error("export failed");
      },
      verifyViewer: acceptedViewer,
    })).rejects.toThrow("export failed");
    await expect(access(path.join(appRoot, "dist"))).rejects.toThrow();
  });

  test("rejects generic missing-shell, fingerprint, source-map, and hydration defects", async () => {
    const cases = [
      async (output: string) => rm(path.join(output, "callback.html")),
      async (output: string) => writeFile(path.join(output, "assets", "not-fingerprinted.ttf"), "font"),
      async (output: string) => writeFile(path.join(output, scriptPath), "//# sourceMappingURL=app.js.map\n"),
      async (output: string) => writeFile(path.join(output, "index.html"), `<script src="/mobile/${scriptPath}"></script>`),
    ];
    for (const mutate of cases) {
      const output = await fixtureRoot();
      await writeValidExport(output);
      await mutate(output);
      await expect(verifyMobileWebExport(output)).rejects.toThrow();
    }
  });

  test("preserves a concurrently created canonical dist when the viewer verifier rejects", async () => {
    const appRoot = await fixtureRoot();
    await expect(exportCanonicalMobileWeb({
      appRoot,
      exportWeb: writeValidExport,
      verifyViewer: async () => {
        await mkdir(path.join(appRoot, "dist"));
        await writeFile(path.join(appRoot, "dist", "concurrent.txt"), "new target");
        throw new Error("viewer closure rejected");
      },
    })).rejects.toThrow("viewer closure rejected");
    await expect(readFile(path.join(appRoot, "dist", "concurrent.txt"), "utf8")).resolves.toBe("new target");
  });

  test("rejects an exact forbidden native authority sentinel", async () => {
    const output = await fixtureRoot();
    await writeValidExport(output);
    await writeFile(path.join(output, scriptPath), "const authority = 'createPushBindingStore';\n");
    await expect(verifyMobileWebExport(output)).rejects.toThrow("forbidden native authority sentinel");
  });
});
