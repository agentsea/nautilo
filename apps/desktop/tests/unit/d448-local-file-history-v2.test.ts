import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { LocalDurableMutationJournal } from "../../electron/local-file-history/durable-mutations.ts";
import { createGuardedNodeAdapter } from "../../electron/local-file-history/file-adapter.ts";
import { snapshotFromBytes } from "../../electron/local-file-history/hash.ts";
import { LocalFileHistoryJournal } from "../../electron/local-file-history/journal.ts";
import { withCanonicalPathLocks } from "../../electron/local-file-history/mutation-lock.ts";
import {
  createJournalStorage,
  type ManifestAtomicWriteBoundary,
} from "../../electron/local-file-history/storage.ts";
import type { LocalFileHistoryManifest } from "../../electron/local-file-history/types.ts";
import type { DocumentMutationCommittedEvent } from "@nautilo/types";
import {
  deriveAtomicDocumentMutationBatchIdempotencyKey,
  type AtomicDocumentMutationEventBatch,
} from "@nautilo/document-mutations";

const roots: string[] = [];
const RELAY = "relay-v2";
const OWNER = "owner-v2";
const AGENT = "agent-v2";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "d448-v2-workspace-"));
  const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "d448-v2-journal-"));
  roots.push(workspace, journalRoot);
  return {
    workspace: await fs.realpath(workspace),
    journalRoot,
    adapter: createGuardedNodeAdapter({ allowedRoots: [workspace] }),
  };
}

test("fresh journal instances serialize disjoint manifest updates without losing either", async () => {
  const fx = await fixture();
  const journals = [0, 1].map(() => new LocalFileHistoryJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
  }));
  const files = ["one.txt", "two.txt"].map((name) => path.join(fx.workspace, name));
  await Promise.all(files.map((file) => fs.writeFile(file, "after")));
  const before = snapshotFromBytes(Buffer.from("before"));
  const after = snapshotFromBytes(Buffer.from("after"));
  await Promise.all(journals.map((journal, index) => journal.recordSuccessfulMutation({
    ownerId: OWNER,
    agentId: AGENT,
    turnId: `turn-${index}`,
    requestedPath: files[index]!,
    zone: "current",
    operation: "write",
    preState: before,
    postState: after,
  })));
  const manifest = await createJournalStorage(fx.journalRoot).readManifest();
  expect(manifest?.v).toBe(1);
  if (manifest?.v === 1) expect(manifest.entries).toHaveLength(2);
});

test("every manifest atomic-write interruption reopens complete old or new truth", async () => {
  const boundaries: readonly ManifestAtomicWriteBoundary[] = [
    "temp_opened",
    "temp_written",
    "temp_synced",
    "manifest_renamed",
    "manifest_mode_restored",
    "directory_synced",
  ];
  const oldManifest: LocalFileHistoryManifest = {
    v: 1,
    relayId: RELAY,
    entries: [],
  };
  const newManifest: LocalFileHistoryManifest = {
    ...oldManifest,
    relayId: `${RELAY}-replacement`,
  };

  for (const boundary of boundaries) {
    const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "d536-atomic-"));
    roots.push(journalRoot);
    await fs.mkdir(path.join(journalRoot, "payloads"));
    await createJournalStorage(journalRoot).writeManifest(oldManifest);
    const faulted = createJournalStorage(journalRoot, {
      onManifestAtomicWriteBoundary(observed) {
        if (observed === boundary) throw new Error(`fault:${boundary}`);
      },
    });

    await expect(faulted.writeManifest(newManifest)).rejects.toThrow(
      `fault:${boundary}`,
    );
    const reopened = await createJournalStorage(journalRoot).readManifest();
    expect(reopened).toEqual(
      boundaries.indexOf(boundary) < boundaries.indexOf("manifest_renamed")
        ? oldManifest
        : newManifest,
    );
    expect((await fs.readdir(journalRoot)).filter((name) =>
      /^\.manifest\.json\.[0-9a-f]{16}\.tmp$/.test(name)
    )).toEqual([]);
  }
});

