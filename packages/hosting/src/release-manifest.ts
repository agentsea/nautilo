import { createPublicKey, verify as verifyEd25519 } from "node:crypto";

/** The only release-envelope schema this hosting package currently understands. */
export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
/** The only topology grammar this implementation can safely map to a driver. */
export const RELEASE_TOPOLOGY_SCHEMA_VERSION = 1;

const IMAGE_DIGEST_PATTERN = /@sha256:[a-f0-9]{64}$/;
const OCI_IMAGE_REFERENCE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?@sha256:[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const V1_SERVICE_IMAGE = {
  "app-postgres": "app-postgres",
  "logto-postgres": "logto-postgres",
  "logto-seed": "logto",
  logto: "logto",
  "nautilo-server": "nautilo-server",
} as const;

const V1_IMAGE_NAMES = [
  "app-postgres",
  "logto-postgres",
  "logto",
  "nautilo-server",
  "nautilo-bootstrap",
] as const;

const V1_MOUNT_BINDING = {
  "app-postgres-data": { service: "app-postgres", mountPath: "/var/lib/postgresql/data" },
  "logto-postgres-data": { service: "logto-postgres", mountPath: "/var/lib/postgresql/data" },
  "nautilo-data": { service: "nautilo-server", mountPath: "/var/lib/nautilo" },
} as const;

export type ReleaseServiceRole = keyof typeof V1_SERVICE_IMAGE;
export type ReleaseImageName = (typeof V1_IMAGE_NAMES)[number];
export type ReleasePersistentMountRole = keyof typeof V1_MOUNT_BINDING;

/** Inclusive integer version range deliberately avoids string-version folklore. */
export interface ReleaseVersionRange {
  readonly minimum: number;
  readonly maximum: number;
}

export interface ReleaseImage {
  /** Stable logical identity used by a topology service declaration. */
  readonly name: ReleaseImageName;
  /** Immutable OCI image reference ending in `@sha256:<64 lowercase hex>`. */
  readonly reference: string;
}

export interface ReleaseService {
  /** V1 is deliberately exact: service name equals its logical role. */
  readonly name: string;
  readonly role: ReleaseServiceRole;
  readonly image: ReleaseImageName;
}

/** One durable POSIX volume intent. V1 has no object-storage topology. */
export interface ReleasePersistentMount {
  readonly role: ReleasePersistentMountRole;
  readonly service: ReleaseServiceRole;
  readonly mountPath: string;
}

/**
 * The transient DB-reconciliation job. A driver must remove and verify its
 * absence before starting the final five-service graph.
 */
export interface ReleaseBootstrap {
  readonly image: "nautilo-bootstrap";
}

/**
 * Provider-neutral topology shape. Drivers map these logical declarations to
 * their own final services, transient bootstrap job, and durable POSIX mounts;
 * it contains no provider IDs, variables, credentials, network rules, domains,
 * or mutable image tags.
 */
export interface ReleaseTopology {
  readonly schemaVersion: number;
  readonly bootstrap: ReleaseBootstrap;
  readonly services: readonly ReleaseService[];
  readonly persistentMounts: readonly ReleasePersistentMount[];
  readonly environmentSchemaVersion: number;
  readonly migrationSchemaVersion: number;
}

/** Compatibility promises made by a release to a hosting runtime. */
export interface ReleaseCompatibility {
  readonly runtime: ReleaseVersionRange;
  readonly protocol: ReleaseVersionRange;
  readonly topology: ReleaseVersionRange;
}

/** The exact, non-secret data covered by the signature. */
export interface ReleaseManifest {
  readonly schemaVersion: typeof RELEASE_MANIFEST_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly images: readonly ReleaseImage[];
  readonly topology: ReleaseTopology;
  readonly compatibility: ReleaseCompatibility;
}

/**
 * A release manifest that crossed this module's complete parse, signature,
 * trust-root, and compatibility gate. The private brand prevents ordinary
 * parsed manifest data from satisfying downstream verified-only APIs while
 * adding no property to the signed/runtime JSON shape.
 */
declare const VERIFIED_RELEASE_MANIFEST: unique symbol;
export type VerifiedReleaseManifest = ReleaseManifest & {
  readonly [VERIFIED_RELEASE_MANIFEST]: true;
};

export interface ReleaseManifestSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  /** Standard base64 of a 64-byte Ed25519 signature. */
  readonly value: string;
}

