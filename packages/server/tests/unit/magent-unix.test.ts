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
function fixture(avatar: Awaited<ReturnType<MagentOperatorService["avatar"]>> = null) {
  const calls: unknown[][] = [];
  const service = {
    async status() { calls.push(["status"]); return { status: "ready", operatorBindingId: id, providerAgentId: "receiving-agent", chatId: "synthetic-room", senderId: "connector-relay" }; },
    async avatar() { calls.push(["avatar"]); return avatar; },
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
  const message = { kind: "operator_control_v1", sessionId: "connector-session", messageId: "message-1", senderId: "connector-relay", senderLabel: "Remote connector", content: "Literal remote request", createdAt: "2026-01-01T00:00:00Z" };
  try {
    for (const extra of [{ kind: undefined }, { kind: "message" }, { sponsorUserId: id }, { roomId: id }, { agentId: id }, { externalOrigin: {} }, { content: "x".repeat(2048) }]) {
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


test("avatar endpoint returns only authenticated binding pixels and rejects identity overrides", async () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const { app, calls } = fixture({ status: "ready", bytes: png, contentType: "image/png" });
  try {
    expect((await app.inject({ url: "/v1/avatar" })).statusCode).toBe(401);
    expect((await app.inject({ url: `/v1/avatar?genieId=${id}`, headers })).statusCode).toBe(400);
    expect(calls).toEqual([]);
    const result = await app.inject({ url: "/v1/avatar", headers });
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("image/png");
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.rawPayload).toEqual(Buffer.from(png));
    expect(calls).toEqual([["avatar"]]);
  } finally { await app.close(); }
  for (const [avatar, statusCode, error] of [
    [null, 409, "authority_or_state_unavailable"],
    [{ status: "absent" as const }, 404, "avatar_absent"],
  ] as const) {
    const fixtureApp = fixture(avatar).app;
    try {
      const result = await fixtureApp.inject({ url: "/v1/avatar", headers });
      expect(result.statusCode).toBe(statusCode);
      expect(result.json()).toEqual({ error });
    } finally { await fixtureApp.close(); }
  }
});

test("another binding credential cannot access any authenticated surface", async () => {
  const { app, calls } = fixture();
  try {
    const otherHeaders = { authorization: "Bearer synthetic-other-binding-capability-with-no-authority-0000" };
    for (const request of [
      { method: "GET" as const, url: "/v1/status" },
      { method: "GET" as const, url: "/v1/avatar" },
      { method: "GET" as const, url: `/v1/turns/${id}` },
      { method: "DELETE" as const, url: `/v1/turns/${id}` },
      { method: "POST" as const, url: `/v1/publications/${id}/claim`, payload: { claimToken: id } },
      { method: "POST" as const, url: `/v1/publications/${id}/authorize`, payload: { claimToken: id } },
      { method: "POST" as const, url: `/v1/publications/${id}/settle`, payload: { claimToken: id, state: "cancelled" } },
    ]) expect((await app.inject({ ...request, headers: otherHeaders })).statusCode).toBe(401);
    expect(calls).toEqual([]);
  } finally { await app.close(); }
});


test("private config files require a private parent and safe canonical ancestors", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "magent-parent-test-")));
  const path = join(directory, "operator.json");
  try {
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    for (const mode of [0o755, 0o770, 0o777]) {
      await chmod(directory, mode);
      await Promise.resolve(expect(readMagentOperatorConfig(path)).rejects.toThrow("magent_config_directory_invalid"));
    }
    await chmod(directory, 0o700);
    expect(await readMagentOperatorConfig(path)).toEqual(config);
    const { mkdir } = await import("node:fs/promises");
    const parent = join(directory, "ancestor");
    const child = join(parent, "private");
    await mkdir(child, { recursive: true, mode: 0o700 });
    const nested = join(child, "operator.json");
    await writeFile(nested, JSON.stringify(config), { mode: 0o600 });
    await chmod(parent, 0o777);
    await Promise.resolve(expect(readMagentOperatorConfig(nested)).rejects.toThrow("magent_config_directory_invalid"));
    await chmod(parent, 0o700);
    const alias = join(directory, "alias");
    await symlink(parent, alias);
    await Promise.resolve(expect(readMagentOperatorConfig(join(alias, "private", "operator.json"))).rejects.toThrow("magent_config_path_invalid"));
    await Promise.resolve(expect(readMagentOperatorConfig(`${parent}/../operator.json`)).rejects.toThrow("magent_config_path_invalid"));
  } finally { await chmod(directory, 0o700); await rm(directory, { recursive: true }); }
});