test("relay aliases of one root serialize and reject mismatched ownership", async () => {
  const fx = await fixture();
  const alias = `${fx.journalRoot}-alias`;
  await fs.symlink(fx.journalRoot, alias);
  roots.push(alias);
  const file = path.join(fx.workspace, "relay.txt");
  await fs.writeFile(file, "after");
  const make = (rootDir: string, relayId: string) => new LocalFileHistoryJournal({
    rootDir,
    relayId,
    fileAdapter: fx.adapter,
  });
  const input = {
    ownerId: OWNER,
    agentId: AGENT,
    turnId: "relay",
    requestedPath: file,
    zone: "current" as const,
    operation: "write" as const,
    preState: snapshotFromBytes(Buffer.from("before")),
    postState: snapshotFromBytes(Buffer.from("after")),
  };
  const settled = await Promise.allSettled([
    make(fx.journalRoot, "relay-a").recordSuccessfulMutation(input),
    make(alias, "relay-b").recordSuccessfulMutation(input),
  ]);
  expect(settled.filter((result) =>
    result.status === "rejected" || !result.value.ok,
  )).toHaveLength(1);
});

test("post-rename manifest errors never delete payloads that durable truth may reference", async () => {
  const fx = await fixture();
  const base = createJournalStorage(fx.journalRoot);
  let writes = 0;
  const storage = {
    ...base,
    async writeManifest(manifest: Parameters<typeof base.writeManifest>[0]) {
      writes += 1;
      await base.writeManifest(manifest);
      if (writes === 2) throw new Error("injected post-rename manifest failure");
    },
  };
  const journal = new LocalFileHistoryJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
    storage,
    journalRootKey: await fs.realpath(fx.journalRoot),
    retention: {
      maxEntriesPerPath: 2,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
    },
  });
  const file = path.join(fx.workspace, "fault.txt");
  await fs.writeFile(file, "one");
  const first = await journal.recordSuccessfulMutation({
    ownerId: OWNER,
    agentId: AGENT,
    turnId: "one",
    requestedPath: file,
    zone: "current",
    operation: "write",
    preState: snapshotFromBytes(Buffer.from("zero")),
    postState: snapshotFromBytes(Buffer.from("one")),
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  await fs.writeFile(file, "two");
  const second = await journal.recordSuccessfulMutation({
    ownerId: OWNER,
    agentId: AGENT,
    turnId: "two",
    requestedPath: file,
    zone: "current",
    operation: "write",
    preState: snapshotFromBytes(Buffer.from("one")),
    postState: snapshotFromBytes(Buffer.from("two")),
  });
  expect(second.ok).toBe(false);
  const committed = await base.readManifest();
  expect(committed?.v).toBe(1);
  if (committed?.v !== 1) return;
  expect(committed.entries).toHaveLength(2);
  const committedId = committed.entries.find((entry) => entry.turnId === "two")!.id;
  expect(await fs.readFile(
    path.join(fx.journalRoot, "payloads", committedId, "pre.bin"),
    "utf8",
  )).toBe("one");
});

test("first v2 intent atomically upgrades and preserves readable v1 history", async () => {
  const fx = await fixture();
  const file = path.join(fx.workspace, "upgrade.txt");
  await fs.writeFile(file, "after");
  const legacy = new LocalFileHistoryJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
  });
  await legacy.recordSuccessfulMutation({
    ownerId: OWNER,
    agentId: AGENT,
    turnId: "legacy",
    requestedPath: file,
    zone: "current",
    operation: "write",
    preState: snapshotFromBytes(Buffer.from("before")),
    postState: snapshotFromBytes(Buffer.from("after")),
  });

  const durable = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
  });
  const operationId = "../opaque/☃".repeat(80);
  const revisionGroupId = "group/opaque";
  const before = snapshotFromBytes(Buffer.from("after"));
  const after = snapshotFromBytes(Buffer.from("next"));
  const actor = { kind: "human" as const, humanId: "human-1" };
  const batch = updateBatch(operationId, revisionGroupId, file, before.sha256, after.sha256, actor);
  const beginInput = {
    operationId,
    revisionGroupId,
    actor,
    producer: { operation: "editor_save" as const },
    batch,
    paths: [{
      kind: "update" as const,
      canonicalPath: file,
      revisionIds: ["revision-1", "revision-2"],
      undoRecordIds: ["undo-1", "undo-2"],
      locations: [{ canonicalPath: file, before, after }],
    }],
  };
  await durable.begin(beginInput);
  await durable.begin({
    ...beginInput,
    batch: {
      events: batch.events.map((event) => ({ ...event })),
      idempotencyKey: batch.idempotencyKey,
      revisionGroupId: batch.revisionGroupId,
      operationId: batch.operationId,
    },
  });
  const manifest = await createJournalStorage(fx.journalRoot).readManifest();
  expect(manifest?.v).toBe(3);
  if (manifest?.v === 3) {
    expect(manifest.legacyEntries).toHaveLength(1);
    expect(manifest.mutations[0]?.state).toBe("pending");
  }
  await legacy.recordSuccessfulMutation({
    ownerId: OWNER,
    agentId: AGENT,
    turnId: "after-upgrade",
    requestedPath: file,
    zone: "current",
    operation: "write",
    preState: before,
    postState: after,
  });
  const stillV2 = await createJournalStorage(fx.journalRoot).readManifest();
  expect(stillV2?.v).toBe(3);
  if (stillV2?.v === 3) expect(stillV2.mutations).toHaveLength(1);
  const payloadNames = await fs.readdir(path.join(fx.journalRoot, "payloads"));
  expect(payloadNames.every((name) => !name.includes("..") && !name.includes("☃"))).toBe(true);
  const listed = await legacy.list({ agentId: AGENT });
  expect(listed).toMatchObject({
    ok: true,
    data: { revisions: expect.arrayContaining([expect.objectContaining({ turnId: "legacy" })]) },
  });
});

