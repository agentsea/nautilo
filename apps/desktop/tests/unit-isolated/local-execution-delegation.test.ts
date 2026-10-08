import { expect, test, spyOn } from "bun:test";
import { rejects } from "node:assert/strict";
import { createLocalExecutionDelegationAuthority } from "../../electron/local-execution-delegation";
import { DesktopFilesystemGrantAuthority } from "../../electron/desktop-filesystem-grants/authority";
import { DesktopFilesystemGrantStore } from "../../electron/desktop-filesystem-grants/store";
const request = { version: 1 as const, humanUserId: "human", agentId: "agent", sourceRoomId: "room", sourceConversationId: "conversation",
  rootTaskId: "task", ceiling: "basic" as const, profile: null,
  target: { instanceId: "", relayId: "relay", pairingGeneration: "pairing", serverOrigin: "https://server.example", serverFingerprint: "fingerprint" } };
function fixture() {
  let access: ("read" | "create_modify" | "delete" | "execute")[] = ["read", "create_modify", "delete", "execute"];
  let projectCurrent = true; let authorityExpiresAt: number | undefined;
  let bytes: string | null = null; let epoch = "epoch"; let selected = "/fixture/project"; let source = true; let inode = 1;
  const store = new DesktopFilesystemGrantStore({ instanceId: "", filePath: "/unused", storage: {
    read: async () => bytes, writeAtomic: async value => { bytes = value; } } });
  const grants = new DesktopFilesystemGrantAuthority({ instanceId: "", store });
  const authority = createLocalExecutionDelegationAuthority({ grants,
    readIdentity: () => ({ humanUserId: "human", target: request.target, profile: null, epoch }),
    assertCaptureSource: async () => { if (!source) throw new Error("source denied"); },
    resolveSelectedProject: async () => ({ canonicalRoot: selected, filesystemIdentity: { realRoot: selected, device: 1, inode }, access, ...(authorityExpiresAt === undefined ? {} : { authorityExpiresAt }), isCurrent: () => projectCurrent }),
    revalidateRoot: async identity => identity.inode === inode
      ? { ok: true, canonicalRoot: identity.realRoot, filesystemIdentity: identity }
      : { ok: false, error: { code: "root_identity_changed", message: "changed" } },
  });
  return { authority, grants, setExpiry: (value: number) => { authorityExpiresAt = value; }, setAccess: (value: typeof access) => { access = value; }, reduceProject: () => { projectCurrent = false; }, folder: (value: string) => { selected = value; }, revokeSource: () => { source = false; },
    replaceRoot: () => { inode++; }, changeEpoch: () => { epoch = "replacement"; } };
}
test("durable Task grant resolves its original project after the selected folder changes", async () => {
  const f = fixture(); const saved = await f.authority.capture(request); f.folder("/fixture/other");
  const scope = await f.authority.resolve(saved); expect(scope.canonicalRoot).toBe("/fixture/project"); expect(scope.isCurrent()).toBe(true);
  const listed = await f.grants.list({ userId: "human" });
  expect(listed).toMatchObject({ ok: true, data: { grants: [{ grant: { lifetime: "durable", origin: "approval", subject: { agentScope: "task:task" } } }] } });
  f.changeEpoch(); expect(scope.isCurrent()).toBe(false);
});
test("revoked grant, replaced root, foreign lineage and Development escalation stay denied", async () => {
  const f = fixture(); const saved = await f.authority.capture(request);
  await rejects(f.authority.resolve({ ...saved, rootTaskId: "other" }), /UNAVAILABLE/);
  await rejects(f.authority.resolve({ ...saved, ceiling: "development", profile: { id: "profile", revision: 1 } }), /UNAVAILABLE/);
  f.replaceRoot(); await rejects(f.authority.resolve(saved), /UNAVAILABLE/);
  await f.grants.revoke({ userId: "human", grantId: saved.projectGrantId });
  await rejects(f.authority.capture(request), /UNAVAILABLE/);
});
test("missing source admission never persists a grant", async () => {
  const f = fixture(); f.revokeSource(); await rejects(f.authority.capture(request), /source denied/);
  const listed = await f.grants.list({ userId: "human" }); expect(listed).toMatchObject({ ok: true, data: { grants: [] } });
});

