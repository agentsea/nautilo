import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { buildAgentToolBundle, type AgentToolsBuildStatus } from "./app-agent-tool-build";
import type { MiniAppManifest } from "./app-manifest";
import {
  computeAppSourceHash,
  type RegisteredMiniApp,
} from "./app-registry";

export type { AgentToolsBuildStatus };

/**
 * M213 — bump when Bun build options, bridge bootstrap, runtime HTML contract,
 * or other server-side mini-app build inputs change deterministic output.
 */
const MINI_APP_RUNTIME_TOOLCHAIN_REVISION = "2026-07-16.v1" as const;

export function miniAppRuntimeToolchainHash(): string {
  return createHash("sha256").update(MINI_APP_RUNTIME_TOOLCHAIN_REVISION).digest("hex");
}

export function miniAppRuntimeBuildCacheKey(appId: string, sourceHash: string): string {
  return `${appId}\0${sourceHash}\0${miniAppRuntimeToolchainHash()}`;
}

export type MiniAppBuildResult =
  | {
      ok: true;
      appId: string;
      sourceHash: string;
      appRoot: string;
      cacheDir: string;
      html: string;
      styles: Array<{ path: string; content: string }>;
      bundleJs: string;
      manifest: MiniAppManifest;
      agentToolsBuild: AgentToolsBuildStatus;
    }
  | {
      ok: false;
      appId: string;
      sourceHash: string | null;
      status: "invalid_manifest" | "needs_dependencies" | "build_failed";
      message: string;
    };

export type SuccessfulMiniAppBuild = Extract<MiniAppBuildResult, { ok: true }>;

/**
 * Digest the exact browser payload which receives host capabilities. Source
 * hashes are intentionally insufficient because installed dependencies can
 * affect the bundle while being excluded from source-tree hashing.
 */
export function miniAppRuntimePayloadDigest(build: SuccessfulMiniAppBuild): string {
  const hash = createHash("sha256");
  const add = (label: string, value: string) => {
    hash.update(label);
    hash.update("\0");
    hash.update(value);
    hash.update("\0");
  };
  add("toolchain", miniAppRuntimeToolchainHash());
  add("appId", build.appId);
  add("manifest", JSON.stringify(build.manifest));
  add("html", build.html);
  for (const style of [...build.styles].sort((a, b) => a.path.localeCompare(b.path))) {
    add(`style:${style.path}`, style.content);
  }
  add("bundleJs", build.bundleJs);
  return hash.digest("hex");
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validateRelativeAppPath(relPath: string): string | null {
  if (relPath.length === 0) return "path must not be empty";
  if (hasControlChars(relPath)) return "path contains control characters";
  if (relPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relPath)) {
    return "path must be relative";
  }
  const segments = relPath.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    return "path must not contain parent traversal";
  }
  return null;
}

function resolveUnderAppRoot(appRoot: string, relPath: string): string | null {
  const validationError = validateRelativeAppPath(relPath);
  if (validationError) return null;

  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const resolved = resolve(appRoot, normalized);
  const rootResolved = resolve(appRoot);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}/`)) {
    return null;
  }
  if (isAbsolute(relPath) && !resolved.startsWith(`${rootResolved}/`)) {
    return null;
  }
  return resolved;
}

function sanitizeBuildMessage(message: string, redactPaths: string[]): string {
  let sanitized = message;
  for (const pathValue of redactPaths) {
    if (!pathValue) continue;
    sanitized = sanitized.split(pathValue).join("<path>");
  }
  sanitized = sanitized.replace(/\/(?:Users|home|var|tmp|opt|private)[^\s:]*/g, "<path>");
  const firstLine = sanitized.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 0 ? firstLine : "App build failed.";
}

function sanitizeBundleJsForRuntime(bundleJs: string, redactPaths: string[]): string {
  let sanitized = bundleJs;
  sanitized = sanitized.replace(/\/\/# sourceMappingURL=[^\n]*/g, "");
  sanitized = sanitized.replace(/\/\/# debugId=[^\n]*/g, "");
  sanitized = sanitized.replace(/^\/\/ .*\.(?:ts|tsx|js|jsx)\n/gm, "");
  for (const pathValue of redactPaths) {
    if (!pathValue) continue;
    sanitized = sanitized.split(pathValue).join("");
  }
  sanitized = sanitized.replace(/\/(?:Users|home|var|tmp|opt|private)[^\s\n"'`]*/g, "");
  return sanitized;
}

async function readTextFile(absPath: string): Promise<string> {
  return readFile(absPath, "utf8");
}

