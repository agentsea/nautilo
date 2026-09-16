import { describe, expect, test } from "bun:test";

import type { CeremonyRef } from "./invite-ceremony";
import {
  activateInviteServer,
  resolveInviteServer,
  type InviteServerRecord,
  type InviteServerRegistry,
  type InviteServerResolutionDependencies,
} from "./invite-server-resolution";

const ref: CeremonyRef = { generation: 4, serverId: "srv_https___invite_test", ceremonyId: "ceremony-4" };
const url = "https://invite.test";
const record: InviteServerRecord = {
  id: ref.serverId,
  serverUrl: url,
  displayName: "Invite Test",
  lastActive: 1,
};

function serverIdFromUrl(serverUrl: string): string {
  return `srv_${serverUrl.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;
}

function harness(registry: InviteServerRegistry = { servers: [], activeId: null }) {
  let current = true;
  let state = registry;
  const calls = { probes: [] as string[], upserts: 0, switches: [] as string[], refreshes: 0, previews: 0 };
  const dependencies: InviteServerResolutionDependencies = {
    serverIdFromUrl,
    probeServer: async (serverUrl) => {
      calls.probes.push(serverUrl);
      return { ok: true, displayName: "Invite Test" };
    },
    loadRegistry: async () => state,
    upsertServer: async ({ serverUrl, displayName }) => {
      calls.upserts += 1;
      const next = { id: serverIdFromUrl(serverUrl), serverUrl, displayName, lastActive: 2 };
      state = { servers: [...state.servers.filter((server) => server.id !== next.id), next], activeId: next.id };
      return next;
    },
    setActiveServer: async (id) => {
      calls.switches.push(id);
      state = { ...state, activeId: state.servers.some((server) => server.id === id) ? id : state.activeId };
    },
    refresh: async () => { calls.refreshes += 1; },
    isCurrent: () => current,
  };
  return {
    dependencies,
    calls,
    get registry() { return state; },
    setRegistry(next: InviteServerRegistry) { state = next; },
    stale() { current = false; },
  };
}

describe("exact invite server resolution", () => {
  test("recognizes a known active exact server without probing or previewing", async () => {
    const h = harness({ servers: [record], activeId: record.id });
    expect(await resolveInviteServer({ ref, serverUrl: url }, h.dependencies)).toMatchObject({
      kind: "known-active", serverId: record.id, serverUrl: url,
    });
    expect(h.calls).toMatchObject({ probes: [], previews: 0 });
  });

  test("classifies a known inactive exact server and activates only that record", async () => {
    const h = harness({ servers: [record], activeId: "srv_other" });
    const resolved = await resolveInviteServer({ ref, serverUrl: url }, h.dependencies);
    expect(resolved.kind).toBe("known-inactive");
    const activation = await activateInviteServer({ ref, serverUrl: url, operation: "switch" }, h.dependencies);
    expect(activation).toMatchObject({ kind: "activated", serverId: record.id, serverUrl: url });
    expect(h.calls).toMatchObject({ probes: [], switches: [record.id], refreshes: 1, previews: 0 });
  });

  test("probes an unknown exact origin before a confirmed add", async () => {
    const h = harness();
    const resolved = await resolveInviteServer({ ref, serverUrl: url }, h.dependencies);
    expect(resolved).toMatchObject({ kind: "requires-confirmation", serverId: record.id, serverUrl: url });
    expect(h.calls.probes).toEqual([url]);
    expect(await activateInviteServer({ ref, serverUrl: url, operation: "add" }, h.dependencies)).toMatchObject({
      kind: "requires-resolution",
    });
    if (resolved.kind !== "requires-confirmation") throw new Error("expected explicit server confirmation");
    expect(await activateInviteServer({ ref, serverUrl: url, operation: "add", confirmation: resolved }, h.dependencies)).toMatchObject({
      kind: "activated", serverId: record.id, serverUrl: url,
    });
    expect(h.calls).toMatchObject({ probes: [url], upserts: 1, previews: 0 });
  });

  test("reports an unreachable target and never adds it", async () => {
    const h = harness();
    h.dependencies.probeServer = async () => ({ ok: false, error: "offline" });
    expect(await resolveInviteServer({ ref, serverUrl: url }, h.dependencies)).toMatchObject({ kind: "unreachable" });
    expect(h.calls).toMatchObject({ upserts: 0, previews: 0 });
  });

  test("rejects an invalid target before it reads the registry or reaches a network client", async () => {
    const h = harness();
    expect(await resolveInviteServer({ ref, serverUrl: "https://invite.test/not-an-origin" }, h.dependencies)).toMatchObject({
      kind: "invalid-locator",
    });
    expect(h.calls).toMatchObject({ probes: [], upserts: 0, switches: [], previews: 0 });
  });

  test("normalizes equivalent origins without changing the exact network target", async () => {
    const h = harness({ servers: [record], activeId: record.id });
    const equivalent = "HTTPS://INVITE.TEST/";
    expect(await resolveInviteServer({ ref, serverUrl: equivalent }, h.dependencies)).toMatchObject({
      kind: "known-active", serverUrl: url,
    });
    expect(h.calls.probes).toEqual([]);
  });

  test("rejects a ceremony/server ID mismatch before a registry or network operation", async () => {
    const h = harness();
    const wrongRef = { ...ref, serverId: "srv_evil" };
    expect(await resolveInviteServer({ ref: wrongRef, serverUrl: url }, h.dependencies)).toMatchObject({ kind: "server-mismatch" });
    expect(h.calls).toMatchObject({ probes: [], upserts: 0, switches: [], previews: 0 });
  });

  test("does not turn a removed known server into an add", async () => {
    const h = harness({ servers: [record], activeId: "srv_other" });
    expect((await resolveInviteServer({ ref, serverUrl: url }, h.dependencies)).kind).toBe("known-inactive");
    h.setRegistry({ servers: [], activeId: null });
    expect(await activateInviteServer({ ref, serverUrl: url, operation: "switch" }, h.dependencies)).toMatchObject({
      kind: "server-removed",
    });
    expect(h.calls).toMatchObject({ upserts: 0, switches: [], previews: 0 });
  });

  test("returns stale when a newer ceremony replaces this one during a probe", async () => {
    const h = harness();
    let release!: () => void;
    h.dependencies.probeServer = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: true, displayName: "Invite Test" };
    };
    const pending = resolveInviteServer({ ref, serverUrl: url }, h.dependencies);
    await Promise.resolve();
    h.stale();
    release();
    expect(await pending).toMatchObject({ kind: "stale", ref, serverUrl: url });
  });

  test("returns stale when a newer ceremony replaces this one during activation", async () => {
    const h = harness({ servers: [record], activeId: "srv_other" });
    let release!: () => void;
    h.dependencies.setActiveServer = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
    };
    const pending = activateInviteServer({ ref, serverUrl: url, operation: "switch" }, h.dependencies);
    await Promise.resolve();
    h.stale();
    release();
    expect(await pending).toMatchObject({ kind: "stale", ref, serverUrl: url });
  });

  test("proves the post-activation active record has the exact ID and normalized URL", async () => {
    const h = harness({ servers: [record], activeId: "srv_other" });
    h.dependencies.setActiveServer = async () => {
      h.setRegistry({ servers: [record], activeId: "srv_other" });
    };
    expect(await activateInviteServer({ ref, serverUrl: url, operation: "switch" }, h.dependencies)).toMatchObject({
      kind: "server-removed", serverId: record.id, serverUrl: url,
    });

    const bad = { ...record, serverUrl: "https://wrong.test" };
    const mismatch = harness({ servers: [bad], activeId: bad.id });
    expect(await resolveInviteServer({ ref, serverUrl: url }, mismatch.dependencies)).toMatchObject({ kind: "server-mismatch" });
  });

  test("has no preview dependency, fan-out loop, or secondary server target", async () => {
    const h = harness();
    const result = await resolveInviteServer({ ref, serverUrl: url }, h.dependencies);
    expect(result.kind).toBe("requires-confirmation");
    expect(h.calls.probes).toEqual([url]);
    expect(h.calls.previews).toBe(0);
    expect(h.registry.servers).toHaveLength(0);
  });
});
