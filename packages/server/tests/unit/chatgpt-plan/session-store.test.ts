import { describe, expect, test } from "bun:test";
import type { ChatGPTRegistrationRecord } from "@nautilo/db";
import { createPersonalProviderCustody } from "@nautilo/operator-secrets";
import { CHATGPT_ISSUER, type ChatGPTSession, type ChatGPTPendingRegistration } from "../../../src/lib/chatgpt-plan/oauth";
import { ChatGPTSessionStore, readChatGPTIdentity, readChatGPTRegistration, type ChatGPTSessionStoreDeps } from "../../../src/lib/chatgpt-plan/session-store";

const runtime = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const signal = new AbortController().signal;
const now = 1_800_000_000_000;
function session(clientId = "oaiapp_synthetic"): ChatGPTSession {
  return { identity: { issuer: CHATGPT_ISSUER, subject: "synthetic-subject", clientId, hostId: `urn:uuid:${runtime}`, email: "test@example.com" },
    accessToken: "synthetic-access", refreshToken: "synthetic-refresh", idToken: "synthetic-id",
    scopes: ["chatgpt.tokens.use.direct", "resource.invoke", "offline_access"], expiresAt: now, receivedAt: now - 3_600_000 };
}
function harness() {
  const rows = new Map<string, ChatGPTRegistrationRecord>();
  const custody = createPersonalProviderCustody();
  let runtimeIdentity = runtime; let refreshes = 0; let failRefresh = false; let remoteRevoke = true; let custodyAvailable = true;
  const tails = new Map<string, Promise<unknown>>();
  const deps: ChatGPTSessionStoreDeps = {
    runtimeIdentity: async () => runtimeIdentity, custody: async () => { if (!custodyAvailable) throw new Error("Unavailable"); return custody; }, now: () => now,
    insert: async row => { rows.set(row.id, structuredClone(row)); return true; },
    lock: async (human, id, action) => {
      const previous = tails.get(id) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(async () => {
        const row = rows.get(id);
        if (!row || row.userId !== human) throw new Error("Registration unavailable");
        const result = await action(structuredClone(row));
        if (result.mutation) rows.set(id, { ...row, ...result.mutation });
        return result.result;
      });
      tails.set(id, next); return next;
    },
    oauth: { refresh: async previous => {
      refreshes++;
      if (failRefresh) throw new Error("synthetic provider error");
      return { ...previous, accessToken: "synthetic-new-access", refreshToken: "synthetic-new-refresh", expiresAt: now + 3_600_000, receivedAt: now };
    }, revoke: async () => remoteRevoke },
  };
  return { store: new ChatGPTSessionStore(deps), rows, custody,
    refreshes: () => refreshes,
    loseCustody: () => { custodyAvailable = false; },
    changeRuntime: () => { runtimeIdentity = "33333333-3333-4333-8333-333333333333"; },
    failRefresh: () => { failRefresh = true; }, failRevoke: () => { remoteRevoke = false; } };
}

