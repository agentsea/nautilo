import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  generateMiniAppAgentToolName,
  getToolModulePathValidationError,
  type MiniAppAgentToolManifest,
} from "./app-manifest";

export type AgentToolsBuildStatus =
  | { status: "none" }
  | {
      status: "ok";
      outputFile: "agent-tools.mjs";
      toolCount: number;
      toolNames: string[];
    }
  | { status: "failed"; message: string };

const FORBIDDEN_MODULE_IMPORTS = [
  "node:fs",
  "node:fs/promises",
  "fs",
  "fs/promises",
  "child_process",
  "node:child_process",
  "net",
  "tls",
  "http",
  "https",
  "@nautilo/db",
  "@nautilo/server",
  "@nautilo/trust",
  "@nautilo/config",
  "electron",
  "electron/preload",
] as const;

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
  return firstLine.length > 0 ? firstLine : "Agent tool build failed.";
}

function collectImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'";]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?(?:[^'";]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (typeof specifier === "string" && specifier.length > 0) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

function hasForbiddenAmbientFetch(source: string): boolean {
  const sourceFile = ts.createSourceFile(
    "agent-tool-module.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let forbidden = false;

  const visit = (node: ts.Node): void => {
    if (forbidden) return;

    if (ts.isPropertyAccessExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "globalThis" || node.expression.text === "window") &&
        node.name.text === "fetch"
      ) {
        forbidden = true;
        return;
      }
    } else if (ts.isElementAccessExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "globalThis" || node.expression.text === "window") &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === "fetch"
      ) {
        forbidden = true;
        return;
      }
    } else if (ts.isIdentifier(node) && node.text === "fetch") {
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isMethodDeclaration(parent) ||
          ts.isMethodSignature(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isPropertyAssignment(parent)) &&
          parent.name === node);
      if (!isPropertyName) {
        forbidden = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return forbidden;
}

export function validateAgentToolModuleSource(source: string, modulePath: string): string | null {
  for (const specifier of collectImportSpecifiers(source)) {
    for (const forbidden of FORBIDDEN_MODULE_IMPORTS) {
      if (specifier === forbidden || specifier.startsWith(`${forbidden}/`)) {
        return `forbidden import in ${modulePath}: ${forbidden}`;
      }
    }
  }

  if (/\bprocess\s*\.\s*env\b/.test(source)) {
    return `process.env access is forbidden in ${modulePath}`;
  }

  if (hasForbiddenAmbientFetch(source)) {
    return `fetch is forbidden in ${modulePath}`;
  }

  return null;
}

