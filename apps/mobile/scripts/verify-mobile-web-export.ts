import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const MOBILE_BASE_PATH = "/mobile/";
// Keep this byte-for-byte aligned with the server's CSP hash input. The
// server image deliberately does not carry Mobile source, so this contract is
// duplicated rather than importing server code into the Expo build closure.
export const MOBILE_WEB_EXPO_HYDRATION_SCRIPT_BODY =
  "globalThis.__EXPO_ROUTER_HYDRATE__=true;" as const;
export const MOBILE_WEB_FINGERPRINT_BASENAME_RE = /[-.][0-9a-f]{32}(?:@[0-9]+x)?\.[^.]+$/;
export const REQUIRED_MOBILE_WEB_SHELLS = [
  "index.html",
  "callback.html",
  "sign-in.html",
  "chat/[roomId].html",
  "tasks/[taskId].html",
  "files.html",
  "files/artifact/[id].html",
  "search/chats.html",
  "settings/index.html",
] as const;
export const FORBIDDEN_WEB_AUTHORITY_SENTINELS = [
  "nautilo://callback",
  "expo-secure-store",
  "expo-notifications",
  "createPushBindingStore",
  "nautilo.remote.controller.seed.",
  "nautilo.inbound-share-custody",
  "nautilo.pending-share",
  "modules/nautilo-share-handoff",
] as const;

const RESOURCE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  audio: ["src"], embed: ["src"], frame: ["src"], iframe: ["src"], img: ["src", "srcset"],
  image: ["href", "xlink:href"], input: ["src"], object: ["data"], script: ["src"],
  source: ["src", "srcset"], track: ["src"], video: ["src", "poster"],
};
const RESOURCE_LINK_RELS = new Set(["icon", "manifest", "modulepreload", "prefetch", "preload", "stylesheet"]);
const GENERATED_ASSET_ROOTS = ["_expo/static", "assets"] as const;

type ResourceReference = { readonly attribute: string; readonly htmlFile: string; readonly tag: string; readonly value: string };

export class MobileWebExportValidationError extends Error {
  override name = "MobileWebExportValidationError";
}

function invalid(message: string): never {
  throw new MobileWebExportValidationError(message);
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) invalid(`export contains a symbolic link: ${entryPath}`);
    if (entry.isDirectory()) return listFiles(entryPath);
    return entry.isFile() ? [entryPath] : [];
  }));
  return nested.flat();
}

function decodeHtmlAttribute(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function attributesForTag(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const attributePattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of source.matchAll(attributePattern)) {
    const name = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    if (name && value !== undefined) attributes.set(name, decodeHtmlAttribute(value));
  }
  return attributes;
}

function collectResourceReferences(html: string, htmlFile: string): ResourceReference[] {
  const resources: ResourceReference[] = [];
  const tagPattern = /<([A-Za-z][A-Za-z0-9:-]*)\b([^>]*)>/g;
  for (const match of html.matchAll(tagPattern)) {
    const tag = match[1]?.toLowerCase();
    if (!tag) continue;
    const attributes = attributesForTag(match[2] ?? "");
    if (tag === "base" && attributes.has("href")) invalid(`${htmlFile}: <base href> changes static-resource resolution`);
    const rel = attributes.get("rel")?.split(/\s+/).some((value) => RESOURCE_LINK_RELS.has(value.toLowerCase())) ?? false;
    const names = tag === "link" && rel ? ["href"] : RESOURCE_ATTRIBUTES[tag] ?? [];
    for (const attribute of names) {
      const value = attributes.get(attribute);
      if (!value) continue;
      const values = attribute === "srcset" ? value.split(",").map((candidate) => candidate.trim().split(/\s+/, 1)[0]).filter(Boolean) : [value];
      for (const reference of values) resources.push({ attribute, htmlFile, tag, value: reference });
    }
  }
  return resources;
}

function requirePinnedHydrationScript(html: string, htmlFile: string): void {
  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter((match) => !attributesForTag(match[1] ?? "").has("src"));
  if (
    inlineScripts.length !== 1 ||
    inlineScripts[0]?.[2] !== MOBILE_WEB_EXPO_HYDRATION_SCRIPT_BODY
  ) {
    invalid(`${htmlFile}: missing or unexpected Expo Router hydration script`);
  }
}

