import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildAtomicDocumentMutationEventBatch,
  type BackendCommitPlan,
} from "@nautilo/document-mutations";
import type { DocumentMutationActor } from "@nautilo/types";

import {
  DesktopFileMutationBackend,
  type PreparedDesktopFileMutation,
} from "../../electron/document-mutations/desktop-file-mutation-backend";
import {
  createGuardedNodeAdapter,
  type GuardedFileAdapter,
} from "../../electron/local-file-history/file-adapter";
import { sha256Hex } from "../../electron/local-file-history/hash";
import { LocalDurableMutationJournal } from "../../electron/local-file-history/durable-mutations";
import { withCanonicalPathLocks } from "../../electron/local-file-history/mutation-lock";

const RELAY = "relay-desktop-backend";
const ACTOR = { kind: "agent" as const, agentId: "agent-desktop-backend" };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

type Fixture = {
  workspace: string;
  journalRoot: string;
  file: string;
  before: Uint8Array;
  after: Uint8Array;
  adapter: GuardedFileAdapter;
  journal: LocalDurableMutationJournal;
};

async function fixture(adapterOverride?: (
  base: GuardedFileAdapter,
) => GuardedFileAdapter): Promise<Fixture> {
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-backend-workspace-"),
  );
  const journalRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "desktop-backend-journal-"),
  );
  roots.push(workspace, journalRoot);
  const requestedFile = path.join(workspace, "document.md");
  const before = Buffer.from("before\n");
  const after = Buffer.from("after\n");
  await fs.writeFile(requestedFile, before);
  const base = createGuardedNodeAdapter({ allowedRoots: [workspace] });
  const file = await base.canonicalize(requestedFile);
  const adapter = adapterOverride?.(base) ?? base;
  const journal = new LocalDurableMutationJournal({
    rootDir: journalRoot,
    relayId: RELAY,
    fileAdapter: adapter,
  });
  return { workspace, journalRoot, file, before, after, adapter, journal };
}

function plan(
  fx: Pick<Fixture, "file" | "before" | "after">,
  input: {
    operationId?: string;
    relayId?: string;
    canonicalPath?: string;
    beforeSha?: string;
    afterSha?: string;
  } = {},
): BackendCommitPlan<"desktop"> {
  const relayId = input.relayId ?? RELAY;
  const canonicalPath = input.canonicalPath ?? fx.file;
  const identity = {
    kind: "local_file" as const,
    relayId,
    canonicalPath,
  };
  const beforeSha = input.beforeSha ?? sha256Hex(fx.before);
  return {
    operationId: input.operationId ?? "operation-desktop-update",
    actor: ACTOR,
    entries: [{
      kind: "update",
      before: {
        identity,
        expectedVersion: {
          identity,
          backendVersion: { kind: "local_sha", sha256: beforeSha },
          sha256: beforeSha,
        },
        bytes: fx.before,
      },
      after: {
        identity,
        sha256: input.afterSha ?? sha256Hex(fx.after),
        bytes: fx.after,
      },
    }],
  };
}

function backend(
  fx: Fixture,
  input: {
    relayId?: string;
    ids?: string[];
    assertTrustedActor?: (
      actor: DocumentMutationActor,
      operationId: string,
    ) => void | Promise<void>;
  } = {},
): DesktopFileMutationBackend {
  const ids = input.ids ?? ["revision-1", "undo-1"];
  return new DesktopFileMutationBackend({
    getTrustedRelayId: () => input.relayId ?? RELAY,
    assertTrustedActor: (actor, operationId) =>
      input.assertTrustedActor?.(actor, operationId),
    producerMetadata: (plan) => ({
      operation: "write",
      turnId: plan.turnId ?? "turn-backend",
    }),
    fileAdapter: fx.adapter,
    journal: fx.journal,
    newOpaqueId: () => ids.shift() ?? "unexpected-extra-id",
  });
}

function eventBuilder(
  commitPlan: BackendCommitPlan<"desktop">,
  revisionGroupId: string,
) {
  return (
    receipt: Parameters<
      Parameters<DesktopFileMutationBackend["commitPrepared"]>[0]["buildCommittedEventBatch"]
    >[0],
  ) =>
    buildAtomicDocumentMutationEventBatch({
      backend: "desktop",
      plan: commitPlan,
      receipt,
      revisionGroupId,
      outcome: "applied",
    });
}

async function prepared(
  subject: DesktopFileMutationBackend,
  commitPlan: BackendCommitPlan<"desktop">,
): Promise<PreparedDesktopFileMutation> {
  const result = await subject.prepare(commitPlan);
  expect(result.kind).toBe("prepared");
  if (result.kind !== "prepared") throw new Error("expected prepared outcome");
  return result.prepared;
}

