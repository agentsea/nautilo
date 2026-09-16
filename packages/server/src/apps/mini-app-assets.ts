import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { DOMParser, XMLSerializer, type Document, type Element } from "@xmldom/xmldom";
import { findArtifactByInternalIdForNamespaces, type Artifact } from "@nautilo/db";
import { physicalPathFromStorageUri } from "@nautilo/agent";
import sharp from "sharp";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ASSET_REF_RE = /^artifact:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([a-f0-9]{64})$/u;
const SVG_ASSET_HREF_PREFIX = "nautilo-asset:";
const LOCAL_FRAGMENT_RE = /^#[A-Za-z_][A-Za-z0-9_.-]*$/u;
const LOCAL_URL_RE = /^url\(#[A-Za-z_][A-Za-z0-9_.-]*\)$/u;
const FONT_DATA_URL_RE = /^data:font\/ttf;base64,[A-Za-z0-9+/]+={0,2}$/u;
const SAFE_EXPORT_SVG_ELEMENTS = new Set([
  "svg", "defs", "style", "mask", "g", "use", "path", "rect", "text", "tspan", "image",
]);

export type ParsedMiniAppAssetRef = Readonly<{
  artifactId: string;
  sha256: string;
}>;

export type MiniAppAssetFailure = Readonly<{
  ok: false;
  code:
    | "INVALID_ASSET_REF"
    | "ASSET_NOT_FOUND"
    | "ASSET_BYTES_UNAVAILABLE"
    | "ASSET_CHANGED"
    | "UNSUPPORTED_ASSET_FORMAT"
    | "ANIMATED_ASSET_UNSUPPORTED"
    | "ASSET_DECODE_FAILED"
    | "INVALID_SVG_ASSET_REFERENCE";
  message: string;
}>;

export type ResolvedMiniAppRasterAsset = Readonly<{
  ok: true;
  ref: string;
  artifactId: string;
  name: string;
  width: number;
  height: number;
  originalSha256: string;
  pngBytes: Buffer;
  pngDataUrl: string;
}>;

export type MiniAppAssetInspectResult =
  | Readonly<{ ok: true; ref: string; name: string; width: number; height: number }>
  | MiniAppAssetFailure;

type FindArtifact = (input: {
  internalId: string;
  readableNamespaceIds: string[];
}) => Promise<Artifact | null>;

export type MiniAppAssetDependencies = Readonly<{
  findArtifact?: FindArtifact;
  readArtifactBytes?: (path: string) => Promise<Uint8Array>;
}>;

export function parseMiniAppAssetRef(value: string): ParsedMiniAppAssetRef | null {
  const match = ASSET_REF_RE.exec(value);
  return match ? { artifactId: match[1]!, sha256: match[2]! } : null;
}

export function formatMiniAppAssetRef(artifactId: string, sha256: string): string | null {
  const parsed = parseMiniAppAssetRef(`artifact:${artifactId}:${sha256}`);
  return parsed ? `artifact:${parsed.artifactId}:${parsed.sha256}` : null;
}

function failure(code: MiniAppAssetFailure["code"], message: string): MiniAppAssetFailure {
  return { ok: false, code, message };
}

function rasterKind(bytes: Uint8Array): "png" | "jpeg" | "webp" | null {
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "png";
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.byteLength >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) return "webp";
  return null;
}

function pngIsAnimated(bytes: Uint8Array): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = Buffer.from(bytes.subarray(offset, offset + 4)).readUInt32BE(0);
    if (length > bytes.byteLength - offset - 12) return false;
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString("ascii");
    if (type === "acTL") return true;
    offset += 12 + length;
  }
  return false;
}

function webpIsAnimated(bytes: Uint8Array): boolean {
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const type = Buffer.from(bytes.subarray(offset, offset + 4)).toString("ascii");
    const length = Buffer.from(bytes.subarray(offset + 4, offset + 8)).readUInt32LE(0);
    if (
      type === "ANIM" ||
      type === "ANMF" ||
      (type === "VP8X" && ((bytes[offset + 8] ?? 0) & 0x02) !== 0)
    ) return true;
    const padded = length + (length % 2);
    if (padded > bytes.byteLength - offset - 8) return false;
    offset += 8 + padded;
  }
  return false;
}

async function normalizeRasterBytes(
  bytes: Uint8Array,
): Promise<
  | { ok: true; pngBytes: Buffer; width: number; height: number }
  | MiniAppAssetFailure
