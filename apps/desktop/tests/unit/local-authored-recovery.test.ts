import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { DesktopDocumentMutationRuntime } from "../../electron/document-mutations/desktop-document-mutation-runtime.ts";
import { LocalDurableMutationJournal } from "../../electron/local-file-history/durable-mutations.ts";
import { createGuardedNodeAdapter } from "../../electron/local-file-history/file-adapter.ts";
import { sha256Hex } from "../../electron/local-file-history/hash.ts";
import {
  journalRootLockKey,
  withJournalRootLock,
} from "../../electron/local-file-history/journal-root-lock.ts";
import { createJournalStorage } from "../../electron/local-file-history/storage.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })
  ));
});

async function fixture() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "authored-recovery-workspace-"));
  const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "authored-recovery-journal-"));
  roots.push(workspace, journalRoot);
  const file = path.join(workspace, "video.md");
  await fs.writeFile(file, "before\n");
  const adapter = createGuardedNodeAdapter({ allowedRoots: [workspace] });
  const journal = new LocalDurableMutationJournal({
    rootDir: journalRoot,
    relayId: "relay-recovery",
    fileAdapter: adapter,
  });
  let id = 0;
  const runtime = new DesktopDocumentMutationRuntime({
    getTrustedRelayId: () => "relay-recovery",
    getTrustedHumanId: () => "human-recovery",
    fileAdapter: adapter,
    journal,
    newOperationId: () => `operation-${++id}`,
    newRevisionGroupId: () => `group-${id}`,
    publishToRenderer: async () => "published",
  });
  return { workspace, journalRoot, file, runtime };
}

async function agentUpdate(
  fx: Awaited<ReturnType<typeof fixture>>,
  before: string,
  after: string,
) {
  const result = await fx.runtime.commitAgentContent({
    mutationRequestId: `request-${after}`,
    semanticDigest: `digest-${after}`,
    targetPath: fx.file,
    before: Buffer.from(before),
    after: Buffer.from(after),
    agentId: "agent-one",
    turnId: `turn-${after}`,
    command: "write",
    reauthorize: async () => undefined,
  });
  expect(result.ok).toBe(true);
  return result;
}

test("returns the latest active authored update with journal-verified payloads", async () => {
  const fx = await fixture();
  const commit = await agentUpdate(fx, "before\n", "agent\n");
  const result = await fx.runtime.readAuthoredChange({
    path: fx.file,
    expectedSha256: sha256Hex(Buffer.from("agent\n")),
  });
  expect(result).toEqual({
    kind: "ready",
    operationId: commit.ok ? commit.operationId : "",
    author: { kind: "agent", displayName: "Genie" },
    before: { content: "before\n", sha256: sha256Hex(Buffer.from("before\n")) },
    after: { content: "agent\n", sha256: sha256Hex(Buffer.from("agent\n")) },
    currentSha256: sha256Hex(Buffer.from("agent\n")),
  });
});

test("allows a later continuous human update while retaining the agent receipt", async () => {
  const fx = await fixture();
  await agentUpdate(fx, "before\n", "agent\n");
  const saved = await fx.runtime.saveExistingFile({
    path: fx.file,
    content: "agent\nhuman\n",
    baseSha256: sha256Hex(Buffer.from("agent\n")),
  });
  expect(saved.ok).toBe(true);
  const result = await fx.runtime.readAuthoredChange({
    path: fx.file,
    expectedSha256: sha256Hex(Buffer.from("agent\nhuman\n")),
  });
  expect(result).toMatchObject({
    kind: "ready",
    before: { content: "before\n" },
    after: { content: "agent\n" },
    currentSha256: sha256Hex(Buffer.from("agent\nhuman\n")),
  });
});

test("returns none for human-only history and an undone agent update", async () => {
  const human = await fixture();
  expect((await human.runtime.saveExistingFile({
    path: human.file,
    content: "human\n",
    baseSha256: sha256Hex(Buffer.from("before\n")),
  })).ok).toBe(true);
  expect(await human.runtime.readAuthoredChange({
    path: human.file,
    expectedSha256: sha256Hex(Buffer.from("human\n")),
  })).toEqual({ kind: "none" });

  const undone = await fixture();
  await agentUpdate(undone, "before\n", "agent\n");
  expect((await undone.runtime.commitHistoryRestore({
    action: "undo",
    targetPath: undone.file,
    agentId: "agent-one",
    turnId: "undo-turn",
    mutationRequestId: "undo-request",
    semanticDigest: "undo-digest",
    authorizedRoots: [undone.workspace],
    reauthorize: async () => undefined,
  })).ok).toBe(true);
  expect(await undone.runtime.readAuthoredChange({
    path: undone.file,
    expectedSha256: sha256Hex(Buffer.from("before\n")),
  })).toEqual({ kind: "none" });
});

