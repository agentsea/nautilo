import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildAtomicDocumentMutationEventBatch,
  type AtomicDocumentMutationEventBatch,
  type BackendCommitPlan,
  type BackendCommitReceipt,
} from "@nautilo/document-mutations";

import {
  DEFAULT_DESKTOP_OUTBOX_STALE_CLAIM_MS,
  DesktopDocumentMutationOutboxRunner,
} from "../../electron/document-mutations/desktop-document-mutation-outbox";
import { createGuardedNodeAdapter } from "../../electron/local-file-history/file-adapter";
import { sha256Hex, snapshotFromBytes } from "../../electron/local-file-history/hash";
import { LocalDurableMutationJournal } from "../../electron/local-file-history/durable-mutations";

const RELAY = "relay-desktop-outbox";
const ACTOR = { kind: "agent" as const, agentId: "agent-desktop-outbox" };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

async function durableFixture(operationId: string, finalize: boolean) {
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-outbox-workspace-"),
  );
  const journalRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-outbox-journal-"),
  );
  roots.push(workspace, journalRoot);
  const requestedFile = path.join(workspace, "document.md");
  const before = snapshotFromBytes(Buffer.from("before\n"));
  const after = snapshotFromBytes(Buffer.from("after\n"));
  if (before.kind !== "bytes" || after.kind !== "bytes") {
    throw new Error("expected byte snapshots");
  }
  await fs.writeFile(requestedFile, before.bytes);
  const adapter = createGuardedNodeAdapter({ allowedRoots: [workspace] });
  const file = await adapter.canonicalize(requestedFile);
  const journal = new LocalDurableMutationJournal({
    rootDir: journalRoot,
    relayId: RELAY,
    fileAdapter: adapter,
  });
  const identity = {
    kind: "local_file" as const,
    relayId: RELAY,
    canonicalPath: file,
  };
  const beforeVersion = {
    identity,
    backendVersion: { kind: "local_sha" as const, sha256: before.sha256 },
    sha256: before.sha256,
  };
  const plan: BackendCommitPlan<"desktop"> = {
    operationId,
    actor: ACTOR,
    entries: [{
      kind: "update",
      before: {
        identity,
        expectedVersion: beforeVersion,
        bytes: before.bytes,
      },
      after: { identity, sha256: after.sha256, bytes: after.bytes },
    }],
  };
  const revisionGroupId = `group-${operationId}`;
  const receipt: BackendCommitReceipt<"desktop"> = {
    backend: "desktop",
    operationId,
    revisionGroupId,
    entries: [{
      entryIndex: 0,
      kind: "update",
      revisionIds: [`revision-${operationId}`],
      undoRecordIds: [`undo-${operationId}`],
      before: beforeVersion,
      after: {
        identity,
        backendVersion: { kind: "local_sha", sha256: after.sha256 },
        sha256: after.sha256,
      },
    }],
  };
  const batch = buildAtomicDocumentMutationEventBatch({
    backend: "desktop",
    plan,
    receipt,
    revisionGroupId,
    outcome: "applied",
  });
  await journal.begin({
    operationId,
    revisionGroupId,
    actor: ACTOR,
    producer: { operation: "write", turnId: "turn-outbox" },
    batch,
    paths: [{
      kind: "update",
      canonicalPath: file,
      revisionIds: [`revision-${operationId}`],
      undoRecordIds: [`undo-${operationId}`],
      locations: [{ canonicalPath: file, before, after }],
    }],
  });
  await fs.writeFile(file, after.bytes);
  if (finalize) await journal.finalize({ operationId });
  return { journal, journalRoot, adapter, batch, file, before, after };
}

