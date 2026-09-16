import type { FastifyInstance, InjectOptions } from "fastify";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

export async function authedInject(
  app: FastifyInstance,
  opts: {
    method: HttpMethod;
    url: string;
    bearer: string;
    payload?: unknown;
    headers?: Record<string, string>;
  },
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.bearer}`,
    ...opts.headers,
  };
  // Only declare a JSON content-type when there is actually a body to
  // parse. Previously this was set for ANY non-GET/HEAD/DELETE method
  // even with no payload, which made Fastify's defaultJsonParser try to
  // parse an empty body and reject the request with 400 — breaking
  // bodyless mutations like `PUT /api/groups/:id/members/:userId`.
  if (opts.payload !== undefined) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }
  const injectOpts: InjectOptions = {
    method: opts.method,
    url: opts.url,
    headers,
  };
  if (opts.payload !== undefined) {
    injectOpts.payload = opts.payload as NonNullable<InjectOptions["payload"]>;
  }
  return app.inject(injectOpts);
}

/**
 * Real TCP round-trip for routes where `app.inject` cannot drain
 * streaming bodies (`@fastify/static`, SSE, large multipart, etc.).
 */
export async function withListeningServer<T>(
  app: FastifyInstance,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    return await fn(address.replace(/\/$/, ""));
  } finally {
    // Fastify v5 defaults to `forceCloseConnections: 'idle'`, which leaves
    // upgraded WebSocket sockets in the http.Server's "active" set even
    // after both ends complete the WS close handshake. Without an explicit
    // closeAllConnections() call, `app.close()` blocks forever waiting for
    // those orphaned upgrade sockets to drain. Belt-and-braces drop them
    // before tearing down the app.
    const server = (app as unknown as { server?: { closeAllConnections?: () => void } }).server;
    server?.closeAllConnections?.();
    await app.close();
  }
}