export async function buildMiniApp(
  app: RegisteredMiniApp,
  appsRoot: string,
): Promise<MiniAppBuildResult> {
  const appRoot = app.root;
  const initialRedactPaths = [appRoot, appsRoot];

  if (app.status === "invalid_manifest") {
    return {
      ok: false,
      appId: app.id,
      sourceHash: app.sourceHash,
      status: "invalid_manifest",
      message: sanitizeBuildMessage(app.error ?? "App manifest is invalid.", initialRedactPaths),
    };
  }

  if (app.status === "needs_dependencies") {
    return {
      ok: false,
      appId: app.id,
      sourceHash: app.sourceHash,
      status: "needs_dependencies",
      message: "App dependencies are not installed.",
    };
  }

  if (!app.manifest) {
    return {
      ok: false,
      appId: app.id,
      sourceHash: app.sourceHash,
      status: "invalid_manifest",
      message: "App manifest is invalid.",
    };
  }

  const manifest = app.manifest;
  const sourceHash = app.sourceHash ?? (await computeAppSourceHash(appRoot));
  const cacheDir = join(appsRoot, ".cache", app.id, sourceHash);
  const redactPaths = [appRoot, appsRoot, cacheDir];

  const entryAbs = resolveUnderAppRoot(appRoot, manifest.entry);
  if (!entryAbs) {
    return {
      ok: false,
      appId: app.id,
      sourceHash,
      status: "build_failed",
      message: sanitizeBuildMessage("App entry path is invalid.", redactPaths),
    };
  }

  const htmlAbs = resolveUnderAppRoot(appRoot, manifest.html);
  if (!htmlAbs) {
    return {
      ok: false,
      appId: app.id,
      sourceHash,
      status: "build_failed",
      message: sanitizeBuildMessage("App html path is invalid.", redactPaths),
    };
  }

  const stylePaths = manifest.styles ?? [];
  const styleAbsPaths: string[] = [];
  for (const stylePath of stylePaths) {
    const abs = resolveUnderAppRoot(appRoot, stylePath);
    if (!abs) {
      return {
        ok: false,
        appId: app.id,
        sourceHash,
        status: "build_failed",
        message: sanitizeBuildMessage("App style path is invalid.", redactPaths),
      };
    }
    styleAbsPaths.push(abs);
  }

  let html: string;
  try {
    html = await readTextFile(htmlAbs);
  } catch (err) {
    return {
      ok: false,
      appId: app.id,
      sourceHash,
      status: "build_failed",
      message: sanitizeBuildMessage(
        err instanceof Error ? err.message : "Failed to read app html.",
        redactPaths,
      ),
    };
  }

  const styles: Array<{ path: string; content: string }> = [];
  for (let i = 0; i < stylePaths.length; i++) {
    const stylePath = stylePaths[i]!;
    const styleAbs = styleAbsPaths[i]!;
    try {
      styles.push({
        path: stylePath,
        content: await readTextFile(styleAbs),
      });
    } catch (err) {
      return {
        ok: false,
        appId: app.id,
        sourceHash,
        status: "build_failed",
        message: sanitizeBuildMessage(
          err instanceof Error ? err.message : "Failed to read app styles.",
          redactPaths,
        ),
      };
    }
  }

  await mkdir(cacheDir, { recursive: true });

  let buildResult: Awaited<ReturnType<typeof Bun.build>>;
  try {
    buildResult = await Bun.build({
      entrypoints: [entryAbs],
      outdir: cacheDir,
      target: "browser",
      format: "esm",
      splitting: false,
      sourcemap: "inline",
      minify: false,
      root: appRoot,
    });
  } catch (err) {
    return {
      ok: false,
      appId: app.id,
      sourceHash,
      status: "build_failed",
      message: sanitizeBuildMessage(
        err instanceof Error ? err.message : "App build failed.",
        redactPaths,
      ),
    };
  }

  if (!buildResult.success) {
    const diagnostic = buildResult.logs
      .map((log) => log.message)
      .filter((line) => line.length > 0)
      .join(" ");
    return {
      ok: false,
      appId: app.id,
      sourceHash,
      status: "build_failed",
      message: sanitizeBuildMessage(
        diagnostic.length > 0 ? diagnostic : "App build failed.",
        redactPaths,
      ),
    };
  }

  const bundleOutput = buildResult.outputs[0];
  if (!bundleOutput) {
    return {
      ok: false,
      appId: app.id,
      sourceHash,
      status: "build_failed",
      message: sanitizeBuildMessage("App build produced no output.", redactPaths),
    };
  }

  let bundleJs: string;
  try {
    bundleJs = sanitizeBundleJsForRuntime(await bundleOutput.text(), redactPaths);
  } catch (err) {
    return {
      ok: false,
      appId: app.id,
      sourceHash,
      status: "build_failed",
      message: sanitizeBuildMessage(
        err instanceof Error ? err.message : "Failed to read app bundle.",
        redactPaths,
      ),
    };
  }

  const agentTools = manifest.agent?.tools ?? [];
  const agentToolsBuild = await buildAgentToolBundle({
    appId: app.id,
    appRoot,
    appsRoot,
    cacheDir,
    tools: agentTools,
    redactPaths,
  });

  return {
    ok: true,
    appId: app.id,
    sourceHash,
    appRoot,
    cacheDir,
    html,
    styles,
    bundleJs,
    manifest,
    agentToolsBuild,
  };
}