> {
  const kind = rasterKind(bytes);
  if (!kind) {
    return failure(
      "UNSUPPORTED_ASSET_FORMAT",
      "Design image assets must be PNG, JPEG, or WebP bytes.",
    );
  }
  if ((kind === "png" && pngIsAnimated(bytes)) || (kind === "webp" && webpIsAnimated(bytes))) {
    return failure(
      "ANIMATED_ASSET_UNSUPPORTED",
      "Animated image assets are not supported by Design.",
    );
  }
  try {
    const image = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: false,
      unlimited: false,
      animated: true,
    });
    const metadata = await image.metadata();
    if (metadata.format !== kind) {
      return failure("UNSUPPORTED_ASSET_FORMAT", "Image bytes do not match a supported raster format.");
    }
    if ((metadata.pages ?? 1) !== 1) {
      return failure(
        "ANIMATED_ASSET_UNSUPPORTED",
        "Animated image assets are not supported by Design.",
      );
    }
    const rendered = await sharp(bytes, {
      failOn: "warning",
      limitInputPixels: false,
      unlimited: false,
    })
      .rotate()
      .png()
      .toBuffer({ resolveWithObject: true });
    if (
      rendered.info.format !== "png" ||
      !Number.isSafeInteger(rendered.info.width) || rendered.info.width < 1 ||
      !Number.isSafeInteger(rendered.info.height) || rendered.info.height < 1
    ) {
      return failure("ASSET_DECODE_FAILED", "Decoded image dimensions are invalid.");
    }
    return {
      ok: true,
      pngBytes: rendered.data,
      width: rendered.info.width,
      height: rendered.info.height,
    };
  } catch (error) {
    return failure(
      "ASSET_DECODE_FAILED",
      `Image decoding failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function resolveWorkspaceRasterAsset(
  ref: string,
  readableNamespaceIds: readonly string[],
  dependencies: MiniAppAssetDependencies = {},
): Promise<ResolvedMiniAppRasterAsset | MiniAppAssetFailure> {
  const parsed = parseMiniAppAssetRef(ref);
  if (!parsed) return failure("INVALID_ASSET_REF", "Asset reference is invalid.");
  const findArtifact = dependencies.findArtifact ?? findArtifactByInternalIdForNamespaces;
  const artifact = await findArtifact({
    internalId: parsed.artifactId,
    readableNamespaceIds: [...readableNamespaceIds],
  });
  if (!artifact) {
    return failure("ASSET_NOT_FOUND", "Image asset is missing or is not readable in this Workspace.");
  }
  const physicalPath = physicalPathFromStorageUri(artifact.storageUri);
  if (!physicalPath) {
    return failure("ASSET_BYTES_UNAVAILABLE", "Image asset bytes are unavailable.");
  }
  let bytes: Uint8Array;
  try {
    bytes = await (dependencies.readArtifactBytes ?? readFile)(physicalPath);
  } catch {
    return failure("ASSET_BYTES_UNAVAILABLE", "Image asset bytes are unavailable.");
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== parsed.sha256) {
    return failure(
      "ASSET_CHANGED",
      "Image asset bytes changed. Relink the image to accept the current version.",
    );
  }
  const normalized = await normalizeRasterBytes(bytes);
  if (!normalized.ok) return normalized;
  return {
    ok: true,
    ref,
    artifactId: parsed.artifactId,
    name: basename(artifact.path) || "Image",
    width: normalized.width,
    height: normalized.height,
    originalSha256: actualSha256,
    pngBytes: normalized.pngBytes,
    pngDataUrl: `data:image/png;base64,${normalized.pngBytes.toString("base64")}`,
  };
}

export async function inspectWorkspaceRasterAsset(
  artifactId: string,
  readableNamespaceIds: readonly string[],
  dependencies: MiniAppAssetDependencies = {},
): Promise<MiniAppAssetInspectResult> {
  if (!ASSET_REF_RE.test(`artifact:${artifactId}:${"0".repeat(64)}`)) {
    return failure("INVALID_ASSET_REF", "Workspace artifact id is invalid.");
  }
  const findArtifact = dependencies.findArtifact ?? findArtifactByInternalIdForNamespaces;
  const artifact = await findArtifact({ internalId: artifactId, readableNamespaceIds: [...readableNamespaceIds] });
  if (!artifact) {
    return failure("ASSET_NOT_FOUND", "Image asset is missing or is not readable in this Workspace.");
  }
  const physicalPath = physicalPathFromStorageUri(artifact.storageUri);
  if (!physicalPath) return failure("ASSET_BYTES_UNAVAILABLE", "Image asset bytes are unavailable.");
  let bytes: Uint8Array;
  try {
    bytes = await (dependencies.readArtifactBytes ?? readFile)(physicalPath);
  } catch {
    return failure("ASSET_BYTES_UNAVAILABLE", "Image asset bytes are unavailable.");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ref = formatMiniAppAssetRef(artifactId, sha256)!;
  const resolved = await resolveWorkspaceRasterAsset(ref, readableNamespaceIds, {
    findArtifact: () => Promise.resolve(artifact),
    readArtifactBytes: () => Promise.resolve(bytes),
  });
  if (!resolved.ok) return resolved;
  return { ok: true, ref, name: resolved.name, width: resolved.width, height: resolved.height };
}

export type ResolvedSvgAssets = Readonly<{
  ok: true;
  svg: string;
  approvedPngDataUrls: ReadonlySet<string>;
}>;

function parseSvg(source: string): Document {
  if (/<\s*!\s*(?:DOCTYPE|ENTITY)|<\?/iu.test(source)) {
    throw new Error("SVG declarations, entities, and processing instructions are unsupported.");
  }
  return new DOMParser({
    locator: false,
    onError(_level, message) {
      throw new Error(message);
    },
  }).parseFromString(source, "image/svg+xml");
}

function styleHasSafeResources(css: string): boolean {
  if (css.includes("\\") || /@import|expression\s*\(/iu.test(css)) return false;
  const urlRe = /url\(([^)]*)\)/giu;
  let match: RegExpExecArray | null;
  while ((match = urlRe.exec(css)) !== null) {
    const value = match[1]!.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2");
    if (!FONT_DATA_URL_RE.test(value) && !LOCAL_FRAGMENT_RE.test(value)) return false;
  }
  const withoutAllowedUrls = css.replace(/url\(([^)]*)\)/giu, "");
  return !/(?:url|https?:|file:|blob:|javascript:|\/\/)/iu.test(withoutAllowedUrls);
}

/**
 * Resolve only host-owned Design image references and reject resource escapes.
 * The returned data URLs are transient export material; source documents keep
 * only their pinned `artifact:<uuid>:<sha256>` references.
 */
export async function resolveMiniAppAssetReferencesInSvg(
  source: string,
  resolveAsset: (ref: string) => Promise<ResolvedMiniAppRasterAsset | MiniAppAssetFailure>,
): Promise<ResolvedSvgAssets | MiniAppAssetFailure> {
  let document: Document;
  try {
    document = parseSvg(source);
  } catch (error) {
    return failure(
      "INVALID_SVG_ASSET_REFERENCE",
      `SVG XML is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = document.documentElement;
  if (!root || root.tagName !== "svg" || root.namespaceURI !== SVG_NAMESPACE) {
    return failure("INVALID_SVG_ASSET_REFERENCE", "Asset-bearing SVG must have a canonical svg root.");
  }
  for (let child = document.firstChild; child; child = child.nextSibling) {
    if (child === root) continue;
    if (child.nodeType === 3 && !(child.nodeValue ?? "").trim()) continue;
    return failure("INVALID_SVG_ASSET_REFERENCE", "Asset-bearing SVG must contain one root element.");
  }
  const approved = new Set<string>();
  const cache = new Map<string, ResolvedMiniAppRasterAsset>();
  let replacements = 0;
  const elements = [root, ...Array.from(root.getElementsByTagName("*"))] as Element[];
  for (const element of elements) {
    if (element.namespaceURI !== SVG_NAMESPACE || !SAFE_EXPORT_SVG_ELEMENTS.has(element.tagName)) {
      return failure("INVALID_SVG_ASSET_REFERENCE", `SVG element ${element.tagName} is not allowed in an asset export.`);
    }
    if (element.tagName === "style" && !styleHasSafeResources(element.textContent ?? "")) {
      return failure("INVALID_SVG_ASSET_REFERENCE", "SVG style contains an external or unsupported resource.");
    }
    for (let index = 0; index < element.attributes.length; index += 1) {
      const attribute = element.attributes.item(index)!;
      const name = attribute.name;
      const value = attribute.value.trim();
      if (/^on/iu.test(name) || name === "src" || name === "poster" || name.includes(":")) {
        return failure("INVALID_SVG_ASSET_REFERENCE", `SVG attribute ${name} is not allowed in an asset export.`);
      }
      if (name === "style" && !styleHasSafeResources(value)) {
        return failure("INVALID_SVG_ASSET_REFERENCE", "SVG style contains an external or unsupported resource.");
      }
      if (/url\s*\(/iu.test(value) && !LOCAL_URL_RE.test(value) && name !== "style") {
        return failure("INVALID_SVG_ASSET_REFERENCE", `SVG attribute ${name} contains an external resource.`);
      }
      if (name === "href" && element.tagName !== "image" && !LOCAL_FRAGMENT_RE.test(value)) {
        return failure("INVALID_SVG_ASSET_REFERENCE", "SVG href must be a local fragment reference.");
      }
    }
    if (element.tagName !== "image") continue;
    const href = element.getAttribute("href");
    if (!href || !href.startsWith(SVG_ASSET_HREF_PREFIX)) {
      return failure(
        "INVALID_SVG_ASSET_REFERENCE",
        "SVG images must use host-owned nautilo-asset references.",
      );
    }
    const ref = href.slice(SVG_ASSET_HREF_PREFIX.length);
    if (!parseMiniAppAssetRef(ref)) {
      return failure("INVALID_ASSET_REF", "SVG image asset reference is invalid.");
    }
    let resolved = cache.get(ref);
    if (!resolved) {
      const result = await resolveAsset(ref);
      if (!result.ok) return result;
      resolved = result;
      cache.set(ref, result);
    }
    element.setAttribute("href", resolved.pngDataUrl);
    approved.add(resolved.pngDataUrl);
    replacements += 1;
  }
  return {
    ok: true,
    svg: replacements === 0 ? source : new XMLSerializer().serializeToString(document),
    approvedPngDataUrls: approved,
  };
}
