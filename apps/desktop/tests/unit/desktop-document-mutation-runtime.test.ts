import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { DesktopDocumentMutationRuntime } from "../../electron/document-mutations/desktop-document-mutation-runtime.ts";
import {
  createGuardedNodeAdapter,
  type GuardedFileAdapter,
} from "../../electron/local-file-history/file-adapter.ts";
import {
  sha256Hex,
  snapshotFromBytes,
} from "../../electron/local-file-history/hash.ts";
import { LocalDurableMutationJournal } from "../../electron/local-file-history/durable-mutations.ts";
import { LocalFileHistoryJournal } from "../../electron/local-file-history/journal.ts";
import { createJournalStorage } from "../../electron/local-file-history/storage.ts";

const roots: string[] = [];
const RELAY = "relay-editor-save";
const HUMAN = "human-editor-save";
const agentMutation = {
  mutationRequestId: "d448:test-request:test-semantics",
  semanticDigest: "test-semantics",
} as const;
const flushOutbox = async () => await new Promise<void>((resolve) => setTimeout(resolve, 0));
async function waitFor(
  probe: () => boolean | Promise<boolean>,
  attempts = 100,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await probe()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition did not become true");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(input: { publisher?: "published" | "not_published" | "unknown" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-editor-save-"));
  const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-editor-save-journal-"));
  roots.push(root, journalRoot);
  const requestedPath = path.join(root, "draft.md");
  await fs.writeFile(requestedPath, "before\n");
  const adapter = createGuardedNodeAdapter({ allowedRoots: [root] });
  const canonicalPath = await adapter.canonicalize(requestedPath);
  const journal = new LocalDurableMutationJournal({ rootDir: journalRoot, relayId: RELAY, fileAdapter: adapter });
  const batches: unknown[] = [];
  const runtime = new DesktopDocumentMutationRuntime({
    getTrustedRelayId: () => RELAY,
    getTrustedHumanId: () => HUMAN,
    fileAdapter: adapter,
    journal,
    newOperationId: () => "editor-operation",
    newRevisionGroupId: () => "editor-group",
    publishToRenderer: async (batch) => {
      batches.push(batch);
      return input.publisher ?? "published";
    },
  });
  return { root, journalRoot, requestedPath, canonicalPath, adapter, journal, runtime, batches };
}