function updateEvent(
  operationId: string,
  revisionGroupId: string,
  canonicalPath: string,
  beforeSha: string,
  afterSha: string,
  actor: { kind: "agent"; agentId: string } | { kind: "human"; humanId: string },
  sequence = 0,
): DocumentMutationCommittedEvent {
  const identity = { kind: "local_file" as const, relayId: RELAY, canonicalPath };
  const before = {
    identity,
    backendVersion: { kind: "local_sha" as const, sha256: beforeSha },
    sha256: beforeSha,
  };
  const after = {
    identity,
    backendVersion: { kind: "local_sha" as const, sha256: afterSha },
    sha256: afterSha,
  };
  return {
    type: "document.mutation.committed",
    operationId,
    revisionGroupId,
    sequence,
    outcome: "applied",
    actor,
    mutation: "update",
    path: { kind: "update", before: identity, after: identity },
    before,
    after,
  };
}

function updateBatch(
  operationId: string,
  revisionGroupId: string,
  canonicalPath: string,
  beforeSha: string,
  afterSha: string,
  actor: { kind: "agent"; agentId: string } | { kind: "human"; humanId: string },
): AtomicDocumentMutationEventBatch {
  return {
    operationId,
    revisionGroupId,
    idempotencyKey: deriveAtomicDocumentMutationBatchIdempotencyKey(
      operationId,
      revisionGroupId,
    ),
    events: [
      updateEvent(operationId, revisionGroupId, canonicalPath, beforeSha, afterSha, actor),
    ],
  };
}

test("restart recovery finalizes exact postimage and drains ordered durable outbox", async () => {
  const fx = await fixture();
  const file = path.join(fx.workspace, "recover.txt");
  const secondFile = path.join(fx.workspace, "recover-second.txt");
  const before = snapshotFromBytes(Buffer.from("before"));
  const after = snapshotFromBytes(Buffer.from("after"));
  await fs.writeFile(file, before.bytes);
  await fs.writeFile(secondFile, before.bytes);
  const first = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
  });
  await first.begin({
    operationId: "operation-1",
    revisionGroupId: "group-1",
    actor: { kind: "agent", agentId: AGENT },
    producer: { operation: "write", turnId: "turn-recovery" },
    batch: {
      operationId: "operation-1",
      revisionGroupId: "group-1",
      idempotencyKey: deriveAtomicDocumentMutationBatchIdempotencyKey("operation-1", "group-1"),
      events: [
        updateEvent("operation-1", "group-1", file, before.sha256, after.sha256, { kind: "agent", agentId: AGENT }, 0),
        updateEvent("operation-1", "group-1", secondFile, before.sha256, after.sha256, { kind: "agent", agentId: AGENT }, 1),
      ],
    },
    paths: [
      {
        kind: "update",
        canonicalPath: file,
        revisionIds: ["revision-1"],
        undoRecordIds: ["undo-1"],
        locations: [{ canonicalPath: file, before, after }],
      },
      {
        kind: "update",
        canonicalPath: secondFile,
        revisionIds: ["revision-2"],
        undoRecordIds: ["undo-2"],
        locations: [{ canonicalPath: secondFile, before, after }],
      },
    ],
  });
  await fs.writeFile(file, after.bytes);
  await fs.writeFile(secondFile, after.bytes);
  const restarted = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
  });
  expect(await restarted.recover()).toEqual([
    { operationId: "operation-1", state: "committed" },
  ]);
  const claimed = await restarted.claimOutbox({ claimantId: "worker-1" });
  expect(claimed).toMatchObject({
    operationId: "operation-1",
    state: "claimed",
    attempts: 1,
    id: 'document-mutation:v1:["operation-1","group-1"]',
    batch: {
      events: [
        expect.objectContaining({ sequence: 0 }),
        expect.objectContaining({ sequence: 1 }),
      ],
    },
  });
  await expect(restarted.ackOutbox(claimed!.id, "wrong-worker")).rejects.toThrow(
    "is not claimed",
  );
  await restarted.retryOutbox(claimed!.id, "worker-1", "offline", new Date(0).toISOString());
  const reclaimed = await restarted.claimOutbox({ claimantId: "worker-2" });
  expect(reclaimed?.attempts).toBe(2);
  await restarted.ackOutbox(reclaimed!.id, "worker-2");
  expect(await restarted.claimOutbox({ claimantId: "worker-3" })).toBeNull();

  const baseStorage = createJournalStorage(fx.journalRoot);
  let idleWrites = 0;
  const idleJournal = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
    storage: {
      ...baseStorage,
      async writeManifest(manifest) {
        idleWrites += 1;
        await baseStorage.writeManifest(manifest);
      },
    },
  });
  expect(await idleJournal.claimOutbox({ claimantId: "idle-worker" })).toBeNull();
  expect(await idleJournal.nextOutboxWakeAt({
    now: new Date().toISOString(),
    staleClaimAfterMs: 60_000,
  })).toBeUndefined();
  expect(idleWrites).toBe(0);
});