async function durableMultiEventFixture() {
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-outbox-multi-workspace-"),
  );
  const journalRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-outbox-multi-journal-"),
  );
  roots.push(workspace, journalRoot);
  const adapter = createGuardedNodeAdapter({ allowedRoots: [workspace] });
  const journal = new LocalDurableMutationJournal({
    rootDir: journalRoot,
    relayId: RELAY,
    fileAdapter: adapter,
  });
  const before = snapshotFromBytes(Buffer.from("before\n"));
  const after = snapshotFromBytes(Buffer.from("after\n"));
  if (before.kind !== "bytes" || after.kind !== "bytes") {
    throw new Error("expected byte snapshots");
  }
  const files = await Promise.all(["first.md", "second.md"].map(async (name) => {
    const requested = path.join(workspace, name);
    await fs.writeFile(requested, before.bytes);
    return adapter.canonicalize(requested);
  }));
  const identities = files.map((canonicalPath) => ({
    kind: "local_file" as const,
    relayId: RELAY,
    canonicalPath,
  }));
  const versions = identities.map((identity) => ({
    identity,
    backendVersion: { kind: "local_sha" as const, sha256: before.sha256 },
    sha256: before.sha256,
  }));
  const operationId = "multi-event";
  const revisionGroupId = "group-multi-event";
  const plan: BackendCommitPlan<"desktop"> = {
    operationId,
    actor: ACTOR,
    entries: identities.map((identity, index) => ({
      kind: "update" as const,
      before: {
        identity,
        expectedVersion: versions[index]!,
        bytes: before.bytes,
      },
      after: { identity, sha256: after.sha256, bytes: after.bytes },
    })),
  };
  const receipt: BackendCommitReceipt<"desktop"> = {
    backend: "desktop",
    operationId,
    revisionGroupId,
    entries: identities.map((identity, entryIndex) => ({
      entryIndex,
      kind: "update" as const,
      revisionIds: [`revision-multi-${entryIndex}`] as [string],
      undoRecordIds: [`undo-multi-${entryIndex}`] as [string],
      before: versions[entryIndex]!,
      after: {
        identity,
        backendVersion: { kind: "local_sha" as const, sha256: after.sha256 },
        sha256: after.sha256,
      },
    })),
  };
  const batch = buildAtomicDocumentMutationEventBatch({
    backend: "desktop",
    plan,
    receipt,
    revisionGroupId,
    outcome: "applied",
  });
  await journal.begin({
    operationId,
    revisionGroupId,
    actor: ACTOR,
    producer: { operation: "write", turnId: "turn-outbox" },
    batch,
    paths: files.map((canonicalPath, index) => ({
      kind: "update" as const,
      canonicalPath,
      revisionIds: [`revision-multi-${index}`],
      undoRecordIds: [`undo-multi-${index}`],
      locations: [{ canonicalPath, before, after }],
    })),
  });
  await Promise.all(files.map((file) => fs.writeFile(file, after.bytes)));
  await journal.finalize({ operationId });
  return { journal, batch, files };
}

