import { expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMagentUnixHttp, readMagentOperatorConfig } from "../../src/messaging/magent-unix";
import type { MagentOperatorService } from "../../src/messaging/magent-operator";

const id = "10000000-0000-4000-8000-000000000001";
const credential = "synthetic-test-capability-with-no-real-authority-0000";
const config = { version: 1 as const, operatorBindingId: id, sponsorUserId: id, genieId: id, origin: "http://127.0.0.1:8080",
  providerAgentId: "receiving-agent", senderId: "connector-relay", chatId: "synthetic-room", roomName: "External conversation",
  socketPath: "/path/to/private/magent.sock", credential, maxRequestBytes: 1024 };
const headers = { authorization: `Bearer ${credential}` };
function fixture() {
  const calls: unknown[][] = [];
  const service = {
    async status() { calls.push(["status"]); return { status: "ready", operatorBindingId: id, providerAgentId: "receiving-agent", chatId: "synthetic-room", senderId: "connector-relay" }; },
    async accept(input: unknown) { calls.push(["accept", input]); return { receiptId: id, state: "accepted", dispatch: "adopted" }; },
    async receipt(value: string) { calls.push(["receipt", value]); return { receiptId: value, state: "pending" }; },
    async cancel(value: string) { calls.push(["cancel", value]); return { receiptId: value, state: "cancelled" }; },
    async claim(outboxId: string, claimToken: string) { calls.push(["claim", outboxId, claimToken]); return { outboxId, claimToken, content: "canonical answer" }; },
    async authorize(...args: string[]) { calls.push(["authorize", ...args]); return null; },
    async settle(...args: unknown[]) { calls.push(["settle", ...args]); return { outboxId: id, state: "cancelled", providerMessageId: null }; },
    async withdraw(state: string) { calls.push(["withdraw", state]); return { state }; },
  } as unknown as MagentOperatorService;
  return { calls, app: createMagentUnixHttp(config, service) };
}

test("operator routes require the scoped credential before exposing metadata or invoking work", async () => {
  const { app, calls } = fixture();
  try {
    for (const authorization of [undefined, "Bearer wrong", credential]) {
      const result = await app.inject({ url: "/v1/status", ...(authorization ? { headers: { authorization } } : {}) });
      expect(result.statusCode).toBe(401);
    }
    expect(calls).toEqual([]);
    const result = await app.inject({ url: "/v1/status", headers });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: "ready", operatorBindingId: id, providerAgentId: "receiving-agent", chatId: "synthetic-room", senderId: "connector-relay" });
    expect(result.body).not.toContain(credential);
  } finally { await app.close(); }
});

test("external input cannot supply local Human authority, routing, tools or oversized content", async () => {
  const { app, calls } = fixture();
  const message = { sessionId: "connector-session", messageId: "message-1", senderId: "connector-relay", senderLabel: "Remote connector", content: "Literal remote request", createdAt: "2026-01-01T00:00:00Z" };
  try {
    for (const extra of [{ sponsorUserId: id }, { roomId: id }, { agentId: id }, { externalOrigin: {} }, { content: "x".repeat(2048) }]) {
      expect((await app.inject({ method: "POST", url: "/v1/turns", headers, payload: { ...message, ...extra } })).statusCode).toBe(400);
    }
    expect(calls).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/v1/turns", headers, payload: message })).statusCode).toBe(200);
    expect(calls).toEqual([["accept", message]]);
  } finally { await app.close(); }
});

test("publication retries retain the client claim and withdrawn authorization fails visibly", async () => {
  const { app, calls } = fixture();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await app.inject({ method: "POST", url: `/v1/publications/${id}/claim`, headers, payload: { claimToken: id } });
      expect(JSON.parse(result.body)).toEqual({ outboxId: id, claimToken: id, content: "canonical answer" });
    }
    expect(calls).toEqual([["claim", id, id], ["claim", id, id]]);
    expect((await app.inject({ method: "POST", url: `/v1/publications/${id}/authorize`, headers, payload: { claimToken: id } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/v1/publications/${id}/settle`, headers, payload: { claimToken: id, state: "published" } })).statusCode).toBe(400);
    expect(JSON.parse((await app.inject({ method: "DELETE", url: `/v1/turns/${id}`, headers })).body)).toEqual({ receiptId: id, state: "cancelled" });
  } finally { await app.close(); }
});

test("operator configuration rejects shared permissions and symlink substitution", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "magent-config-test-")));
  const path = join(directory, "operator.json");
  try {
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    expect(await readMagentOperatorConfig(path)).toEqual(config);
    await chmod(path, 0o644);
    await Promise.resolve(expect(readMagentOperatorConfig(path)).rejects.toThrow("magent_config_invalid"));
    await chmod(path, 0o600);
    const alias = join(directory, "alias.json");
    await symlink(path, alias);
    await Promise.resolve(expect(readMagentOperatorConfig(alias)).rejects.toThrow("magent_config_path_invalid"));
  } finally { await rm(directory, { recursive: true }); }
});
