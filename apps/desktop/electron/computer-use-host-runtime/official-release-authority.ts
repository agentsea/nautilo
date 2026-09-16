import { createHash, timingSafeEqual } from "node:crypto";
import type {
  ComputerUseHostArchitecture,
  ComputerUseHostMember,
  ComputerUseHostRelease,
  ComputerUseHostReleaseAuthority,
} from "./contracts.ts";

export const OFFICIAL_COMPUTER_USE_HOST_POINTER_URL =
  "https://media.nautilo.ai/computer-use/host/v1/latest.json";
const OFFICIAL_ORIGIN = "https://media.nautilo.ai";
const OFFICIAL_PREFIX = "/computer-use/host/v1/";
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u;
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

type FetchLike = (input: string, init: Readonly<{ redirect: "error"; signal?: AbortSignal }>) => Promise<Response>;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function officialUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.origin === OFFICIAL_ORIGIN && url.pathname.startsWith(OFFICIAL_PREFIX)
      && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch { return null; }
}

function sameDigest(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

async function boundedText(fetcher: FetchLike, url: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const checked = officialUrl(url);
  if (checked === null) throw new Error("host release URL rejected");
  const response = await fetcher(checked.href, { redirect: "error", ...(signal ? { signal } : {}) });
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const declaredText = response.headers.get("content-length");
  const declared = declaredText === null ? null : Number(declaredText);
  if (!response.ok || response.status !== 200 || response.url !== checked.href || contentType !== "application/json"
    || (declared !== null && (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes)) || !response.body) {
    throw new Error("host release response rejected");
  }
  type Reader = { read(): Promise<{ done: true } | { done: false; value: Uint8Array }>; releaseLock(): void };
  const reader = response.body.getReader() as unknown as Reader; const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("host release cancelled");
      const item = await reader.read(); if (item.done) break;
      total += item.value.byteLength; if (total > maxBytes) throw new Error("host release response too large");
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  if (declared !== null && total !== declared) throw new Error("host release length changed");
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function parseMember(value: unknown): ComputerUseHostMember | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, item["executable"] === undefined ? ["path", "bytes", "sha256"] : ["path", "bytes", "sha256", "executable"])
    || typeof item["path"] !== "string" || !Number.isSafeInteger(item["bytes"]) || Number(item["bytes"]) < 0
    || typeof item["sha256"] !== "string" || !SHA256.test(item["sha256"])
    || (item["executable"] !== undefined && item["executable"] !== true)) return null;
  return Object.freeze({ path: item["path"], bytes: Number(item["bytes"]), sha256: item["sha256"], ...(item["executable"] === true ? { executable: true as const } : {}) });
}

export function parseComputerUseHostRelease(
  value: unknown,
  pointerUrl = OFFICIAL_COMPUTER_USE_HOST_POINTER_URL,
  allowBundledBare = false,
): ComputerUseHostRelease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const archive = item["archive"]; const signature = item["signature"];
  if (!exactKeys(item, ["schemaVersion", "releaseId", "version", "pointerUrl", "archive", "entrypoint", "members", "architectures", "signature"])
    || item["schemaVersion"] !== 1 || typeof item["releaseId"] !== "string" || typeof item["version"] !== "string" || !VERSION.test(item["version"])
    || item["pointerUrl"] !== pointerUrl || typeof item["entrypoint"] !== "string" || !Array.isArray(item["members"])
    || !Array.isArray(item["architectures"]) || !archive || typeof archive !== "object" || Array.isArray(archive)
    || !signature || typeof signature !== "object" || Array.isArray(signature)) return null;
  const archiveItem = archive as Record<string, unknown>; const signatureItem = signature as Record<string, unknown>;
  const members = item["members"].map(parseMember);
  if (!exactKeys(archiveItem, ["format", "url", "bytes", "sha256"])
    || (archiveItem["format"] !== "tar.gz" && !(allowBundledBare && archiveItem["format"] === "bare"))
    || typeof archiveItem["url"] !== "string" || officialUrl(archiveItem["url"]) === null
    || !Number.isSafeInteger(archiveItem["bytes"]) || Number(archiveItem["bytes"]) <= 0
    || typeof archiveItem["sha256"] !== "string" || !SHA256.test(archiveItem["sha256"])
    || !exactKeys(signatureItem, ["teamId", "designatedRequirement", "notarized"])
    || typeof signatureItem["teamId"] !== "string" || !/^[A-Z0-9]{10}$/u.test(signatureItem["teamId"])
    || typeof signatureItem["designatedRequirement"] !== "string" || signatureItem["designatedRequirement"].length < 1
    || signatureItem["notarized"] !== true || members.some((member) => member === null)) return null;
  const architectures = item["architectures"];
  if (architectures.length !== 2 || architectures[0] !== "arm64" || architectures[1] !== "x64") return null;
  return Object.freeze({
    schemaVersion: 1,
    releaseId: item["releaseId"],
    version: item["version"],
    pointerUrl,
    archive: Object.freeze({ format: archiveItem["format"], url: archiveItem["url"], bytes: Number(archiveItem["bytes"]), sha256: archiveItem["sha256"] }),
    entrypoint: item["entrypoint"],
    members: Object.freeze(members as ComputerUseHostMember[]),
    architectures: Object.freeze(["arm64", "x64"] as ComputerUseHostArchitecture[]),
    signature: Object.freeze({ teamId: signatureItem["teamId"], designatedRequirement: signatureItem["designatedRequirement"], notarized: true }),
  });
}

export class OfficialComputerUseHostReleaseAuthority implements ComputerUseHostReleaseAuthority {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async resolveOfficialRelease(officialPointerUrl: string, signal?: AbortSignal): Promise<ComputerUseHostRelease> {
    if (officialPointerUrl !== OFFICIAL_COMPUTER_USE_HOST_POINTER_URL) throw new Error("host pointer authority rejected");
    const pointerBytes = await boundedText(this.fetcher, officialPointerUrl, MAX_POINTER_BYTES, signal);
    const pointer = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pointerBytes)) as unknown;
    if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) throw new Error("host pointer rejected");
    const item = pointer as Record<string, unknown>;
    if (!exactKeys(item, ["schemaVersion", "manifestUrl", "manifestBytes", "manifestSha256"]) || item["schemaVersion"] !== 1
      || typeof item["manifestUrl"] !== "string" || officialUrl(item["manifestUrl"]) === null
      || !Number.isSafeInteger(item["manifestBytes"]) || Number(item["manifestBytes"]) <= 0 || Number(item["manifestBytes"]) > MAX_MANIFEST_BYTES
      || typeof item["manifestSha256"] !== "string" || !SHA256.test(item["manifestSha256"])) throw new Error("host pointer rejected");
    const manifestBytes = await boundedText(this.fetcher, item["manifestUrl"], Number(item["manifestBytes"]), signal);
    if (manifestBytes.byteLength !== item["manifestBytes"]
      || !sameDigest(createHash("sha256").update(manifestBytes).digest("hex"), item["manifestSha256"])) throw new Error("host manifest digest rejected");
    const release = parseComputerUseHostRelease(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)), officialPointerUrl);
    if (release === null) throw new Error("host manifest rejected");
    return release;
  }
}
