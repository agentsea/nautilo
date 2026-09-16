/* eslint-disable @typescript-eslint/await-thenable -- Bun promise matchers are awaited at runtime. */
import { expect, test } from "bun:test";
import { createAppDraftRecovery, isAppRecoveryDraft, type NativeAppRecovery } from "../../src/apps/app-draft-recovery";
import { artifactOpenFileTarget, fsOpenFileTarget } from "../../src/components/browser-column/open-file-target";

const artifact = artifactOpenFileTarget({ id: "internal-uuid", path: "deck.presentation.html", mimeType: "text/html" });
const draft = { version: 1 as const, content: "exact draft", exact: true, baseSha256: "sha", baseRevision: 1 };

function nativeFixture() {
  const opens: Parameters<NativeAppRecovery["open"]>[0][] = [];
  const reads: string[] = [];
  const writes: Array<{ handle: string; input: Parameters<NativeAppRecovery["write"]>[1] }> = [];
  const closed: string[] = [];
  const native: NativeAppRecovery = {
    async open(input) { opens.push(input); return { handle: `handle-${opens.length}` }; },
    async read(handle) { reads.push(handle); return { revision: null, draft: null }; },
    async write(handle, input) { writes.push({ handle, input }); return { revision: "receipt" }; },
    async close(handle) { closed.push(handle); },
  };
  return { native, opens, reads, writes, closed };
}

test("host binds the verified viewer and internal artifact identity, retaining one native handle across rename", async () => {
  const f = nativeFixture();
  const port = createAppDraftRecovery({ appId: "nautilo-presentation", viewerKey: "human-a", native: f.native, getRelayId: async () => null });
  await Promise.all([port.read(artifact), port.read({ ...artifact, path: "renamed.presentation.html" })]);
  await port.write(artifact, { expectedRevision: null, draft });
  expect(f.opens).toEqual([{ expectedViewerId: "human-a", appId: "nautilo-presentation", target: { kind: "workspace_artifact", artifactInternalId: "internal-uuid" } }]);
  expect(f.reads).toEqual(["handle-1", "handle-1"]);
  expect(f.writes).toEqual([{ handle: "handle-1", input: { expectedRevision: null, draft } }]);
  port.dispose();
  await Promise.resolve();
  expect(f.closed).toEqual(["handle-1"]);
  await expect(port.read(artifact)).rejects.toThrow("closed");
});

test("Board retains its app identity when opening an otherwise matching journal", async () => {
  const f = nativeFixture();
  const port = createAppDraftRecovery({ appId: "nautilo-board", viewerKey: "human-a", native: f.native, getRelayId: async () => null });
  await port.read(artifact);
  expect(f.opens).toEqual([{ expectedViewerId: "human-a", appId: "nautilo-board", target: { kind: "workspace_artifact", artifactInternalId: "internal-uuid" } }]);
  port.dispose();
});

test("Current Folder binds the native relay and host-owned absolute path without server state", async () => {
  const f = nativeFixture();
  const port = createAppDraftRecovery({ appId: "nautilo-presentation", viewerKey: "human-a", native: f.native, getRelayId: async () => "native-relay" });
  await port.write(fsOpenFileTarget("/allowed/deck.presentation.html", "/allowed"), { expectedRevision: "prior", draft });
  expect(f.opens[0]?.target).toEqual({ kind: "local_file", relayId: "native-relay", candidatePath: "/allowed/deck.presentation.html" });
  port.dispose();
});

test("closing while native authorization is pending revokes the eventual handle before any read", async () => {
  const f = nativeFixture();
  let release!: (value: { handle: string }) => void;
  f.native.open = () => new Promise(resolve => { release = resolve; });
  const port = createAppDraftRecovery({ appId: "nautilo-presentation", viewerKey: "human-a", native: f.native, getRelayId: async () => null });
  const reading = port.read(artifact);
  port.dispose();
  release({ handle: "late-handle" });
  await expect(reading).rejects.toThrow("closed");
  expect(f.reads).toHaveLength(0);
  expect(f.closed).toEqual(["late-handle"]);
});

test("unverified users and old Desktop versions cannot silently receive a recovery acknowledgement", async () => {
  const f = nativeFixture();
  for (const [viewerKey, native] of [[null, f.native], ["human-a", null]] as const) {
    const port = createAppDraftRecovery({ appId: "nautilo-presentation", viewerKey, native, getRelayId: async () => null });
    await expect(port.write(artifact, { expectedRevision: null, draft })).rejects.toThrow("signed-in Desktop");
    port.dispose();
  }
  expect(f.opens).toHaveLength(0);
});

test("recovery records reject extra authority and invalid revision values", () => {
  expect(isAppRecoveryDraft(draft)).toBe(true);
  expect(isAppRecoveryDraft({ ...draft, humanId: "forged" })).toBe(false);
  expect(isAppRecoveryDraft({ ...draft, baseRevision: NaN })).toBe(false);
  expect(isAppRecoveryDraft({ ...draft, baseRevision: -1 })).toBe(false);
});
