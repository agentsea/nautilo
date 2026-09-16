import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";

import {
  createDnsResolver,
  startNetworkProxy,
  type NetworkPolicy,
  type NetworkProxy,
} from "../../src/network";

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.close();
  }
});

describe("startNetworkProxy", () => {
  test("denies non-allowlisted CONNECT targets with 403", async () => {
    const decisions: unknown[] = [];
    const proxy = await startProxy({
      mode: "proxy-allowlist",
      allow: [{ type: "domain", host: "allowed.example" }],
    }, undefined, decisions);
    const res = await connectRaw(proxy.port, "denied.example:443");
    expect(res).toContain("403 Forbidden");
    expect(res).toContain("network_egress_denied");
    expect(res).toContain("\"host\":\"denied.example\"");
    expect(res).toContain("\"ports\":[443]");
    expect(decisions).toContainEqual({
      host: "denied.example",
      port: 443,
      allowed: false,
      reason: "no allow rule matched",
      deniedDestination: {
        host: "denied.example",
        port: 443,
        reason: "no allow rule matched",
      },
    });
  });

  test("allows CONNECT to an allowlisted host and pipes bytes", async () => {
    const upstream = await startTcpEchoServer();
    const proxy = await startProxy({
      mode: "proxy-allowlist",
      allow: [
        { type: "domain", host: "allowed.example", ports: [upstream.port] },
        { type: "cidr", cidr: "127.0.0.1/32", ports: [upstream.port] },
      ],
    });

    const socket = net.connect({ host: "127.0.0.1", port: proxy.port });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    await onceConnect(socket);
    socket.write(
      `CONNECT allowed.example:${upstream.port} HTTP/1.1\r\nHost: allowed.example:${upstream.port}\r\n\r\n`,
    );
    await waitForText(chunks, "200 Connection Established");
    socket.write("ping");
    await waitForText(chunks, "echo:ping");
    socket.destroy();
  });

  test("plain HTTP proxy denies non-allowlisted host", async () => {
    const proxy = await startProxy({
      mode: "proxy-allowlist",
      allow: [{ type: "domain", host: "allowed.example", ports: [80] }],
    });
    const res = await httpGet(proxy.port, "http://denied.example/private?token=secret");
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: "network_egress_denied",
      destination: {
        host: "denied.example",
        port: 80,
        reason: "no allow rule matched",
        suggestedRule: {
          type: "domain",
          host: "denied.example",
          ports: [80],
        },
      },
    });
    expect(res.body).not.toContain("private");
    expect(res.body).not.toContain("secret");
  });

  test("plain HTTP proxy forwards allowlisted host", async () => {
    const upstream = await startHttpServer();
    const proxy = await startProxy({
      mode: "proxy-allowlist",
      allow: [
        { type: "domain", host: "allowed.example", ports: [upstream.port] },
        { type: "cidr", cidr: "127.0.0.1/32", ports: [upstream.port] },
      ],
    });
    const res = await httpGet(proxy.port, `http://allowed.example:${upstream.port}/hello`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("upstream:/hello");
  });

  test("denies CONNECT when an allowlisted host resolves to loopback without CIDR allow", async () => {
    const upstream = await startTcpEchoServer();
    const proxy = await startProxy({
      mode: "proxy-allowlist",
      allow: [{ type: "domain", host: "allowed.example", ports: [upstream.port] }],
    });

    const res = await connectRaw(proxy.port, `allowed.example:${upstream.port}`);
    expect(res).toContain("403 Forbidden");
  });

  test("plain HTTP proxy denies allowlisted host resolving to metadata IP", async () => {
    const proxy = await startProxy(
      {
        mode: "proxy-allowlist",
        allow: [{ type: "domain", host: "allowed.example", ports: [80] }],
      },
      ["169.254.169.254"],
    );

    const res = await httpGet(proxy.port, "http://allowed.example/");
    expect(res.status).toBe(403);
  });

  test("close is idempotent", async () => {
    const proxy = await startProxy({
      mode: "proxy-allowlist",
      allow: [{ type: "domain", host: "allowed.example" }],
    });
    await proxy.close();
    await proxy.close();
  });
});

async function startProxy(
  policy: NetworkPolicy,
  lookupResult: readonly string[] = ["127.0.0.1"],
  decisions?: unknown[],
): Promise<NetworkProxy> {
  const proxy = await startNetworkProxy({
    policy,
    resolver: createDnsResolver({ lookup: async () => lookupResult }),
    ...(decisions === undefined ? {} : { onDecision: (event) => decisions.push(event) }),
  });
  servers.push(proxy);
  return proxy;
}

async function startTcpEchoServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(`echo:${chunk.toString("utf-8")}`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("bad addr");
  const out = {
    port: addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  servers.push(out);
  return out;
}

async function startHttpServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.end(`upstream:${req.url ?? ""}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("bad addr");
  const out = {
    port: addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  servers.push(out);
  return out;
}

async function connectRaw(port: number, authority: string): Promise<string> {
  const socket = net.connect({ host: "127.0.0.1", port });
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await onceConnect(socket);
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  await waitForText(chunks, "\r\n\r\n");
  socket.destroy();
  return Buffer.concat(chunks).toString("utf-8");
}

async function httpGet(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "GET",
      path: url,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function onceConnect(socket: net.Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

async function waitForText(chunks: readonly Buffer[], needle: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (Buffer.concat(chunks).toString("utf-8").includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${needle}`);
}