test("v2 delivered-envelope migration cuts the 51-record fixture by at least half and is idempotent", async () => {
  const fx = await fixture();
  const file = path.join(fx.workspace, "compact.txt");
  await fs.writeFile(file, "state-0");
  const journal = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
  });
  for (let index = 0; index < 51; index += 1) {
    const operationId = `compact-operation-${index}`;
    const revisionGroupId = `compact-group-${index}`;
    const before = snapshotFromBytes(Buffer.from(`state-${index}`));
    const after = snapshotFromBytes(Buffer.from(`state-${index + 1}`));
    const actor = { kind: "agent" as const, agentId: AGENT };
    await journal.begin({
      operationId,
      revisionGroupId,
      actor,
      producer: { operation: "write", turnId: `compact-turn-${index}` },
      batch: updateBatch(
        operationId,
        revisionGroupId,
        file,
        before.sha256,
        after.sha256,
        actor,
      ),
      paths: [{
        kind: "update",
        canonicalPath: file,
        revisionIds: [`compact-revision-${index}`],
        undoRecordIds: [`compact-undo-${index}`],
        locations: [{ canonicalPath: file, before, after }],
      }],
    });
    await fs.writeFile(file, after.bytes);
    await journal.finalize({ operationId });
    const claimed = await journal.claimOutbox({ claimantId: "compact-worker" });
    expect(claimed?.operationId).toBe(operationId);
    await journal.ackOutbox(claimed!.id, "compact-worker");
  }

  const storage = createJournalStorage(fx.journalRoot);
  const current = await storage.readManifest();
  if (current?.v !== 3) throw new Error("expected current manifest fixture");
  const completedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
  const legacyV2 = {
    v: 2 as const,
    relayId: current.relayId,
    legacyEntries: current.legacyEntries,
    mutations: current.mutations.map((intent) => ({
      ...intent,
      createdAt: completedAt,
      updatedAt: completedAt,
    })),
    outbox: current.outbox.map((row) => ({
      ...row,
      createdAt: completedAt,
      updatedAt: completedAt,
      deliveredAt: completedAt,
    })),
  };
  const legacyPrettyBytes = Buffer.byteLength(JSON.stringify(legacyV2, null, 2));
  await storage.writeManifest(legacyV2);

  let cleanupCallsAfterFailedCommit = 0;
  const postRenameFailure = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
    storage: {
      ...storage,
      async writeManifest(manifest) {
        await storage.writeManifest(manifest);
        throw new Error("injected post-rename migration failure");
      },
      async cleanupUnreferencedArtifacts() {
        cleanupCallsAfterFailedCommit += 1;
        return { removedTemps: 0, removedPayloadRoots: 0 };
      },
    },
  });
  await expect(postRenameFailure.recover()).rejects.toThrow(
    "injected post-rename migration failure",
  );
  expect(cleanupCallsAfterFailedCommit).toBe(0);
  expect((await storage.readManifest())?.v).toBe(3);
  expect((await fs.readdir(path.join(fx.journalRoot, "payloads"))).filter((name) =>
    name.startsWith("v2-")
  )).toHaveLength(51);

  const upgraded = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
  });
  expect(await upgraded.recover()).toEqual([]);
  const migrated = await storage.readManifest();
  if (migrated?.v !== 3) throw new Error("expected migrated manifest");
  expect(migrated.mutations).toHaveLength(51);
  expect(migrated.outbox).toHaveLength(10);
  expect(migrated.receipts).toHaveLength(41);
  const manifestPath = path.join(fx.journalRoot, "manifest.json");
  const compactBytes = (await fs.stat(manifestPath)).size;
  expect(compactBytes).toBeLessThan(legacyPrettyBytes * 0.5);

  const firstBytes = await fs.readFile(manifestPath);
  const firstMtime = (await fs.stat(manifestPath)).mtimeMs;
  expect(await upgraded.recover()).toEqual([]);
  expect(await fs.readFile(manifestPath)).toEqual(firstBytes);
  expect((await fs.stat(manifestPath)).mtimeMs).toBe(firstMtime);

  const expiredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString();
  const oversizedProtectedOperation = migrated.outbox[0]!.operationId;
  await storage.writeManifest({
    ...migrated,
    mutations: migrated.mutations.map((intent) => ({
      ...intent,
      createdAt: expiredAt,
      updatedAt: expiredAt,
      paths: intent.operationId !== oversizedProtectedOperation
        ? intent.paths
        : intent.paths.map((mutationPath) => ({
            ...mutationPath,
            locations: mutationPath.locations.map((location) => ({
              ...location,
              before: location.before.kind === "missing"
                ? location.before
                : {
                    ...location.before,
                    size: 600 * 1024 * 1024,
                    payload: { ...location.before.payload, size: 600 * 1024 * 1024 },
                  },
              after: location.after.kind === "missing"
                ? location.after
                : {
                    ...location.after,
                    size: 600 * 1024 * 1024,
                    payload: { ...location.after.payload, size: 600 * 1024 * 1024 },
                  },
            })),
          })),
    })),
    outbox: migrated.outbox.map((row) => ({
      ...row,
      createdAt: expiredAt,
      updatedAt: expiredAt,
      deliveredAt: expiredAt,
    })),
    receipts: migrated.receipts.map((receipt) => ({
      ...receipt,
      createdAt: expiredAt,
      updatedAt: expiredAt,
      completedAt: expiredAt,
    })),
  });
  const retentionPass = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
  });
  expect(await retentionPass.recover()).toEqual([]);
  const reaped = await storage.readManifest();
  if (reaped?.v !== 3) throw new Error("expected retained manifest");
  // The ten newest full envelopes are the replay frontier. Only fully
  // reconciled older groups and their payload roots are reaped.
  expect(reaped.mutations).toHaveLength(10);
  expect(reaped.mutations.some((intent) =>
    intent.operationId === oversizedProtectedOperation
  )).toBe(true);
  expect(reaped.outbox).toHaveLength(10);
  expect(reaped.receipts).toHaveLength(0);
  expect((await fs.readdir(path.join(fx.journalRoot, "payloads"))).filter((name) =>
    name.startsWith("v2-")
  )).toHaveLength(10);
});