export interface SignedReleaseManifest {
  readonly manifest: ReleaseManifest;
  readonly signature: ReleaseManifestSignature;
}

/** Explicit host-side versions checked after signature verification. */
export interface ReleaseManifestRuntime {
  readonly runtimeVersion: number;
  readonly protocolVersion: number;
  readonly topologySchemaVersion: number;
}

/**
 * Trust roots are supplied by the caller. This task deliberately does not
 * distribute a production key or fetch one over the network.
 */
export interface ReleaseManifestTrust {
  /** key ID to base64 DER/SPKI Ed25519 public key. */
  readonly trustedPublicKeys: Readonly<Record<string, string>>;
  readonly verifier?: ReleaseManifestSignatureVerifier | undefined;
}

/** Injectable crypto seam for test harnesses and future platform adapters. */
export interface ReleaseManifestSignatureVerifier {
  verify(input: {
    readonly signedBytes: Uint8Array;
    readonly signature: Uint8Array;
    readonly publicKeyDer: Uint8Array;
  }): boolean;
}

export type ReleaseManifestFailureCode =
  | "hosting.release.malformed"
  | "hosting.release.unsupported-version"
  | "hosting.release.unsigned"
  | "hosting.release.untrusted-key"
  | "hosting.release.invalid-signature"
  | "hosting.release.mutable-image"
  | "hosting.release.incompatible-runtime"
  | "hosting.release.incompatible-topology";

export type ReleaseManifestVerification =
  | { readonly ok: true; readonly manifest: VerifiedReleaseManifest }
  | { readonly ok: false; readonly code: ReleaseManifestFailureCode };

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function readString(value: unknown, pattern?: RegExp): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return pattern && !pattern.test(value) ? null : value;
}

function readVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function readRange(value: unknown): ReleaseVersionRange | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["minimum", "maximum"])) return null;
  const minimum = readVersion(value["minimum"]);
  const maximum = readVersion(value["maximum"]);
  return minimum !== null && maximum !== null && minimum <= maximum ? { minimum, maximum } : null;
}

function readImage(value: unknown): ReleaseImage | null | "mutable" {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["name", "reference"])) return null;
  const name = readString(value["name"], IDENTIFIER_PATTERN);
  const reference = readString(value["reference"]);
  if (name === null || reference === null) return null;
  if (!IMAGE_DIGEST_PATTERN.test(reference) || !OCI_IMAGE_REFERENCE_PATTERN.test(reference)) return "mutable";
  return { name: name as ReleaseImageName, reference };
}

function readService(value: unknown): ReleaseService | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["name", "role", "image"])) return null;
  const name = readString(value["name"], IDENTIFIER_PATTERN);
  const image = readString(value["image"], IDENTIFIER_PATTERN);
  const role = typeof value["role"] === "string" && Object.hasOwn(V1_SERVICE_IMAGE, value["role"])
    ? value["role"] as ReleaseServiceRole
    : null;
  return name !== null && image !== null && role !== null
    ? { name, image: image as ReleaseImageName, role }
    : null;
}

function readPersistentMount(value: unknown): ReleasePersistentMount | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["role", "service", "mountPath"])) return null;
  const role = typeof value["role"] === "string" && Object.hasOwn(V1_MOUNT_BINDING, value["role"])
    ? value["role"] as ReleasePersistentMountRole
    : null;
  const service = typeof value["service"] === "string" && Object.hasOwn(V1_SERVICE_IMAGE, value["service"])
    ? value["service"] as ReleaseServiceRole
    : null;
  const mountPath = readString(value["mountPath"]);
  return role !== null && service !== null && mountPath !== null ? { role, service, mountPath } : null;
}

function readBootstrap(value: unknown): ReleaseBootstrap | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["image"])) return null;
  return value["image"] === "nautilo-bootstrap" ? { image: "nautilo-bootstrap" } : null;
}

function allUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function exactSet(values: readonly string[], expected: readonly string[]): boolean {
  return values.length === expected.length && allUnique(values) && values.every((value) => expected.includes(value));
}