test("fails closed on expected SHA mismatch, external replacement, and stale authority", async () => {
  const fx = await fixture();
  await agentUpdate(fx, "before\n", "agent\n");
  expect(await fx.runtime.readAuthoredChange({
    path: fx.file,
    expectedSha256: sha256Hex(Buffer.from("before\n")),
  })).toEqual({ kind: "unavailable", code: "expected_sha256_mismatch" });

  await fs.writeFile(fx.file, "external\n");
  expect(await fx.runtime.readAuthoredChange({
    path: fx.file,
    expectedSha256: sha256Hex(Buffer.from("external\n")),
  })).toEqual({ kind: "unavailable", code: "history_drift" });

  fx.runtime.stopOutboxPump();
  expect(await fx.runtime.readAuthoredChange({
    path: fx.file,
    expectedSha256: sha256Hex(Buffer.from("external\n")),
  })).toEqual({ kind: "unavailable", code: "history_unavailable" });
});

test("does not read payloads for another path", async () => {
  const fx = await fixture();
  await agentUpdate(fx, "before\n", "agent\n");
  const other = path.join(fx.workspace, "other.md");
  await fs.writeFile(other, "other\n");
  expect(await fx.runtime.readAuthoredChange({
    path: other,
    expectedSha256: sha256Hex(Buffer.from("other\n")),
  })).toEqual({ kind: "none" });
});

test("does not invent a receipt when retained payload evidence is corrupt", async () => {
  const fx = await fixture();
  const commit = await agentUpdate(fx, "before\n", "agent\n");
  if (!commit.ok) throw new Error(commit.message);
  const manifest = await createJournalStorage(fx.journalRoot).readManifest();
  if (manifest?.v !== 3) throw new Error("expected V3 journal");
  const state = manifest.mutations[0]?.paths[0]?.locations[0]?.before;
  if (state?.kind !== "bytes") throw new Error("expected retained payload");
  await fs.rm(path.join(fx.journalRoot, state.payload.path));
  expect(await fx.runtime.readAuthoredChange({
    path: fx.file,
    expectedSha256: sha256Hex(Buffer.from("agent\n")),
  })).toEqual({ kind: "unavailable", code: "history_unavailable" });
});

test("fails closed across delete and recreate structural history", async () => {
  const fx = await fixture();
  await agentUpdate(fx, "before\n", "agent\n");
  expect((await fx.runtime.commitAgentStructural({
    command: "delete",
    sourcePath: fx.file,
    authorizedRoots: [fx.workspace],
    agentId: "agent-one",
    turnId: "delete-turn",
    mutationRequestId: "delete-request",
    semanticDigest: "delete-digest",
    reauthorize: async () => undefined,
  })).ok).toBe(true);
  expect((await fx.runtime.commitAgentContent({
    targetPath: fx.file,
    before: null,
    after: Buffer.from("recreated\n"),
    agentId: "agent-one",
    turnId: "recreate-turn",
    command: "write",
    mutationRequestId: "recreate-request",
    semanticDigest: "recreate-digest",
    reauthorize: async () => undefined,
  })).ok).toBe(true);
  expect(await fx.runtime.readAuthoredChange({
    path: fx.file,
    expectedSha256: sha256Hex(Buffer.from("recreated\n")),
  })).toEqual({ kind: "unavailable", code: "history_unavailable" });
});

test("missing undo lineage fails closed instead of resurrecting its source", async () => {
  const fx = await fixture();
  await agentUpdate(fx, "before\n", "agent\n");
  expect((await fx.runtime.commitHistoryRestore({
    action: "undo",
    targetPath: fx.file,
    agentId: "agent-one",
    turnId: "undo-turn",
    mutationRequestId: "undo-request",
    semanticDigest: "undo-digest",
    authorizedRoots: [fx.workspace],
    reauthorize: async () => undefined,
  })).ok).toBe(true);
  fx.runtime.stopOutboxPump();
  const storage = createJournalStorage(fx.journalRoot);
  // Stopping blocks future pump requests; the canonical journal lock also
  // serializes this corruption behind any outbox write already in flight.
  await withJournalRootLock(
    journalRootLockKey(await fs.realpath(fx.journalRoot)),
    async () => {
      const manifest = await storage.readManifest();
      if (manifest?.v !== 3) throw new Error("expected V3 journal");
      const undoIntent = manifest.mutations.find((intent) =>
        intent.producer?.operation === "undo"
      );
      if (undoIntent === undefined) throw new Error("expected retained undo intent");
      await storage.writeManifest({
        ...manifest,
        mutations: manifest.mutations.map((intent) =>
          intent === undoIntent
            ? {
                ...intent,
                producer: {
                  ...intent.producer!,
                  history: { action: "undo", sourceRevisionIds: ["pruned-source"] },
                },
              }
            : intent
        ),
      });
    },
  );
  const reader = new DesktopDocumentMutationRuntime({
    getTrustedRelayId: () => "relay-recovery",
    getTrustedHumanId: () => "human-recovery",
    fileAdapter: createGuardedNodeAdapter({ allowedRoots: [fx.workspace] }),
    journal: new LocalDurableMutationJournal({
      rootDir: fx.journalRoot,
      relayId: "relay-recovery",
      fileAdapter: createGuardedNodeAdapter({ allowedRoots: [fx.workspace] }),
    }),
    publishToRenderer: async () => "published",
  });
  expect(await reader.readAuthoredChange({
    path: fx.file,
    expectedSha256: sha256Hex(Buffer.from("before\n")),
  })).toEqual({ kind: "unavailable", code: "history_unavailable" });
});