describe("ChatGPT runtime custody", () => {
  test("encrypts identity/tokens separately and keeps registrations distinct", async () => {
    const h = harness(); const a = await h.store.connect(userId, session(), signal);
    const b = await h.store.connect(userId, session("oaiapp_other_workspace"), signal);
    expect(a).not.toBe(b);
    expect(JSON.stringify([...h.rows.values()])).not.toContain("synthetic-access");
    expect(JSON.stringify([...h.rows.values()])).not.toContain("test@example.com");
    expect(readChatGPTIdentity(h.custody, h.rows.get(a)!).email).toBe("test@example.com");
    expect(h.rows.get(a)!.selected).toBe(false);
  });
  test("concurrent access rotates once without changing authority revision", async () => {
    const h = harness(); const id = await h.store.connect(userId, session(), signal);
    const values = await Promise.all(Array.from({ length: 6 }, () => h.store.accessToken(userId, id, 1, signal)));
    expect(new Set(values)).toEqual(new Set(["synthetic-new-access"]));
    expect(h.refreshes()).toBe(1);
    expect(h.rows.get(id)!.authorityRevision).toBe(1); expect(h.rows.get(id)!.tokenGeneration).toBe(2);
  });
  test("rejects another Human, cloned runtime and tampered custody context", async () => {
    const h = harness(); const id = await h.store.connect(userId, session(), signal);
    await assertRejects(h.store.accessToken("another-human", id, 1, signal));
    const row = h.rows.get(id)!;
    h.rows.set(id, { ...row, clientId: "another-client" });
    await assertRejects(h.store.accessToken(userId, id, 1, signal), "reconnect_required");
    h.rows.set(id, row); h.changeRuntime();
    await assertRejects(h.store.accessToken(userId, id, 1, signal), "credential_unavailable");
    expect(h.refreshes()).toBe(0);
  });
  test("failed refresh persists a fence and never retries the old rotating token", async () => {
    const h = harness(); const id = await h.store.connect(userId, session(), signal); h.failRefresh();
    await assertRejects(h.store.accessToken(userId, id, 1, signal), "reconnect_required");
    expect(h.rows.get(id)!.state).toBe("reconnect_required"); expect(h.rows.get(id)!.envelope).toBeNull();
    await assertRejects(h.store.accessToken(userId, id, 1, signal), "credential_conflict");
    expect(h.refreshes()).toBe(1);
  });
  test("disconnect clears tokens, retains registration identity and reports failed remote revoke", async () => {
    const h = harness(); const id = await h.store.connect(userId, session(), signal); h.failRevoke();
    h.rows.get(id)!.selected = true;
    expect(await h.store.disconnect(userId, id, 1, signal)).toEqual({ remoteRevocationConfirmed: false });
    const row = h.rows.get(id)!;
    expect(row.state).toBe("disconnected"); expect(row.envelope).toBeNull(); expect(row.selected).toBe(true);
    expect(readChatGPTIdentity(h.custody, row).subject).toBe("synthetic-subject");
    await assertRejects(h.store.accessToken(userId, id, 1, signal), "credential_conflict");
  });
  test.each(["tokens", "identity", "custody", "runtime"])("disconnect remains possible with damaged %s and never unpins funding", async kind => {
    const h = harness(); const id = await h.store.connect(userId, session(), signal);
    const row = h.rows.get(id)!; row.selected = true;
    if (kind === "tokens") row.envelope = { ...row.envelope!, ciphertextBase64: "damaged" };
    if (kind === "identity") row.identityEnvelope = { ...row.identityEnvelope, ciphertextBase64: "damaged" };
    if (kind === "custody") h.loseCustody();
    if (kind === "runtime") h.changeRuntime();
    expect(await h.store.disconnect(userId, id, 1, signal)).toEqual({ remoteRevocationConfirmed: false });
    expect(h.rows.get(id)).toMatchObject({ selected: true, state: "disconnected", envelope: null, authorityRevision: 2, tokenGeneration: 2 });
    await assertRejects(h.store.connect(userId, { ...session(), identity: { ...session().identity, subject: "replacement" } }, signal,
      { id, authorityRevision: 2 }));
  });
  test("damaged tokens are fenced but the verified identity can reconnect", async () => {
    const h = harness(); const id = await h.store.connect(userId, session(), signal);
    h.rows.get(id)!.envelope = { ...h.rows.get(id)!.envelope!, ciphertextBase64: "damaged" };
    await assertRejects(h.store.accessToken(userId, id, 1, signal), "reconnect_required");
    expect(h.rows.get(id)).toMatchObject({ state: "reconnect_required", envelope: null, authorityRevision: 2 });
    await h.store.connect(userId, session(), signal, { id, authorityRevision: 2 });
    expect(h.rows.get(id)!.state).toBe("connected");
  });
  test("reconnect fences stale authority and cannot replace the selected identity", async () => {
    const h = harness(); const id = await h.store.connect(userId, session(), signal);
    await h.store.disconnect(userId, id, 1, signal);
    await assertRejects(h.store.connect(userId, session(), signal, { id, authorityRevision: 1 }), "credential_conflict");
    const wrong = session();
    await assertRejects(h.store.connect(userId, { ...wrong, identity: { ...wrong.identity, subject: "another-subject" } }, signal,
      { id, authorityRevision: 2 }), "identity_invalid");
    await h.store.connect(userId, session(), signal, { id, authorityRevision: 2 });
    expect(h.rows.get(id)!.authorityRevision).toBe(3);
    expect(h.rows.get(id)!.state).toBe("connected");
  });
});

async function assertRejects(promise: Promise<unknown>, message?: string): Promise<void> {
  let rejection: unknown;
  try { await promise; } catch (error) { rejection = error; }
  expect(rejection).toBeInstanceOf(Error);
  if (message) expect(String(rejection)).toContain(message);
}

test("persisted unfinished registration is recoverable without becoming verified or spendable", async () => {
  const h = harness();
  const pending: ChatGPTPendingRegistration = { issuer: CHATGPT_ISSUER, clientId: "oaiapp_synthetic", hostId: `urn:uuid:${runtime}`, pending: true as const };
  const saved = await h.store.rememberRegistration(userId, pending, signal);
  const row = h.rows.get(saved.id)!;
  expect(row).toMatchObject({ state: "reconnect_required", envelope: null, selected: false });
  expect(readChatGPTRegistration(h.custody, structuredClone(row))).toEqual(pending);
  expect(() => readChatGPTIdentity(h.custody, row)).toThrow("registration_incomplete");
  await assertRejects(h.store.accessToken(userId, saved.id, 1, signal), "reconnect_required");
  await assertRejects(h.store.connect(userId, session("oaiapp_wrong"), signal, saved), "identity_invalid");
  await h.store.connect(userId, session(), signal, saved);
  expect(readChatGPTIdentity(h.custody, h.rows.get(saved.id)!).subject).toBe("synthetic-subject");
  expect(h.rows.get(saved.id)).toMatchObject({ state: "connected", selected: false, authorityRevision: 2 });
});
test("unfinished registration cannot bypass ownership, cancellation or restore fencing", async () => {
  const h = harness();
  const pending: ChatGPTPendingRegistration = { issuer: CHATGPT_ISSUER, clientId: "oaiapp_synthetic", hostId: `urn:uuid:${runtime}`, pending: true as const };
  const cancelled = new AbortController(); cancelled.abort();
  await assertRejects(h.store.rememberRegistration(userId, pending, cancelled.signal));
  expect(h.rows.size).toBe(0);
  const saved = await h.store.rememberRegistration(userId, pending, signal);
  await assertRejects(h.store.connect("another-human", session(), signal, saved));
  await h.store.disconnect(userId, saved.id, 1, signal);
  expect(readChatGPTRegistration(h.custody, h.rows.get(saved.id)!)).toEqual(pending);
  await assertRejects(h.store.connect(userId, session(), signal, saved), "credential_conflict");
  h.changeRuntime();
  await assertRejects(h.store.connect(userId, session(), signal, { ...saved, authorityRevision: 2 }), "identity_invalid");
});
