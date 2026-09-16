import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConnectedAppProviderId } from "@nautilo/types";

const ConnectionSchema = z.object({
  id: z.string().min(1),
  service: z.string().min(1),
  connectionName: z.string().min(1),
  configured: z.boolean(),
  profile: z.object({
    accountId: z.string().min(1),
    displayName: z.string().min(1),
    grantedScopes: z.array(z.string()),
  }).passthrough(),
}).passthrough();

const OAuthAuthorizationSchema = z.object({
  authorizationUrl: z.string().url(),
  state: z.string().min(1),
}).passthrough();

const RuntimeTokenSchema = z.object({
  token: z.string().regex(/^oct_[A-Za-z0-9_-]+$/u),
  record: z.object({ id: z.string().min(1) }).passthrough(),
}).strict();

const OAuthConfigSchema = z.object({
  service: z.string().optional(),
  configured: z.boolean().optional(),
  clientId: z.string().nullable().optional(),
  expectedRedirectUri: z.string().url().optional(),
}).passthrough();

const TransitFileUploadSchema = z.object({
  fileId: z.string().regex(/^[a-f0-9]{32}(?:\.[a-z0-9]{1,16})?$/u),
  downloadUrl: z.string().url(),
  sizeBytes: z.number().int().nonnegative(),
  name: z.string().min(1),
  mimeType: z.string().min(1),
}).strict();

export type OpenConnectorConnection = z.infer<typeof ConnectionSchema>;

export class OpenConnectorAdminError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "OpenConnectorAdminError";
  }
}

const SAFE_CODES = new Set([
  "connection_cancelled",
  "connection_not_found",
  "file_not_found",
  "file_too_large",
  "invalid_input",
  "oauth_client_not_configured",
  "runtime_token_not_found",
  "unauthorized",
  "unknown_action",
  "unknown_service",
]);

const SAFE_CODE_ALIASES: Readonly<Record<string, string>> = {
  // OpenConnector 1.4.x renamed the missing OAuth-client error returned by
  // POST /api/oauth/authorizations. Keep Nautilo's product-facing recovery
  // code stable across the reviewed runtime versions.
  oauth_client_config_required: "oauth_client_not_configured",
};