function readTopology(value: unknown): ReleaseTopology | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, [
    "schemaVersion",
    "bootstrap",
    "services",
    "persistentMounts",
    "environmentSchemaVersion",
    "migrationSchemaVersion",
  ])) return null;
  const schemaVersion = readVersion(value["schemaVersion"]);
  const bootstrap = readBootstrap(value["bootstrap"]);
  const environmentSchemaVersion = readVersion(value["environmentSchemaVersion"]);
  const migrationSchemaVersion = readVersion(value["migrationSchemaVersion"]);
  if (!Array.isArray(value["services"]) || !Array.isArray(value["persistentMounts"])) return null;
  const sourceServices: readonly unknown[] = value["services"];
  const sourceMounts: readonly unknown[] = value["persistentMounts"];
  const services = sourceServices.map(readService);
  if (services.some((service) => service === null)) return null;
  const resolvedServices = services as ReleaseService[];
  const serviceRoles = Object.keys(V1_SERVICE_IMAGE);
  if (!exactSet(resolvedServices.map((service) => service.role), serviceRoles)) return null;
  if (resolvedServices.some((service) => service.name !== service.role || service.image !== V1_SERVICE_IMAGE[service.role])) return null;
  const mounts = sourceMounts.map(readPersistentMount);
  if (mounts.some((mount) => mount === null)) return null;
  const resolvedMounts = mounts as ReleasePersistentMount[];
  const mountRoles = Object.keys(V1_MOUNT_BINDING);
  if (!exactSet(resolvedMounts.map((mount) => mount.role), mountRoles)) return null;
  if (resolvedMounts.some((mount) => {
    const required = V1_MOUNT_BINDING[mount.role];
    return mount.service !== required.service || mount.mountPath !== required.mountPath;
  })) return null;
  return schemaVersion !== null && bootstrap !== null && environmentSchemaVersion !== null && migrationSchemaVersion !== null
    ? {
        schemaVersion,
        bootstrap,
        services: resolvedServices,
        persistentMounts: resolvedMounts,
        environmentSchemaVersion,
        migrationSchemaVersion,
      }
    : null;
}

function readManifest(value: unknown): { manifest: ReleaseManifest } | { code: ReleaseManifestFailureCode } {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["schemaVersion", "releaseId", "images", "topology", "compatibility"])) {
    return { code: "hosting.release.malformed" };
  }
  if (typeof value["schemaVersion"] === "number" && value["schemaVersion"] !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    return { code: "hosting.release.unsupported-version" };
  }
  if (value["schemaVersion"] !== RELEASE_MANIFEST_SCHEMA_VERSION || !Array.isArray(value["images"])) {
    return { code: "hosting.release.malformed" };
  }
  const releaseId = readString(value["releaseId"], RELEASE_ID_PATTERN);
  const images = value["images"].map(readImage);
  if (images.some((image) => image === "mutable")) return { code: "hosting.release.mutable-image" };
  if (images.some((image) => image === null)) return { code: "hosting.release.malformed" };
  const resolvedImages = images as ReleaseImage[];
  if (!allUnique(resolvedImages.map((image) => image.name))) return { code: "hosting.release.malformed" };
  if (!exactSet(resolvedImages.map((image) => image.name), V1_IMAGE_NAMES)) {
    return { code: "hosting.release.malformed" };
  }
  const topology = readTopology(value["topology"]);
  if (!isPlainObject(value["compatibility"]) || !hasOnlyKeys(value["compatibility"], ["runtime", "protocol", "topology"])) {
    return { code: "hosting.release.malformed" };
  }
  const runtime = readRange(value["compatibility"]["runtime"]);
  const protocol = readRange(value["compatibility"]["protocol"]);
  const topologyCompatibility = readRange(value["compatibility"]["topology"]);
  if (releaseId === null || topology === null || runtime === null || protocol === null || topologyCompatibility === null) {
    return { code: "hosting.release.malformed" };
  }
  if (topology.schemaVersion !== RELEASE_TOPOLOGY_SCHEMA_VERSION) {
    return { code: "hosting.release.incompatible-topology" };
  }
  if (!topologyCompatibility.minimum || topology.schemaVersion < topologyCompatibility.minimum || topology.schemaVersion > topologyCompatibility.maximum) {
    return { code: "hosting.release.incompatible-topology" };
  }
  return {
    manifest: {
      schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
      releaseId,
      images: resolvedImages,
      topology,
      compatibility: { runtime, protocol, topology: topologyCompatibility },
    },
  };
}

