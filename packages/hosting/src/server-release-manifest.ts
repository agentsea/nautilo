import { createPublicKey, verify as verifyEd25519 } from "node:crypto";

import {
  verifyRuntimeArtifactRecord,
  type RuntimeArtifactRecordV1,
  type VerifiedRuntimeArtifactRecord,
} from "./runtime-artifact-record";

export const SERVER_RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export interface ServerReleaseManifest {
  readonly schemaVersion: typeof SERVER_RELEASE_MANIFEST_SCHEMA_VERSION;
  readonly channel: "stable";
  readonly runtimeArtifact: RuntimeArtifactRecordV1;
}

declare const VERIFIED_SERVER_RELEASE_MANIFEST: unique symbol;
export type VerifiedServerReleaseManifest = Omit<ServerReleaseManifest, "runtimeArtifact"> & {
  readonly runtimeArtifact: VerifiedRuntimeArtifactRecord;
  readonly [VERIFIED_SERVER_RELEASE_MANIFEST]: true;
};

export interface ServerReleaseManifestSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
}

export interface SignedServerReleaseManifest {
  readonly manifest: ServerReleaseManifest;
  readonly signature: ServerReleaseManifestSignature;
}

export interface ServerReleaseManifestSignatureVerifier {
  verify(input: {
    readonly signedBytes: Uint8Array;
    readonly signature: Uint8Array;
    readonly publicKeyDer: Uint8Array;
  }): boolean;
}

export interface ServerReleaseManifestTrust {
  readonly trustedPublicKeys: Readonly<Record<string, string>>;
  readonly verifier?: ServerReleaseManifestSignatureVerifier | undefined;
}

export type ServerReleaseManifestFailureCode =
  | "hosting.server-release.malformed"
  | "hosting.server-release.unsupported-version"
  | "hosting.server-release.wrong-channel"
  | "hosting.server-release.unsigned"
  | "hosting.server-release.untrusted-key"
  | "hosting.server-release.invalid-signature"
  | "hosting.server-release.invalid-runtime-artifact";

export type ServerReleaseManifestVerification =
  | { readonly ok: true; readonly manifest: VerifiedServerReleaseManifest }
  | { readonly ok: false; readonly code: ServerReleaseManifestFailureCode };

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(",")}}`;
}

export function canonicalServerReleaseManifestBytes(manifest: ServerReleaseManifest): Uint8Array {
  return Buffer.from(canonicalJson(manifest as unknown as JsonValue), "utf8");
}

function readSignature(value: unknown): ServerReleaseManifestSignature | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["algorithm", "keyId", "value"])) return null;
  if (value["algorithm"] !== "ed25519" || typeof value["keyId"] !== "string" ||
    !IDENTIFIER_PATTERN.test(value["keyId"]) || typeof value["value"] !== "string" ||
    !BASE64_PATTERN.test(value["value"])) return null;
  return Buffer.from(value["value"], "base64").byteLength === 64
    ? { algorithm: "ed25519", keyId: value["keyId"], value: value["value"] }
    : null;
}

const nodeEd25519Verifier: ServerReleaseManifestSignatureVerifier = {
  verify({ signedBytes, signature, publicKeyDer }): boolean {
    try {
      const key = createPublicKey({ key: Buffer.from(publicKeyDer), format: "der", type: "spki" });
      return key.asymmetricKeyType === "ed25519" && verifyEd25519(null, signedBytes, key, signature);
    } catch {
      return false;
    }
  },
};

/** Verify the stable server pointer under a caller-pinned trust root. */
export function verifyServerReleaseManifest(
  input: unknown,
  trust: ServerReleaseManifestTrust,
): ServerReleaseManifestVerification {
  try {
    if (!isPlainObject(input)) return { ok: false, code: "hosting.server-release.malformed" };
    if (!Object.hasOwn(input, "signature")) return { ok: false, code: "hosting.server-release.unsigned" };
    if (!hasExactKeys(input, ["manifest", "signature"]) || !isPlainObject(input["manifest"])) {
      return { ok: false, code: "hosting.server-release.malformed" };
    }
    const body = input["manifest"];
    if (!hasExactKeys(body, ["schemaVersion", "channel", "runtimeArtifact"])) {
      return { ok: false, code: "hosting.server-release.malformed" };
    }
    if (typeof body["schemaVersion"] === "number" && body["schemaVersion"] !== SERVER_RELEASE_MANIFEST_SCHEMA_VERSION) {
      return { ok: false, code: "hosting.server-release.unsupported-version" };
    }
    if (body["schemaVersion"] !== SERVER_RELEASE_MANIFEST_SCHEMA_VERSION) {
      return { ok: false, code: "hosting.server-release.malformed" };
    }
    if (body["channel"] !== "stable") return { ok: false, code: "hosting.server-release.wrong-channel" };
    const rawArtifact = body["runtimeArtifact"];
    const candidate = isPlainObject(rawArtifact) ? rawArtifact : {};
    const runtimeArtifact = verifyRuntimeArtifactRecord(rawArtifact, {
      sourceSha: typeof candidate["sourceSha"] === "string" ? candidate["sourceSha"] : "",
      manifestDigest: typeof candidate["manifestDigest"] === "string"
        ? candidate["manifestDigest"] as `sha256:${string}`
        : "" as `sha256:${string}`,
    });
    if (!runtimeArtifact.ok) return { ok: false, code: "hosting.server-release.invalid-runtime-artifact" };
    const signature = readSignature(input["signature"]);
    if (signature === null) return { ok: false, code: "hosting.server-release.malformed" };
    if (!Object.hasOwn(trust.trustedPublicKeys, signature.keyId)) {
      return { ok: false, code: "hosting.server-release.untrusted-key" };
    }
    const publicKeyBase64 = trust.trustedPublicKeys[signature.keyId];
    if (typeof publicKeyBase64 !== "string" || !BASE64_PATTERN.test(publicKeyBase64)) {
      return { ok: false, code: "hosting.server-release.untrusted-key" };
    }
    const manifest: ServerReleaseManifest = {
      schemaVersion: SERVER_RELEASE_MANIFEST_SCHEMA_VERSION,
      channel: "stable",
      runtimeArtifact: runtimeArtifact.record,
    };
    let verified: boolean;
    try {
      verified = (trust.verifier ?? nodeEd25519Verifier).verify({
        signedBytes: canonicalServerReleaseManifestBytes(manifest),
        signature: Buffer.from(signature.value, "base64"),
        publicKeyDer: Buffer.from(publicKeyBase64, "base64"),
      });
    } catch {
      return { ok: false, code: "hosting.server-release.invalid-signature" };
    }
    if (!verified) return { ok: false, code: "hosting.server-release.invalid-signature" };
    return { ok: true, manifest: manifest as VerifiedServerReleaseManifest };
  } catch {
    return { ok: false, code: "hosting.server-release.malformed" };
  }
}