describe("DesktopFileMutationBackend", () => {
  test("guarded target resolution rejects final symlinks and canonicalizes missing nested destinations", async () => {
    const fx = await fixture();
    const realDirectory = path.join(fx.workspace, "real-parent");
    await fs.mkdir(realDirectory);
    const linkedDirectory = path.join(fx.workspace, "linked-parent");
    await fs.symlink(realDirectory, linkedDirectory);
    const missing = await fx.adapter.resolveTarget(
      path.join(linkedDirectory, "new.md"),
      { allowMissing: true, rejectFinalSymlink: true },
    );
    expect(missing).toBe(path.join(await fs.realpath(realDirectory), "new.md"));

    const sourceLink = path.join(fx.workspace, "source-link.md");
    await fs.symlink(fx.file, sourceLink);
    await expect(
      fx.adapter.resolveTarget(sourceLink, {
        allowMissing: false,
        rejectFinalSymlink: true,
      }),
    ).rejects.toMatchObject({ code: "PATH_GUARD_REJECTED" });
    const nested = path.join(fx.workspace, "missing-parent", "nested", "new.md");
    expect(await fx.adapter.resolveTarget(
      nested,
      { allowMissing: true, rejectFinalSymlink: true },
    )).toBe(path.join(
      await fs.realpath(fx.workspace),
      "missing-parent",
      "nested",
      "new.md",
    ));
    expect(await fx.adapter.writeFileAtomicConditional!(
      nested,
      { kind: "missing" },
      Buffer.from("nested\n"),
    )).toEqual({ kind: "applied" });
    expect(await fs.readFile(nested, "utf8")).toBe("nested\n");
  });

  test("rejects relay/path forgery, canonical drift, stale CAS, and a forged candidate hash", async () => {
    const fx = await fixture();
    expect(
      (await backend(fx).prepare(plan(fx, { relayId: "renderer-forged" }))).kind,
    ).toBe("failed");
    expect(
      (
        await backend(fx, { relayId: "different-configured-relay" }).prepare(
          plan(fx),
        )
      ).kind,
    ).toBe("failed");
    expect(
      (
        await backend(fx).prepare(
          plan(fx, {
            canonicalPath: path.join(fx.workspace, "..", "outside.md"),
          }),
        )
      ).kind,
    ).toBe("failed");

    const driftFx = await fixture((base) => ({
      ...base,
      resolveTarget: async (candidate, options) =>
        candidate.endsWith("document.md")
          ? path.join(path.dirname(candidate), "drifted.md")
          : base.resolveTarget(candidate, options),
    }));
    expect((await backend(driftFx).prepare(plan(driftFx))).kind).toBe("failed");

    await fs.writeFile(fx.file, "foreign\n");
    const stale = await backend(fx).prepare(plan(fx));
    const foreignBytes = new TextEncoder().encode("foreign\n");
    expect(stale).toMatchObject({
      kind: "conflict",
      code: "stale_version",
      evidence: [{
        currentVersion: { sha256: sha256Hex(foreignBytes) },
      }],
      currentSnapshots: [{
        bytes: foreignBytes,
        currentVersion: { sha256: sha256Hex(foreignBytes) },
      }],
    });

    await fs.writeFile(fx.file, fx.before);
    expect(
      (
        await backend(fx).prepare(
          plan(fx, { afterSha: "f".repeat(64) }),
        )
      ).kind,
    ).toBe("failed");
  });

  test("holds the existing canonical lock and durably begins before write, then finalizes after exact proof", async () => {
    const order: string[] = [];
    const fx = await fixture((base) => ({
      ...base,
      writeFileAtomicConditional: async (file, expected, bytes) => {
        order.push("write");
        return base.writeFileAtomicConditional!(file, expected, bytes);
      },
    }));
    const originalBegin = fx.journal.begin.bind(fx.journal);
    fx.journal.begin = async (input) => {
      order.push("begin");
      return originalBegin(input);
    };
    const originalFinalize = fx.journal.finalize.bind(fx.journal);
    fx.journal.finalize = async (input) => {
      expect(await fs.readFile(fx.file)).toEqual(Buffer.from(fx.after));
      order.push("finalize");
      return originalFinalize(input);
    };
    const subject = backend(fx);
    const commitPlan = plan(fx);
    const candidate = await prepared(subject, commitPlan);

    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    let outerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      outerEntered = resolve;
    });
    const outer = withCanonicalPathLocks([fx.file], async () => {
      outerEntered();
      await blocker;
    });
    await entered;
    const committing = subject.commitPrepared({
      plan: commitPlan,
      prepared: candidate,
      revisionGroupId: "group-desktop-update",
      buildCommittedEventBatch: eventBuilder(
        commitPlan,
        "group-desktop-update",
      ),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    release();
    await outer;
    const committed = await committing;
    expect(committed).toMatchObject({
      kind: "committed",
      receipt: {
        revisionGroupId: "group-desktop-update",
        entries: [{
          revisionIds: ["revision-1"],
          undoRecordIds: ["undo-1"],
        }],
      },
    });
    expect(order).toEqual(["begin", "write", "finalize"]);
    if (committed.kind !== "committed") throw new Error("expected commit");
    expect(committed.enlistedEventBatch.events).toEqual([
      expect.objectContaining({
        type: "document.mutation.committed",
        operationId: commitPlan.operationId,
        revisionGroupId: "group-desktop-update",
        sequence: 0,
        mutation: "update",
      }),
    ]);
  });

  test("committed retry is prepared from journal truth and performs zero begin/write", async () => {
    let writes = 0;
    const fx = await fixture((base) => ({
      ...base,
      writeFileAtomicConditional: async (file, expected, bytes) => {
        writes += 1;
        return base.writeFileAtomicConditional!(file, expected, bytes);
      },
    }));
    let begins = 0;
    const originalBegin = fx.journal.begin.bind(fx.journal);
    fx.journal.begin = async (input) => {
      begins += 1;
      return originalBegin(input);
    };
    const subject = backend(fx);
    const commitPlan = plan(fx);
    const revisionGroupId = "group-replay";
    const first = await subject.commitPrepared({
      plan: commitPlan,
      prepared: await prepared(subject, commitPlan),
      revisionGroupId,
      buildCommittedEventBatch: eventBuilder(commitPlan, revisionGroupId),
    });
    expect(first.kind).toBe("committed");
    expect({ begins, writes }).toEqual({ begins: 1, writes: 1 });

    await fs.writeFile(fx.file, "later legitimate human edit\n");
    const replayOutcome = await subject.prepare(commitPlan);
    expect(replayOutcome).toMatchObject({
      kind: "prepared",
      revisionGroupIdHint: revisionGroupId,
    });
    if (replayOutcome.kind !== "prepared") {
      throw new Error("expected replay preparation");
    }
    const replayPrepared = replayOutcome.prepared;
    expect(replayPrepared.kind).toBe("replay");
    const replay = await subject.commitPrepared({
      plan: commitPlan,
      prepared: replayPrepared,
      revisionGroupId,
      buildCommittedEventBatch: eventBuilder(commitPlan, revisionGroupId),
    });
    expect(replay).toEqual(first);
    expect({ begins, writes }).toEqual({ begins: 1, writes: 1 });
    expect(await fs.readFile(fx.file, "utf8")).toBe(
      "later legitimate human edit\n",
    );
  });

  test("commit-time drift is a pre-write conflict with no journal intent", async () => {
    let writes = 0;
    const fx = await fixture((base) => ({
      ...base,
      writeFileAtomicConditional: async (file, expected, bytes) => {
        writes += 1;
        return base.writeFileAtomicConditional!(file, expected, bytes);
      },
    }));
    const subject = backend(fx);
    const commitPlan = plan(fx);
    const candidate = await prepared(subject, commitPlan);
    await fs.writeFile(fx.file, "human save\n");
    const result = await subject.commitPrepared({
      plan: commitPlan,
      prepared: candidate,
      revisionGroupId: "group-stale",
      buildCommittedEventBatch: eventBuilder(commitPlan, "group-stale"),
    });
    expect(result).toMatchObject({ kind: "conflict", code: "stale_version" });
    expect(writes).toBe(0);
    expect(await fx.journal.lookupOperation(commitPlan.operationId)).toBeNull();
  });

  test("read-only preconditions reject stale source bytes at prepare and immediately before publish without a source receipt or event", async () => {
    let writes = 0;
    const fx = await fixture((base) => ({
      ...base,
      writeFileAtomicConditional: async (file, expected, bytes) => {
        writes += 1;
        return base.writeFileAtomicConditional!(file, expected, bytes);
      },
    }));
    const sourcePath = await fx.adapter.canonicalize(path.join(fx.workspace, "source.docx"));
    const sourceBytes = Buffer.from("source bytes\n");
    await fs.writeFile(sourcePath, sourceBytes);
    const sourceIdentity = {
      kind: "local_file" as const,
      relayId: RELAY,
      canonicalPath: sourcePath,
    };
    const sourceSnapshot = {
      identity: sourceIdentity,
      expectedVersion: {
        identity: sourceIdentity,
        backendVersion: { kind: "local_sha" as const, sha256: sha256Hex(sourceBytes) },
        sha256: sha256Hex(sourceBytes),
      },
      bytes: sourceBytes,
    };
    const commitPlan: BackendCommitPlan<"desktop"> = {
      ...plan(fx, { operationId: "operation-read-only-precondition" }),
      preconditions: [sourceSnapshot],
    };
    await fs.writeFile(sourcePath, "foreign source\n");
    const staleAtPrepare = await backend(fx).prepare(commitPlan);
    expect(staleAtPrepare).toMatchObject({
      kind: "failed",
      diagnostics: [{ code: "stale_precondition" }],
    });
    await fs.writeFile(sourcePath, sourceBytes);

    const subject = backend(fx);
    const candidate = await prepared(subject, commitPlan);
    const begin = fx.journal.begin.bind(fx.journal);
    fx.journal.begin = async (input) => {
      await begin(input);
      await fs.writeFile(sourcePath, "human changed source\n");
    };
    const outcome = await subject.commitPrepared({
      plan: commitPlan,
      prepared: candidate,
      revisionGroupId: "group-read-only-precondition",
      buildCommittedEventBatch: eventBuilder(commitPlan, "group-read-only-precondition"),
    });
    expect(outcome).toMatchObject({
      kind: "failed",
      code: "backend_failure",
      requiresCompensation: false,
    });
    expect(writes).toBe(0);
    expect(await fs.readFile(fx.file)).toEqual(Buffer.from(fx.before));
    expect(await fs.readFile(sourcePath, "utf8")).toBe("human changed source\n");
    expect(await fx.journal.lookupOperation(commitPlan.operationId)).toMatchObject({
      intent: { state: "aborted", paths: [{ kind: "update" }] },
      outbox: { state: "cancelled" },
    });
  });

  test("write failure restores exact preimage and aborts, while foreign bytes remain recovery evidence", async () => {
    const beginFx = await fixture();
    const durableBegin = beginFx.journal.begin.bind(beginFx.journal);
    beginFx.journal.begin = async (input) => {
      await durableBegin(input);
      throw new Error("injected return-path failure after durable begin");
    };
    const beginSubject = backend(beginFx);
    const beginPlan = plan(beginFx, { operationId: "operation-begin-unknown" });
    const beginUnknown = await beginSubject.commitPrepared({
      plan: beginPlan,
      prepared: await prepared(beginSubject, beginPlan),
      revisionGroupId: "group-begin-unknown",
      buildCommittedEventBatch: eventBuilder(
        beginPlan,
        "group-begin-unknown",
      ),
    });
    expect(beginUnknown).toMatchObject({
      kind: "failed",
      code: "backend_failure",
      requiresCompensation: false,
    });
    expect(await fs.readFile(beginFx.file)).toEqual(Buffer.from(beginFx.before));
    expect(
      (await beginFx.journal.lookupOperation("operation-begin-unknown"))?.intent
        .state,
    ).toBe("aborted");

    const unavailableFx = await fixture();
    const unavailableBegin = unavailableFx.journal.begin.bind(
      unavailableFx.journal,
    );
    unavailableFx.journal.begin = async (input) => {
      await unavailableBegin(input);
      throw new Error("injected failure after durable manifest replacement");
    };
    const unavailableLookup = unavailableFx.journal.lookupOperation.bind(
      unavailableFx.journal,
    );
    let unavailableLookupCalls = 0;
    unavailableFx.journal.lookupOperation = async (operationId) => {
      unavailableLookupCalls += 1;
      if (unavailableLookupCalls >= 3) {
        throw new Error("injected post-begin lookup outage");
      }
      return unavailableLookup(operationId);
    };
    const unavailableSubject = backend(unavailableFx);
    const unavailablePlan = plan(unavailableFx, {
      operationId: "operation-begin-lookup-unavailable",
    });
    const unavailable = await unavailableSubject.commitPrepared({
      plan: unavailablePlan,
      prepared: await prepared(unavailableSubject, unavailablePlan),
      revisionGroupId: "group-begin-lookup-unavailable",
      buildCommittedEventBatch: eventBuilder(
        unavailablePlan,
        "group-begin-lookup-unavailable",
      ),
    });
    expect(unavailable).toMatchObject({
      kind: "failed",
      code: "inconsistent_outcome",
      requiresCompensation: true,
      diagnostics: [{ code: "journal_begin_lookup_unavailable" }],
    });
    expect(
      (await unavailableLookup("operation-begin-lookup-unavailable"))?.intent
        .state,
    ).toBe("pending");

    const lookupFx = await fixture((base) => ({
      ...base,
      writeFileAtomicConditional: async () => {
        throw new Error("injected write failure");
      },
    }));
    const durableLookup = lookupFx.journal.lookupOperation.bind(
      lookupFx.journal,
    );
    let lookupCalls = 0;
    lookupFx.journal.lookupOperation = async (operationId) => {
      lookupCalls += 1;
      if (lookupCalls >= 3) throw new Error("injected recovery lookup failure");
      return durableLookup(operationId);
    };
    const lookupSubject = backend(lookupFx);
    const lookupPlan = plan(lookupFx, {
      operationId: "operation-recovery-lookup-throws",
    });
    const lookupFailure = await lookupSubject.commitPrepared({
      plan: lookupPlan,
      prepared: await prepared(lookupSubject, lookupPlan),
      revisionGroupId: "group-recovery-lookup-throws",
      buildCommittedEventBatch: eventBuilder(
        lookupPlan,
        "group-recovery-lookup-throws",
      ),
    });
    expect(lookupFailure).toMatchObject({
      kind: "failed",
      code: "inconsistent_outcome",
      requiresCompensation: true,
    });
    expect(await fs.readFile(lookupFx.file)).toEqual(Buffer.from(lookupFx.before));

    const rollbackFx = await fixture((base) => ({
      ...base,
      writeFileAtomicConditional: async () => {
        throw new Error("injected pre-write failure");
      },
    }));
    const rollbackSubject = backend(rollbackFx);
    const rollbackPlan = plan(rollbackFx, { operationId: "operation-rollback" });
    const rolledBack = await rollbackSubject.commitPrepared({
      plan: rollbackPlan,
      prepared: await prepared(rollbackSubject, rollbackPlan),
      revisionGroupId: "group-rollback",
      buildCommittedEventBatch: eventBuilder(rollbackPlan, "group-rollback"),
    });
    expect(rolledBack).toMatchObject({
      kind: "failed",
      code: "backend_failure",
      requiresCompensation: false,
    });
    expect(await fs.readFile(rollbackFx.file)).toEqual(
      Buffer.from(rollbackFx.before),
    );
    expect(
      (await rollbackFx.journal.lookupOperation("operation-rollback"))?.intent
        .state,
    ).toBe("aborted");
    expect(await rollbackSubject.prepare(rollbackPlan)).toMatchObject({
      kind: "failed",
      diagnostics: [{ code: "operation_aborted_cancelled" }],
    });

    const ambiguityFx = await fixture((base) => ({
      ...base,
      writeFileAtomicConditional: async (file) => {
        await base.writeFile(file, Buffer.from("foreign concurrent bytes\n"));
        throw new Error("injected ambiguous write");
      },
    }));
    const ambiguitySubject = backend(ambiguityFx);
    const ambiguityPlan = plan(ambiguityFx, {
      operationId: "operation-ambiguous",
    });
    const ambiguous = await ambiguitySubject.commitPrepared({
      plan: ambiguityPlan,
      prepared: await prepared(ambiguitySubject, ambiguityPlan),
      revisionGroupId: "group-ambiguous",
      buildCommittedEventBatch: eventBuilder(
        ambiguityPlan,
        "group-ambiguous",
      ),
    });
    expect(ambiguous).toMatchObject({
      kind: "failed",
      code: "inconsistent_outcome",
      requiresCompensation: true,
    });
    expect(await fs.readFile(ambiguityFx.file, "utf8")).toBe(
      "foreign concurrent bytes\n",
    );
    expect(await ambiguitySubject.prepare(ambiguityPlan)).toMatchObject({
      kind: "failed",
      diagnostics: [{ code: "operation_pending_held" }],
    });
    expect(await ambiguityFx.journal.recover()).toEqual([{
      operationId: "operation-ambiguous",
      state: "recovery_required",
    }]);
    expect(await ambiguitySubject.prepare(ambiguityPlan)).toMatchObject({
      kind: "failed",
      diagnostics: [{ code: "operation_recovery_required_held" }],
    });
    const evidence = await ambiguityFx.journal.lookupOperation(
      "operation-ambiguous",
    );
    expect(evidence?.intent).toMatchObject({
      state: "recovery_required",
      recoveryEvidence: {
        actual: [{
          canonicalPath: ambiguityFx.file,
          state: { sha256: sha256Hex(Buffer.from("foreign concurrent bytes\n")) },
        }],
      },
    });
    expect(evidence?.outbox.state).toBe("held");
  });

  test("revalidates the trusted actor immediately before durable begin", async () => {
    const fx = await fixture();
    let assertions = 0;
    const subject = backend(fx, {
      assertTrustedActor: () => {
        assertions += 1;
        if (assertions === 2) {
          throw new Error("human session changed after prepare");
        }
      },
    });
    const commitPlan = plan(fx, { operationId: "operation-actor-drift" });
    const outcome = await subject.commitPrepared({
      plan: commitPlan,
      prepared: await prepared(subject, commitPlan),
      revisionGroupId: "group-actor-drift",
      buildCommittedEventBatch: eventBuilder(commitPlan, "group-actor-drift"),
    });
    expect(assertions).toBe(2);
    expect(outcome).toMatchObject({
      kind: "failed",
      code: "backend_failure",
      requiresCompensation: false,
    });
    expect(await fx.journal.lookupOperation("operation-actor-drift")).toBeNull();
    expect(await fs.readFile(fx.file, "utf8")).toBe("before\n");
  });

  test("generation loss after durable begin is compensated before atomic replacement", async () => {
    const fx = await fixture();
    let assertions = 0;
    const subject = backend(fx, {
      assertTrustedActor: () => {
        assertions += 1;
        if (assertions === 4) {
          throw new Error("runtime generation changed before replacement");
        }
      },
    });
    const commitPlan = plan(fx, { operationId: "operation-generation-before-write" });
    const outcome = await subject.commitPrepared({
      plan: commitPlan,
      prepared: await prepared(subject, commitPlan),
      revisionGroupId: "group-generation-before-write",
      buildCommittedEventBatch: eventBuilder(commitPlan, "group-generation-before-write"),
    });
    expect(outcome).toMatchObject({
      kind: "failed",
      code: "backend_failure",
      requiresCompensation: false,
    });
    expect(assertions).toBe(4);
    expect(await fs.readFile(fx.file, "utf8")).toBe("before\n");
    expect(await fx.journal.lookupOperation("operation-generation-before-write"))
      .toMatchObject({ intent: { state: "aborted" }, outbox: { state: "cancelled" } });
  });

  test("authority expiry during postimage proof compensates without a committed receipt or event", async () => {
    let authorityExpired = false;
    const fx = await fixture((base) => ({
      ...base,
      readFile: async (canonicalPath) => {
        const bytes = await base.readFile(canonicalPath);
        if (Buffer.from(bytes).equals(Buffer.from("after\n"))) {
          authorityExpired = true;
        }
        return bytes;
      },
    }));
    let finalizes = 0;
    const originalFinalize = fx.journal.finalize.bind(fx.journal);
    fx.journal.finalize = async (input) => {
      finalizes += 1;
      return originalFinalize(input);
    };
    const subject = backend(fx, {
      assertTrustedActor: () => {
        if (authorityExpired) {
          throw new Error("authority expired during postimage proof");
        }
      },
    });
    const commitPlan = plan(fx, {
      operationId: "operation-authority-expired-after-proof",
    });
    const outcome = await subject.commitPrepared({
      plan: commitPlan,
      prepared: await prepared(subject, commitPlan),
      revisionGroupId: "group-authority-expired-after-proof",
      buildCommittedEventBatch: eventBuilder(
        commitPlan,
        "group-authority-expired-after-proof",
      ),
    });

    expect(authorityExpired).toBe(true);
    expect(outcome).toMatchObject({
      kind: "failed",
      code: "backend_failure",
      requiresCompensation: false,
      diagnostics: [{
        code: "commit_rolled_back",
        message: "authority expired during postimage proof",
      }],
    });
    expect(finalizes).toBe(0);
    expect(await fs.readFile(fx.file, "utf8")).toBe("before\n");
    expect(
      await fx.journal.lookupOperation(
        "operation-authority-expired-after-proof",
      ),
    ).toMatchObject({
      intent: { state: "aborted" },
      outbox: { state: "cancelled" },
    });
  });

  test("commits create, update, overwrite move, and delete as one exact durable plan", async () => {
    const fx = await fixture();
    const createPath = await fx.adapter.canonicalize(
      path.join(fx.workspace, "created.md"),
    );
    const moveSource = path.join(fx.workspace, "move-source.md");
    const moveDestination = path.join(fx.workspace, "move-destination.md");
    const deletePath = path.join(fx.workspace, "delete.md");
    const moveSourceBytes = Buffer.from("move source\n");
    const moveDestinationBytes = Buffer.from("replaced destination\n");
    const movedBytes = Buffer.from("moved exact postimage\n");
    const deleteBytes = Buffer.from("delete me\n");
    await fs.writeFile(moveSource, moveSourceBytes);
    await fs.writeFile(moveDestination, moveDestinationBytes);
    await fs.writeFile(deletePath, deleteBytes);
    const canonicalSource = await fx.adapter.canonicalize(moveSource);
    const canonicalDestination = await fx.adapter.canonicalize(moveDestination);
    const canonicalDelete = await fx.adapter.canonicalize(deletePath);
    const identity = (canonicalPath: string) => ({
      kind: "local_file" as const,
      relayId: RELAY,
      canonicalPath,
    });
    const expected = (canonicalPath: string, bytes: Uint8Array) => {
      const localIdentity = identity(canonicalPath);
      const sha256 = sha256Hex(bytes);
      return {
        identity: localIdentity,
        expectedVersion: {
          identity: localIdentity,
          backendVersion: { kind: "local_sha" as const, sha256 },
          sha256,
        },
        bytes,
      };
    };
    const createBytes = Buffer.from("created\n");
    const commitPlan: BackendCommitPlan<"desktop"> = {
      operationId: "operation-structural-batch",
      actor: ACTOR,
      entries: [
        {
          kind: "create",
          after: {
            identity: identity(createPath),
            sha256: sha256Hex(createBytes),
            bytes: createBytes,
          },
        },
        {
          kind: "update",
          before: expected(fx.file, fx.before),
          after: {
            identity: identity(fx.file),
            sha256: sha256Hex(fx.after),
            bytes: fx.after,
          },
        },
        {
          kind: "move",
          source: expected(canonicalSource, moveSourceBytes),
          destinationBefore: expected(
            canonicalDestination,
            moveDestinationBytes,
          ),
          after: {
            identity: identity(canonicalDestination),
            sha256: sha256Hex(movedBytes),
            bytes: movedBytes,
          },
        },
        {
          kind: "delete",
          before: expected(canonicalDelete, deleteBytes),
        },
      ],
    };
    const ids = [
      "revision-create", "undo-create",
      "revision-update", "undo-update",
      "revision-move", "undo-move",
      "revision-delete", "undo-delete",
    ];
    const subject = backend(fx, { ids });
    const revisionGroupId = "group-structural-batch";
    const result = await subject.commitPrepared({
      plan: commitPlan,
      prepared: await prepared(subject, commitPlan),
      revisionGroupId,
      buildCommittedEventBatch: eventBuilder(commitPlan, revisionGroupId),
    });

    expect(result).toMatchObject({
      kind: "committed",
      receipt: {
        revisionGroupId,
        entries: [
          { entryIndex: 0, kind: "create", revisionIds: ["revision-create"] },
          { entryIndex: 1, kind: "update", revisionIds: ["revision-update"] },
          { entryIndex: 2, kind: "move", revisionIds: ["revision-move"] },
          { entryIndex: 3, kind: "delete", revisionIds: ["revision-delete"] },
        ],
      },
    });
    expect(await fs.readFile(createPath)).toEqual(createBytes);
    expect(await fs.readFile(fx.file)).toEqual(Buffer.from(fx.after));
    expect(await fs.stat(canonicalSource).catch(() => null)).toBeNull();
    expect(await fs.readFile(canonicalDestination)).toEqual(movedBytes);
    expect(await fs.stat(canonicalDelete).catch(() => null)).toBeNull();
    const durable = await fx.journal.lookupOperation(commitPlan.operationId);
    expect(durable?.intent).toMatchObject({
      state: "committed",
      paths: [
        { kind: "create", canonicalPath: createPath },
        { kind: "update", canonicalPath: fx.file },
        {
          kind: "move",
          canonicalPath: canonicalDestination,
          sourceCanonicalPath: canonicalSource,
        },
        { kind: "delete", canonicalPath: canonicalDelete },
      ],
    });
    if (result.kind !== "committed") throw new Error("expected commit");
    expect(result.enlistedEventBatch.events.map((event) => event.mutation))
      .toEqual(["create", "update", "move", "delete"]);

    const replayPreparation = await subject.prepare(commitPlan);
    expect(replayPreparation).toMatchObject({
      kind: "prepared",
      revisionGroupIdHint: revisionGroupId,
      prepared: { kind: "replay" },
    });
    if (replayPreparation.kind !== "prepared") {
      throw new Error("expected structural replay preparation");
    }
    const replay = await subject.commitPrepared({
      plan: commitPlan,
      prepared: replayPreparation.prepared,
      revisionGroupId,
      buildCommittedEventBatch: eventBuilder(commitPlan, revisionGroupId),
    });
    expect(replay).toEqual(result);
  });

  test("a partial multi-file write failure restores every exact preimage and aborts", async () => {
    let writes = 0;
    const fx = await fixture((base) => ({
      ...base,
      writeFileAtomicConditional: async (file, expected, bytes) => {
        writes += 1;
        if (writes === 2) throw new Error("injected second-write failure");
        return base.writeFileAtomicConditional!(file, expected, bytes);
      },
    }));
    const created = await fx.adapter.canonicalize(
      path.join(fx.workspace, "partial-created.md"),
    );
    const createdBytes = Buffer.from("partial create\n");
    const createdIdentity = {
      kind: "local_file" as const,
      relayId: RELAY,
      canonicalPath: created,
    };
    const updateIdentity = {
      kind: "local_file" as const,
      relayId: RELAY,
      canonicalPath: fx.file,
    };
    const beforeSha = sha256Hex(fx.before);
    const commitPlan: BackendCommitPlan<"desktop"> = {
      operationId: "operation-partial-multi",
      actor: ACTOR,
      entries: [
        {
          kind: "create",
          after: {
            identity: createdIdentity,
            sha256: sha256Hex(createdBytes),
            bytes: createdBytes,
          },
        },
        {
          kind: "update",
          before: {
            identity: updateIdentity,
            expectedVersion: {
              identity: updateIdentity,
              backendVersion: { kind: "local_sha", sha256: beforeSha },
              sha256: beforeSha,
            },
            bytes: fx.before,
          },
          after: {
            identity: updateIdentity,
            sha256: sha256Hex(fx.after),
            bytes: fx.after,
          },
        },
      ],
    };
    const subject = backend(fx, {
      ids: ["revision-create", "undo-create", "revision-update", "undo-update"],
    });
    const outcome = await subject.commitPrepared({
      plan: commitPlan,
      prepared: await prepared(subject, commitPlan),
      revisionGroupId: "group-partial-multi",
      buildCommittedEventBatch: eventBuilder(commitPlan, "group-partial-multi"),
    });
    expect(outcome).toMatchObject({
      kind: "failed",
      code: "backend_failure",
      requiresCompensation: false,
    });
    expect(await fs.stat(created).catch(() => null)).toBeNull();
    expect(await fs.readFile(fx.file)).toEqual(Buffer.from(fx.before));
    expect(await fx.journal.lookupOperation(commitPlan.operationId)).toMatchObject({
      intent: { state: "aborted" },
      outbox: { state: "cancelled" },
    });
  });

  test("publish-time update conflict preserves the human write and never finalizes", async () => {
    const humanBytes = Buffer.from("human update won\n");
    let injected = false;
    const fx = await fixture((base) => ({
      ...base,
      writeFileAtomicConditional: async (file, expected, bytes) => {
        if (!injected) {
          injected = true;
          await fs.writeFile(file, humanBytes);
        }
        return base.writeFileAtomicConditional!(file, expected, bytes);
      },
    }));
    let finalizes = 0;
    const finalize = fx.journal.finalize.bind(fx.journal);
    fx.journal.finalize = async (input) => {
      finalizes += 1;
      return finalize(input);
    };
    const subject = backend(fx);
    const commitPlan = plan(fx, { operationId: "operation-publish-update-race" });
    const outcome = await subject.commitPrepared({
      plan: commitPlan,
      prepared: await prepared(subject, commitPlan),
      revisionGroupId: "group-publish-update-race",
      buildCommittedEventBatch: eventBuilder(commitPlan, "group-publish-update-race"),
    });

    expect(outcome).toMatchObject({
      kind: "conflict",
      code: "stale_version",
    });
    expect(await fs.readFile(fx.file)).toEqual(humanBytes);
    expect(finalizes).toBe(0);
    expect(await fx.journal.lookupOperation(commitPlan.operationId)).toMatchObject({
      intent: { state: "aborted" },
      outbox: { state: "cancelled" },
    });
  });

  test("publish-time create uses no-replace and preserves a human-created file", async () => {
    const humanBytes = Buffer.from("human created first\n");
    let target = "";
    const fx = await fixture((base) => ({
      ...base,
      writeFileAtomicConditional: async (file, expected, bytes) => {
        if (file === target) await fs.writeFile(file, humanBytes);
        return base.writeFileAtomicConditional!(file, expected, bytes);
      },
    }));
    target = await fx.adapter.canonicalize(path.join(fx.workspace, "created-race.md"));
    const agentBytes = Buffer.from("agent create\n");
    const identity = { kind: "local_file" as const, relayId: RELAY, canonicalPath: target };
    const commitPlan: BackendCommitPlan<"desktop"> = {
      operationId: "operation-publish-create-race",
      actor: ACTOR,
      entries: [{
        kind: "create",
        after: { identity, sha256: sha256Hex(agentBytes), bytes: agentBytes },
      }],
    };
    let finalizes = 0;
    const originalFinalize = fx.journal.finalize.bind(fx.journal);
    fx.journal.finalize = async (input) => {
      finalizes += 1;
      return originalFinalize(input);
    };
    const subject = backend(fx);
    const outcome = await subject.commitPrepared({
      plan: commitPlan,
      prepared: await prepared(subject, commitPlan),
      revisionGroupId: "group-publish-create-race",
      buildCommittedEventBatch: eventBuilder(commitPlan, "group-publish-create-race"),
    });

    expect(outcome).toMatchObject({
      kind: "conflict",
      code: "stale_version",
    });
    expect(await fs.readFile(target)).toEqual(humanBytes);
    expect(finalizes).toBe(0);
  });

  test("publish-time delete conflict preserves replacement human bytes", async () => {
    const humanBytes = Buffer.from("human replacement before delete\n");
    let injected = false;
    const fx = await fixture((base) => ({
      ...base,
      removeConditional: async (file, expected) => {
        if (!injected) {
          injected = true;
          await fs.writeFile(file, humanBytes);
        }
        return base.removeConditional!(file, expected);
      },
    }));
    const identity = { kind: "local_file" as const, relayId: RELAY, canonicalPath: fx.file };
    const beforeSha = sha256Hex(fx.before);
    const commitPlan: BackendCommitPlan<"desktop"> = {
      operationId: "operation-publish-delete-race",
      actor: ACTOR,
      entries: [{
        kind: "delete",
        before: {
          identity,
          expectedVersion: {
            identity,
            backendVersion: { kind: "local_sha", sha256: beforeSha },
            sha256: beforeSha,
          },
          bytes: fx.before,
        },
      }],
    };
    const subject = backend(fx);
    const outcome = await subject.commitPrepared({
      plan: commitPlan,
      prepared: await prepared(subject, commitPlan),
      revisionGroupId: "group-publish-delete-race",
      buildCommittedEventBatch: eventBuilder(commitPlan, "group-publish-delete-race"),
    });

    expect(outcome).toMatchObject({
      kind: "conflict",
      code: "stale_version",
    });
    expect(await fs.readFile(fx.file)).toEqual(humanBytes);
    expect((await fx.journal.lookupOperation(commitPlan.operationId))?.intent.state)
      .toBe("aborted");
  });

  test("overwrite-move rechecks the destination at publish and leaves source plus human destination intact", async () => {
    const fx = await fixture();
    const destination = path.join(fx.workspace, "overwrite-race.md");
    const destinationBefore = Buffer.from("destination before\n");
    const humanBytes = Buffer.from("human destination won\n");
    const movedBytes = Buffer.from("agent moved postimage\n");
    await fs.writeFile(destination, destinationBefore);
    const canonicalDestination = await fx.adapter.canonicalize(destination);
    let injected = false;
    fx.adapter.writeFileAtomicConditional = async (file, expected, bytes) => {
      if (!injected && file === canonicalDestination) {
        injected = true;
        await fs.writeFile(file, humanBytes);
      }
      return createGuardedNodeAdapter({ allowedRoots: [fx.workspace] })
        .writeFileAtomicConditional!(file, expected, bytes);
    };
    const identity = (canonicalPath: string) => ({
      kind: "local_file" as const,
      relayId: RELAY,
      canonicalPath,
    });
    const expected = (canonicalPath: string, bytes: Uint8Array) => {
      const localIdentity = identity(canonicalPath);
      const sha256 = sha256Hex(bytes);
      return {
        identity: localIdentity,
        expectedVersion: {
          identity: localIdentity,
          backendVersion: { kind: "local_sha" as const, sha256 },
          sha256,
        },
        bytes,
      };
    };
    const commitPlan: BackendCommitPlan<"desktop"> = {
      operationId: "operation-publish-overwrite-move-race",
      actor: ACTOR,
      entries: [{
        kind: "move",
        source: expected(fx.file, fx.before),
        destinationBefore: expected(canonicalDestination, destinationBefore),
        after: {
          identity: identity(canonicalDestination),
          sha256: sha256Hex(movedBytes),
          bytes: movedBytes,
        },
      }],
    };
    const subject = backend(fx);
    const outcome = await subject.commitPrepared({
      plan: commitPlan,
      prepared: await prepared(subject, commitPlan),
      revisionGroupId: "group-publish-overwrite-move-race",
      buildCommittedEventBatch: eventBuilder(
        commitPlan,
        "group-publish-overwrite-move-race",
      ),
    });

    expect(outcome).toMatchObject({
      kind: "conflict",
      code: "stale_version",
    });
    expect(await fs.readFile(fx.file)).toEqual(Buffer.from(fx.before));
    expect(await fs.readFile(canonicalDestination)).toEqual(humanBytes);
    expect((await fx.journal.lookupOperation(commitPlan.operationId))?.intent.state)
      .toBe("aborted");
  });

  test("move source race after destination publish enters recovery and preserves human source bytes", async () => {
    const humanSource = Buffer.from("human source won\n");
    let source = "";
    const fx = await fixture((base) => ({
      ...base,
      removeConditional: async (file, expected) => {
        if (file === source) await fs.writeFile(file, humanSource);
        return base.removeConditional!(file, expected);
      },
    }));
    source = fx.file;
    const destination = await fx.adapter.canonicalize(path.join(fx.workspace, "move-race.md"));
    const movedBytes = Buffer.from("agent destination\n");
    const sourceIdentity = { kind: "local_file" as const, relayId: RELAY, canonicalPath: source };
    const destinationIdentity = {
      kind: "local_file" as const,
      relayId: RELAY,
      canonicalPath: destination,
    };
    const beforeSha = sha256Hex(fx.before);
    const commitPlan: BackendCommitPlan<"desktop"> = {
      operationId: "operation-publish-move-source-race",
      actor: ACTOR,
      entries: [{
        kind: "move",
        source: {
          identity: sourceIdentity,
          expectedVersion: {
            identity: sourceIdentity,
            backendVersion: { kind: "local_sha", sha256: beforeSha },
            sha256: beforeSha,
          },
          bytes: fx.before,
        },
        after: {
          identity: destinationIdentity,
          sha256: sha256Hex(movedBytes),
          bytes: movedBytes,
        },
      }],
    };
    const subject = backend(fx);
    const outcome = await subject.commitPrepared({
      plan: commitPlan,
      prepared: await prepared(subject, commitPlan),
      revisionGroupId: "group-publish-move-source-race",
      buildCommittedEventBatch: eventBuilder(commitPlan, "group-publish-move-source-race"),
    });

    expect(outcome).toMatchObject({
      kind: "failed",
      code: "inconsistent_outcome",
      requiresCompensation: true,
      diagnostics: [{ code: "recovery_required" }],
    });
    expect(await fs.readFile(source)).toEqual(humanSource);
    expect(await fs.readFile(destination)).toEqual(movedBytes);
    expect(await fx.journal.lookupOperation(commitPlan.operationId)).toMatchObject({
      intent: { state: "pending" },
      outbox: { state: "held" },
    });
  });
});
