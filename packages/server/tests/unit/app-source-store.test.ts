import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_MINI_APP_MANIFEST } from "../helpers/test-mini-app-manifest";
import { createMiniAppToolRuntime } from "../../src/apps/mini-app-tool-runtime";
import {
  AppNotFoundError,
  AppSourceConflictError,
  AppSourcePathError,
  AppSourceRangeError,
  AppSourceStaleSourceError,
  listAppSourceTree,
  readAppSourceFile,
  readAppSourceFileRange,
  resolveAppSourcePath,
  writeAppSourceFile,
} from "../../src/apps/app-source-store";

let appsRoot = "";

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function writeTestApp(root: string): Promise<void> {
  const appDir = join(root, "test-canvas");
  await mkdir(join(appDir, "src"), { recursive: true });
  await writeFile(join(appDir, "app.json"), `${JSON.stringify(TEST_MINI_APP_MANIFEST, null, 2)}\n`);
  await writeFile(join(appDir, "main.ts"), "export {};\n");
  await writeFile(join(appDir, "src", "helper.ts"), "export const x = 1;\n");
  await writeFile(
    join(appDir, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
}

afterEach(async () => {
  if (appsRoot) {
    await rm(appsRoot, { recursive: true, force: true });
    appsRoot = "";
  }
});

describe("app-source-store path resolver", () => {
  test("rejects absolute paths", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    expect(resolveAppSourcePath(appsRoot, "test-canvas", "/etc/passwd")).rejects.toBeInstanceOf(
      AppSourcePathError,
    );
  });

  test("rejects parent traversal", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    expect(resolveAppSourcePath(appsRoot, "test-canvas", "../secret.txt")).rejects.toBeInstanceOf(
      AppSourcePathError,
    );
  });

  test("rejects control characters", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    expect(resolveAppSourcePath(appsRoot, "test-canvas", "main\u0000.ts")).rejects.toBeInstanceOf(
      AppSourcePathError,
    );
  });

  test("rejects excluded directory segments", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    expect(
      resolveAppSourcePath(appsRoot, "test-canvas", "node_modules/pkg/index.js"),
    ).rejects.toBeInstanceOf(AppSourcePathError);
    expect(resolveAppSourcePath(appsRoot, "test-canvas", ".cache/out.js")).rejects.toBeInstanceOf(
      AppSourcePathError,
    );
  });

  test("rejects symlink escape", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    const outside = join(tmpdir(), `nautilo-outside-${Date.now()}`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(outside, join(appsRoot, "test-canvas", "escape-link"));
    try {
      expect(
        resolveAppSourcePath(appsRoot, "test-canvas", "escape-link/secret.txt"),
      ).rejects.toBeInstanceOf(AppSourcePathError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("missing app returns typed not found", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    expect(resolveAppSourcePath(appsRoot, "missing", "main.ts")).rejects.toBeInstanceOf(
      AppNotFoundError,
    );
  });
});

describe("app-source-store tree and IO", () => {
  test("tree excludes generated and dependency dirs", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    await mkdir(join(appsRoot, "test-canvas", "node_modules", "pkg"), { recursive: true });
    await writeFile(join(appsRoot, "test-canvas", "node_modules", "pkg", "index.js"), "noise");
    await mkdir(join(appsRoot, "test-canvas", ".cache"), { recursive: true });
    await writeFile(join(appsRoot, "test-canvas", ".cache", "bundle.js"), "noise");
    await mkdir(join(appsRoot, "test-canvas", "dist"), { recursive: true });
    await writeFile(join(appsRoot, "test-canvas", "dist", "bundle.js"), "noise");

    const tree = await listAppSourceTree(appsRoot, "test-canvas");
    const paths = tree.map((entry) => entry.path);
    expect(paths).toContain("main.ts");
    expect(paths).toContain("src");
    expect(paths).toContain("src/helper.ts");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.includes(".cache"))).toBe(false);
    expect(paths.some((p) => p.includes("dist"))).toBe(false);
  });

  test("read returns content and sha256", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    const content = "export const hello = 1;\n";
    await writeFile(join(appsRoot, "test-canvas", "main.ts"), content);

    const result = await readAppSourceFile(appsRoot, "test-canvas", "main.ts");
    expect(result.path).toBe("main.ts");
    expect(result.content).toBe(content);
    expect(result.sha256).toBe(sha256Hex(content));
  });

  test("read range returns an ordinary whole file when lengthBytes is omitted", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    const content = "export const hello = '💥';\n";
    await writeFile(join(appsRoot, "test-canvas", "main.ts"), content);

    const result = await readAppSourceFileRange(appsRoot, "test-canvas", "main.ts", {
      offsetBytes: 0,
    });
    const totalBytes = Buffer.byteLength(content, "utf8");
    expect(result).toEqual({
      path: "main.ts",
      content,
      sha256: sha256Hex(content),
      totalBytes,
      offsetBytes: 0,
      returnedBytes: totalBytes,
      nextOffsetBytes: totalBytes,
      complete: true,
    });
  });

  test("reconstructs multibyte source across many caller-selected ranges", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    const content = "α".repeat(20_000);
    await writeFile(join(appsRoot, "test-canvas", "main.ts"), content);

    const pieces: string[] = [];
    let offsetBytes = 0;
    let expectedSha256: string | undefined;
    let pageCount = 0;
    let finalResult: Awaited<ReturnType<typeof readAppSourceFileRange>> | undefined;
    do {
      const result = await readAppSourceFileRange(appsRoot, "test-canvas", "main.ts", {
        offsetBytes,
        lengthBytes: 1_001,
        ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
      });
      pieces.push(result.content);
      offsetBytes = result.nextOffsetBytes;
      expectedSha256 = result.sha256;
      pageCount += 1;
      finalResult = result;
    } while (!finalResult.complete);

    expect(pageCount).toBeGreaterThan(16);
    expect(pieces.join("")).toBe(content);
    expect(finalResult).toMatchObject({
      totalBytes: Buffer.byteLength(content, "utf8"),
      nextOffsetBytes: Buffer.byteLength(content, "utf8"),
      complete: true,
    });
  });

  test("backs a requested end away from a multibyte boundary and reports the safe next offset", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    const content = "a💥b";
    await writeFile(join(appsRoot, "test-canvas", "main.ts"), content);

    const first = await readAppSourceFileRange(appsRoot, "test-canvas", "main.ts", {
      lengthBytes: 2,
    });
    expect(first).toMatchObject({
      content: "a",
      offsetBytes: 0,
      returnedBytes: 1,
      nextOffsetBytes: 1,
      complete: false,
    });

    const second = await readAppSourceFileRange(appsRoot, "test-canvas", "main.ts", {
      offsetBytes: first.nextOffsetBytes,
      expectedSha256: first.sha256,
    });
    expect(`${first.content}${second.content}`).toBe(content);
    expect(second.complete).toBe(true);
  });

  test("rejects a range too small to contain the next UTF-8 character", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    await writeFile(join(appsRoot, "test-canvas", "main.ts"), "a💥b");
    const first = await readAppSourceFileRange(appsRoot, "test-canvas", "main.ts", {
      lengthBytes: 1,
    });

    let caught: unknown;
    try {
      await readAppSourceFileRange(appsRoot, "test-canvas", "main.ts", {
        offsetBytes: first.nextOffsetBytes,
        lengthBytes: 2,
        expectedSha256: first.sha256,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "invalid_range",
      minimumBytes: 4,
    } satisfies Partial<AppSourceRangeError>);
  });

  test("rejects an invalid UTF-8 boundary and stale source rather than mixing versions", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    const path = join(appsRoot, "test-canvas", "main.ts");
    await writeFile(path, "a💥b");
    const first = await readAppSourceFileRange(appsRoot, "test-canvas", "main.ts", {
      lengthBytes: 1,
    });

    let invalidBoundary: unknown;
    try {
      await readAppSourceFileRange(appsRoot, "test-canvas", "main.ts", {
        offsetBytes: 2,
        expectedSha256: first.sha256,
      });
    } catch (error) {
      invalidBoundary = error;
    }
    expect(invalidBoundary).toMatchObject({ code: "invalid_range" } satisfies Partial<AppSourceRangeError>);

    await writeFile(path, "changed");
    let stale: unknown;
    try {
      await readAppSourceFileRange(appsRoot, "test-canvas", "main.ts", {
        offsetBytes: first.nextOffsetBytes,
        expectedSha256: first.sha256,
      });
    } catch (error) {
      stale = error;
    }
    expect(stale).toMatchObject({
      code: "stale_source",
      expectedSha256: first.sha256,
      currentSha256: sha256Hex("changed"),
    } satisfies Partial<AppSourceStaleSourceError>);
  });

  test("tool runtime returns typed range and stale-source failures without content", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    const path = join(appsRoot, "test-canvas", "main.ts");
    await writeFile(path, "a💥b");
    const runtime = createMiniAppToolRuntime(() => appsRoot);
    const first = await runtime.readSource({ userId: "user" }, {
      appId: "test-canvas",
      path: "main.ts",
      lengthBytes: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok || !first.sha256 || first.nextOffsetBytes === undefined) {
      throw new Error("expected a successful initial source range");
    }

    const invalid = await runtime.readSource({ userId: "user" }, {
      appId: "test-canvas",
      path: "main.ts",
      offsetBytes: 2,
      expectedSha256: first.sha256,
    });
    expect(invalid).toMatchObject({ ok: false, error: "invalid_range" });
    expect(invalid).not.toHaveProperty("content");

    const tooSmall = await runtime.readSource({ userId: "user" }, {
      appId: "test-canvas",
      path: "main.ts",
      offsetBytes: first.nextOffsetBytes,
      lengthBytes: 2,
      expectedSha256: first.sha256,
    });
    expect(tooSmall).toMatchObject({ ok: false, error: "invalid_range", minimumBytes: 4 });
    expect(tooSmall).not.toHaveProperty("content");

    await writeFile(path, "new file");
    const stale = await runtime.readSource({ userId: "user" }, {
      appId: "test-canvas",
      path: "main.ts",
      offsetBytes: first.nextOffsetBytes,
      expectedSha256: first.sha256,
    });
    expect(stale).toMatchObject({
      ok: false,
      error: "stale_source",
      expectedSha256: first.sha256,
      currentSha256: sha256Hex("new file"),
    });
    expect(stale).not.toHaveProperty("content");
  });

  test("write success updates sha and sourceHash", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    const before = await readAppSourceFile(appsRoot, "test-canvas", "main.ts");
    const next = "export const updated = true;\n";

    const result = await writeAppSourceFile(
      appsRoot,
      "test-canvas",
      "main.ts",
      next,
      before.sha256,
    );
    expect(result.ok).toBe(true);
    expect(result.sha256).toBe(sha256Hex(next));
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.status).toBe("ready");

    const onDisk = await readFile(join(appsRoot, "test-canvas", "main.ts"), "utf8");
    expect(onDisk).toBe(next);
  });

  test("stale write returns conflict without modifying file", async () => {
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-source-"));
    await writeTestApp(appsRoot);
    const current = await readAppSourceFile(appsRoot, "test-canvas", "main.ts");
    const staleBase = sha256Hex("stale base");

    expect(
      writeAppSourceFile(appsRoot, "test-canvas", "main.ts", "export {};\n", staleBase),
    ).rejects.toMatchObject({
      name: "AppSourceConflictError",
      currentSha256: current.sha256,
    } satisfies Partial<AppSourceConflictError>);

    const after = await readAppSourceFile(appsRoot, "test-canvas", "main.ts");
    expect(after.content).toBe(current.content);
    expect(after.sha256).toBe(current.sha256);
  });
});
