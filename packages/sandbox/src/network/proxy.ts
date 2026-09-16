import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

import { evaluateNetworkEgress } from "./allowlist";
import { createDnsResolver, type DnsResolver } from "./dns";
import {
  type DeniedNetworkDestination,
  type NetworkPolicy,
} from "./policy";
import { isPublicRoutableAddress } from "./address";

export interface NetworkProxyOptions {
  readonly policy: NetworkPolicy;
  readonly resolver?: DnsResolver;
  readonly onDecision?: (event: NetworkProxyDecisionEvent) => void;
}

export interface NetworkProxyDecisionEvent {
  readonly host: string;
  readonly port: number;
  readonly allowed: boolean;
  readonly reason: string;
  readonly deniedDestination?: DeniedNetworkDestination;
}

export interface NetworkProxy {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export async function startNetworkProxy(
  opts: NetworkProxyOptions,
): Promise<NetworkProxy> {
  const resolver = opts.resolver ?? createDnsResolver();
  const server = http.createServer((req, res) => {
    void handleHttpRequest(req, res, opts.policy, resolver, opts.onDecision);
  });

  server.on("connect", (req, socket, head) => {
    void handleConnect(req, socket, head, opts.policy, resolver, opts.onDecision);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("network proxy did not bind to a TCP port");
  }

  let closed = false;
  return {
    port: address.port,
    url: `http://localhost:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleConnect(
  req: http.IncomingMessage,
  client: Duplex,
  head: Buffer,
  policy: NetworkPolicy,
  resolver: DnsResolver,
  onDecision: NetworkProxyOptions["onDecision"],
): Promise<void> {
  const target = parseAuthority(req.url ?? "");
  if (target === null) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  const decision = evaluateNetworkEgress(policy, target.host, target.port);
  emitDecision(onDecision, target.host, target.port, decision.allowed, decision.reason);
  if (!decision.allowed) {
    client.end(forbiddenResponse(target.host, target.port, decision.reason));
    return;
  }

  try {
    const [address] = await resolver.resolve(target.host);
    if (address === undefined) throw new Error("resolver returned no addresses");
    if (!resolvedAddressAllowed(policy, address, target.port)) {
      emitDecision(onDecision, address, target.port, false, "resolved address is not allowlisted");
      client.end(forbiddenResponse(target.host, target.port, "resolved address is not allowlisted"));
      return;
    }
    const upstream = net.connect({ host: address, port: target.port });
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", () => {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
  } catch {
    client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  }
}

async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  policy: NetworkPolicy,
  resolver: DnsResolver,
  onDecision: NetworkProxyOptions["onDecision"],
): Promise<void> {
  const target = parseHttpProxyUrl(req.url ?? "");
  if (target === null) {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  const decision = evaluateNetworkEgress(policy, target.hostname, target.port);
  emitDecision(onDecision, target.hostname, target.port, decision.allowed, decision.reason);
  if (!decision.allowed) {
    writeForbiddenJson(res, target.hostname, target.port, decision.reason);
    return;
  }

  try {
    const [address] = await resolver.resolve(target.hostname);
    if (address === undefined) throw new Error("resolver returned no addresses");
    if (!resolvedAddressAllowed(policy, address, target.port)) {
      emitDecision(onDecision, address, target.port, false, "resolved address is not allowlisted");
      writeForbiddenJson(res, target.hostname, target.port, "resolved address is not allowlisted");
      return;
    }
    const upstream = http.request({
      host: address,
      port: target.port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: {
        ...req.headers,
        host: target.hostHeader,
      },
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.once("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("Bad Gateway");
    });
    req.pipe(upstream);
  } catch {
    res.writeHead(502);
    res.end("Bad Gateway");
  }
}

function parseAuthority(value: string): { host: string; port: number } | null {
  const idx = value.lastIndexOf(":");
  if (idx <= 0) return null;
  const host = value.slice(0, idx).replace(/^\[|\]$/g, "");
  const port = Number.parseInt(value.slice(idx + 1), 10);
  if (!Number.isInteger(port)) return null;
  return { host, port };
}

interface ParsedHttpProxyUrl {
  readonly hostname: string;
  readonly port: number;
  readonly pathname: string;
  readonly search: string;
  readonly hostHeader: string;
}

function parseHttpProxyUrl(value: string): ParsedHttpProxyUrl | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:") return null;
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : 80;
    if (!Number.isInteger(port)) return null;
    return {
      hostname: parsed.hostname,
      port,
      pathname: parsed.pathname,
      search: parsed.search,
      hostHeader: parsed.host,
    };
  } catch {
    return null;
  }
}

function emitDecision(
  onDecision: NetworkProxyOptions["onDecision"],
  host: string,
  port: number,
  allowed: boolean,
  reason: string,
): void {
  onDecision?.({
    host,
    port,
    allowed,
    reason,
    ...(allowed
      ? {}
      : { deniedDestination: deniedNetworkDestination(host, port, reason) }),
  });
}

function deniedNetworkDestination(
  host: string,
  port: number,
  reason: string,
): DeniedNetworkDestination {
  return {
    host,
    port,
    reason,
  };
}

function forbiddenResponse(host: string, port: number, reason: string): string {
  const body = `${JSON.stringify({
    error: "network_egress_denied",
    destination: {
      ...deniedNetworkDestination(host, port, reason),
      // User-facing HTTP body only. Control plane derives its own
      // narrow rule from host+port via relay protocol metadata.
      suggestedRule: {
        type: "domain",
        host,
        ports: [port],
      },
    },
  })}\n`;
  return [
    "HTTP/1.1 403 Forbidden",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
    "",
    body,
  ].join("\r\n");
}

function writeForbiddenJson(
  res: http.ServerResponse,
  host: string,
  port: number,
  reason: string,
): void {
  res.writeHead(403, { "content-type": "application/json" });
  res.end(`${JSON.stringify({
    error: "network_egress_denied",
    destination: {
      ...deniedNetworkDestination(host, port, reason),
      suggestedRule: {
        type: "domain",
        host,
        ports: [port],
      },
    },
  })}\n`);
}

function resolvedAddressAllowed(
  policy: NetworkPolicy,
  address: string,
  port: number,
): boolean {
  if (isPublicRoutableAddress(address)) return true;
  const ipDecision = evaluateNetworkEgress(policy, address, port);
  return ipDecision.allowed && ipDecision.matchedRule?.type === "cidr";
}