describe("DesktopDocumentMutationRuntime", () => {
  test("ordinary agent content commits produce one V2 receipt and one exact event batch", async () => {
    const fx = await fixture();
    const before = Buffer.from("before\n");
    const after = Buffer.from("after\n");
    const result = await fx.runtime.commitAgentContent({
      ...agentMutation,
      targetPath: fx.requestedPath,
      before,
      after,
      agentId: "agent-file-tool",
      turnId: "turn-file-tool",
      command: "write",
      reauthorize: async () => undefined,
    });
    expect(result).toMatchObject({
      ok: true,
      sha256: sha256Hex(after),
      byteLength: after.byteLength,
    });
    if (!result.ok) throw new Error(result.message);
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("after\n");
    const durable = await fx.journal.lookupOperation(result.operationId);
    expect(durable).toMatchObject({
      intent: {
        state: "committed",
        actor: { kind: "agent", agentId: "agent-file-tool" },
        paths: [{ kind: "update", revisionIds: [result.revisionId] }],
      },
    });
    await waitFor(() => fx.batches.length === 1);
    expect(fx.batches).toHaveLength(1);
    expect(fx.batches[0]).toMatchObject({
      operationId: result.operationId,
      events: [{
        type: "document.mutation.committed",
        mutation: "update",
        actor: { kind: "agent", agentId: "agent-file-tool" },
        before: { sha256: sha256Hex(before) },
        after: { sha256: sha256Hex(after) },
      }],
    });
  });

  for (const command of ["write", "insert", "str_replace", "document_write_commit"] as const) {
    test(`${command} lost-response retry returns one durable receipt/event and exact bytes`, async () => {
      const fx = await fixture();
      const before = Buffer.from("before\n");
      const after = Buffer.from(`${command} after\n`);
      const identity = {
        mutationRequestId: `d448:${command}:lost-response`,
        semanticDigest: `${command}-semantics`,
      } as const;
      const first = await fx.runtime.commitAgentContent({
        ...identity,
        targetPath: fx.requestedPath,
        before,
        after,
        agentId: "agent-file-tool",
        turnId: `turn-${command}`,
        command,
        reauthorize: async () => undefined,
      });
      const retry = await fx.runtime.commitAgentContent({
        ...identity,
        targetPath: fx.requestedPath,
        authorizedRoots: [fx.root],
        // A non-idempotent handler would now derive a different candidate.
        before: after,
        after: Buffer.from(`incorrect duplicate ${command}\n`),
        agentId: "agent-file-tool",
        turnId: `turn-${command}`,
        command,
        replayOnly: true,
        reauthorize: async () => undefined,
      });
      expect(first).toMatchObject({ ok: true, replayed: false });
      expect(retry).toMatchObject({
        ok: true,
        replayed: true,
        operationId: first.ok ? first.operationId : undefined,
        revisionId: first.ok ? first.revisionId : undefined,
      });
      expect(await fs.readFile(fx.requestedPath)).toEqual(after);
      await waitFor(() => fx.batches.length === 1);
      expect(fx.batches).toHaveLength(1);
    });
  }

  test("a retry identity cannot be rebound to altered command semantics", async () => {
    const fx = await fixture();
    const before = Buffer.from("before\n");
    const after = Buffer.from("after\n");
    const first = await fx.runtime.commitAgentContent({
      mutationRequestId: "d448:stable-request:original-semantics",
      semanticDigest: "original-semantics",
      targetPath: fx.requestedPath,
      before,
      after,
      agentId: "agent-file-tool",
      turnId: "turn-altered-retry",
      command: "str_replace",
      reauthorize: async () => undefined,
    });
    expect(first).toMatchObject({ ok: true });
    const altered = await fx.runtime.commitAgentContent({
      mutationRequestId: "d448:stable-request:original-semantics",
      semanticDigest: "altered-semantics",
      targetPath: fx.requestedPath,
      authorizedRoots: [fx.root],
      before: after,
      after: Buffer.from("altered\n"),
      agentId: "agent-file-tool",
      turnId: "turn-altered-retry",
      command: "str_replace",
      replayOnly: true,
      reauthorize: async () => undefined,
    });
    expect(altered).toMatchObject({
      ok: false,
      code: "error",
      message:
        "stable file-tool mutation request identity is already bound to different command semantics",
    });
    expect(await fs.readFile(fx.requestedPath)).toEqual(after);
  });

  test("durable retry succeeds without live I/O after deletion or symlink replacement", async () => {
    const fx = await fixture();
    const before = Buffer.from("before\n");
    const after = Buffer.from("committed\n");
    const identity = {
      mutationRequestId: "d448:pre-io-retry:semantics",
      semanticDigest: "pre-io-retry-semantics",
    } as const;
    const first = await fx.runtime.commitAgentContent({
      ...identity,
      targetPath: fx.requestedPath,
      before,
      after,
      agentId: "agent-file-tool",
      turnId: "turn-pre-io-retry",
      command: "str_replace",
      reauthorize: async () => undefined,
    });
    expect(first).toMatchObject({ ok: true, replayed: false });

    const retry = () =>
      fx.runtime.commitAgentContent({
        ...identity,
        targetPath: fx.requestedPath,
        authorizedRoots: [fx.root],
        before: null,
        after: new Uint8Array(),
        agentId: "agent-file-tool",
        turnId: "turn-pre-io-retry",
        command: "str_replace",
        replayOnly: true,
        reauthorize: async () => undefined,
      });

    await fs.unlink(fx.requestedPath);
    expect(await fx.runtime.commitAgentContent({
      ...identity,
      targetPath: fx.requestedPath,
      authorizedRoots: [fx.journalRoot],
      before: null,
      after: new Uint8Array(),
      agentId: "agent-file-tool",
      turnId: "turn-pre-io-retry",
      command: "str_replace",
      replayOnly: true,
      reauthorize: async () => undefined,
    })).toMatchObject({
      ok: false,
      code: "error",
      message:
        "durable local file-tool replay does not match its trusted request identity",
    });
    expect(await retry()).toMatchObject({
      ok: true,
      replayed: true,
      revisionId: first.ok ? first.revisionId : undefined,
      sha256: sha256Hex(after),
    });

    const symlinkTarget = path.join(fx.root, "unrelated.md");
    await fs.writeFile(symlinkTarget, "unrelated\n");
    await fs.symlink(symlinkTarget, fx.requestedPath);
    expect(await retry()).toMatchObject({
      ok: true,
      replayed: true,
      revisionId: first.ok ? first.revisionId : undefined,
      sha256: sha256Hex(after),
    });
    expect(await fs.readFile(symlinkTarget, "utf8")).toBe("unrelated\n");
    await waitFor(() => fx.batches.length === 1);
    expect(fx.batches).toHaveLength(1);
  });

  test("concurrent identical agent commits retain their exact dispatch authority", async () => {
    const fx = await fixture();
    const before = Buffer.from("before\n");
    const after = Buffer.from("after\n");
    let firstAuthorizations = 0;
    let secondAuthorizations = 0;

    const common = {
      ...agentMutation,
      targetPath: fx.requestedPath,
      authorizedRoots: [fx.root],
      before,
      after,
      agentId: "agent-file-tool",
      turnId: "turn-identical-concurrent",
      command: "write",
    } as const;
    const [first, second] = await Promise.all([
      fx.runtime.commitAgentContent({
        ...common,
        reauthorize: async () => {
          firstAuthorizations += 1;
          await Promise.resolve();
        },
      }),
      fx.runtime.commitAgentContent({
        ...common,
        reauthorize: async () => {
          secondAuthorizations += 1;
          await Promise.resolve();
        },
      }),
    ]);

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(firstAuthorizations).toBeGreaterThan(0);
    expect(secondAuthorizations).toBeGreaterThan(0);
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("after\n");
    await waitFor(() => fx.batches.length === 1);
    expect(fx.batches).toHaveLength(1);
  });

  test("ordinary agent content CAS conflict preserves the external winner and records no commit", async () => {
    const fx = await fixture();
    const before = Buffer.from("before\n");
    const external = Buffer.from("external\n");
    const result = await fx.runtime.commitAgentContent({
      ...agentMutation,
      targetPath: fx.requestedPath,
      before,
      after: Buffer.from("agent\n"),
      agentId: "agent-file-tool",
      turnId: "turn-file-tool-conflict",
      command: "write",
      reauthorize: async () => {
        await fs.writeFile(fx.requestedPath, external);
      },
    });
    expect(result).toEqual({
      ok: false,
      code: "reapply_required",
      message:
        "The local file changed while the file-tool mutation was being admitted. Reread the current file and construct a new edit; do not blindly retry.",
    });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("external\n");
    expect(fx.batches).toHaveLength(0);
  });

  test("file-tool lease admission allows clean/disjoint edits and rejects overlap with human priority", async () => {
    const clean = await fixture();
    const cleanLease = await clean.runtime.registerHumanEditLease({
      sessionId: "clean-session",
      target: { kind: "local_file", relayId: RELAY, candidatePath: clean.requestedPath },
      state: "clean",
    });
    expect(cleanLease.status).toBe("ok");
    expect(await clean.runtime.commitAgentContent({
      ...agentMutation,
      targetPath: clean.requestedPath,
      before: Buffer.from("before\n"),
      after: Buffer.from("clean agent\n"),
      agentId: "agent-file-tool",
      turnId: "turn-clean",
      command: "str_replace",
      reauthorize: async () => undefined,
    })).toMatchObject({ ok: true });

    const disjoint = await fixture();
    await fs.writeFile(disjoint.requestedPath, "top\nbottom\n");
    const dirtyLease = await disjoint.runtime.registerHumanEditLease({
      sessionId: "dirty-session",
      target: { kind: "local_file", relayId: RELAY, candidatePath: disjoint.requestedPath },
      state: "dirty",
      draftPatch: { kind: "anchored_text", oldString: "bottom", newString: "human bottom" },
    });
    expect(dirtyLease.status).toBe("ok");
    expect(await disjoint.runtime.commitAgentContent({
      ...agentMutation,
      targetPath: disjoint.requestedPath,
      before: Buffer.from("top\nbottom\n"),
      after: Buffer.from("agent top\nbottom\n"),
      agentId: "agent-file-tool",
      turnId: "turn-disjoint",
      command: "insert",
      reauthorize: async () => undefined,
    })).toMatchObject({ ok: true });

    const overlap = await fixture();
    await fs.writeFile(overlap.requestedPath, "title\nbody\n");
    const overlapLease = await overlap.runtime.registerHumanEditLease({
      sessionId: "overlap-session",
      target: { kind: "local_file", relayId: RELAY, candidatePath: overlap.requestedPath },
      state: "dirty",
      draftPatch: {
        kind: "anchored_text",
        oldString: "title\n",
        newString: "human-title\n",
      },
    });
    expect(overlapLease.status).toBe("ok");
    expect(await overlap.runtime.commitAgentContent({
      ...agentMutation,
      targetPath: overlap.requestedPath,
      before: Buffer.from("title\nbody\n"),
      after: Buffer.from("agent heading\nbody\n"),
      agentId: "agent-file-tool",
      turnId: "turn-overlap",
      command: "str_replace",
      reauthorize: async () => undefined,
    })).toMatchObject({ ok: false, code: "human_edit_conflict" });
    expect(await fs.readFile(overlap.requestedPath, "utf8")).toBe("title\nbody\n");

    const saving = await fixture();
    expect(await saving.runtime.registerHumanEditLease({
      sessionId: "saving-session",
      target: { kind: "local_file", relayId: RELAY, candidatePath: saving.requestedPath },
      state: "saving",
    })).toMatchObject({ status: "ok" });
    expect(await saving.runtime.commitAgentContent({
      ...agentMutation,
      targetPath: saving.requestedPath,
      before: Buffer.from("before\n"),
      after: Buffer.from("agent\n"),
      agentId: "agent-file-tool",
      turnId: "turn-saving",
      command: "write",
      reauthorize: async () => undefined,
    })).toMatchObject({ ok: false, code: "reapply_required" });
    expect(await fs.readFile(saving.requestedPath, "utf8")).toBe("before\n");
  });

  test("owns local human-edit lease truth under the same canonical identity lock domain", async () => {
    const fx = await fixture();
    const registered = await fx.runtime.registerHumanEditLease({
      sessionId: "desktop-editor-session",
      target: { kind: "local_file", relayId: RELAY, candidatePath: fx.requestedPath },
      state: "clean",
    });
    expect(registered).toMatchObject({
      status: "ok",
      record: {
        lease: {
          humanId: HUMAN,
          identity: { kind: "local_file", relayId: RELAY, canonicalPath: fx.canonicalPath },
          baseVersion: { sha256: sha256Hex(Buffer.from("before\n")) },
          generation: 0,
        },
      },
    });
    if (registered.status !== "ok") throw new Error("lease registration failed");

    await fs.writeFile(fx.requestedPath, "human changed\n");
    const updated = await fx.runtime.updateHumanEditLease(registered.record.lease.leaseId, {
      sessionId: "desktop-editor-session",
      target: { kind: "local_file", relayId: RELAY, candidatePath: fx.requestedPath },
      expectedGeneration: 0,
      state: "clean",
    });
    expect(updated).toMatchObject({
      status: "ok",
      record: {
        lease: {
          generation: 1,
          baseVersion: { sha256: sha256Hex(Buffer.from("human changed\n")) },
        },
      },
    });
    if (updated.status !== "ok") throw new Error("lease update failed");

    const renewed = await fx.runtime.renewHumanEditLease(registered.record.lease.leaseId, {
      sessionId: "desktop-editor-session",
      target: { kind: "local_file", relayId: RELAY, candidatePath: fx.requestedPath },
      expectedGeneration: 1,
    });
    expect(renewed).toMatchObject({ status: "ok", record: { lease: { generation: 1 } } });
    const released = await fx.runtime.releaseHumanEditLease(registered.record.lease.leaseId, {
      sessionId: "desktop-editor-session",
      expectedGeneration: 1,
    });
    expect(released).toMatchObject({ status: "ok" });
  });

  test("rejects renderer local lease correlation that does not resolve to the active guarded relay", async () => {
    const fx = await fixture();
    const wrongRelay = await fx.runtime.registerHumanEditLease({
      sessionId: "desktop-editor-session",
      target: { kind: "local_file", relayId: "other-relay", candidatePath: fx.requestedPath },
      state: "clean",
    });
    expect(wrongRelay).toMatchObject({ status: "invalid" });
    const outside = await fx.runtime.registerHumanEditLease({
      sessionId: "desktop-editor-session",
      target: { kind: "local_file", relayId: RELAY, candidatePath: "/outside/guarded-root.md" },
      state: "clean",
    });
    expect(outside).toMatchObject({ status: "invalid" });

    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-lease-outside-"));
    roots.push(outsideRoot);
    const outsideFile = path.join(outsideRoot, "outside.md");
    const symlink = path.join(fx.root, "escape.md");
    await fs.writeFile(outsideFile, "outside\n");
    await fs.symlink(outsideFile, symlink);
    const escapedSymlink = await fx.runtime.registerHumanEditLease({
      sessionId: "desktop-editor-session",
      target: { kind: "local_file", relayId: RELAY, candidatePath: symlink },
      state: "clean",
    });
    expect(escapedSymlink).toMatchObject({ status: "invalid" });

    const insideSymlink = path.join(fx.root, "alias.md");
    await fs.symlink(fx.requestedPath, insideSymlink);
    const finalSymlink = await fx.runtime.registerHumanEditLease({
      sessionId: "desktop-editor-session",
      target: { kind: "local_file", relayId: RELAY, candidatePath: insideSymlink },
      state: "clean",
    });
    expect(finalSymlink).toMatchObject({ status: "invalid" });
  });

  test("commits an existing human update through coordinator journal/event truth", async () => {
    const fx = await fixture();
    const result = await fx.runtime.saveExistingFile({
      path: fx.requestedPath,
      content: "after\n",
      baseSha256: sha256Hex(Buffer.from("before\n")),
      // Current pre-cutover Workbench callers do not supply checkpoint. It is
      // false until an editor intentionally provides a real checkpoint.
      correlation: {},
    });
    await waitFor(async () =>
      (await fx.journal.lookupOperation("editor-operation"))?.outbox.state === "delivered"
    );
    expect(result).toEqual({ ok: true, sha256: sha256Hex(Buffer.from("after\n")), size: 6 });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("after\n");
    const durable = await fx.journal.lookupOperation("editor-operation");
    expect(durable).toMatchObject({
      intent: { state: "committed", actor: { kind: "human", humanId: HUMAN } },
      outbox: { state: "delivered", revisionGroupId: "editor-group" },
    });
    expect(fx.batches).toEqual([expect.objectContaining({
      operationId: "editor-operation",
      revisionGroupId: "editor-group",
      events: [expect.objectContaining({
        type: "document.mutation.committed",
        actor: { kind: "human", humanId: HUMAN },
        editorSave: expect.objectContaining({ checkpoint: false }),
      })],
    })]);
  });

  test("commits a complete private-tree agent batch through the shared coordinator", async () => {
    const fx = await fixture();
    expect(await fx.runtime.registerHumanEditLease({
      sessionId: "desktop-clean-agent-session",
      target: { kind: "local_file", relayId: RELAY, candidatePath: fx.requestedPath },
      state: "clean",
    })).toMatchObject({ status: "ok" });
    const result = await fx.runtime.commitApplyPatch({
      root: fx.root,
      agentId: "agent-apply-patch",
      turnId: "turn-apply-patch",
      reauthorize: async () => {},
      operations: [
        {
          operation: "update",
          path: "draft.md",
          state: "applied",
          destination: {
            path: "draft.md",
            before: {
              logicalPath: "draft.md",
              artifactId: fx.canonicalPath,
              revision: null,
              bytes: new TextEncoder().encode("before\n"),
            },
            after: new TextEncoder().encode("agent update\n"),
          },
        },
        {
          operation: "add",
          path: "new.md",
          state: "applied",
          destination: {
            path: "new.md",
            before: null,
            after: new TextEncoder().encode("agent create\n"),
          },
        },
      ],
    });
    expect(result).toMatchObject({
      operations: [
        { operation: "update", path: "draft.md", state: "committed" },
        { operation: "add", path: "new.md", state: "committed" },
      ],
    });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("agent update\n");
    expect(await fs.readFile(path.join(fx.root, "new.md"), "utf8"))
      .toBe("agent create\n");
    await waitFor(() => fx.batches.length === 1);
    expect(fx.batches).toEqual([expect.objectContaining({
      events: [
        expect.objectContaining({
          mutation: "update",
          actor: { kind: "agent", agentId: "agent-apply-patch" },
        }),
        expect.objectContaining({
          mutation: "create",
          actor: { kind: "agent", agentId: "agent-apply-patch" },
        }),
      ],
    })]);
  });

  test("admits only disjoint dirty text apply_patch edits and leaves the agent postimage authoritative", async () => {
    const fx = await fixture();
    await fs.writeFile(fx.requestedPath, "title\nbody\n");
    expect(await fx.runtime.registerHumanEditLease({
      sessionId: "desktop-dirty-disjoint-session",
      target: { kind: "local_file", relayId: RELAY, candidatePath: fx.requestedPath },
      state: "dirty",
      draftPatch: { kind: "anchored_text", oldString: "body", newString: "human-body" },
    })).toMatchObject({ status: "ok" });
    const result = await fx.runtime.commitApplyPatch({
      root: fx.root, agentId: "agent-apply-patch", turnId: "turn-dirty-disjoint", reauthorize: async () => {},
      operations: [{
        operation: "update", path: "draft.md", state: "applied",
        destination: {
          path: "draft.md",
          before: { logicalPath: "draft.md", artifactId: fx.canonicalPath, revision: null, bytes: new TextEncoder().encode("title\nbody\n") },
          after: new TextEncoder().encode("agent-title\nbody\n"),
        },
      }],
    });
    expect(result).toMatchObject({ operations: [{ state: "committed" }] });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("agent-title\nbody\n");
  });

  test("rejects overlapping or saving local human edits before apply_patch persistence", async () => {
    for (const state of ["dirty", "saving"] as const) {
      const fx = await fixture();
      await fs.writeFile(fx.requestedPath, "title\nbody\n");
      expect(await fx.runtime.registerHumanEditLease({
        sessionId: `desktop-${state}-agent-session`,
        target: { kind: "local_file", relayId: RELAY, candidatePath: fx.requestedPath },
        state,
        ...(state === "dirty"
          ? { draftPatch: { kind: "anchored_text" as const, oldString: "title\n", newString: "human-title\n" } }
          : {}),
      })).toMatchObject({ status: "ok" });
      const result = await fx.runtime.commitApplyPatch({
        root: fx.root, agentId: "agent-apply-patch", turnId: `turn-${state}-conflict`, reauthorize: async () => {},
        operations: [{
          operation: "update", path: "draft.md", state: "applied",
          destination: {
            path: "draft.md",
            before: { logicalPath: "draft.md", artifactId: fx.canonicalPath, revision: null, bytes: new TextEncoder().encode("title\nbody\n") },
            after: new TextEncoder().encode("agent heading\nbody\n"),
          },
        }],
      });
      expect(result).toMatchObject({
        rejected: true,
        operations: [],
        error: { code: state === "dirty" ? "human_edit_conflict" : "reapply_required", retryable: false },
      });
      expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("title\nbody\n");
      expect(fx.batches).toEqual([]);
    }
  });

  test("commits an OfficeCLI binary postimage with a V2 receipt and a distinct-source CAS precondition", async () => {
    const fx = await fixture();
    const source = path.join(fx.root, "source.docx");
    const target = path.join(fx.root, "target.docx");
    const sourceBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const targetBefore = Buffer.from([0x50, 0x4b, 0x03, 0x04, 4, 5, 6]);
    const generated = Buffer.from([0x50, 0x4b, 0x03, 0x04, 7, 8, 9]);
    await fs.writeFile(source, sourceBytes);
    await fs.writeFile(target, targetBefore);
    const result = await fx.runtime.commitOfficeCli({
      targetPath: target,
      targetBefore,
      after: generated,
      source: { path: source, before: sourceBytes },
      agentId: "agent-officecli",
      turnId: "turn-officecli",
      reauthorize: async () => {},
    });
    expect(result).toMatchObject({
      ok: true,
      sha256: sha256Hex(generated),
      byteLength: generated.byteLength,
    });
    expect(await fs.readFile(source)).toEqual(sourceBytes);
    expect(await fs.readFile(target)).toEqual(generated);
    if (!result.ok) throw new Error(result.message);
    const durable = await fx.journal.lookupOperation(result.operationId);
    expect(durable).toMatchObject({
      intent: {
        state: "committed",
        actor: { kind: "agent", agentId: "agent-officecli" },
        revisionGroupId: result.revisionGroupId,
      },
    });
    expect(durable?.intent.paths).toHaveLength(1);
    expect(durable?.intent.paths[0]?.revisionIds).toEqual([result.revisionId]);
    await waitFor(() => fx.batches.length === 1);
    expect(fx.batches).toEqual([expect.objectContaining({
      operationId: result.operationId,
      events: [expect.objectContaining({
        mutation: "update",
        actor: { kind: "agent", agentId: "agent-officecli" },
      })],
    })]);
  });

  test("OfficeCLI stale source or target rejects before any live write", async () => {
    const fx = await fixture();
    const source = path.join(fx.root, "source.docx");
    const target = path.join(fx.root, "target.docx");
    const sourceBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]);
    const targetBefore = Buffer.from([0x50, 0x4b, 0x03, 0x04, 2]);
    const generated = Buffer.from([0x50, 0x4b, 0x03, 0x04, 3]);
    await fs.writeFile(source, sourceBytes);
    await fs.writeFile(target, targetBefore);
    await fs.writeFile(source, Buffer.from([0x50, 0x4b, 0x03, 0x04, 4]));
    const staleSource = await fx.runtime.commitOfficeCli({
      targetPath: target,
      targetBefore,
      after: generated,
      source: { path: source, before: sourceBytes },
      agentId: "agent-officecli",
      turnId: "turn-officecli-stale-source",
      reauthorize: async () => {},
    });
    expect(staleSource).toMatchObject({ ok: false });
    expect(await fs.readFile(target)).toEqual(targetBefore);

    const currentSource = await fs.readFile(source);
    await fs.writeFile(target, Buffer.from([0x50, 0x4b, 0x03, 0x04, 5]));
    const staleTarget = await fx.runtime.commitOfficeCli({
      targetPath: target,
      targetBefore,
      after: generated,
      source: { path: source, before: currentSource },
      agentId: "agent-officecli",
      turnId: "turn-officecli-stale-target",
      reauthorize: async () => {},
    });
    expect(staleTarget).toMatchObject({ ok: false, code: "conflict" });
    expect(await fs.readFile(source)).toEqual(currentSource);
    expect(await fs.readFile(target)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04, 5]));
    expect(fx.batches).toEqual([]);
  });

  test("rejects an OfficeCLI binary commit when the target has even a clean human edit lease", async () => {
    const fx = await fixture();
    const target = path.join(fx.root, "leased-target.docx");
    const before = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]);
    const generated = Buffer.from([0x50, 0x4b, 0x03, 0x04, 2]);
    await fs.writeFile(target, before);
    expect(await fx.runtime.registerHumanEditLease({
      sessionId: "desktop-office-clean-session",
      target: { kind: "local_file", relayId: RELAY, candidatePath: target },
      state: "clean",
    })).toMatchObject({ status: "ok" });
    const result = await fx.runtime.commitOfficeCli({
      targetPath: target, targetBefore: before, after: generated,
      agentId: "agent-officecli", turnId: "turn-office-clean-lease", reauthorize: async () => {},
    });
    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(await fs.readFile(target)).toEqual(before);
    expect(fx.batches).toEqual([]);
  });

  test("OfficeCLI commit-time reauthorization failure leaves staged bytes uncommitted", async () => {
    const fx = await fixture();
    const target = path.join(fx.root, "target.docx");
    const before = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]);
    const generated = Buffer.from([0x50, 0x4b, 0x03, 0x04, 2]);
    await fs.writeFile(target, before);
    const result = await fx.runtime.commitOfficeCli({
      targetPath: target,
      targetBefore: before,
      after: generated,
      agentId: "agent-officecli",
      turnId: "turn-officecli-revoked",
      reauthorize: async () => {
        throw new Error("grant revoked");
      },
    });
    expect(result).toMatchObject({ ok: false, code: "error" });
    expect(await fs.readFile(target)).toEqual(before);
    expect(fx.batches).toEqual([]);
  });

  test("human bytes win when they change after private staging", async () => {
    const fx = await fixture();
    await fs.writeFile(fx.requestedPath, "human edit\n");
    const result = await fx.runtime.commitApplyPatch({
      root: fx.root,
      agentId: "agent-apply-patch",
      turnId: "turn-apply-patch-conflict",
      reauthorize: async () => {},
      operations: [{
        operation: "update",
        path: "draft.md",
        state: "applied",
        destination: {
          path: "draft.md",
          before: {
            logicalPath: "draft.md",
            artifactId: fx.canonicalPath,
            revision: null,
            bytes: new TextEncoder().encode("before\n"),
          },
          after: new TextEncoder().encode("agent update\n"),
        },
      }],
    });
    expect(result).toMatchObject({
      rejected: true,
      operations: [],
      error: { code: "reapply_required", retryable: false },
    });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("human edit\n");
    expect(fx.batches).toEqual([]);
  });

  test("rebases disjoint human bytes saved after private staging and reports it", async () => {
    const fx = await fixture();
    await fs.writeFile(
      fx.requestedPath,
      "agent target\nhuman changed\n",
    );
    const result = await fx.runtime.commitApplyPatch({
      root: fx.root,
      agentId: "agent-apply-patch",
      turnId: "turn-apply-patch-rebased",
      reauthorize: async () => {},
      operations: [{
        operation: "update",
        path: "draft.md",
        state: "applied",
        destination: {
          path: "draft.md",
          before: {
            logicalPath: "draft.md",
            artifactId: fx.canonicalPath,
            revision: null,
            bytes: new TextEncoder().encode(
              "agent target\nhuman target\n",
            ),
          },
          after: new TextEncoder().encode(
            "agent changed\nhuman target\n",
          ),
        },
      }],
    });

    expect(result).toMatchObject({
      rebased: true,
      operations: [{ state: "committed" }],
    });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe(
      "agent changed\nhuman changed\n",
    );
    await waitFor(() => fx.batches.length === 1);
    expect(fx.batches[0]?.events[0]).toMatchObject({ outcome: "rebased" });
  });

  test("revoked D418 authority after native staging produces zero live writes", async () => {
    const fx = await fixture();
    let checks = 0;
    const result = await fx.runtime.commitApplyPatch({
      root: fx.root,
      agentId: "agent-apply-patch",
      turnId: "turn-revoked-after-staging",
      reauthorize: async () => {
        checks += 1;
        if (checks >= 2) throw new Error("grant revoked");
      },
      operations: [{
        operation: "update",
        path: "draft.md",
        state: "applied",
        destination: {
          path: "draft.md",
          before: {
            logicalPath: "draft.md",
            artifactId: fx.canonicalPath,
            revision: null,
            bytes: new TextEncoder().encode("before\n"),
          },
          after: new TextEncoder().encode("agent update\n"),
        },
      }],
    });
    expect(result).toMatchObject({ rejected: true, operations: [] });
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("before\n");
    expect(fx.batches).toEqual([]);
    expect(
      await fs.stat(path.join(fx.journalRoot, "manifest.json")).catch(() => null),
    ).toBeNull();
  });

  test("stale base rejects before journal/write and missing create is not an update fallback", async () => {
    const fx = await fixture();
    const stale = await fx.runtime.saveExistingFile({
      path: fx.requestedPath,
      content: "agent overwrite\n",
      baseSha256: "a".repeat(64),
    });
    expect(stale).toEqual({ ok: false, code: "conflict", currentSha256: sha256Hex(Buffer.from("before\n")) });
    expect(await fx.journal.lookupOperation("editor-operation")).toBeNull();
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("before\n");
    const missing = await fx.runtime.saveExistingFile({
      path: path.join(fx.root, "new.md"),
      content: "new\n",
      baseSha256: sha256Hex(Buffer.from("anything")),
    });
    expect(missing).toMatchObject({ ok: false, code: "error" });
    await expect(fs.access(path.join(fx.root, "new.md"))).rejects.toThrow();
  });

  test("stable correlation replays durable bytes and rejects every changed request semantic", async () => {
    const fx = await fixture();
    const baseVersion = {
      identity: { kind: "local_file" as const, relayId: RELAY, canonicalPath: fx.canonicalPath },
      backendVersion: {
        kind: "local_sha" as const,
        sha256: sha256Hex(Buffer.from("before\n")),
      },
      sha256: sha256Hex(Buffer.from("before\n")),
    };
    const input = {
      path: fx.requestedPath,
      content: "after\n",
      baseSha256: sha256Hex(Buffer.from("before\n")),
      correlation: {
        checkpoint: true,
        requestId: "lost-response-request",
        clientMutationId: "lost-response-save",
        anchoredPatch: {
          kind: "anchored_text" as const,
          oldString: "before\n",
          newString: "after\n",
        },
        baseVersion,
      },
    };
    expect((await fx.runtime.saveExistingFile(input)).ok).toBe(true);
    await waitFor(() => fx.batches.length === 1);
    const operationId = (fx.batches[0] as { operationId: string }).operationId;
    expect(await fx.runtime.saveExistingFile(input)).toEqual({
      ok: true, sha256: sha256Hex(Buffer.from("after\n")), size: 6,
    });
    expect(await fx.journal.lookupOperation(operationId)).not.toBeNull();
    const alterations = [
      { ...input, content: "altered\n" },
      { ...input, baseSha256: "a".repeat(64) },
      { ...input, correlation: { ...input.correlation, checkpoint: false } },
      { ...input, correlation: { ...input.correlation, requestId: "changed-request" } },
      { ...input, correlation: { ...input.correlation, clientMutationId: "changed-client" } },
      {
        ...input,
        correlation: {
          ...input.correlation,
          anchoredPatch: {
            kind: "anchored_text" as const,
            oldString: "before\n",
            newString: "different\n",
          },
        },
      },
      {
        ...input,
        correlation: {
          ...input.correlation,
          baseVersion: { ...baseVersion, sha256: "b".repeat(64) },
        },
      },
    ];
    for (const altered of alterations) {
      expect((await fx.runtime.saveExistingFile(altered)).ok).toBe(false);
    }
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("after\n");
  });

  test("fails closed when a trusted human actor cannot be resolved", async () => {
    const fx = await fixture();
    const runtime = new DesktopDocumentMutationRuntime({
      getTrustedRelayId: () => RELAY,
      getTrustedHumanId: () => null,
      fileAdapter: fx.adapter,
      journal: fx.journal,
      publishToRenderer: async () => "published",
    });
    expect(await runtime.saveExistingFile({
      path: fx.requestedPath,
      content: "after\n",
      baseSha256: sha256Hex(Buffer.from("before\n")),
    })).toMatchObject({ ok: false, code: "error" });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("before\n");
    expect(await fx.journal.lookupOperation("editor-operation")).toBeNull();
  });

  test("revalidates trusted human identity at commit after prepare", async () => {
    const fx = await fixture();
    let lookups = 0;
    const runtime = new DesktopDocumentMutationRuntime({
      getTrustedRelayId: () => RELAY,
      getTrustedHumanId: () => {
        lookups += 1;
        return lookups >= 3 ? "different-human" : HUMAN;
      },
      fileAdapter: fx.adapter,
      journal: fx.journal,
      publishToRenderer: async () => "published",
    });
    expect(await runtime.saveExistingFile({
      path: fx.requestedPath,
      content: "after\n",
      baseSha256: sha256Hex(Buffer.from("before\n")),
    })).toMatchObject({ ok: false, code: "error" });
    expect(lookups).toBe(3);
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("before\n");
    expect(await fx.journal.lookupOperation("editor-operation")).toBeNull();
  });

  test("failed renderer publication leaves a committed durable batch for restart recovery", async () => {
    const fx = await fixture({ publisher: "not_published" });
    expect((await fx.runtime.saveExistingFile({
      path: fx.requestedPath,
      content: "after\n",
      baseSha256: sha256Hex(Buffer.from("before\n")),
    })).ok).toBe(true);
    await waitFor(async () =>
      (await fx.journal.lookupOperation("editor-operation"))?.outbox.state === "pending"
    );
    expect((await fx.journal.lookupOperation("editor-operation"))?.outbox.state).toBe("pending");
    fx.runtime.stopOutboxPump();

    const delivered: unknown[] = [];
    const replay = new DesktopDocumentMutationRuntime({
      getTrustedRelayId: () => RELAY,
      getTrustedHumanId: () => HUMAN,
      fileAdapter: fx.adapter,
      journal: fx.journal,
      publishToRenderer: async (batch) => {
        delivered.push(batch);
        return "published";
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    // The old runtime was stopped before the simulated relay/runtime
    // replacement, so its unref'd pump cannot reclaim/publish the batch.
    expect(fx.batches).toHaveLength(1);
    await replay.recoverAtStartup();
    expect(delivered).toHaveLength(1);
    expect((await fx.journal.lookupOperation("editor-operation"))?.outbox.state).toBe("delivered");
  });

  test("save success never waits for renderer acknowledgement", async () => {
    const fx = await fixture();
    const runtime = new DesktopDocumentMutationRuntime({
      getTrustedRelayId: () => RELAY,
      getTrustedHumanId: () => HUMAN,
      fileAdapter: fx.adapter,
      journal: fx.journal,
      newOperationId: () => "nonblocking-ack-operation",
      newRevisionGroupId: () => "nonblocking-ack-group",
      publishToRenderer: async () => await new Promise<"published">(() => {}),
    });
    const result = await runtime.saveExistingFile({
      path: fx.requestedPath,
      content: "after\n",
      baseSha256: sha256Hex(Buffer.from("before\n")),
    });
    expect(result).toMatchObject({ ok: true });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("after\n");
    runtime.stopOutboxPump();
  });

  test("delivered-only idle state does not rewrite the manifest on a timer", async () => {
    const fx = await fixture();
    expect((await fx.runtime.saveExistingFile({
      path: fx.requestedPath,
      content: "after\n",
      baseSha256: sha256Hex(Buffer.from("before\n")),
    }))).toMatchObject({ ok: true });
    await waitFor(async () =>
      (await fx.journal.lookupOperation("editor-operation"))?.outbox.state === "delivered"
    );
    const manifestPath = path.join(fx.journalRoot, "manifest.json");
    const before = await fs.stat(manifestPath);
    const beforeBytes = await fs.readFile(manifestPath);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const after = await fs.stat(manifestPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(manifestPath)).toEqual(beforeBytes);
    fx.runtime.stopOutboxPump();
  });

  test("one pump drains every currently due committed batch, not one batch per wake", async () => {
    const fx = await fixture();
    let publish = false;
    let ids = 0;
    const runtime = new DesktopDocumentMutationRuntime({
      getTrustedRelayId: () => RELAY,
      getTrustedHumanId: () => HUMAN,
      fileAdapter: fx.adapter,
      journal: fx.journal,
      newOperationId: () => `drain-operation-${++ids}`,
      newRevisionGroupId: () => `drain-group-${ids}`,
      outboxWakeIntervalMs: 60_000,
      publishToRenderer: async (batch) => {
        fx.batches.push(batch);
        return publish ? "published" : "not_published";
      },
    });
    expect((await runtime.saveExistingFile({
      path: fx.requestedPath,
      content: "after-one\n",
      baseSha256: sha256Hex(Buffer.from("before\n")),
    })).ok).toBe(true);
    await flushOutbox();
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    publish = true;
    expect((await runtime.saveExistingFile({
      path: fx.requestedPath,
      content: "after-two\n",
      baseSha256: sha256Hex(Buffer.from("after-one\n")),
    })).ok).toBe(true);
    await waitFor(async () =>
      (await fx.journal.lookupOperation("drain-operation-2"))?.outbox.state === "delivered"
    );
    await waitFor(async () =>
      (await fx.journal.lookupOperation("drain-operation-1"))?.outbox.state === "delivered",
      400,
    );
    // Persisted retry deadlines may re-attempt the first batch immediately
    // before the second save. If so, the second save progresses independently
    // and the first batch is delivered at its next persisted deadline.
    const attempted = (fx.batches as Array<{ operationId: string }>)
      .map((batch) => batch.operationId);
    // Immediate drains and the unref'd wake are intentionally nonblocking, so
    // a pending first batch may be attempted more than twice. Correctness is
    // the durable terminal state plus second-batch progress, not a scheduler-
    // dependent exact retry count.
    expect(attempted.filter((id) => id === "drain-operation-1").length).toBeGreaterThanOrEqual(2);
    expect(attempted).toContain("drain-operation-2");
    expect((await fx.journal.lookupOperation("drain-operation-1"))?.outbox.state).toBe("delivered");
    expect((await fx.journal.lookupOperation("drain-operation-2"))?.outbox.state).toBe("delivered");
  });

  test("authority/path drift fails closed at commit without a legacy fallback", async () => {
    const fx = await fixture();
    let drifted = false;
    const drifting: GuardedFileAdapter = {
      ...fx.adapter,
      canonicalize: async (filePath) => {
        if (drifted) return path.join(fx.root, "other.md");
        return await fx.adapter.canonicalize(filePath);
      },
      writeFileAtomicConditional: async () => {
        drifted = true;
        throw new Error("simulated canonical path drift before replacement");
      },
    };
    const runtime = new DesktopDocumentMutationRuntime({
      getTrustedRelayId: () => RELAY,
      getTrustedHumanId: () => HUMAN,
      fileAdapter: drifting,
      journal: fx.journal,
      publishToRenderer: async () => "published",
    });
    const result = await runtime.saveExistingFile({
      path: fx.requestedPath,
      content: "after\n",
      baseSha256: sha256Hex(Buffer.from("before\n")),
    });
    expect(result).toMatchObject({ ok: false, code: "error" });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("before\n");
  });

  test("an in-flight save is fenced when its process-owned generation changes", async () => {
    const fx = await fixture();
    let current = true;
    let releaseRead: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      const originalRead = fx.adapter.readFile.bind(fx.adapter);
      fx.adapter.readFile = async (filePath) => {
        resolve();
        await new Promise<void>((release) => {
          releaseRead = release;
        });
        return await originalRead(filePath);
      };
    });
    const runtime = new DesktopDocumentMutationRuntime({
      getTrustedRelayId: () => RELAY,
      getTrustedHumanId: () => HUMAN,
      fileAdapter: fx.adapter,
      journal: fx.journal,
      isCurrent: () => current,
      publishToRenderer: async () => "published",
    });
    const pending = runtime.saveExistingFile({
      path: fx.requestedPath,
      content: "after\n",
      baseSha256: sha256Hex(Buffer.from("before\n")),
    });
    await readStarted;
    current = false;
    releaseRead?.();
    expect(await pending).toMatchObject({ ok: false, code: "error" });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("before\n");
    expect(await fx.journal.lookupOperation("editor-operation")).toBeNull();
  });

  test("generation loss after a proven commit preserves save success and durable outbox truth", async () => {
    const fx = await fixture();
    let current = true;
    const runtime = new DesktopDocumentMutationRuntime({
      getTrustedRelayId: () => RELAY,
      getTrustedHumanId: () => HUMAN,
      fileAdapter: fx.adapter,
      journal: fx.journal,
      isCurrent: () => current,
      newOperationId: () => "post-commit-generation-operation",
      newRevisionGroupId: () => "post-commit-generation-group",
      publishToRenderer: async () => {
        current = false;
        return "published";
      },
    });
    const result = await runtime.saveExistingFile({
      path: fx.requestedPath,
      content: "after\n",
      baseSha256: sha256Hex(Buffer.from("before\n")),
    });
    expect(result).toEqual({
      ok: true,
      sha256: sha256Hex(Buffer.from("after\n")),
      size: 6,
    });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("after\n");
    await waitFor(async () => {
      const state = (await fx.journal.lookupOperation("post-commit-generation-operation"))?.outbox.state;
      return state === "pending" || state === "claimed";
    });
    expect((await fx.journal.lookupOperation("post-commit-generation-operation"))?.intent.state)
      .toBe("committed");
  });

  test("a journal bound to another relay fails closed without mutation", async () => {
    const fx = await fixture();
    expect((await fx.runtime.saveExistingFile({
      path: fx.requestedPath,
      content: "bound\n",
      baseSha256: sha256Hex(Buffer.from("before\n")),
    })).ok).toBe(true);
    await waitFor(async () =>
      (await fx.journal.lookupOperation("editor-operation"))?.intent.state === "committed"
    );
    const wrongRelayJournal = new LocalDurableMutationJournal({
      rootDir: fx.journalRoot,
      relayId: "replacement-relay",
      fileAdapter: fx.adapter,
    });
    const runtime = new DesktopDocumentMutationRuntime({
      getTrustedRelayId: () => "replacement-relay",
      getTrustedHumanId: () => HUMAN,
      fileAdapter: fx.adapter,
      journal: wrongRelayJournal,
      publishToRenderer: async () => "published",
    });
    expect(await runtime.saveExistingFile({
      path: fx.requestedPath,
      content: "after\n",
      baseSha256: sha256Hex(Buffer.from("bound\n")),
    })).toMatchObject({
      ok: false,
      code: "error",
      message: expect.stringContaining("explicit local-history relay rebind is required"),
    });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("bound\n");
  });

  test("canonical history maintains durable repeated undo/redo stacks and invalidates redo after a forward write", async () => {
    const fx = await fixture();
    const agentId = "agent-history";
    const commit = async (
      request: string,
      turnId: string,
      before: string,
      after: string,
    ) =>
      fx.runtime.commitAgentContent({
        mutationRequestId: `d448:history:${request}`,
        semanticDigest: `history-${request}`,
        targetPath: fx.requestedPath,
        before: Buffer.from(before),
        after: Buffer.from(after),
        agentId,
        turnId,
        command: "write",
        reauthorize: async () => undefined,
      });
    const restore = async (
      action: "undo" | "redo",
      request: string,
    ) =>
      fx.runtime.commitHistoryRestore({
        action,
        targetPath: fx.requestedPath,
        agentId,
        turnId: `turn-${request}`,
        mutationRequestId: `d448:history:${request}`,
        semanticDigest: `history-${request}`,
        authorizedRoots: [fx.root],
        reauthorize: async () => undefined,
      });

    expect(await commit("forward-b", "turn-b", "before\n", "b\n"))
      .toMatchObject({ ok: true });
    expect(await commit("forward-c", "turn-c", "b\n", "c\n"))
      .toMatchObject({ ok: true });
    expect(await restore("undo", "undo-c")).toMatchObject({ ok: true });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("b\n");
    expect(await restore("undo", "undo-b")).toMatchObject({ ok: true });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("before\n");
    expect(await restore("redo", "redo-b")).toMatchObject({ ok: true });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("b\n");
    expect(await restore("redo", "redo-c")).toMatchObject({ ok: true });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("c\n");

    expect(await restore("undo", "undo-c-again")).toMatchObject({ ok: true });
    expect(await commit("forward-d", "turn-d", "b\n", "d\n"))
      .toMatchObject({ ok: true });
    expect(await restore("redo", "redo-invalidated")).toMatchObject({
      ok: false,
      code: "nothing_to_redo",
    });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("d\n");
  });

  test("undo_turn collapses same-path writes from final postimage to first preimage in one canonical commit", async () => {
    const fx = await fixture();
    const agentId = "agent-turn";
    const targetTurnId = "turn-collapse";
    for (const [request, before, after] of [
      ["one", "before\n", "middle\n"],
      ["two", "middle\n", "final\n"],
    ] as const) {
      expect(await fx.runtime.commitAgentContent({
        mutationRequestId: `d448:collapse:${request}`,
        semanticDigest: `collapse-${request}`,
        targetPath: fx.requestedPath,
        before: Buffer.from(before),
        after: Buffer.from(after),
        agentId,
        turnId: targetTurnId,
        command: "str_replace",
        reauthorize: async () => undefined,
      })).toMatchObject({ ok: true });
    }
    const result = await fx.runtime.commitHistoryRestore({
      action: "undo_turn",
      targetTurnId,
      agentId,
      turnId: "turn-undo-collapse",
      mutationRequestId: "d448:collapse:undo",
      semanticDigest: "collapse-undo",
      authorizedRoots: [fx.root],
      reauthorize: async () => undefined,
    });
    expect(result).toMatchObject({ ok: true, replayed: false });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("before\n");
    if (!result.ok) throw new Error(result.message);
    expect(result.revisions).toHaveLength(1);
    expect((await fx.journal.lookupOperation(result.operationId))?.intent)
      .toMatchObject({
        state: "committed",
        producer: {
          operation: "undo",
          history: {
            action: "undo",
            targetTurnId,
            sourceRevisionIds: expect.any(Array),
          },
        },
      });
  });

  test("multi-path undo_turn is all-or-nothing when a human changes one path", async () => {
    const fx = await fixture();
    const secondPath = path.join(fx.root, "second.md");
    await fs.writeFile(secondPath, "second-before\n");
    const targetTurnId = "turn-multi";
    for (const [request, targetPath, before, after] of [
      ["first", fx.requestedPath, "before\n", "first-agent\n"],
      ["second", secondPath, "second-before\n", "second-agent\n"],
    ] as const) {
      expect(await fx.runtime.commitAgentContent({
        mutationRequestId: `d448:multi:${request}`,
        semanticDigest: `multi-${request}`,
        targetPath,
        before: Buffer.from(before),
        after: Buffer.from(after),
        agentId: "agent-multi",
        turnId: targetTurnId,
        command: "write",
        reauthorize: async () => undefined,
      })).toMatchObject({ ok: true });
    }
    await fs.writeFile(secondPath, "human-wins\n");
    const result = await fx.runtime.commitHistoryRestore({
      action: "undo_turn",
      targetTurnId,
      agentId: "agent-multi",
      turnId: "turn-multi-undo",
      mutationRequestId: "d448:multi:undo",
      semanticDigest: "multi-undo",
      authorizedRoots: [fx.root],
      reauthorize: async () => undefined,
    });
    expect(result).toMatchObject({ ok: false, code: "reapply_required" });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("first-agent\n");
    expect(await fs.readFile(secondPath, "utf8")).toBe("human-wins\n");
  });

  test("undo_turn rejects every path when one selected location is outside the current authorized roots", async () => {
    const fx = await fixture();
    const authorizedRoot = path.join(fx.root, "authorized");
    const outsideAuthorizedRoot = path.join(fx.root, "outside.md");
    await fs.mkdir(authorizedRoot);
    const inside = path.join(authorizedRoot, "inside.md");
    await fs.writeFile(inside, "inside-before\n");
    await fs.writeFile(outsideAuthorizedRoot, "outside-before\n");
    for (const [request, targetPath, before, after] of [
      ["inside", inside, "inside-before\n", "inside-after\n"],
      ["outside", outsideAuthorizedRoot, "outside-before\n", "outside-after\n"],
    ] as const) {
      expect(await fx.runtime.commitAgentContent({
        mutationRequestId: `d448:authority:${request}`,
        semanticDigest: `authority-${request}`,
        targetPath,
        before: Buffer.from(before),
        after: Buffer.from(after),
        agentId: "agent-authority",
        turnId: "turn-authority",
        command: "write",
        reauthorize: async () => undefined,
      })).toMatchObject({ ok: true });
    }
    expect(await fx.runtime.commitHistoryRestore({
      action: "undo_turn",
      targetTurnId: "turn-authority",
      agentId: "agent-authority",
      turnId: "turn-authority-undo",
      mutationRequestId: "d448:authority:undo",
      semanticDigest: "authority-undo",
      authorizedRoots: [authorizedRoot],
      reauthorize: async () => undefined,
    })).toMatchObject({ ok: false, code: "reapply_required" });
    expect(await fs.readFile(inside, "utf8")).toBe("inside-after\n");
    expect(await fs.readFile(outsideAuthorizedRoot, "utf8")).toBe(
      "outside-after\n",
    );
  });

  test("history lost-response retry returns the one durable receipt and emits no duplicate event", async () => {
    const fx = await fixture();
    expect(await fx.runtime.commitAgentContent({
      mutationRequestId: "d448:history-retry:forward",
      semanticDigest: "history-retry-forward",
      targetPath: fx.requestedPath,
      before: Buffer.from("before\n"),
      after: Buffer.from("after\n"),
      agentId: "agent-history-retry",
      turnId: "turn-history-forward",
      command: "write",
      reauthorize: async () => undefined,
    })).toMatchObject({ ok: true });
    const request = {
      action: "undo" as const,
      targetPath: fx.requestedPath,
      agentId: "agent-history-retry",
      turnId: "turn-history-undo",
      mutationRequestId: "d448:history-retry:undo",
      semanticDigest: "history-retry-undo",
      authorizedRoots: [fx.root],
      reauthorize: async () => undefined,
    };
    const first = await fx.runtime.commitHistoryRestore(request);
    const retry = await fx.runtime.commitHistoryRestore({
      ...request,
      replayOnly: true,
    });
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(retry).toMatchObject({
      ok: true,
      replayed: true,
      operationId: first.ok ? first.operationId : undefined,
      revisionGroupId: first.ok ? first.revisionGroupId : undefined,
    });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("before\n");
    await waitFor(() => fx.batches.length === 2);
    expect(fx.batches).toHaveLength(2);

    const narrowerRoot = path.join(fx.root, "narrower");
    await fs.mkdir(narrowerRoot);
    expect(await fx.runtime.commitHistoryRestore({
      ...request,
      authorizedRoots: [narrowerRoot],
      replayOnly: true,
    })).toMatchObject({
      ok: false,
      code: "error",
      message: expect.stringContaining("outside the current authorized roots"),
    });
  });

  test("canonical restore ingests a structural V1 move and restores both historical locations exactly", async () => {
    const fx = await fixture();
    const source = path.join(fx.root, "legacy-source.txt");
    const destination = path.join(fx.root, "legacy-destination.txt");
    await fs.rm(fx.requestedPath);
    await fs.writeFile(destination, "source bytes\n");
    const legacy = new LocalFileHistoryJournal({
      rootDir: fx.journalRoot,
      relayId: RELAY,
      fileAdapter: fx.adapter,
    });
    await legacy.init();
    expect(await legacy.recordSuccessfulMutation({
      ownerId: HUMAN,
      agentId: "agent-legacy-move",
      turnId: "turn-legacy-move",
      requestedPath: source,
      zone: "current",
      operation: "move",
      preState: snapshotFromBytes(Buffer.from("source bytes\n")),
      postState: { kind: "missing" },
      relatedCanonicalPath: destination,
      relatedPreState: snapshotFromBytes(Buffer.from("old destination\n")),
      relatedPostState: snapshotFromBytes(Buffer.from("source bytes\n")),
    })).toMatchObject({ ok: true });

    const result = await fx.runtime.commitHistoryRestore({
      action: "undo",
      targetPath: source,
      agentId: "agent-legacy-move",
      turnId: "turn-undo-legacy-move",
      mutationRequestId: "d448:legacy-move:undo",
      semanticDigest: "legacy-move-undo",
      authorizedRoots: [fx.root],
      reauthorize: async () => undefined,
    });
    expect(result).toMatchObject({ ok: true });
    expect(await fs.readFile(source, "utf8")).toBe("source bytes\n");
    expect(await fs.readFile(destination, "utf8")).toBe("old destination\n");

    expect(await fx.runtime.commitHistoryRestore({
      action: "redo",
      targetPath: source,
      agentId: "agent-legacy-move",
      turnId: "turn-redo-legacy-move",
      mutationRequestId: "d448:legacy-move:redo",
      semanticDigest: "legacy-move-redo",
      authorizedRoots: [fx.root],
      reauthorize: async () => undefined,
    })).toMatchObject({ ok: true });
    await expect(fs.stat(source)).rejects.toThrow();
    expect(await fs.readFile(destination, "utf8")).toBe("source bytes\n");
  });

  test("durable history sequence, not tied timestamps or random IDs, determines the active undo top", async () => {
    const fx = await fixture();
    const first = await fx.runtime.commitAgentContent({
      mutationRequestId: "d448:sequence:first",
      semanticDigest: "sequence-first",
      targetPath: fx.requestedPath,
      before: Buffer.from("before\n"),
      after: Buffer.from("first\n"),
      agentId: "agent-sequence",
      turnId: "turn-sequence-first",
      command: "write",
      reauthorize: async () => undefined,
    });
    const second = await fx.runtime.commitAgentContent({
      mutationRequestId: "d448:sequence:second",
      semanticDigest: "sequence-second",
      targetPath: fx.requestedPath,
      before: Buffer.from("first\n"),
      after: Buffer.from("second\n"),
      agentId: "agent-sequence",
      turnId: "turn-sequence-second",
      command: "write",
      reauthorize: async () => undefined,
    });
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    const storage = createJournalStorage(fx.journalRoot);
    const manifest = await storage.readManifest();
    if (manifest?.v !== 3) throw new Error("expected current manifest");
    await storage.writeManifest({
      ...manifest,
      mutations: manifest.mutations.map((intent) => ({
        ...intent,
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
    });
    const ordered = (await fx.journal.readCanonicalHistoryRecords()).filter(
      (record) =>
        record.actor.kind === "agent" &&
        record.actor.agentId === "agent-sequence",
    );
    expect(ordered.map((record) => record.revisionId)).toEqual([
      first.ok ? first.revisionId : "",
      second.ok ? second.revisionId : "",
    ]);
    expect(await fx.runtime.commitHistoryRestore({
      action: "undo",
      targetPath: fx.requestedPath,
      agentId: "agent-sequence",
      turnId: "turn-sequence-undo",
      mutationRequestId: "d448:sequence:undo",
      semanticDigest: "sequence-undo",
      authorizedRoots: [fx.root],
      reauthorize: async () => undefined,
    })).toMatchObject({ ok: true });
    expect(await fs.readFile(fx.requestedPath, "utf8")).toBe("first\n");
  });

  test("V2 revisions remain listable and pinnable through the local history read facade", async () => {
    const fx = await fixture();
    const committed = await fx.runtime.commitAgentContent({
      mutationRequestId: "d448:v2-pin:forward",
      semanticDigest: "v2-pin-forward",
      targetPath: fx.requestedPath,
      before: Buffer.from("before\n"),
      after: Buffer.from("pinnable\n"),
      agentId: "agent-v2-pin",
      turnId: "turn-v2-pin",
      command: "write",
      reauthorize: async () => undefined,
    });
    expect(committed).toMatchObject({ ok: true });
    if (!committed.ok) return;
    const facade = new LocalFileHistoryJournal({
      rootDir: fx.journalRoot,
      relayId: RELAY,
      fileAdapter: fx.adapter,
    });
    const listed = await facade.list({ agentId: "agent-v2-pin" });
    expect(listed).toMatchObject({
      ok: true,
      data: { revisions: [{ pinned: false }] },
    });
    if (!listed.ok) return;
    const revisionRef = listed.data.revisions[0]!.revisionRef;
    expect(await facade.pin({
      agentId: "agent-v2-pin",
      revisionRef,
    })).toMatchObject({ ok: true, data: { pinned: true } });
    expect(await facade.list({
      agentId: "agent-v2-pin",
      includePinnedOnly: true,
    })).toMatchObject({
      ok: true,
      data: { revisions: [{ revisionRef, pinned: true }] },
    });
    expect(await facade.unpin({
      agentId: "agent-v2-pin",
      revisionRef,
    })).toMatchObject({ ok: true, data: { pinned: false } });
  });

  test("structural delete lost-response retry replays before observing a replacement symlink", async () => {
    const fx = await fixture();
    const identity = {
      command: "delete" as const,
      sourcePath: fx.requestedPath,
      authorizedRoots: [fx.root],
      agentId: "agent-structural",
      turnId: "turn-delete",
      mutationRequestId: "d448:delete:lost-response",
      semanticDigest: "delete-semantics",
    };
    const first = await fx.runtime.commitAgentStructural({
      ...identity,
      reauthorize: async () => undefined,
    });
    expect(first).toMatchObject({ ok: true, replayed: false, sha256: null });
    const outside = path.join(os.tmpdir(), `d448-delete-outside-${crypto.randomUUID()}`);
    roots.push(outside);
    await fs.writeFile(outside, "outside");
    await fs.symlink(outside, fx.requestedPath);
    const retry = await fx.runtime.commitAgentStructural({
      ...identity,
      replayOnly: true,
      reauthorize: async () => undefined,
    });
    expect(retry).toMatchObject({
      ok: true,
      replayed: true,
      operationId: first.ok ? first.operationId : undefined,
    });
    expect(await fs.readFile(outside, "utf8")).toBe("outside");
  });

  for (const command of ["move", "copy"] as const) {
    test(`${command} lost-response retry remains bound to source semantics after post-state drift`, async () => {
      const fx = await fixture();
      const destinationPath = path.join(fx.root, `${command}-destination.md`);
      const identity = {
        command,
        sourcePath: fx.requestedPath,
        destinationPath,
        authorizedRoots: [fx.root],
        agentId: "agent-structural",
        turnId: `turn-${command}`,
        mutationRequestId: `d448:${command}:lost-response`,
        semanticDigest: `${command}-semantics`,
      };
      const first = await fx.runtime.commitAgentStructural({
        ...identity,
        reauthorize: async () => undefined,
      });
      expect(first).toMatchObject({ ok: true, replayed: false });
      if (command === "copy") await fs.rm(fx.requestedPath);
      await fs.rm(destinationPath);
      const outside = path.join(os.tmpdir(), `d448-${command}-outside-${crypto.randomUUID()}`);
      roots.push(outside);
      await fs.writeFile(outside, "outside");
      await fs.symlink(outside, destinationPath);
      const retry = await fx.runtime.commitAgentStructural({
        ...identity,
        replayOnly: true,
        reauthorize: async () => undefined,
      });
      expect(retry).toMatchObject({
        ok: true,
        replayed: true,
        operationId: first.ok ? first.operationId : undefined,
      });
      expect(await fs.readFile(outside, "utf8")).toBe("outside");
      if (retry.ok) {
        const durable = await fx.journal.lookupOperation(retry.operationId);
        expect(durable?.intent.producer?.structural).toMatchObject({
          command,
          sourceRequestPath: fx.requestedPath,
          destinationRequestPath: destinationPath,
        });
      }
    });
  }

  test("structural copy is public no-clobber and revoked authority blocks replay", async () => {
    const fx = await fixture();
    const destinationPath = path.join(fx.root, "occupied.md");
    await fs.writeFile(destinationPath, "human wins\n");
    const input = {
      command: "copy" as const,
      sourcePath: fx.requestedPath,
      destinationPath,
      authorizedRoots: [fx.root],
      agentId: "agent-structural",
      turnId: "turn-copy-no-clobber",
      mutationRequestId: "d448:copy:no-clobber",
      semanticDigest: "copy-no-clobber",
    };
    expect(await fx.runtime.commitAgentStructural({
      ...input,
      reauthorize: async () => undefined,
    })).toMatchObject({ ok: false, code: "destination_exists" });
    expect(await fs.readFile(destinationPath, "utf8")).toBe("human wins\n");
    expect(await fx.runtime.commitAgentStructural({
      ...input,
      replayOnly: true,
      reauthorize: async () => {
        throw new Error("authority revoked");
      },
    })).toMatchObject({ ok: false, code: "error", message: "authority revoked" });
  });
});