function isLocalImportSpecifier(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

function candidateLocalModulePaths(importerAbs: string, specifier: string): string[] {
  const base = resolve(dirname(importerAbs), specifier);
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.mts`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.js"),
    join(base, "index.mjs"),
  ];
}

async function resolveLocalModule(importerAbs: string, specifier: string): Promise<string | null> {
  for (const candidate of candidateLocalModulePaths(importerAbs, specifier)) {
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // Try the next extension/index candidate. Bun will report a real
      // build failure later if the import is genuinely unresolved.
    }
  }
  return null;
}

async function validateAgentToolModuleGraph(params: {
  appRoot: string;
  moduleAbs: string;
  modulePath: string;
  visited: Set<string>;
}): Promise<string | null> {
  const { appRoot, moduleAbs, modulePath, visited } = params;
  if (visited.has(moduleAbs)) return null;
  visited.add(moduleAbs);

  let source: string;
  try {
    source = await readFile(moduleAbs, "utf8");
  } catch (err) {
    return err instanceof Error ? err.message : "Failed to read agent tool module.";
  }

  const staticValidation = validateAgentToolModuleSource(source, modulePath);
  if (staticValidation) return staticValidation;

  for (const specifier of collectImportSpecifiers(source)) {
    if (!isLocalImportSpecifier(specifier)) continue;
    const localAbs = await resolveLocalModule(moduleAbs, specifier);
    if (!localAbs) continue;

    const rootResolved = resolve(appRoot);
    if (localAbs !== rootResolved && !localAbs.startsWith(`${rootResolved}/`)) {
      return `local import in ${modulePath} escapes app root: ${specifier}`;
    }

    const localRel = relative(appRoot, localAbs).replace(/\\/g, "/");
    const nested = await validateAgentToolModuleGraph({
      appRoot,
      moduleAbs: localAbs,
      modulePath: localRel,
      visited,
    });
    if (nested) return nested;
  }

  return null;
}

function moduleImportSpecifier(bootstrapDir: string, moduleAbs: string): string {
  let rel = relative(bootstrapDir, moduleAbs).replace(/\\/g, "/");
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return rel;
}

async function writeAgentToolBootstrap(
  cacheDir: string,
  appRoot: string,
  modules: string[],
): Promise<string> {
  const lines = ["// @nautilo-generated agent-tools bootstrap", ""];
  modules.forEach((modulePath, index) => {
    const moduleAbs = resolveUnderAppRoot(appRoot, modulePath);
    if (!moduleAbs) {
      throw new Error("Agent tool module path is invalid.");
    }
    const importPath = moduleImportSpecifier(cacheDir, moduleAbs);
    lines.push(`import * as __mod_${index} from ${JSON.stringify(importPath)};`);
  });
  lines.push("");
  lines.push("export const __nautiloAppToolModules = {");
  modules.forEach((modulePath, index) => {
    lines.push(`  ${JSON.stringify(modulePath)}: __mod_${index},`);
  });
  lines.push("};");
  lines.push("");

  const bootstrapPath = join(cacheDir, "agent-tools-bootstrap.ts");
  await writeFile(bootstrapPath, lines.join("\n"), "utf8");
  return bootstrapPath;
}

export async function buildAgentToolBundle(options: {
  appId: string;
  appRoot: string;
  appsRoot: string;
  cacheDir: string;
  tools: MiniAppAgentToolManifest[];
  redactPaths: string[];
}): Promise<AgentToolsBuildStatus> {
  const { appId, appRoot, appsRoot, cacheDir, tools, redactPaths } = options;
  if (tools.length === 0) {
    return { status: "none" };
  }

  const uniqueModules = [...new Set(tools.map((tool) => tool.module))];
  for (const modulePath of uniqueModules) {
    const moduleValidation = getToolModulePathValidationError(modulePath);
    if (moduleValidation) {
      return {
        status: "failed",
        message: sanitizeBuildMessage(moduleValidation, redactPaths),
      };
    }

    const moduleAbs = resolveUnderAppRoot(appRoot, modulePath);
    if (!moduleAbs) {
      return {
        status: "failed",
        message: sanitizeBuildMessage("Agent tool module path is invalid.", redactPaths),
      };
    }

    const staticValidation = await validateAgentToolModuleGraph({
      appRoot,
      moduleAbs,
      modulePath,
      visited: new Set(),
    });
    if (staticValidation) {
      return {
        status: "failed",
        message: sanitizeBuildMessage(staticValidation, redactPaths),
      };
    }
  }

  await mkdir(cacheDir, { recursive: true });

  let bootstrapPath: string;
  try {
    bootstrapPath = await writeAgentToolBootstrap(cacheDir, appRoot, uniqueModules);
  } catch (err) {
    return {
      status: "failed",
      message: sanitizeBuildMessage(
        err instanceof Error ? err.message : "Failed to prepare agent tool build.",
        redactPaths,
      ),
    };
  }

  const outputFile = join(cacheDir, "agent-tools.mjs");
  let buildResult: Awaited<ReturnType<typeof Bun.build>>;
  try {
    buildResult = await Bun.build({
      entrypoints: [bootstrapPath],
      outdir: cacheDir,
      naming: "agent-tools.[ext]",
      target: "bun",
      format: "esm",
      splitting: false,
      sourcemap: "none",
      minify: false,
      root: appsRoot,
    });
  } catch (err) {
    return {
      status: "failed",
      message: sanitizeBuildMessage(
        err instanceof Error ? err.message : "Agent tool build failed.",
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
      status: "failed",
      message: sanitizeBuildMessage(
        diagnostic.length > 0 ? diagnostic : "Agent tool build failed.",
        redactPaths,
      ),
    };
  }

  const bundleOutput = buildResult.outputs[0];
  if (!bundleOutput) {
    return {
      status: "failed",
      message: sanitizeBuildMessage("Agent tool build produced no output.", redactPaths),
    };
  }

  try {
    const builtPath = bundleOutput.path;
    if (builtPath !== outputFile) {
      await rename(builtPath, outputFile);
    }
  } catch (err) {
    return {
      status: "failed",
      message: sanitizeBuildMessage(
        err instanceof Error ? err.message : "Failed to finalize agent tool bundle.",
        redactPaths,
      ),
    };
  }

  const toolNames = tools.map((tool) => generateMiniAppAgentToolName(appId, tool.id));
  return {
    status: "ok",
    outputFile: "agent-tools.mjs",
    toolCount: tools.length,
    toolNames,
  };
}
