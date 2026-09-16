import { afterEach, describe, expect, test } from "bun:test";
import Fastify from "fastify";
import type {
  ConnectionRecord,
  ConnectionRef,
  ConnectionRefWithId,
  ConnectionScope,
  StoreConnectionOptions,
  UnlockVaultOptions,
  VaultBackend,
  VaultState,
} from "@nautilo/types";

import {
  connectionProxyRoutes,
  dispatchConnectionProxy,
} from "../../src/routes/connection-proxy";

class MemoryVault implements VaultBackend {
  readonly state: VaultState = "plaintext_open";
  readonly vaultFilePath = "memory://connection-proxy";
  getCalls = 0;
  private readonly rows = new Map<string, { value: Buffer; scope: ConnectionScope }>();

  unlock(_options?: UnlockVaultOptions): Promise<void> {
    return Promise.resolve();
  }
  lock(): void {}
  enableEncryption(_options?: UnlockVaultOptions): Promise<void> {
    return Promise.resolve();
  }
  async get(ref: ConnectionRefWithId, scope: ConnectionScope): Promise<Uint8Array | null> {
    this.getCalls++;
    const hit = this.rows.get(`${ref.service}.${ref.field}`);
    if (!hit) return null;
    if (
      hit.scope.agentId === scope.agentId &&
      hit.scope.defaultNamespaceId !== null &&
      hit.scope.defaultNamespaceId !== undefined &&
      scope.readableNamespaceIds.includes(hit.scope.defaultNamespaceId)
    ) {
      return Buffer.from(hit.value);
    }
    return null;
  }
  async set(
    ref: ConnectionRef,
    value: Uint8Array,
    scope: ConnectionScope,
    _options?: StoreConnectionOptions,
  ): Promise<void> {
    this.rows.set(`${ref.service}.${ref.field}`, { value: Buffer.from(value), scope });
  }
  list(_scope: ConnectionScope): Promise<ConnectionRecord[]> {
    return Promise.resolve([]);
  }
  delete(_ref: ConnectionRefWithId, _scope: ConnectionScope): Promise<boolean> {
    return Promise.resolve(false);
  }
  rotateKey(): Promise<void> {
    return Promise.resolve();
  }
}

function makeApp(
  vault = new MemoryVault(),
  fetchImpl?: typeof fetch,
  options: { actorRole?: string; memoryEnvelope?: boolean } = {},
) {
  const app = Fastify();
  app.decorateRequest("policyContext", null);
  app.decorateRequest("memoryEnvelope", null);
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("sessionActorId", null);
  app.addHook("preHandler", (request, _reply, done) => {
    request.policyContext = {
      actorRole: options.actorRole ?? "owner",
    } as typeof request.policyContext;
    request.sessionUserId = "user-1";
    request.sessionActorId = "actor-1";
    request.memoryEnvelope = options.memoryEnvelope === false
      ? null
      : {
          ownerId: "user-1",
          actorId: "actor-1",
          agentId: "agent-1",
          roomId: "room-1",
          readableNamespaces: ["ns-1"],
          mutableNamespaces: ["ns-1"],
          writableNamespaces: ["ns-1"],
          toolPolicy: {},
        };
    done();
  });
  const audits: unknown[] = [];
  connectionProxyRoutes(app, {
    vault,
    fetchImpl,
    auditConnection: (evt) => audits.push(evt),
  });
  return { app, audits, vault };
}

afterEach(() => {
  delete process.env["NAUTILO_CONNECTION_PROXY_ALLOW_LOCALHOST"];
});

