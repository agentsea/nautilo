import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type {
  ConnectedAppProviderId,
  ConnectedAppResultPresentationContract,
  ConnectedAppToolReceipt,
} from "@nautilo/types";
import type { ConnectedAppScope } from "@nautilo/db";

type RuntimePresentation = NonNullable<ConnectedAppToolReceipt["presentation"]>;

const PREVIEW_KEY_DOMAIN = "nautilo.connected-app-result-preview.v1\0";

export type ConnectedAppArtifactImportReceipt = Readonly<{
  artifactId: string;
  path: string;
  mime: string;
  bytes: number;
}>;

export type ConnectedAppArtifactImporter = (input: Readonly<{
  logicalPath: string;
  mimeType: string;
  chunks: AsyncIterable<Uint8Array>;
}>) => Promise<ConnectedAppArtifactImportReceipt | null>;

export type ConnectedAppTransitFileReader = (input: Readonly<{
  fileId: string;
  signal?: AbortSignal | undefined;
}>) => Promise<Readonly<{
  chunks: AsyncIterable<Uint8Array>;
}>>;

export type ConnectedAppTransitFileDisposer = (input: Readonly<{
  fileId: string;
}>) => Promise<void>;

export class ConnectedAppResultMediaError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "ConnectedAppResultMediaError";
  }
}

/** Domain-separate the deployment's stable secret before using it for previews. */
export function deriveConnectedAppPreviewKey(secret: string): Buffer {
  if (secret.length === 0) throw new TypeError("connected app preview secret is required");
  return createHmac("sha256", secret).update(PREVIEW_KEY_DOMAIN, "utf8").digest();
}

type PreviewAuthority = Readonly<{
  userId: string;
  namespaceId: string;
  url: string;
  allowedHosts: readonly string[];
}>;