test("concurrent capture reuses one canonical Task grant", async () => {
  const f = fixture(); const results = await Promise.all([f.authority.capture(request), f.authority.capture(request)]);
  expect(results[0]?.projectGrantId).toBe(results[1]?.projectGrantId);
  const listed = await f.grants.list({ userId: "human" });
  expect(listed.ok && listed.data.grants.length).toBe(1);
  expect(await f.authority.capture(request)).toEqual(results[0]);
});

test("capture preserves no-delete authority and refuses a read-only project", async () => {
  const f = fixture(); f.setAccess(["read", "create_modify", "execute"]);
  const saved = await f.authority.capture(request);
  expect((await f.authority.resolve(saved)).access).toEqual(["read", "create_modify", "execute"]);
  const readOnly = fixture(); readOnly.setAccess(["read"]);
  await rejects(readOnly.authority.capture(request), /UNAVAILABLE/);
  expect(await readOnly.grants.list({ userId: "human" })).toMatchObject({ ok: true, data: { grants: [] } });
});
test("source reduction refuses replay without repairing the original Task grant", async () => {
  const f = fixture(); await f.authority.capture(request); f.reduceProject();
  await rejects(f.authority.capture(request), /UNAVAILABLE/);
});

test("revocation after a list read cannot return stale Task authority", async () => {
  const f = fixture(); const saved = await f.authority.capture(request);
  const list = f.grants.list.bind(f.grants);
  let intercepted = false;
  const spy = spyOn(f.grants, "list").mockImplementation(async input => {
    const result = await list(input);
    if (!intercepted) {
      intercepted = true;
      await f.grants.revoke({ userId: "human", grantId: saved.projectGrantId });
    }
    return result;
  });
  try { await rejects(f.authority.capture(request), /UNAVAILABLE/); }
  finally { spy.mockRestore(); }
});
test("compare-and-create refuses grant drift before Task persistence", async () => {
  const f = fixture();
  const originalCreate = f.grants.create.bind(f.grants);
  const spy = spyOn(f.grants, "create").mockImplementation(async input => {
    const competing = { ...input.grant, id: "other-consent", subject: { ...input.grant.subject, agentScope: "ordinary" } };
    await originalCreate({ userId: input.userId, grant: competing });
    await f.grants.revoke({ userId: input.userId, grantId: competing.id });
    return originalCreate(input);
  });
  try { await rejects(f.authority.capture(request), /UNAVAILABLE/); }
  finally { spy.mockRestore(); }
  const listed = await f.grants.list({ userId: "human", includeHistory: true });
  expect(listed.ok && listed.data.grants.some(item => item.grant.subject.agentScope === "task:task")).toBe(false);
});


test("Task capture preserves finite project expiry and never extends it on replay", async () => {
  const f = fixture(); const expiry = Date.now() + 60_000; f.setExpiry(expiry);
  const saved = await f.authority.capture(request);
  expect(await f.grants.list({ userId: "human" })).toMatchObject({ ok: true, data: { grants: [{ grant: { expiresAt: new Date(expiry).toISOString() } }] } });
  const resolved = await f.authority.resolve(saved); expect(resolved.authorityExpiresAt).toBe(expiry);
  f.setExpiry(expiry + 60_000); await rejects(f.authority.capture(request), /UNAVAILABLE/);
  const clock = spyOn(Date, "now").mockReturnValue(expiry);
  try { expect(resolved.isCurrent()).toBe(false); await rejects(f.authority.resolve(saved), /UNAVAILABLE/); }
  finally { clock.mockRestore(); }
});