describe("/api/connection-proxy", () => {
  test("injects auth upstream and redacts echoed secret", async () => {
    process.env["NAUTILO_CONNECTION_PROXY_ALLOW_LOCALHOST"] = "1";
    const vault = new MemoryVault();
    await vault.set(
      { service: "github", field: "api_key" },
      Buffer.from("ghp_secret"),
      {
        agentId: "agent-1",
        defaultNamespaceId: "ns-1",
        readableNamespaceIds: ["ns-1"],
      },
    );
    const seenAuth: string[] = [];
    const audits: unknown[] = [];
    const fetchImpl = ((input, init) => {
      void input;
      const headers = new Headers(init?.headers);
      seenAuth.push(headers.get("authorization") ?? "");
      return Promise.resolve(
        new Response(`upstream saw ${headers.get("authorization")}`, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );
    }) as typeof fetch;

    const res = await dispatchConnectionProxy(
      { vault, fetchImpl, auditConnection: (evt) => audits.push(evt) },
      {
        service: "github",
        scope: {
          agentId: "agent-1",
          defaultNamespaceId: "ns-1",
          readableNamespaceIds: ["ns-1"],
        },
        actorId: "actor-1",
        ip: "127.0.0.1",
        request: {
        field: "api_key",
        url: "http://127.0.0.1/upstream",
        method: "POST",
        category: "user",
        body: "{}",
        headers: { Authorization: "Bearer attacker", "x-nautilo-connection-id": "local" },
      },
      },
    );

    expect(res.status).toBe("ok");
    expect(seenAuth[0]).toBe("Bearer ghp_secret");
    expect(res.body).not.toContain("ghp_secret");
    expect(res.body).toContain("[REDACTED CONNECTION]");
    expect(audits).toContainEqual(expect.objectContaining({
      action: "use",
      tool: "connection_proxy",
      outcome: "ok",
      service: "github",
      field: "api_key",
    }));
  });

  test("rejects disallowed upstream before vault lookup", async () => {
    const vault = new MemoryVault();
    let err: unknown;
    try {
      await dispatchConnectionProxy(
        { vault },
        {
          service: "github",
          scope: {
            agentId: "agent-1",
            defaultNamespaceId: "ns-1",
            readableNamespaceIds: ["ns-1"],
          },
          actorId: "actor-1",
          ip: "127.0.0.1",
          request: {
            field: "api_key",
            url: "https://evil.example.test/path",
            method: "GET",
            category: "user",
          },
        },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Connection proxy target is not allowed");
    expect(vault.getCalls).toBe(0);
  });

  test("wrong namespace and wrong agent cannot access user Connection", async () => {
    process.env["NAUTILO_CONNECTION_PROXY_ALLOW_LOCALHOST"] = "1";
    const vault = new MemoryVault();
    await vault.set(
      { service: "github", field: "api_key" },
      Buffer.from("ghp_secret"),
      {
        agentId: "agent-other",
        defaultNamespaceId: "ns-private",
        readableNamespaceIds: ["ns-private"],
      },
    );
    let err: unknown;
    try {
      await dispatchConnectionProxy(
        { vault },
        {
          service: "github",
          scope: {
            agentId: "agent-1",
            defaultNamespaceId: "ns-1",
            readableNamespaceIds: ["ns-1"],
          },
          actorId: "actor-1",
          ip: "127.0.0.1",
          request: {
            field: "api_key",
            url: "http://127.0.0.1/upstream",
            method: "GET",
            category: "user",
          },
        },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Connection not found");
  });

  test("system/provider keys are not accepted on Connection proxy route", async () => {
    process.env["NAUTILO_CONNECTION_PROXY_ALLOW_LOCALHOST"] = "1";
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/connection-proxy/tavily",
      payload: {
        field: "api_key",
        category: "system",
        url: "http://127.0.0.1/upstream",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  test.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "direct route is disabled before vault lookup for payload method %s",
    async (method) => {
      process.env["NAUTILO_CONNECTION_PROXY_ALLOW_LOCALHOST"] = "1";
      const { app, vault } = makeApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/connection-proxy/github",
        payload: {
          field: "api_key",
          method,
          url: "http://127.0.0.1/upstream",
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.body).toContain("Direct Connection proxy route is disabled");
      expect(vault.getCalls).toBe(0);
    },
  );
});