function jsonPointer(value: unknown, path: string): unknown {
  let current = value;
  for (const encoded of path.slice(1).split("/")) {
    if (!current || typeof current !== "object") return undefined;
    const segment = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function withoutJsonPointer(value: unknown, path: string): unknown {
  const clone = structuredClone(value);
  if (!clone || typeof clone !== "object") return clone;
  const segments = path.slice(1).split("/").map((encoded) =>
    encoded.replace(/~1/gu, "/").replace(/~0/gu, "~"));
  let current: unknown = clone;
  for (const segment of segments.slice(0, -1)) {
    if (!current || typeof current !== "object") return clone;
    current = (current as Record<string, unknown>)[segment];
  }
  const last = segments.at(-1);
  if (last !== undefined && current && typeof current === "object") {
    delete (current as Record<string, unknown>)[last];
  }
  return clone;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function exactHttpsUrl(value: unknown, allowedHosts: readonly string[]): string | null {
  if (typeof value !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const hosts = new Set(allowedHosts.map((host) => host.toLowerCase()));
  return parsed.protocol === "https:"
    && parsed.username.length === 0
    && parsed.password.length === 0
    && parsed.hash.length === 0
    && (parsed.port.length === 0 || parsed.port === "443")
    && hosts.has(parsed.hostname.toLowerCase())
    ? parsed.toString()
    : null;
}

function normalizedMime(value: string | null): string {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(mime)
    ? mime
    : "application/octet-stream";
}

function extensionForMime(mime: string): string {
  const known: Readonly<Record<string, string>> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/zip": "zip",
    "text/csv": "csv",
    "text/html": "html",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "video/mp4": "mp4",
  };
  return known[mime] ?? "bin";
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return safe || "result";
}

async function* responseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.byteLength > 0) yield value;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function* exactSizeChunks(
  chunks: AsyncIterable<Uint8Array>,
  expectedBytes: number,
): AsyncGenerator<Uint8Array> {
  let observedBytes = 0;
  for await (const chunk of chunks) {
    observedBytes += chunk.byteLength;
    if (observedBytes > expectedBytes) throw new Error("connected_app_transit_file_size_mismatch");
    yield chunk;
  }
  if (observedBytes !== expectedBytes) throw new Error("connected_app_transit_file_size_mismatch");
}

/**
 * Provider-neutral result projector and private media broker. The catalogue
 * supplies field pointers and exact public hosts only; all executable fetch,
 * artifact, and authorization behavior remains local Nautilo code.
 */
export class ConnectedAppResultPresenter {
  private readonly previewKey: Buffer;

  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    previewKey: Uint8Array = randomBytes(32),
  ) {
    if (previewKey.byteLength !== 32) {
      throw new TypeError("connected app preview key must be exactly 32 bytes");
    }
    this.previewKey = Buffer.from(previewKey);
  }

  private sealPreview(authority: PreviewAuthority): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.previewKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(authority), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  private openPreview(ref: string): PreviewAuthority | null {
    try {
      const sealed = Buffer.from(ref, "base64url");
      if (sealed.byteLength <= 28) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.previewKey, sealed.subarray(0, 12));
      decipher.setAuthTag(sealed.subarray(12, 28));
      const parsed: unknown = JSON.parse(Buffer.concat([
        decipher.update(sealed.subarray(28)),
        decipher.final(),
      ]).toString("utf8"));
      if (!parsed || typeof parsed !== "object") return null;
      const value = parsed as Record<string, unknown>;
      if (typeof value["userId"] !== "string" || typeof value["namespaceId"] !== "string"
        || typeof value["url"] !== "string" || !Array.isArray(value["allowedHosts"])
        || value["allowedHosts"].some((host) => typeof host !== "string")) return null;
      return value as PreviewAuthority;
    } catch {
      return null;
    }
  }

  async readPreview(input: {
    scope: ConnectedAppScope;
    ref: string;
    signal?: AbortSignal | undefined;
  }): Promise<{ chunks: AsyncIterable<Uint8Array>; contentType: string }> {
    const authority = this.openPreview(input.ref);
    if (!authority || authority.userId !== input.scope.userId
      || authority.namespaceId !== input.scope.namespaceId) {
      throw new ConnectedAppResultMediaError("connected_app_preview_not_found", 404);
    }
    const url = exactHttpsUrl(authority.url, authority.allowedHosts);
    if (!url) throw new ConnectedAppResultMediaError("connected_app_preview_not_found", 404);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch {
      throw new ConnectedAppResultMediaError("connected_app_preview_unavailable", 502);
    }
    const contentType = normalizedMime(response.headers.get("content-type"));
    if (!response.ok || !response.body || !contentType.startsWith("image/")) {
      throw new ConnectedAppResultMediaError("connected_app_preview_unavailable", 502);
    }
    return { chunks: responseChunks(response.body), contentType };
  }

  async project(input: {
    scope: ConnectedAppScope;
    providerId: ConnectedAppProviderId;
    executionId: string;
    result: unknown;
    contract: ConnectedAppResultPresentationContract;
    artifactImporter?: ConnectedAppArtifactImporter | undefined;
    transitFileReader?: ConnectedAppTransitFileReader | undefined;
    transitFileDisposer?: ConnectedAppTransitFileDisposer | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<{ result: unknown; presentation: RuntimePresentation }> {
    if (input.contract.kind === "entity") {
      const title = nonEmpty(jsonPointer(input.result, input.contract.titlePointer))
        ?? input.contract.fallbackTitle;
      const subtitle = input.contract.subtitlePointer
        ? nonEmpty(jsonPointer(input.result, input.contract.subtitlePointer))
        : null;
      const previewUrl = input.contract.image
        ? exactHttpsUrl(jsonPointer(input.result, input.contract.image.pointer), input.contract.image.allowedHosts)
        : null;
      const preview = previewUrl && input.contract.image ? {
        ref: this.sealPreview({
          ...input.scope,
          url: previewUrl,
          allowedHosts: input.contract.image.allowedHosts,
        }),
        alt: input.contract.image.alt,
        width: input.contract.image.widthPointer
          ? positiveInteger(jsonPointer(input.result, input.contract.image.widthPointer))
          : null,
        height: input.contract.image.heightPointer
          ? positiveInteger(jsonPointer(input.result, input.contract.image.heightPointer))
          : null,
      } : null;
      const links = input.contract.links.flatMap((link) => {
        const url = exactHttpsUrl(jsonPointer(input.result, link.pointer), link.allowedHosts);
        return url ? [{ label: link.label, url }] : [];
      });
      return {
        result: input.contract.image
          ? withoutJsonPointer(input.result, input.contract.image.pointer)
          : input.result,
        presentation: { version: 1, kind: "entity", title, subtitle, preview, links },
      };
    }

    if (input.contract.kind === "transit_artifact_import") {
      const fileId = nonEmpty(jsonPointer(input.result, input.contract.fileIdPointer));
      const name = nonEmpty(jsonPointer(input.result, input.contract.namePointer));
      const mimeType = normalizedMime(nonEmpty(jsonPointer(input.result, input.contract.mimeTypePointer)));
      const sizeBytes = nonNegativeInteger(jsonPointer(input.result, input.contract.sizeBytesPointer));
      const artifacts: ConnectedAppArtifactImportReceipt[] = [];
      if (fileId) {
        try {
          if (name && sizeBytes !== null && input.transitFileReader && input.artifactImporter) {
            const imported = await input.transitFileReader({
              fileId,
              ...(input.signal ? { signal: input.signal } : {}),
            }).then((transit) => input.artifactImporter!({
              logicalPath: `connected-apps/${safeSegment(input.providerId)}/${safeSegment(name)}`,
              mimeType,
              chunks: exactSizeChunks(transit.chunks, sizeBytes),
            })).catch(() => null);
            if (imported) artifacts.push(imported);
          }
        } finally {
          // The Room artifact is now canonical (or the import failed). Either
          // way, the connector-owned copy is only transport and must not linger.
          await input.transitFileDisposer?.({ fileId }).catch(() => undefined);
        }
      }
      const state = artifacts.length === 1 ? "ready" : "import_failed";
      return {
        result: withoutJsonPointer(input.result, input.contract.filePointer),
        presentation: {
          version: 1,
          kind: "artifact_import",
          status: state,
          state,
          artifacts,
          errorCode: state === "ready" ? null : "connected_app_artifact_import_failed",
        },
      };
    }

    const contract = input.contract;
    const resultIdentity = nonEmpty(jsonPointer(input.result, contract.identityPointer))
      ?? input.executionId;
    const status = nonEmpty(jsonPointer(input.result, contract.statusPointer)) ?? "unknown";
    const rawUrls = jsonPointer(input.result, contract.urlsPointer);
    const urls = Array.isArray(rawUrls)
      ? rawUrls.flatMap((value) => {
          const url = exactHttpsUrl(value, contract.allowedHosts);
          return url ? [url] : [];
        })
      : [];
    const artifacts: ConnectedAppArtifactImportReceipt[] = [];
    let importFailures = 0;
    if (status === contract.readyValue && input.artifactImporter) {
      for (const [index, url] of urls.entries()) {
        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: "GET",
            redirect: "error",
            credentials: "omit",
            ...(input.signal ? { signal: input.signal } : {}),
          });
        } catch {
          importFailures += 1;
          continue;
        }
        if (!response.ok || !response.body) {
          importFailures += 1;
          continue;
        }
        const mimeType = normalizedMime(response.headers.get("content-type"));
        const imported = await input.artifactImporter({
          logicalPath: `connected-apps/${safeSegment(input.providerId)}/export-${safeSegment(resultIdentity)}-${index + 1}.${extensionForMime(mimeType)}`,
          mimeType,
          chunks: responseChunks(response.body),
        }).catch(() => null);
        if (imported) artifacts.push(imported);
        else importFailures += 1;
      }
    }
    const state: Extract<RuntimePresentation, { kind: "artifact_import" }>["state"] =
      status === contract.failedValue ? "failed"
      : status !== contract.readyValue ? "pending"
      : artifacts.length === 0 && (urls.length === 0 || importFailures > 0) ? "import_failed"
      : importFailures > 0 ? "partial"
      : "ready";
    return {
      result: withoutJsonPointer(input.result, contract.urlsPointer),
      presentation: {
        version: 1,
        kind: "artifact_import",
        status,
        state,
        artifacts,
        errorCode: state === "import_failed" || state === "partial"
          ? "connected_app_artifact_import_failed"
          : null,
      },
    };
  }
}
