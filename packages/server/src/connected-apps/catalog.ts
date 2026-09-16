import { createHash, createPublicKey, verify } from "node:crypto";
import {
  canonicalConnectionProviderCatalogSigningPayloadV1,
  ConnectionProviderCatalogPointerSchema,
  ConnectionProviderCatalogSchema,
  type ConnectionProviderCatalog,
} from "@nautilo/types";
import { compileConnectedAppOperationAdmissions } from "@nautilo/agent";
import bundledCatalogJson from "./seed/catalog.json";

const CONNECTION_PROVIDER_CATALOG_POINTER_URL =
  "https://media.nautilo.ai/connections/latest.json";

const TRUSTED_CONNECTION_CATALOG_KEYS: Readonly<Record<string, string>> = {
  "catalog-2026-07-17":
    "MCowBQYDK2VwAyEAX9Kq7L0rqQVJJw9Mau3fmr9nbKDC1iTDEWoWNVJZCAo=",
};

/**
 * Bundled recovery data generated from the signed catalogue. Never construct
 * provider contracts in TypeScript: parsing gives the exact same authority to
 * the recovery path as the remote signed artifact.
 */
export const BUNDLED_CONNECTION_PROVIDER_CATALOG: ConnectionProviderCatalog =
  ConnectionProviderCatalogSchema.parse(bundledCatalogJson);

export type ResolvedConnectionProviderCatalog = {
  readonly catalog: ConnectionProviderCatalog;
  readonly source: "remote" | "bundled";
  readonly reason: string | null;
};

function artifactUrl(version: string): string {
  return `https://media.nautilo.ai/connections/catalog-${encodeURIComponent(version)}.json`;
}

async function exactJson(url: string, fetchImpl: typeof fetch): Promise<{ value: unknown; text: string }> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new Error("connection catalog fetch rejected");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new Error("connection catalog content type rejected");
  }
  const text = await response.text();
  return { value: JSON.parse(text), text };
}

export async function loadConnectionProviderCatalog(
  fetchImpl: typeof fetch = fetch,
  trustedKeys: Readonly<Record<string, string>> = TRUSTED_CONNECTION_CATALOG_KEYS,
): Promise<ResolvedConnectionProviderCatalog> {
  try {
    const pointerDocument = await exactJson(CONNECTION_PROVIDER_CATALOG_POINTER_URL, fetchImpl);
    const pointer = ConnectionProviderCatalogPointerSchema.parse(pointerDocument.value);
    const keyBytes = trustedKeys[pointer.signingKeyId];
    if (!keyBytes) throw new Error("connection catalog signing key rejected");
    const publicKey = createPublicKey({
      key: Buffer.from(keyBytes, "base64"),
      format: "der",
      type: "spki",
    });
    const valid = verify(
      null,
      Buffer.from(canonicalConnectionProviderCatalogSigningPayloadV1(
        pointer.catalogVersion,
        pointer.artifactSha256,
      )),
      publicKey,
      Buffer.from(pointer.signature, "base64"),
    );
    if (!valid) throw new Error("connection catalog signature rejected");
    const artifact = await exactJson(artifactUrl(pointer.catalogVersion), fetchImpl);
    const digest = createHash("sha256").update(artifact.text, "utf8").digest("hex");
    if (digest !== pointer.artifactSha256) throw new Error("connection catalog artifact hash rejected");
    const catalog = ConnectionProviderCatalogSchema.parse(artifact.value);
    // Reject unsupported JSON-Schema declarations before publishing a new
    // active snapshot. No request is allowed to discover this incompatibility.
    compileConnectedAppOperationAdmissions(catalog.providers);
    if (catalog.catalogVersion !== pointer.catalogVersion) {
      throw new Error("connection catalog version rejected");
    }
    return { catalog, source: "remote", reason: null };
  } catch (error) {
    return {
      catalog: BUNDLED_CONNECTION_PROVIDER_CATALOG,
      source: "bundled",
      reason: error instanceof Error ? error.message : "connection catalog unavailable",
    };
  }
}