describe("DesktopDocumentMutationOutboxRunner", () => {
  test("recovers startup truth, publishes the exact whole batch, and acknowledges only after success", async () => {
    const fx = await durableFixture("startup", false);
    const published: AtomicDocumentMutationEventBatch[] = [];
    const runner = new DesktopDocumentMutationOutboxRunner({
      journal: fx.journal,
      workerId: "desktop-worker",
      publisher: {
        publishAtomic: async (batch) => {
          published.push(batch);
          return { kind: "published" };
        },
      },
    });
    expect(await runner.recoverAtStartup()).toEqual([
      { operationId: "startup", state: "committed" },
    ]);
    expect(published).toEqual([fx.batch]);
    expect(
      (await fx.journal.lookupOperation("startup"))?.outbox.state,
    ).toBe("delivered");
  });

  test("preserves a genuine multi-event durable batch whole, ordered, and untruncated", async () => {
    const fx = await durableMultiEventFixture();
    const published: AtomicDocumentMutationEventBatch[] = [];
    const runner = new DesktopDocumentMutationOutboxRunner({
      journal: fx.journal,
      workerId: "desktop-multi-worker",
      publisher: {
        publishAtomic: async (batch) => {
          published.push(batch);
          return { kind: "published" };
        },
      },
    });
    expect(await runner.runOnce()).toEqual({
      kind: "dispatched",
      batchIdempotencyKey: fx.batch.idempotencyKey,
      count: 2,
    });
    expect(published).toEqual([fx.batch]);
    expect(published[0]?.events).toHaveLength(2);
    expect(published[0]?.events.map((event) => event.sequence)).toEqual([0, 1]);
    expect(
      published[0]?.events.map((event) =>
        event.mutation === "update"
          ? event.after.identity.canonicalPath
          : "unexpected",
      ),
    ).toEqual(fx.files);
  });

  test("retries the exact batch with caller scheduling and no attempt cap", async () => {
    const fx = await durableFixture("retry", true);
    let now = new Date("2026-07-24T00:00:00.000Z");
    let attempts = 0;
    const seen: AtomicDocumentMutationEventBatch[] = [];
    const runner = new DesktopDocumentMutationOutboxRunner({
      journal: fx.journal,
      workerId: "desktop-worker",
      now: () => now,
      nextAttemptAt: ({ now: current }) =>
        new Date(current.getTime() + 5_000),
      publisher: {
        publishAtomic: async (batch) => {
          attempts += 1;
          seen.push(batch);
          return attempts < 4
            ? { kind: "not_published" as const }
            : { kind: "published" as const };
        },
      },
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await runner.runOnce()).toMatchObject({
        kind: "retry_scheduled",
        batchIdempotencyKey: fx.batch.idempotencyKey,
      });
      expect(
        (await fx.journal.lookupOperation("retry"))?.outbox.attempts,
      ).toBe(attempt);
      now = new Date(now.getTime() + 5_000);
    }
    expect(await runner.runOnce()).toMatchObject({ kind: "dispatched" });
    expect(seen).toEqual([fx.batch, fx.batch, fx.batch, fx.batch]);
    expect(
      (await fx.journal.lookupOperation("retry"))?.outbox,
    ).toMatchObject({ state: "delivered", attempts: 4 });
  });

  test("publisher failure never acknowledges committed truth", async () => {
    const fx = await durableFixture("offline", true);
    const runner = new DesktopDocumentMutationOutboxRunner({
      journal: fx.journal,
      workerId: "desktop-worker",
      publisher: {
        publishAtomic: async () => {
          throw new Error("offline");
        },
      },
    });
    expect(await runner.runOnce()).toMatchObject({
      kind: "retry_scheduled",
      count: 1,
    });
    expect(
      (await fx.journal.lookupOperation("offline"))?.outbox,
    ).toMatchObject({
      state: "pending",
      attempts: 1,
      lastError: "offline",
    });
    expect(await fs.readFile(fx.file)).toEqual(Buffer.from(fx.after.bytes));
    expect(sha256Hex(await fs.readFile(fx.file))).toBe(fx.after.sha256);
  });

  test("publication success with ack failure reports unknown finalization, not a failed commit", async () => {
    const fx = await durableFixture("ack-failure", true);
    const firstNow = new Date("2026-07-24T02:00:00.000Z");
    fx.journal.ackOutbox = async () => {
      throw new Error("injected ack failure");
    };
    const runner = new DesktopDocumentMutationOutboxRunner({
      journal: fx.journal,
      workerId: "desktop-worker",
      now: () => firstNow,
      publisher: {
        publishAtomic: async () => ({ kind: "published" }),
      },
    });
    expect(await runner.runOnce()).toEqual({
      kind: "published_finalization_unknown",
      batchIdempotencyKey: fx.batch.idempotencyKey,
      nextWakeAt: "2026-07-24T02:01:00.000Z",
    });
    expect(
      (await fx.journal.lookupOperation("ack-failure"))?.intent.state,
    ).toBe("committed");

    const restartedJournal = new LocalDurableMutationJournal({
      rootDir: fx.journalRoot,
      relayId: RELAY,
      fileAdapter: fx.adapter,
    });
    const republished: AtomicDocumentMutationEventBatch[] = [];
    const restarted = new DesktopDocumentMutationOutboxRunner({
      journal: restartedJournal,
      workerId: "desktop-worker-restarted",
      now: () =>
        new Date(
          firstNow.getTime() + DEFAULT_DESKTOP_OUTBOX_STALE_CLAIM_MS + 1,
        ),
      publisher: {
        publishAtomic: async (batch) => {
          republished.push(batch);
          return { kind: "published" };
        },
      },
    });
    expect(await restarted.recoverAtStartup()).toEqual([]);
    expect(republished).toEqual([fx.batch]);
    expect(
      (await restartedJournal.lookupOperation("ack-failure"))?.outbox.state,
    ).toBe("delivered");
  });

  test("clamps invalid, past, and immediate retry dates to a finite delay floor", async () => {
    const now = new Date("2026-07-24T03:00:00.000Z");
    const candidates = [
      new Date(Number.NaN),
      new Date(now.getTime() - 10_000),
      new Date(now),
    ];
    for (const [index, candidate] of candidates.entries()) {
      const operationId = `retry-date-${index}`;
      const fx = await durableFixture(operationId, true);
      const runner = new DesktopDocumentMutationOutboxRunner({
        journal: fx.journal,
        workerId: `desktop-worker-${index}`,
        now: () => now,
        nextAttemptAt: () => candidate,
        publisher: {
          publishAtomic: async () => ({ kind: "not_published" }),
        },
      });
      expect(await runner.runOnce()).toMatchObject({
        kind: "retry_scheduled",
      });
      expect(
        (await fx.journal.lookupOperation(operationId))?.outbox.nextAttemptAt,
      ).toBe("2026-07-24T03:00:01.000Z");
    }
  });

  test("omits invalid stale thresholds and clamps now/future without altering safe past thresholds", async () => {
    const fx = await durableFixture("stale-threshold", true);
    const now = new Date("2026-07-24T04:00:00.000Z");
    const candidates = [
      new Date(Number.NaN),
      new Date(now),
      new Date(now.getTime() + 10_000),
      new Date(now.getTime() - 20_000),
    ];
    const captured: Array<string | undefined> = [];
    fx.journal.claimOutbox = async (input) => {
      captured.push(input.staleClaimBefore);
      return null;
    };
    let index = 0;
    const runner = new DesktopDocumentMutationOutboxRunner({
      journal: fx.journal,
      workerId: "desktop-worker",
      now: () => now,
      staleClaimBefore: () => candidates[index++]!,
      publisher: {
        publishAtomic: async () => ({ kind: "published" }),
      },
    });
    for (const _candidate of candidates) {
      expect(await runner.runOnce()).toMatchObject({ kind: "idle" });
    }
    expect(captured).toEqual([
      "2026-07-24T03:59:00.000Z",
      "2026-07-24T03:59:59.000Z",
      "2026-07-24T03:59:59.000Z",
      "2026-07-24T03:59:40.000Z",
    ]);
  });
});