test("artifact cleanup removes only aged proven orphans and valid manifest temp files", async () => {
  const fx = await fixture();
  const storage = createJournalStorage(fx.journalRoot);
  await storage.ensureRoot();
  const payloads = path.join(fx.journalRoot, "payloads");
  const keep = path.join(payloads, "keep-root");
  const oldOrphan = path.join(payloads, "old-orphan");
  const youngOrphan = path.join(payloads, "young-orphan");
  await Promise.all([keep, oldOrphan, youngOrphan].map((dir) =>
    fs.mkdir(dir, { recursive: true })
  ));
  const oldTemp = path.join(fx.journalRoot, ".manifest.json.0123456789abcdef.tmp");
  const youngTemp = path.join(fx.journalRoot, ".manifest.json.fedcba9876543210.tmp");
  const unrelated = path.join(fx.journalRoot, "manifest.json.not-owned.tmp");
  await Promise.all([oldTemp, youngTemp, unrelated].map((file) => fs.writeFile(file, "x")));
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
  await fs.utimes(oldOrphan, old, old);
  await fs.utimes(oldTemp, old, old);

  expect(await storage.cleanupUnreferencedArtifacts({
    referencedPayloadRoots: ["keep-root"],
    olderThanMs: 24 * 60 * 60 * 1_000,
  })).toEqual({ removedTemps: 1, removedPayloadRoots: 1 });
  expect((await fs.readdir(payloads)).sort()).toEqual(["keep-root", "young-orphan"]);
  expect((await fs.readdir(fx.journalRoot)).sort()).toEqual([
    ".manifest.json.fedcba9876543210.tmp",
    "manifest.json.not-owned.tmp",
    "payloads",
  ]);

  const failClosedOrphan = path.join(payloads, "fail-closed-orphan");
  await fs.mkdir(failClosedOrphan);
  await fs.utimes(failClosedOrphan, old, old);
  await fs.writeFile(path.join(fx.journalRoot, "manifest.json"), JSON.stringify({
    v: 3,
    relayId: RELAY,
    legacyEntries: [],
    mutations: "corrupt",
    outbox: [],
    receipts: [],
  }));
  const invalid = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
  });
  await expect(invalid.recover()).rejects.toThrow("unsupported manifest version");
  expect((await fs.stat(failClosedOrphan)).isDirectory()).toBe(true);
});