test("revalidates trusted human and relay identities after awaited reads", async () => {
  const fx = await fixture();
  await agentUpdate(fx, "before\n", "agent\n");
  let humanCalls = 0;
  const changedHumanRuntime = new DesktopDocumentMutationRuntime({
    getTrustedRelayId: () => "relay-recovery",
    getTrustedHumanId: () => ++humanCalls === 1 ? "human-recovery" : "human-replacement",
    fileAdapter: createGuardedNodeAdapter({ allowedRoots: [fx.workspace] }),
    journal: new LocalDurableMutationJournal({
      rootDir: fx.journalRoot,
      relayId: "relay-recovery",
      fileAdapter: createGuardedNodeAdapter({ allowedRoots: [fx.workspace] }),
    }),
    publishToRenderer: async () => "published",
  });
  expect(await changedHumanRuntime.readAuthoredChange({
    path: fx.file,
    expectedSha256: sha256Hex(Buffer.from("agent\n")),
  })).toEqual({ kind: "unavailable", code: "history_unavailable" });

  let relayCalls = 0;
  const changedRelayRuntime = new DesktopDocumentMutationRuntime({
    getTrustedRelayId: () => ++relayCalls === 1 ? "relay-recovery" : "relay-replacement",
    getTrustedHumanId: () => "human-recovery",
    fileAdapter: createGuardedNodeAdapter({ allowedRoots: [fx.workspace] }),
    journal: new LocalDurableMutationJournal({
      rootDir: fx.journalRoot,
      relayId: "relay-recovery",
      fileAdapter: createGuardedNodeAdapter({ allowedRoots: [fx.workspace] }),
    }),
    publishToRenderer: async () => "published",
  });
  expect(await changedRelayRuntime.readAuthoredChange({
    path: fx.file,
    expectedSha256: sha256Hex(Buffer.from("agent\n")),
  })).toEqual({ kind: "unavailable", code: "history_unavailable" });
});

test("path-scoped legacy reads skip unrelated paths outside current grants", async () => {
  const fx = await fixture();
  const storage = createJournalStorage(fx.journalRoot);
  await storage.writeManifest({
    v: 1,
    relayId: "relay-recovery",
    entries: [{
      id: "legacy-unrelated",
      ownerId: "owner",
      agentId: "agent",
      turnId: "turn",
      requestedPath: "/outside/unrelated.md",
      canonicalPath: "/outside/unrelated.md",
      operation: "write",
      createdAt: new Date().toISOString(),
      preState: { kind: "bytes", sha256: "a".repeat(64), size: 1 },
      postState: { kind: "bytes", sha256: "b".repeat(64), size: 1 },
      pinned: false,
      payloadBytes: 2,
    }],
  });
  expect(await fx.runtime.readAuthoredChange({
    path: fx.file,
    expectedSha256: sha256Hex(Buffer.from("before\n")),
  })).toEqual({ kind: "none" });
});

test("many-row recovery reads only the selected candidate payload pair", async () => {
  const fx = await fixture();
  let before = "before\n";
  for (let index = 0; index < 12; index += 1) {
    const after = `agent-${index}\n`;
    await agentUpdate(fx, before, after);
    before = after;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  fx.runtime.stopOutboxPump();
  const base = createJournalStorage(fx.journalRoot);
  let payloadReads = 0;
  const journal = new LocalDurableMutationJournal({
    rootDir: fx.journalRoot,
    relayId: "relay-recovery",
    fileAdapter: createGuardedNodeAdapter({ allowedRoots: [fx.workspace] }),
    storage: {
      ...base,
      async readMutationState(state) {
        payloadReads += 1;
        return await base.readMutationState(state);
      },
    },
    journalRootKey: await fs.realpath(fx.journalRoot),
  });
  const result = await journal.readAuthoredChangeCandidate(await fs.realpath(fx.file));
  expect(result.candidate?.operationId).toContain("digest-agent-11");
  expect(payloadReads).toBe(2);
});
