import type { FastifyInstance } from "fastify";
import { redactSecrets } from "@nautilo/vault";
import type {
  ConnectionAuthShape,
  ConnectionProxyResponse,
  ConnectionScope,
  ConnectionVaultToolAuditPayload,
  VaultBackend,
} from "@nautilo/types";

export interface ConnectionProxyRouteDeps {
  readonly vault: VaultBackend;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly auditConnection?: (
    event: ConnectionVaultToolAuditPayload & {
      readonly actorId: string | null;
      readonly ip: string;
      readonly userAgent?: string | undefined;
    },
  ) => void;
}

interface ConnectionProxyDispatchRequest {
  readonly field: string;
  readonly url: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly category: "user";
  readonly authShape?: ConnectionAuthShape | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly body?: string | undefined;
}

export interface DispatchConnectionProxyInput {
  readonly service: string;
  readonly request: ConnectionProxyDispatchRequest;
  readonly scope: ConnectionScope;
  readonly actorId: string | null;
  readonly ip: string;
  readonly userAgent?: string | undefined;
}

const UPSTREAM_HOSTS: Readonly<Record<string, readonly string[]>> = {
  github: ["api.github.com"],
  slack: ["api.slack.com", "slack.com"],
  stripe: ["api.stripe.com"],
};

const RESPONSE_HEADERS = new Set([
  "content-type",
  "date",
  "x-request-id",
]);

function localProxyTestsAllowed(): boolean {
  return process.env["NODE_ENV"] === "test" ||
    process.env["NAUTILO_CONNECTION_PROXY_ALLOW_LOCALHOST"] === "1";
}

function isAllowedProxyTarget(service: string, url: URL): boolean {
  if (url.protocol !== "https:" && !localProxyTestsAllowed()) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (localProxyTestsAllowed() && (host === "127.0.0.1" || host === "localhost")) {
    return true;
  }
  return (UPSTREAM_HOSTS[service] ?? []).includes(host);
}

function stripLocalOnlyHeaders(headers: Record<string, string> | undefined): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers ?? {})) {
    const normalized = key.toLowerCase();
    if (
      normalized === "authorization" ||
      normalized === "cookie" ||
      normalized === "proxy-authorization" ||
      normalized.startsWith("x-nautilo-connection")
    ) {
      continue;
    }
    out.set(key, value);
  }
  return out;
}

function injectAuth(
  headers: Headers,
  shape: ConnectionAuthShape,
  secret: string,
): void {
  if (shape === "basic_auth") {
    headers.set("Authorization", `Basic ${Buffer.from(secret, "utf8").toString("base64")}`);
    return;
  }
  if (shape === "cookie") {
    headers.set("Cookie", secret);
    return;
  }
  if (shape === "api_key") {
    headers.set("x-api-key", secret);
    return;
  }
  headers.set("Authorization", `Bearer ${secret}`);
}

function responseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (RESPONSE_HEADERS.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

export async function dispatchConnectionProxy(
  deps: ConnectionProxyRouteDeps,
  input: DispatchConnectionProxyInput,
): Promise<ConnectionProxyResponse> {
  const { request, service } = input;
  const target = new URL(request.url);
  if (!isAllowedProxyTarget(service, target)) {
    deps.auditConnection?.({
      action: "use",
      tool: "connection_proxy",
      outcome: "error",
      service,
      field: request.field,
      errorKind: "ProxyTargetRejected",
      actorId: input.actorId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw new Error("Connection proxy target is not allowed");
  }

  let value: Uint8Array | null;
  try {
    value = await deps.vault.get({ service, field: request.field }, input.scope);
  } catch (e) {
    deps.auditConnection?.({
      action: "use",
      tool: "connection_proxy",
      outcome: "error",
      service,
      field: request.field,
      errorKind: e instanceof Error ? e.name : "Error",
      actorId: input.actorId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw e;
  }
  if (!value) {
    deps.auditConnection?.({
      action: "use",
      tool: "connection_proxy",
      outcome: "missing",
      service,
      field: request.field,
      actorId: input.actorId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw new Error("Connection not found");
  }

  const secret = Buffer.from(value).toString("utf8");
  const headers = stripLocalOnlyHeaders(request.headers);
  try {
    injectAuth(
      headers,
      request.authShape ?? "bearer_token",
      secret,
    );
    const upstream = await (deps.fetchImpl ?? fetch)(target, {
      method: request.method,
      headers,
      body: request.method === "GET" ? undefined : request.body,
    });
    const rawBody = await upstream.text();
    const redacted = redactSecrets(rawBody, [secret]).text;
    deps.auditConnection?.({
      action: "use",
      tool: "connection_proxy",
      outcome: "ok",
      service,
      field: request.field,
      actorId: input.actorId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return {
      status: "ok",
      upstreamStatus: upstream.status,
      body: redacted,
      headers: responseHeaders(upstream.headers),
    };
  } catch (e) {
    deps.auditConnection?.({
      action: "use",
      tool: "connection_proxy",
      outcome: "error",
      service,
      field: request.field,
      errorKind: e instanceof Error ? e.name : "Error",
      actorId: input.actorId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw e;
  } finally {
    if (Buffer.isBuffer(value)) value.fill(0);
  }
}

export function connectionProxyRoutes(
  app: FastifyInstance,
  deps: ConnectionProxyRouteDeps,
) {
  void deps;
  app.post<{ Params: { service: string } }>(
    "/api/connection-proxy/:service",
    async (_request, reply) => {
      return reply.code(403).send({
        error: "Direct Connection proxy route is disabled in the foundation PR",
      });
    },
  );
}