function localPathForResource(outputDirectory: string, reference: ResourceReference): string {
  const value = reference.value;
  if (value.includes("?") || value.includes("#")) invalid(`${reference.htmlFile}: ${reference.tag}[${reference.attribute}] has a query or fragment`);
  if (value.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) invalid(`${reference.htmlFile}: ${reference.tag}[${reference.attribute}] has external resource authority`);
  if (!value.startsWith(MOBILE_BASE_PATH)) invalid(`${reference.htmlFile}: ${reference.tag}[${reference.attribute}] escapes ${MOBILE_BASE_PATH}`);
  let relativePath: string;
  try { relativePath = decodeURIComponent(value.slice(MOBILE_BASE_PATH.length)); } catch { invalid(`${reference.htmlFile}: resource path has invalid encoding`); }
  if (!relativePath || relativePath.includes("\\")) invalid(`${reference.htmlFile}: resource path is invalid`);
  const outputRoot = path.resolve(outputDirectory);
  const localPath = path.resolve(outputRoot, relativePath);
  if (!localPath.startsWith(`${outputRoot}${path.sep}`)) invalid(`${reference.htmlFile}: resource path escapes export`);
  return localPath;
}

async function requireDirectory(directory: string, label: string): Promise<void> {
  let details;
  try { details = await lstat(directory); } catch { invalid(`${label} is missing`); }
  if (!details!.isDirectory() || details!.isSymbolicLink()) invalid(`${label} is not a real directory`);
}

export interface MobileWebExportVerification {
  readonly htmlFiles: number;
  readonly resourceReferences: number;
  readonly verifiedLocalFiles: number;
  readonly generatedAssetFiles: number;
}

/** Filesystem-only validation; HTTP MIME/CSP is intentionally a server gate. */
export async function verifyMobileWebExport(outputDirectoryArgument: string): Promise<MobileWebExportVerification> {
  const outputDirectory = path.resolve(outputDirectoryArgument);
  await requireDirectory(outputDirectory, "export output");
  const outputFiles = (await listFiles(outputDirectory)).sort();
  const relativeFiles = new Set(outputFiles.map((file) => path.relative(outputDirectory, file).replaceAll("\\", "/")));
  for (const shell of REQUIRED_MOBILE_WEB_SHELLS) {
    if (!relativeFiles.has(shell)) invalid(`required route shell is missing: ${shell}`);
  }
  const htmlFiles = outputFiles.filter((file) => file.endsWith(".html"));
  if (htmlFiles.length === 0) invalid("export contains no HTML files");
  if (outputFiles.some((file) => file.endsWith(".map"))) invalid("export publishes source maps");
  const sourceFiles = outputFiles.filter((file) => /\.(?:js|mjs|css)$/.test(file));
  const sources = await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")));
  if (sources.some((source) => /sourceMappingURL\s*=/.test(source))) {
    invalid("export contains sourceMappingURL directives");
  }
  if (sources.some((source) => FORBIDDEN_WEB_AUTHORITY_SENTINELS.some((sentinel) => source.includes(sentinel)))) {
    invalid("export contains a forbidden native authority sentinel");
  }
  let generatedAssetFiles = 0;
  for (const assetRoot of GENERATED_ASSET_ROOTS) {
    const absoluteRoot = path.join(outputDirectory, assetRoot);
    await requireDirectory(absoluteRoot, `generated asset tree ${assetRoot}`);
    const assets = await listFiles(absoluteRoot);
    if (assets.length === 0) invalid(`generated asset tree ${assetRoot} is empty`);
    for (const asset of assets) {
      if (!MOBILE_WEB_FINGERPRINT_BASENAME_RE.test(path.basename(asset))) invalid(`generated asset is not fingerprinted: ${path.relative(outputDirectory, asset)}`);
    }
    generatedAssetFiles += assets.length;
  }
  const htmlSources = await Promise.all(htmlFiles.map(async (htmlFile) => ({
    htmlFile,
    relativeHtmlFile: path.relative(outputDirectory, htmlFile),
    source: await readFile(htmlFile, "utf8"),
  })));
  const resources = htmlSources.flatMap(({ source, relativeHtmlFile }) => {
    requirePinnedHydrationScript(source, relativeHtmlFile);
    return collectResourceReferences(source, relativeHtmlFile);
  });
  if (resources.length === 0) invalid("export HTML contains no app-controlled static resource references");
  const verifiedFiles = new Set<string>();
  for (const resource of resources) {
    const localPath = localPathForResource(outputDirectory, resource);
    let details;
    try { details = await stat(localPath); } catch { invalid(`${resource.htmlFile}: resource does not exist`); }
    if (!details!.isFile() || details!.isSymbolicLink()) invalid(`${resource.htmlFile}: resource is not a real file`);
    verifiedFiles.add(path.relative(outputDirectory, localPath));
  }
  return { htmlFiles: htmlFiles.length, resourceReferences: resources.length, verifiedLocalFiles: verifiedFiles.size, generatedAssetFiles };
}

async function main(): Promise<void> {
  const receipt = await verifyMobileWebExport(process.argv[2] ?? "dist");
  process.stdout.write(`${JSON.stringify({ event: "mobile-web-export-verified", ...receipt })}\n`);
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "verification failed";
    process.stderr.write(`${JSON.stringify({ event: "mobile-web-export-invalid", error: message })}\n`);
    process.exitCode = 1;
  });
}