function readSignature(value: unknown): ReleaseManifestSignature | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["algorithm", "keyId", "value"])) return null;
  const keyId = readString(value["keyId"], IDENTIFIER_PATTERN);
  const signature = readString(value["value"], BASE64_PATTERN);
  if (value["algorithm"] !== "ed25519" || keyId === null || signature === null) return null;
  const bytes = Buffer.from(signature, "base64");
  return bytes.length === 64 ? { algorithm: "ed25519", keyId, value: signature } : null;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(",")}}`;
}

/** Deterministic UTF-8 bytes of exactly the manifest body, excluding signature metadata. */
export function canonicalReleaseManifestBytes(manifest: ReleaseManifest): Uint8Array {
  return Buffer.from(canonicalJson(manifest as unknown as JsonValue), "utf8");
}

const nodeEd25519Verifier: ReleaseManifestSignatureVerifier = {
  verify({ signedBytes, signature, publicKeyDer }): boolean {
    try {
      const key = createPublicKey({ key: Buffer.from(publicKeyDer), format: "der", type: "spki" });
      return key.asymmetricKeyType === "ed25519" && verifyEd25519(null, signedBytes, key, signature);
    } catch {
      return false;
    }
  },
};

function inRange(value: number, range: ReleaseVersionRange): boolean {
  return Number.isSafeInteger(value) && value >= range.minimum && value <= range.maximum;
}

/**
 * Strictly parse and verify an untrusted signed manifest without throwing
 * parser or crypto errors through this public seam.
 */
export function verifyReleaseManifest(
  input: unknown,
  runtime: ReleaseManifestRuntime,
  trust: ReleaseManifestTrust,
): ReleaseManifestVerification {
  try {
    if (!isPlainObject(input)) return { ok: false, code: "hosting.release.malformed" };
    if (!Object.hasOwn(input, "signature")) return { ok: false, code: "hosting.release.unsigned" };
    if (!hasOnlyKeys(input, ["manifest", "signature"])) return { ok: false, code: "hosting.release.malformed" };
    const parsed = readManifest(input["manifest"]);
    if ("code" in parsed) return { ok: false, code: parsed.code };
    const signature = readSignature(input["signature"]);
    if (signature === null) return { ok: false, code: "hosting.release.malformed" };
    if (!Object.hasOwn(trust.trustedPublicKeys, signature.keyId)) {
      return { ok: false, code: "hosting.release.untrusted-key" };
    }
    const publicKeyB64 = trust.trustedPublicKeys[signature.keyId];
    if (typeof publicKeyB64 !== "string" || !BASE64_PATTERN.test(publicKeyB64)) {
      return { ok: false, code: "hosting.release.untrusted-key" };
    }
    const publicKeyDer = Buffer.from(publicKeyB64, "base64");
    let verified: boolean;
    try {
      verified = (trust.verifier ?? nodeEd25519Verifier).verify({
        signedBytes: canonicalReleaseManifestBytes(parsed.manifest),
        signature: Buffer.from(signature.value, "base64"),
        publicKeyDer,
      });
    } catch {
      return { ok: false, code: "hosting.release.invalid-signature" };
    }
    if (!verified) return { ok: false, code: "hosting.release.invalid-signature" };
    if (!inRange(runtime.runtimeVersion, parsed.manifest.compatibility.runtime) || !inRange(runtime.protocolVersion, parsed.manifest.compatibility.protocol)) {
      return { ok: false, code: "hosting.release.incompatible-runtime" };
    }
    if (!inRange(runtime.topologySchemaVersion, parsed.manifest.compatibility.topology) || runtime.topologySchemaVersion !== parsed.manifest.topology.schemaVersion) {
      return { ok: false, code: "hosting.release.incompatible-topology" };
    }
    return { ok: true, manifest: parsed.manifest as VerifiedReleaseManifest };
  } catch {
    return { ok: false, code: "hosting.release.malformed" };
  }
}
