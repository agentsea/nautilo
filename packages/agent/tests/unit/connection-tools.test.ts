import { afterEach, describe, expect, test } from "bun:test";

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
  createDeleteConnectionTool,
  createListConnectionsTool,
  createUseConnectionTool,
} from "../../src/tools/connections/connections";
import {
  setConnectionVaultAuditSink,
  setConnectionVaultBackend,
} from "../../src/tools/connections/runtime";

class MemoryBackend implements VaultBackend {
  readonly state: VaultState = "plaintext_open";
  readonly vaultFilePath = "memory://test";
  private rows = new Map<string, { bytes: Buffer; record: ConnectionRecord }>();

  unlock(_options?: UnlockVaultOptions  ): Promise<void> {
    return Promise.resolve();
  }

  lock(): void {}

  enableEncryption(_options?: UnlockVaultOptions  ): Promise<void> {
    return Promise.resolve();
  }

  async get(ref: ConnectionRefWithId, _scope: ConnectionScope): Promise<Uint8Array | null> {
    return this.rows.get(`${ref.service}.${ref.field}`)?.bytes ?? null;
  }

  async set(
    ref: ConnectionRef,
    value: Uint8Array,
    scope: ConnectionScope,
    options?: StoreConnectionOptions  ,
  ): Promise<void> {
    const key = `${ref.service}.${ref.field}`;
    this.rows.set(key, {
      bytes: Buffer.from(value),
      record: {
        id: key,
        ref,
        metadata: {
          agent_id: scope.agentId,
          authored_by_user_id: options?.authoredByUserId ?? null,
          category: options?.category ?? "user",
          created_at: "2026-01-01T00:00:00.000Z",
          expires_at: options?.expiresAt ?? null,
          field: ref.field,
          namespace_id: scope.defaultNamespaceId ?? null,
          service: ref.service,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      },
    });
  }

  async list(_scope: ConnectionScope): Promise<ConnectionRecord[]> {
    return [...this.rows.values()].map((row) => row.record);
  }

  async delete(ref: ConnectionRefWithId, _scope: ConnectionScope): Promise<boolean> {
    return this.rows.delete(`${ref.service}.${ref.field}`);
  }

  rotateKey(): Promise<void> {
    return Promise.resolve();
  }
}

const context = {
  agentId: "agent-a",
  userId: "user-a",
  memoryAccessEnvelope: {
    agentId: "agent-a",
    readableNamespaces: ["ns-a"],
    mutableNamespaces: ["ns-a"],
    writableNamespaces: ["ns-a"],
  },
};

afterEach(() => {
  setConnectionVaultBackend(null);
  setConnectionVaultAuditSink(null);
});

describe("D041 Connection tools", () => {
  test("list/use return metadata-only status", async () => {
    const backend = new MemoryBackend();
    setConnectionVaultBackend(backend);
    await backend.set(
      { service: "github", field: "token" },
      Buffer.from("ghp_secretsecretsecretsecretsecret"),
      {
        agentId: "agent-a",
        defaultNamespaceId: "ns-a",
        readableNamespaceIds: ["ns-a"],
      },
      { category: "user" },
    );

    const list = createListConnectionsTool(context);
    const use = createUseConnectionTool(context);

    const listed = String(await list.invoke({}));
    expect(listed).toContain("\"service\":\"github\"");
    expect(listed).toContain("\"category\":\"user\"");
    expect(listed).not.toContain("ghp_secret");

    const used = String(await use.invoke({ service: "github", field: "token" }));
    expect(used).toContain("\"status\":\"available\"");
    expect(used).not.toContain("ghp_secret");
  });

  test("delete_connection removes row and emits audit rows", async () => {
    const audits: unknown[] = [];
    setConnectionVaultAuditSink((evt) => {
      audits.push(evt);
    });
    const backend = new MemoryBackend();
    setConnectionVaultBackend(backend);

    const del = createDeleteConnectionTool(context);

    await backend.set(
      { service: "api", field: "key" },
      Buffer.from("supersecretvalue"),
      {
        agentId: "agent-a",
        defaultNamespaceId: "ns-a",
        readableNamespaceIds: ["ns-a"],
      },
      { category: "user" },
    );
    const removed = String(
      await del.invoke({ service: "api", field: "key" }),
    );
    expect(removed).toContain("\"status\":\"deleted\"");

    const missing = String(
      await del.invoke({ service: "api", field: "key" }),
    );
    expect(missing).toContain("\"status\":\"missing\"");

    expect(audits.some((e) => (e as { action: string }).action === "delete")).toBe(true);
  });
});

