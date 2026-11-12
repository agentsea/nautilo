import { createHash } from "node:crypto";
import artifacts from "./chromium-artifacts.json";
import type { RuntimeImageEvidenceManifestV1 } from "./runtime-image-evidence.ts";

export const CHROMIUM_EXECUTABLE_PATH = "/opt/nautilo/chromium/chrome-headless-shell";
export const CHROMIUM_RECEIPT_PATH = "/opt/nautilo/chromium/artifact-manifest.json";
const AUGMENTATION = "source-pinned-chrome-headless-shell";
const CATALOGER = "nautilo-source-pinned-chromium";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Chromium SBOM evidence: ${message}`);
}

function expected(manifest: RuntimeImageEvidenceManifestV1) {
  const pin = artifacts.targets[manifest.architecture];
  return {
    schemaVersion: 1, augmentation: AUGMENTATION, sourceSha: manifest.sourceSha,
    architecture: manifest.architecture, image: manifest.image, version: artifacts.version,
    url: pin.url, archiveSha256: pin.sha256, executableSha256: pin.executableSha256,
    executablePath: CHROMIUM_EXECUTABLE_PATH, receiptPath: CHROMIUM_RECEIPT_PATH,
    componentId: createHash("sha256").update(`${CATALOGER}:${manifest.architecture}:${pin.executableSha256}`).digest("hex"),
  };
}

export function chromiumCpe(version: string): string {
  return `cpe:2.3:a:google:chrome:${version}:*:*:*:*:*:*:*`;
}

/** Runs inside the immutable image; no browser execution or network is needed. */
export const CHROMIUM_INVENTORY_PROBE = `
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const bytes = readFileSync(${JSON.stringify(CHROMIUM_EXECUTABLE_PATH)});
if (bytes.length < 20 || bytes.subarray(0, 4).toString("hex") !== "7f454c46") throw new Error("Chromium is not an ELF executable");
console.log(JSON.stringify({ platform: process.platform, arch: process.arch,
  executableSha256: createHash("sha256").update(bytes).digest("hex"),
  elf: { class: bytes[4] === 2 ? 64 : 32, endianness: bytes[5] === 1 ? "little" : "big", machine: bytes.readUInt16LE(18) },
  receipt: JSON.parse(readFileSync(${JSON.stringify(CHROMIUM_RECEIPT_PATH)}, "utf8")) }));
`;

/** Additive inventory: retain every Syft field and package, and disclose provenance. */
export function augmentChromiumSbom(rawSyft: string, manifest: RuntimeImageEvidenceManifestV1, observation: unknown): Record<string, unknown> {
  const sbom: unknown = JSON.parse(rawSyft);
  if (!record(sbom) || !Array.isArray(sbom["artifacts"])) fail("Syft artifacts are missing");
  if (sbom["nautiloChromium"] !== undefined) fail("Syft input already contains an augmentation");
  const proof = expected(manifest);
  if (!record(observation) || observation["platform"] !== "linux" || observation["arch"] !== (manifest.architecture === "linux/amd64" ? "x64" : "arm64")) fail("probe platform does not match the manifest");
  if (observation["executableSha256"] !== proof.executableSha256) fail("image executable hash does not match the source pin");
  const elf = observation["elf"];
  if (!record(elf) || elf["class"] !== 64 || elf["endianness"] !== "little" || elf["machine"] !== (manifest.architecture === "linux/amd64" ? 62 : 183)) fail("ELF architecture does not match the manifest");
  const receipt = observation["receipt"];
  if (!record(receipt) || receipt["schemaVersion"] !== 1 || receipt["version"] !== proof.version || receipt["platform"] !== proof.architecture || receipt["archiveSha256"] !== proof.archiveSha256 || receipt["executableSha256"] !== proof.executableSha256 || receipt["url"] !== proof.url) fail("image receipt does not match the source pin");
  if (sbom["artifacts"].some((entry: unknown) => record(entry) && entry["id"] === proof.componentId)) fail("component ID collides with the raw inventory");
  const augmented = {
    ...sbom,
    artifacts: [...sbom["artifacts"], {
      id: proof.componentId, name: "google-chrome", version: proof.version, type: "binary", foundBy: CATALOGER,
      locations: [{ path: CHROMIUM_EXECUTABLE_PATH, accessPath: CHROMIUM_EXECUTABLE_PATH, annotations: { evidence: "primary" } }],
      licenses: [], language: "", cpes: [{ cpe: chromiumCpe(proof.version), source: CATALOGER }],
      purl: `pkg:generic/google-chrome@${proof.version}?arch=${manifest.architecture.split("/")[1]}`,
    }],
    nautiloChromium: {
      ...proof, rawSyftSha256: `sha256:${createHash("sha256").update(rawSyft).digest("hex")}`,
      verification: { platform: observation["platform"], arch: observation["arch"], elf },
      coverage: { grype: "google-chrome-cpe", trivy: "image-os-dependencies-and-licenses" },
    },
  };
  assertChromiumSbomEvidence(augmented, manifest);
  return augmented;
}

/** Release consumers must reject missing, altered, or source-unbound browser inventory. */
export function assertChromiumSbomEvidence(sbom: unknown, manifest: RuntimeImageEvidenceManifestV1): void {
  if (!record(sbom) || !Array.isArray(sbom["artifacts"]) || !record(sbom["nautiloChromium"])) fail("augmentation is missing");
  const proof = sbom["nautiloChromium"];
  for (const [key, value] of Object.entries(expected(manifest))) {
    if (key === "image") {
      const image = proof["image"];
      if (!record(image) || Object.entries(manifest.image).some(([field, expectedValue]) => image[field] !== expectedValue)) fail("image binding differs from the manifest");
    } else if (proof[key] !== value) fail(`${key} differs from the source pin or manifest`);
  }
  if (typeof proof["rawSyftSha256"] !== "string" || !/^sha256:[a-f0-9]{64}$/.test(proof["rawSyftSha256"])) fail("raw Syft hash is missing");
  const verification = proof["verification"];
  const elf = record(verification) ? verification["elf"] : undefined;
  if (!record(verification) || verification["platform"] !== "linux" || verification["arch"] !== (manifest.architecture === "linux/amd64" ? "x64" : "arm64") || !record(elf) || elf["class"] !== 64 || elf["endianness"] !== "little" || elf["machine"] !== (manifest.architecture === "linux/amd64" ? 62 : 183)) fail("verified platform is missing or wrong");
  const components = sbom["artifacts"].filter((entry: unknown) => record(entry) && entry["id"] === proof["componentId"]);
  if (components.length !== 1) fail("exactly one verified Chrome component is required");
  const component = components[0] as Record<string, unknown>;
  if (component["name"] !== "google-chrome" || component["version"] !== artifacts.version || component["type"] !== "binary" || component["foundBy"] !== CATALOGER || !Array.isArray(component["cpes"]) || !component["cpes"].some((entry: unknown) => record(entry) && entry["cpe"] === chromiumCpe(artifacts.version) && entry["source"] === CATALOGER) || !Array.isArray(component["locations"]) || !component["locations"].some((entry: unknown) => record(entry) && entry["path"] === CHROMIUM_EXECUTABLE_PATH)) fail("Chrome component identity, location, or CPE is invalid");
}