test("recovery aborts exact preimage and preserves foreign bytes as held evidence", async () => {
  const fx = await fixture();
  const journal = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
  });
  const before = snapshotFromBytes(Buffer.from("before"));
  const after = snapshotFromBytes(Buffer.from("after"));
  const actor = { kind: "agent" as const, agentId: AGENT };
  const add = async (operationId: string, file: string, suffix: string) => {
    await fs.writeFile(file, before.bytes);
    await journal.begin({
      operationId,
      revisionGroupId: `group-${suffix}`,
      actor,
      producer: { operation: "write", turnId: `turn-${suffix}` },
      batch: updateBatch(
        operationId,
        `group-${suffix}`,
        file,
        before.sha256,
        after.sha256,
        actor,
      ),
      paths: [{
        kind: "update",
        canonicalPath: file,
        revisionIds: [`revision-${suffix}`],
        undoRecordIds: [`undo-${suffix}`],
        locations: [{ canonicalPath: file, before, after }],
      }],
    });
  };
  const preimageFile = path.join(fx.workspace, "preimage.txt");
  const foreignFile = path.join(fx.workspace, "foreign.txt");
  await add("operation-pre", preimageFile, "pre");
  await add("operation-foreign", foreignFile, "foreign");
  await fs.writeFile(foreignFile, "human-won");
  expect(await journal.recover()).toEqual([
    { operationId: "operation-pre", state: "aborted" },
    { operationId: "operation-foreign", state: "recovery_required" },
  ]);
  const manifest = await createJournalStorage(fx.journalRoot).readManifest();
  expect(manifest?.v).toBe(3);
  if (manifest?.v === 3) {
    expect(manifest.outbox.map((batch) => batch.state)).toEqual(["cancelled", "held"]);
    expect(manifest.mutations[1]?.recoveryEvidence?.actual[0]?.state).toMatchObject({
      kind: "bytes",
    });
  }
});

test("recovery waits for an in-flight path-locked writer before classifying pending intent", async () => {
  const fx = await fixture();
  const file = path.join(fx.workspace, "in-flight.txt");
  const before = snapshotFromBytes(Buffer.from("before"));
  const after = snapshotFromBytes(Buffer.from("after"));
  await fs.writeFile(file, before.bytes);
  const journal = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
  });
  let pending!: () => void;
  const pendingReady = new Promise<void>((resolve) => {
    pending = resolve;
  });
  let continueWriter!: () => void;
  const writerMayContinue = new Promise<void>((resolve) => {
    continueWriter = resolve;
  });
  const writer = withCanonicalPathLocks([file], async () => {
    await journal.begin({
      operationId: "operation-in-flight",
      revisionGroupId: "group-in-flight",
      actor: { kind: "agent", agentId: AGENT },
      producer: { operation: "write", turnId: "turn-in-flight" },
      batch: updateBatch(
        "operation-in-flight",
        "group-in-flight",
        file,
        before.sha256,
        after.sha256,
        { kind: "agent", agentId: AGENT },
      ),
      paths: [{
        kind: "update",
        canonicalPath: file,
        revisionIds: ["revision-in-flight"],
        undoRecordIds: ["undo-in-flight"],
        locations: [{ canonicalPath: file, before, after }],
      }],
    });
    pending();
    await writerMayContinue;
    await fs.writeFile(file, after.bytes);
    await journal.finalize({ operationId: "operation-in-flight" });
  });
  await pendingReady;
  const recovery = journal.recover();
  continueWriter();
  await writer;
  expect(await recovery).toEqual([]);
  const claimed = await journal.claimOutbox({ claimantId: "worker-after-race" });
  expect(claimed?.operationId).toBe("operation-in-flight");
});