export function normalizeOpenConnectorOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenConnectorAdminError("openconnector_origin_invalid", 503);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new OpenConnectorAdminError("openconnector_origin_invalid", 503);
  }
  return url.origin;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class OpenConnectorAdminClient {
  readonly origin: string;

  constructor(
    origin: string,
    private readonly adminToken: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.origin = normalizeOpenConnectorOrigin(origin);
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (this.adminToken) headers.set("Authorization", `Bearer ${this.adminToken}`);
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.origin), {
        ...init,
        headers,
        redirect: "error",
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new OpenConnectorAdminError("request_cancelled", 499);
      }
      throw new OpenConnectorAdminError("openconnector_unreachable", 503);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const upstream = z.object({ error: z.object({ code: z.string() }).passthrough() }).passthrough()
        .safeParse(body);
      const upstreamCode = upstream.success ? upstream.data.error.code : null;
      const normalizedCode = upstreamCode
        ? SAFE_CODE_ALIASES[upstreamCode] ?? upstreamCode
        : null;
      const code = normalizedCode && SAFE_CODES.has(normalizedCode)
        ? normalizedCode
        : response.status === 401 || response.status === 403
          ? "unauthorized"
          : "openconnector_error";
      throw new OpenConnectorAdminError(code, response.status);
    }
    return body;
  }

  async verifyProvider(
    providerId: ConnectedAppProviderId,
    actionIds: readonly string[],
    schemaSha256: Readonly<Record<string, string>>,
    client: { clientId: string; clientSecret: string; requestedScopes?: readonly string[] } | null,
    signal?: AbortSignal,
  ): Promise<{
    callbackUrl: string;
    clientId: string;
  }> {
    const config = client
      ? OAuthConfigSchema.parse(await this.request(`/api/oauth/configs/${encodeURIComponent(providerId)}`, {
          method: "PUT",
          body: JSON.stringify(client),
          ...(signal ? { signal } : {}),
        }))
      : z.array(OAuthConfigSchema).parse(await this.request("/api/oauth/configs", signal ? { signal } : {}))
          .find((candidate) => candidate.service === providerId && candidate.configured === true);
    if (!config?.clientId) throw new OpenConnectorAdminError("oauth_client_not_configured", 409);
    const providers = z.array(z.object({ service: z.string() }).passthrough())
      .parse(await this.request("/api/providers", signal ? { signal } : {}));
    if (!providers.some((provider) => provider.service === providerId)) {
      throw new OpenConnectorAdminError("connected_app_provider_unavailable", 503);
    }
    const expectedActionIds = new Set(actionIds);
    if (expectedActionIds.size !== actionIds.length) {
      throw new OpenConnectorAdminError("connected_app_action_inventory_invalid", 409);
    }
    const listedActions = z.array(z.object({ id: z.string().min(1), service: z.string().min(1) }).passthrough())
      .parse(await this.request("/api/actions", signal ? { signal } : {}))
      .filter((action) => action.service === providerId);
    const listedActionIds = listedActions.map((action) => action.id);
    const actualActionIds = new Set(listedActionIds);
    if (
      actualActionIds.size !== listedActionIds.length
      || actualActionIds.size !== expectedActionIds.size
      || [...expectedActionIds].some((actionId) => !actualActionIds.has(actionId))
    ) {
      // New upstream actions are not implicitly authorized. A catalogue
      // update must review their schemas, metadata, and approval policy.
      throw new OpenConnectorAdminError("connected_app_action_inventory_mismatch", 409);
    }
    for (const actionId of actionIds) {
      const expectedHash = schemaSha256[actionId];
      if (!expectedHash || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
        throw new OpenConnectorAdminError("connected_app_action_schema_invalid", 409);
      }
      const action = z.object({ id: z.literal(actionId), inputSchema: z.record(z.string(), z.unknown()), outputSchema: z.record(z.string(), z.unknown()) })
        .passthrough().parse(await this.request(`/api/actions/${encodeURIComponent(actionId)}`, signal ? { signal } : {}));
      if (!action.inputSchema || !action.outputSchema) {
        throw new OpenConnectorAdminError("openconnector_action_schema_invalid", 502);
      }
      const actualHash = createHash("sha256").update(canonicalJson({
        inputSchema: action.inputSchema,
        outputSchema: action.outputSchema,
      })).digest("hex");
      if (actualHash !== expectedHash) {
        throw new OpenConnectorAdminError("openconnector_action_schema_drift", 409);
      }
    }
    return {
      callbackUrl: config.expectedRedirectUri ?? new URL("/oauth/callback", this.origin).toString(),
      clientId: config.clientId,
    };
  }

  async startAuthorization(
    providerId: ConnectedAppProviderId,
    connectionName: string,
    signal?: AbortSignal,
  ): Promise<{
    authorizationUrl: string;
    state: string;
  }> {
    return OAuthAuthorizationSchema.parse(await this.request("/api/oauth/authorizations", {
      method: "POST",
      body: JSON.stringify({ service: providerId, connectionName }),
      ...(signal ? { signal } : {}),
    }));
  }

  async listConnections(providerId: ConnectedAppProviderId, signal?: AbortSignal): Promise<OpenConnectorConnection[]> {
    return z.array(ConnectionSchema).parse(await this.request("/api/connections", signal ? { signal } : {}))
      .filter((connection) => connection.service === providerId && connection.configured);
  }

  async createRestrictedRuntimeToken(input: {
    name: string;
    connectionId: string;
    allowedActions: readonly string[];
    signal?: AbortSignal;
  }): Promise<{ token: string; recordId: string }> {
    const existing = z.array(z.object({ id: z.string(), name: z.string() }).passthrough())
      .parse(await this.request("/api/runtime-tokens", input.signal ? { signal: input.signal } : {}));
    for (const token of existing.filter((candidate) => candidate.name === input.name)) {
      await this.revokeRuntimeToken(token.id, input.signal).catch(() => {});
    }
    const created = RuntimeTokenSchema.parse(await this.request("/api/runtime-tokens", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        allowedActions: input.allowedActions,
        blockedActions: [],
        allowedProxies: [],
        allowedConnections: [input.connectionId],
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    }));
    return { token: created.token, recordId: created.record.id };
  }

  async revokeRuntimeToken(recordId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/api/runtime-tokens/${encodeURIComponent(recordId)}`, {
      method: "DELETE",
      ...(signal ? { signal } : {}),
    });
  }

  async disconnect(
    providerId: ConnectedAppProviderId,
    connectionName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(`/api/connections/${encodeURIComponent(providerId)}?connectionName=${encodeURIComponent(connectionName)}`, {
      method: "DELETE",
      ...(signal ? { signal } : {}),
    });
  }

  async uploadTransitFile(input: {
    name: string;
    mimeType: string;
    sizeBytes: number;
    chunks: AsyncIterable<Uint8Array>;
    signal?: AbortSignal;
  }): Promise<z.infer<typeof TransitFileUploadSchema>> {
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new OpenConnectorAdminError("invalid_input", 400);
    }
    const boundary = `nautilo-${randomUUID()}`;
    const safeName = input.name.replace(/[\r\n"\\]/gu, "_") || "artifact";
    const safeMime = input.mimeType.replace(/[\r\n]/gu, "").trim() || "application/octet-stream";
    const encoder = new TextEncoder();
    const prefix = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\n`
      + `Content-Type: ${safeMime}\r\n\r\n`,
    );
    const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = multipartBody(prefix, input.chunks, input.sizeBytes, suffix);
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(prefix.byteLength + input.sizeBytes + suffix.byteLength),
      },
      body,
      duplex: "half",
      ...(input.signal ? { signal: input.signal } : {}),
    };
    return TransitFileUploadSchema.parse(await this.request("/api/files", init));
  }

  async deleteTransitFile(fileId: string, signal?: AbortSignal): Promise<boolean> {
    if (!/^[a-f0-9]{32}(?:\.[a-z0-9]{1,16})?$/u.test(fileId)) {
      throw new OpenConnectorAdminError("invalid_input", 400);
    }
    const result = z.object({ fileId: z.literal(fileId), deleted: z.boolean() }).strict()
      .parse(await this.request(`/api/files/${encodeURIComponent(fileId)}`, {
        method: "DELETE",
        ...(signal ? { signal } : {}),
      }));
    return result.deleted;
  }
}

function multipartBody(
  prefix: Uint8Array,
  chunks: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  suffix: Uint8Array,
): ReadableStream<Uint8Array> {
  const iterator = (async function* (): AsyncGenerator<Uint8Array> {
    yield prefix;
    let written = 0;
    for await (const chunk of chunks) {
      written += chunk.byteLength;
      if (written > expectedBytes) {
        throw new OpenConnectorAdminError("connected_app_artifact_changed", 409);
      }
      if (chunk.byteLength > 0) yield chunk;
    }
    if (written !== expectedBytes) {
      throw new OpenConnectorAdminError("connected_app_artifact_changed", 409);
    }
    yield suffix;
  })()[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
}
