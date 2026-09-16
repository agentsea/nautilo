import {
  verifyServerReleaseManifest,
  type VerifiedRuntimeArtifactRecord,
} from "@nautilo/hosting";

import { CLI_RELEASE_TRUSTED_PUBLIC_KEYS } from "./cli-release-trust.ts";

const MAX_SERVER_RELEASE_BYTES = 1024 * 1024;
// Shared per-request budget for signed release metadata. A successful CDN fetch
// during Railway qualification took 10.97 seconds, exceeding the old deadline.
// This is an interactive wait default, not a provider SLA or deployment timeout.
export const SERVER_RELEASE_TIMEOUT_MS = 60_000;

export const SERVER_PRODUCTION_RELEASE_MANIFEST_URL =
  "https://media.nautilo.ai/server/stable/manifest.json" as const;

export type ServerProductionRelease =
  | { readonly state: "verified"; readonly runtimeArtifact: VerifiedRuntimeArtifactRecord }
  | { readonly state: "missing" | "invalid" };

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_SERVER_RELEASE_BYTES) {
      throw new Error("unsafe-server-release");
    }
  }
  if (response.body === null) throw new Error("unsafe-server-release");
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_SERVER_RELEASE_BYTES) throw new Error("unsafe-server-release");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export interface ServerProductionReleaseOptions {
  readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly trustedPublicKeys?: Readonly<Record<string, string>>;
}

/** Resolve the signed server-only stable channel under the CLI's pinned trust root. */
export async function resolveServerProductionRelease(
  options: ServerProductionReleaseOptions = {},
): Promise<ServerProductionRelease> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(SERVER_PRODUCTION_RELEASE_MANIFEST_URL, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(SERVER_RELEASE_TIMEOUT_MS),
    });
  } catch {
    return { state: "missing" };
  }
  if (response.status === 404) return { state: "missing" };
  if (!response.ok || response.url !== SERVER_PRODUCTION_RELEASE_MANIFEST_URL) {
    return { state: "missing" };
  }
  try {
    const result = verifyServerReleaseManifest(await readBoundedJson(response), {
      trustedPublicKeys: options.trustedPublicKeys ?? CLI_RELEASE_TRUSTED_PUBLIC_KEYS,
    });
    return result.ok
      ? { state: "verified", runtimeArtifact: result.manifest.runtimeArtifact }
      : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}