test("recovery ignores a new pending writer created after its path snapshot", async () => {
  const fx = await fixture();
  const baseStorage = createJournalStorage(fx.journalRoot);
  let armSnapshot = false;
  let snapshotSeen!: () => void;
  const snapshotRead = new Promise<void>((resolve) => {
    snapshotSeen = resolve;
  });
  const storage = {
    ...baseStorage,
    async readManifest() {
      const manifest = await baseStorage.readManifest();
      if (armSnapshot) {
        armSnapshot = false;
        snapshotSeen();
      }
      return manifest;
    },
  };
  const journal = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
    storage,
    journalRootKey: await fs.realpath(fx.journalRoot),
  });
  const before = snapshotFromBytes(Buffer.from("before"));
  const after = snapshotFromBytes(Buffer.from("after"));
  const actor = { kind: "agent" as const, agentId: AGENT };
  const oldFile = path.join(fx.workspace, "old-pending.txt");
  const newFile = path.join(fx.workspace, "new-pending.txt");
  await fs.writeFile(oldFile, before.bytes);
  await fs.writeFile(newFile, before.bytes);
  const beginUpdate = async (
    operationId: string,
    groupId: string,
    file: string,
    suffix: string,
  ) => journal.begin({
    operationId,
    revisionGroupId: groupId,
    actor,
    producer: { operation: "write", turnId: `turn-${suffix}` },
    batch: updateBatch(operationId, groupId, file, before.sha256, after.sha256, actor),
    paths: [{
      kind: "update" as const,
      canonicalPath: file,
      revisionIds: [`revision-${suffix}`],
      undoRecordIds: [`undo-${suffix}`],
      locations: [{ canonicalPath: file, before, after }],
    }],
  });
  await beginUpdate("operation-old", "group-old", oldFile, "old");

  let releaseOldLock!: () => void;
  const holdOldLock = new Promise<void>((resolve) => {
    releaseOldLock = resolve;
  });
  let oldLockHeld!: () => void;
  const oldLockReady = new Promise<void>((resolve) => {
    oldLockHeld = resolve;
  });
  const blocker = withCanonicalPathLocks([oldFile], async () => {
    oldLockHeld();
    await holdOldLock;
  });
  await oldLockReady;

  armSnapshot = true;
  const recovery = journal.recover();
  await snapshotRead;

  let newPending!: () => void;
  const newPendingReady = new Promise<void>((resolve) => {
    newPending = resolve;
  });
  let continueNewWriter!: () => void;
  const newWriterMayContinue = new Promise<void>((resolve) => {
    continueNewWriter = resolve;
  });
  const newWriter = withCanonicalPathLocks([newFile], async () => {
    await beginUpdate("operation-new", "group-new", newFile, "new");
    newPending();
    await newWriterMayContinue;
    await fs.writeFile(newFile, after.bytes);
    await journal.finalize({ operationId: "operation-new" });
  });
  await newPendingReady;
  releaseOldLock();
  await blocker;
  expect(await recovery).toEqual([
    { operationId: "operation-old", state: "aborted" },
  ]);
  const during = await baseStorage.readManifest();
  expect(during?.v).toBe(3);
  if (during?.v === 3) {
    expect(during.mutations.find((item) => item.operationId === "operation-new")?.state)
      .toBe("pending");
  }
  continueNewWriter();
  await newWriter;
});

