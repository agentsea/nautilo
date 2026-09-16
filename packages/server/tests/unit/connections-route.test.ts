import { describe, expect, test } from "bun:test";
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

import { connectionRoutes } from "../../src/routes/connections";

class MemoryVault implements VaultBackend {
  readonly state: VaultState = "plaintext_open";
  readonly vaultFilePath = "memory://connections-route";
  private readonly rows = new Map<string, ConnectionRecord>();

  constructor(private readonly options?: { readonly failList?: boolean }) {}

  private readable(row: ConnectionRecord, scope: ConnectionScope): boolean {
    const ns = row.metadata.namespace_id;
    const expiresAt = row.metadata.expires_at;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      return false;
    }
    return (
      ns !== null &&
      row.metadata.agent_id === scope.agentId &&
      scope.readableNamespaceIds.includes(ns)
    );
  }

  unlock(_options?: UnlockVaultOptions): Promise<void> {
    return Promise.resolve();
  }
  lock(): void {}
  enableEncryption(_options?: UnlockVaultOptions): Promise<void> {
    return Promise.resolve();
  }
  get(_ref: ConnectionRefWithId, _scope: ConnectionScope): Promise<Uint8Array | null> {
    return Promise.resolve(Buffer.from("secret"));
  }
  async set(
    ref: ConnectionRef,
    _value: Uint8Array,
    scope: ConnectionScope,
    options?: StoreConnectionOptions,
  ): Promise<void> {
    const id = `${ref.service}.${ref.field}`;
    this.rows.set(id, {
      id,
      ref,
      metadata: {
        service: ref.service,
        field: ref.field,
        category: options?.category ?? "user",
        namespace_id: options?.namespaceId ?? scope.defaultNamespaceId ?? null,
        agent_id: options?.agentId ?? scope.agentId,
        authored_by_user_id: options?.authoredByUserId ?? null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        expires_at: options?.expiresAt ?? null,
      },
    });
  }
  list(_scope: ConnectionScope): Promise<ConnectionRecord[]> {
    if (this.options?.failList) {
      return Promise.reject(new Error("vault list failed"));
    }
    return Promise.resolve([...this.rows.values()].filter((row) => this.readable(row, _scope)));
  }
  delete(ref: ConnectionRefWithId, scope: ConnectionScope): Promise<boolean> {
    const key = `${ref.service}.${ref.field}`;
    const row = this.rows.get(key);
    if (!row || !this.readable(row, scope)) {
      return Promise.resolve(false);
    }
    return Promise.resolve(this.rows.delete(key));
  }
  rotateKey(): Promise<void> {
    return Promise.resolve();
  }
}

function makeApp(vault: VaultBackend = new MemoryVault()) {
  const app = Fastify();
  app.decorateRequest("policyContext", null);
  app.decorateRequest("memoryEnvelope", null);
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", (request, _reply, done) => {
    request.policyContext = { actorRole: "owner" } as typeof request.policyContext;
    request.sessionUserId = "user-1";
    request.memoryEnvelope = {
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
  connectionRoutes(app, { vault });
  return app;
}

describe("/api/connections", () => {
  test("stores and lists metadata without returning values", async () => {
    const app = makeApp();
    const saved = await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { service: "github", field: "api_key", value: "ghp_secret" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("ghp_secret");

    const listed = await app.inject({ method: "GET", url: "/api/connections" });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).toContain("\"service\":\"github\"");
    expect(listed.body).not.toContain("ghp_secret");
  });

  test("rejects invalid expiresAt strings before persistence", async () => {
    const app = makeApp();
    const saved = await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: {
        service: "github",
        field: "api_key",
        value: "ghp_secret",
        expiresAt: "not-a-date",
      },
    });

    expect(saved.statusCode).toBe(400);

    const listed = await app.inject({ method: "GET", url: "/api/connections" });
    expect(listed.body).not.toContain("github");
  });

  test("accepts valid future expiresAt", async () => {
    const app = makeApp();
    const saved = await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: {
        service: "github",
        field: "api_key",
        value: "ghp_secret",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.body).toContain("\"expires_at\":\"2999-01-01T00:00:00.000Z\"");
    expect(saved.body).not.toContain("ghp_secret");
  });

  test("rejects expired expiresAt values before persistence", async () => {
    const app = makeApp();
    const saved = await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: {
        service: "github",
        field: "api_key",
        value: "ghp_secret",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    });

    expect(saved.statusCode).toBe(400);

    const listed = await app.inject({ method: "GET", url: "/api/connections" });
    expect(listed.body).not.toContain("github");
  });

  test("delete returns metadata-only status", async () => {
    const app = makeApp();
    await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { service: "github", field: "api_key", value: "ghp_secret" },
    });
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/connections/github/api_key",
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.body).toContain("\"status\":\"deleted\"");
    expect(removed.body).not.toContain("ghp_secret");
  });

  test("store/delete mutation routes allow owner sessions from non-loopback", async () => {
    const app = makeApp();

    const saved = await app.inject({
      method: "POST",
      url: "/api/connections",
      remoteAddress: "203.0.113.10",
      payload: { service: "github", field: "api_key", value: "ghp_secret" },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("ghp_secret");

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/connections/github/api_key",
      remoteAddress: "203.0.113.10",
    });

    expect(deleted.statusCode).toBe(200);
  });

  test("rejects system/provider key storage as a Connection", async () => {
    const app = makeApp();
    const saved = await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: {
        service: "openai",
        field: "api_key",
        category: "system",
        value: "sk-secret",
      },
    });
    expect(saved.statusCode).toBe(400);
    expect(saved.body).not.toContain("sk-secret");
  });

  test("list only returns rows visible to the request scope", async () => {
    const vault = new MemoryVault();
    await vault.set(
      { service: "github", field: "api_key" },
      Buffer.from("visible"),
      { agentId: "agent-1", defaultNamespaceId: "ns-1", readableNamespaceIds: ["ns-1"] },
    );
    await vault.set(
      { service: "slack", field: "api_key" },
      Buffer.from("hidden"),
      { agentId: "agent-2", defaultNamespaceId: "ns-2", readableNamespaceIds: ["ns-2"] },
    );
    const app = makeApp(vault);

    const listed = await app.inject({ method: "GET", url: "/api/connections" });

    expect(listed.statusCode).toBe(200);
    expect(listed.body).toContain("\"service\":\"github\"");
    expect(listed.body).not.toContain("slack");
    expect(listed.body).not.toContain("hidden");
  });

  test("list surfaces vault errors instead of reporting an empty success", async () => {
    const app = makeApp(new MemoryVault({ failList: true }));

    const listed = await app.inject({ method: "GET", url: "/api/connections" });

    expect(listed.statusCode).toBe(500);
    expect(listed.body).not.toContain("\"connections\":[]");
  });

  test("audit surfaces vault errors instead of reporting false findings", async () => {
    const app = makeApp(new MemoryVault({ failList: true }));

    const audited = await app.inject({ method: "POST", url: "/api/connections/audit" });

    expect(audited.statusCode).toBe(500);
    expect(audited.body).not.toContain("\"status\":\"ok\"");
  });
});
