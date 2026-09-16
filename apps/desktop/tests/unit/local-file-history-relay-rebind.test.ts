import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { DesktopDocumentMutationRuntime } from "../../electron/document-mutations/desktop-document-mutation-runtime.ts";
import { LocalDurableMutationJournal } from "../../electron/local-file-history/durable-mutations.ts";
import { createGuardedNodeAdapter } from "../../electron/local-file-history/file-adapter.ts";
import { rebindLegacyLocalFileHistoryRelay } from "../../electron/local-file-history/relay-rebind.ts";
import { createJournalStorage } from "../../electron/local-file-history/storage.ts";

const OLD_RELAY = "11111111-1111-4111-8111-111111111111";
const NEW_RELAY = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })
  ));
});

async function fixture(publish: "published" | "not_published") {
  const fileRoot = await fs.mkdtemp(path.join(os.tmpdir(), "history-rebind-files-"));
  const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "history-rebind-journal-"));
  roots.push(fileRoot, journalRoot);
  const targetPath = path.join(fileRoot, "note.txt");
  await fs.writeFile(targetPath, "before\n");
  const adapter = createGuardedNodeAdapter({ allowedRoots: [fileRoot] });
  const journal = new LocalDurableMutationJournal({
    rootDir: journalRoot,
    relayId: OLD_RELAY,
    fileAdapter: adapter,
  });
  const runtime = new DesktopDocumentMutationRuntime({
    getTrustedRelayId: () => OLD_RELAY,
    getTrustedHumanId: () => "00000000-0000-4000-8000-000000000001",
    fileAdapter: adapter,
    journal,
    newOperationId: () => "relay-rebind-operation",
    newRevisionGroupId: () => "relay-rebind-group",
    publishToRenderer: async () => publish,
  });
  const committed = await runtime.commitAgentContent({
    mutationRequestId: "d448:relay-rebind:test",
    semanticDigest: "relay-rebind-test",
    targetPath,
    before: Buffer.from("before\n"),
    after: Buffer.from("after\n"),
    agentId: "00000000-0000-4000-8000-000000000002",
    turnId: "turn-relay-rebind",
    command: "write",
    reauthorize: async () => undefined,
  });
  expect(committed).toMatchObject({ ok: true });
  return { journalRoot, journal, runtime };
}

async function waitForActionableOutbox(journalRoot: string): Promise<void> {
  const storage = createJournalStorage(journalRoot);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const manifest = await storage.readManifest();
    if (manifest?.v !== 1 && manifest.outbox.some((row) =>
      row.state === "pending" && row.attempts >= 1
    )) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("outbox did not become actionable");
}

describe("legacy local-history relay rebind", () => {
  test("backs up and atomically rebinds completed whole-history identity", async () => {
    const fx = await fixture("not_published");
    await waitForActionableOutbox(fx.journalRoot);
    fx.runtime.stopOutboxPump();
    const storage = createJournalStorage(fx.journalRoot);
    const actionable = await storage.readManifest();
    if (actionable?.v === 1 || actionable === null) throw new Error("expected current manifest");
    await storage.writeManifest({
      ...actionable,
      outbox: actionable.outbox.map((row) => ({
        ...row,
        state: "delivered" as const,
        attempts: Math.max(1, row.attempts),
        deliveredAt: new Date().toISOString(),
      })),
    });
    const manifestPath = path.join(fx.journalRoot, "manifest.json");
    const before = await fs.readFile(manifestPath);
    expect(before.toString("utf8")).toContain(OLD_RELAY);

    const result = await rebindLegacyLocalFileHistoryRelay({
      rootDir: fx.journalRoot,
      previousRelayId: OLD_RELAY,
      relayId: NEW_RELAY,
    });
    expect(result.status).toBe("rebound");
    if (result.status !== "rebound") return;
    expect(await fs.readFile(result.backupPath)).toEqual(before);
    const after = await fs.readFile(manifestPath, "utf8");
    expect(after).not.toContain(OLD_RELAY);
    expect(after).toContain(NEW_RELAY);

    const rebound = new LocalDurableMutationJournal({
      rootDir: fx.journalRoot,
      relayId: NEW_RELAY,
      fileAdapter: createGuardedNodeAdapter({ allowedRoots: [] }),
    });
    await rebound.assertRelayBinding();
    let staleRelayError: unknown;
    try {
      await fx.journal.assertRelayBinding();
    } catch (error) {
      staleRelayError = error;
    }
    expect(staleRelayError).toBeInstanceOf(Error);
    expect(String(staleRelayError)).toContain("relay mismatch");
  });

  test("refuses to transfer actionable outbox work", async () => {
    const fx = await fixture("not_published");
    await waitForActionableOutbox(fx.journalRoot);
    fx.runtime.stopOutboxPump();
    const manifestPath = path.join(fx.journalRoot, "manifest.json");

    expect(await rebindLegacyLocalFileHistoryRelay({
      rootDir: fx.journalRoot,
      previousRelayId: OLD_RELAY,
      relayId: NEW_RELAY,
    })).toEqual({
      status: "refused",
      reason: "unfinished_history",
      manifestRelayId: OLD_RELAY,
    });
    expect(JSON.parse(await fs.readFile(manifestPath, "utf8"))).toMatchObject({
      relayId: OLD_RELAY,
    });
    expect((await fs.readdir(fx.journalRoot)).some((name) =>
      name.startsWith("manifest.before-relay-rebind-")
    )).toBe(false);
  });
});
