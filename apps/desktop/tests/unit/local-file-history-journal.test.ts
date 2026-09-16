import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createGuardedNodeAdapter } from "../../electron/local-file-history/file-adapter.ts";
import { snapshotFromBytes } from "../../electron/local-file-history/hash.ts";
import { formatRevisionRef } from "../../electron/local-file-history/ids.ts";
import { LocalFileHistoryJournal } from "../../electron/local-file-history/journal.ts";

const OWNER = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-000000000002";
const RELAY = "relay-test-desktop";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(maxEntriesPerPath = 5) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lfh-workspace-"));
  const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lfh-journal-"));
  roots.push(workspace, journalRoot);
  const adapter = createGuardedNodeAdapter({ allowedRoots: [workspace] });
  const createJournal = () =>
    new LocalFileHistoryJournal({
      rootDir: journalRoot,
      relayId: RELAY,
      fileAdapter: adapter,
      retention: {
        maxEntriesPerPath,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        maxTotalBytes: 1024 * 1024,
      },
    });
  const journal = createJournal();
  await journal.init();
  return { workspace, journalRoot, adapter, journal, createJournal };
}

async function record(
  fx: Awaited<ReturnType<typeof fixture>>,
  file: string,
  turnId: string,
  before: string,
  after: string,
) {
  return fx.journal.recordSuccessfulMutation({
    ownerId: OWNER,
    agentId: AGENT,
    turnId,
    requestedPath: file,
    zone: "current",
    operation: "write",
    preState: snapshotFromBytes(Buffer.from(before)),
    postState: snapshotFromBytes(Buffer.from(after)),
  });
}

test("the isolated structural V1 producer records, restarts, and lists relay-local history", async () => {
  const fx = await fixture();
  const file = path.join(fx.workspace, "notes.txt");
  await fs.writeFile(file, "after");
  const recorded = await record(fx, file, "turn-one", "before", "after");
  expect(recorded.ok).toBe(true);
  if (!recorded.ok) return;
  expect(recorded.data.revisionRef).toBe(
    formatRevisionRef(RELAY, recorded.data.revisionId),
  );

  const restarted = fx.createJournal();
  const listed = await restarted.list({ agentId: AGENT });
  expect(listed).toMatchObject({
    ok: true,
    data: {
      revisions: [{
        revisionRef: recorded.data.revisionRef,
        operation: "write",
        turnId: "turn-one",
      }],
      truncated: false,
    },
  });
});

test("legacy pin/unpin remains readable and rejects foreign relay references", async () => {
  const fx = await fixture();
  const file = path.join(fx.workspace, "pin.txt");
  await fs.writeFile(file, "after");
  const recorded = await record(fx, file, "turn-pin", "before", "after");
  expect(recorded.ok).toBe(true);
  if (!recorded.ok) return;

  expect(await fx.journal.pin({
    agentId: AGENT,
    revisionRef: recorded.data.revisionRef,
  })).toMatchObject({ ok: true, data: { pinned: true } });
  expect(await fx.journal.unpin({
    agentId: AGENT,
    revisionRef: recorded.data.revisionRef,
  })).toMatchObject({ ok: true, data: { pinned: false } });
  expect(await fx.journal.pin({
    agentId: AGENT,
    revisionRef: formatRevisionRef("other-relay", recorded.data.revisionId),
  })).toMatchObject({
    ok: false,
    code: "history_unavailable_on_this_relay",
  });
});

test("legacy producer retention prunes old unpinned rows without a restore writer", async () => {
  const fx = await fixture(2);
  const file = path.join(fx.workspace, "retention.txt");
  for (let index = 0; index < 3; index += 1) {
    await fs.writeFile(file, `v${index + 1}`);
    expect(await record(
      fx,
      file,
      `turn-${index}`,
      `v${index}`,
      `v${index + 1}`,
    )).toMatchObject({ ok: true });
  }
  expect(fx.journal.entryCount()).toBe(2);
  const listed = await fx.journal.list({ agentId: AGENT, limit: 10 });
  expect(listed).toMatchObject({ ok: true, data: { truncated: false } });
  if (listed.ok) expect(listed.data.revisions).toHaveLength(2);
});

test("journal persistence remains private, atomic, and leaves no temporary manifest", async () => {
  const fx = await fixture();
  const file = path.join(fx.workspace, "private.txt");
  await fs.writeFile(file, "after");
  expect(await record(fx, file, "turn-private", "before", "after"))
    .toMatchObject({ ok: true });
  expect((await fs.stat(fx.journalRoot)).mode & 0o777).toBe(0o700);
  const manifest = path.join(fx.journalRoot, "manifest.json");
  expect((await fs.stat(manifest)).mode & 0o777).toBe(0o600);
  expect((await fs.readdir(fx.journalRoot)).some((name) =>
    name.includes(".tmp")
  )).toBe(false);
});

test("structural V1 producer rejects paths outside the guarded workspace", async () => {
  const fx = await fixture();
  const outside = path.join(os.tmpdir(), `lfh-outside-${crypto.randomUUID()}`);
  expect(await record(fx, outside, "turn-outside", "before", "after"))
    .toMatchObject({ ok: false, code: "path_guard_rejected" });
});