test("read-only replay lookup preserves v1, returns exact committed truth, and isolates callers", async () => {
  const fx = await fixture();
  const storage = createJournalStorage(fx.journalRoot);
  await storage.ensureRoot();
  await storage.writeManifest({ v: 1, relayId: RELAY, entries: [] });
  const journal = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
  });
  const manifestPath = path.join(fx.journalRoot, "manifest.json");
  const v1Bytes = await fs.readFile(manifestPath);
  const v1Mtime = (await fs.stat(manifestPath)).mtimeMs;
  expect(await journal.lookupOperation("absent-v1")).toBeNull();
  expect(await fs.readFile(manifestPath)).toEqual(v1Bytes);
  expect((await fs.stat(manifestPath)).mtimeMs).toBe(v1Mtime);
  await expect(journal.lookupOperation("   ")).rejects.toThrow(
    "operationId must not be empty",
  );

  const file = path.join(fx.workspace, "replay.txt");
  const before = snapshotFromBytes(Buffer.from("before"));
  const after = snapshotFromBytes(Buffer.from("after"));
  const actor = { kind: "agent" as const, agentId: AGENT };
  const batch = updateBatch(
    "operation-replay",
    "group-replay",
    file,
    before.sha256,
    after.sha256,
    actor,
  );
  await fs.writeFile(file, before.bytes);
  await journal.begin({
    operationId: "operation-replay",
    revisionGroupId: "group-replay",
    actor,
    producer: { operation: "write", turnId: "turn-replay" },
    batch,
    paths: [{
      kind: "update",
      canonicalPath: file,
      revisionIds: ["revision-replay-1", "revision-replay-2"],
      undoRecordIds: ["undo-replay-1", "undo-replay-2"],
      locations: [{ canonicalPath: file, before, after }],
    }],
  });
  await fs.writeFile(file, after.bytes);
  await journal.finalize({ operationId: "operation-replay" });

  const bytesBefore = await fs.readFile(manifestPath);
  const mtimeBefore = (await fs.stat(manifestPath)).mtimeMs;
  expect(await journal.lookupOperation("absent-v2")).toBeNull();
  const replay = await journal.lookupOperation("operation-replay");
  expect(replay).not.toBeNull();
  expect(replay?.intent.paths[0]).toMatchObject({
    revisionIds: ["revision-replay-1", "revision-replay-2"],
    undoRecordIds: ["undo-replay-1", "undo-replay-2"],
  });
  expect(replay?.outbox.batch).toEqual(batch);

  replay!.intent.paths[0]!.revisionIds[0] = "caller-tampered";
  (replay!.outbox.batch as { operationId: string }).operationId = "caller-tampered";
  const freshJournal = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
  });
  const replayedAgain = await freshJournal.lookupOperation("operation-replay");
  expect(replayedAgain?.intent.paths[0]?.revisionIds).toEqual([
    "revision-replay-1",
    "revision-replay-2",
  ]);
  expect(replayedAgain?.outbox.batch).toEqual(batch);
  expect(await fs.readFile(manifestPath)).toEqual(bytesBefore);
  expect((await fs.stat(manifestPath)).mtimeMs).toBe(mtimeBefore);
});

test("corrupt v2 event/evidence mismatches fail closed instead of appearing absent", async () => {
  const fx = await fixture();
  const file = path.join(fx.workspace, "corrupt.txt");
  const before = snapshotFromBytes(Buffer.from("before"));
  const after = snapshotFromBytes(Buffer.from("after"));
  await fs.writeFile(file, before.bytes);
  const journal = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: RELAY,
    fileAdapter: fx.adapter,
  });
  await journal.begin({
    operationId: "operation-corrupt",
    revisionGroupId: "group-corrupt",
    actor: { kind: "agent", agentId: AGENT },
    producer: { operation: "write", turnId: "turn-corrupt" },
    batch: updateBatch(
      "operation-corrupt",
      "group-corrupt",
      file,
      before.sha256,
      after.sha256,
      { kind: "agent", agentId: AGENT },
    ),
    paths: [{
      kind: "update",
      canonicalPath: file,
      revisionIds: ["revision-corrupt"],
      undoRecordIds: ["undo-corrupt"],
      locations: [{ canonicalPath: file, before, after }],
    }],
  });
  const manifestPath = path.join(fx.journalRoot, "manifest.json");
  const raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    outbox: Array<{
      state: string;
      attempts: number;
      batch: { events: Array<{
        after: { sha256: string; backendVersion: { sha256: string } };
      }> };
    }>;
  };
  const forgedSha = "0".repeat(64);
  raw.outbox[0]!.batch.events[0]!.after.sha256 = forgedSha;
  raw.outbox[0]!.batch.events[0]!.after.backendVersion.sha256 = forgedSha;
  await fs.writeFile(manifestPath, JSON.stringify(raw));
  await expect(createJournalStorage(fx.journalRoot).readManifest()).rejects.toThrow(
    "after SHA mismatch",
  );
  raw.outbox[0]!.batch.events[0]!.after.sha256 = after.sha256;
  raw.outbox[0]!.batch.events[0]!.after.backendVersion.sha256 = after.sha256;
  raw.outbox[0]!.state = "claimed";
  raw.outbox[0]!.attempts = 1;
  await fs.writeFile(manifestPath, JSON.stringify(raw));
  await expect(createJournalStorage(fx.journalRoot).readManifest()).rejects.toThrow(
    "invalid claimed outbox state",
  );
});
