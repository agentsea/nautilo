import { describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import type { DocumentChange, DocumentEnvelope, BoardBridge, BoardRecoveryDraft, WriteResult } from "./board-bridge";
import { BoardSession } from "./board-session";
import type { BoardSaveStatus } from "./board-session";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const sha = (revision: number): string => revision.toString(16).padStart(64, "0");

function envelope(content: string, revision: number, path = "/Budget.sheets"): DocumentEnvelope {
  return { content, baseSha256: sha(revision), baseRevision: revision, path };
}

async function settle(): Promise<void> {
  for (let step = 0; step < 12; step += 1) await Promise.resolve();
}

function createFixture(initial = envelope("initial", 1)) {
  let remote = initial;
  let handler: ((event: DocumentChange) => void) | undefined;
  const writes: Array<{ content: string; base: Parameters<BoardBridge["document"]["write"]>[1] }> = [];
  const copies: string[] = [];
  const replacements: string[] = [];
  const statuses: Array<{ state: BoardSaveStatus; message?: string }> = [];
  const labels: Array<string | undefined> = [];
  const humanStates: string[] = [];
  const readResults: Array<DocumentEnvelope | Promise<DocumentEnvelope>> = [];
  const writeResults: Array<WriteResult | Promise<WriteResult>> = [];
  let reads = 0;
  let snapshotCalls = 0;
  let subscriptions = 0;
  let unsubscribeCalls = 0;
  let content = initial.content;

  const bridge: BoardBridge = {
    document: {
      read: async () => {
        reads += 1;
        const result = readResults.shift();
        return result ? await result : remote;
      },
      write: async (submitted, base) => {
        writes.push({ content: submitted, base });
        const result = writeResults.shift();
        if (!result) throw new Error("No write result was queued");
        return await result;
      },
      downloadCopy: async (snapshot) => { copies.push(snapshot); },
      saveCopy: async (snapshot) => { copies.push(snapshot); return { path: "Recovery.board.html" }; },
      onChange: (nextHandler) => {
        subscriptions += 1;
        handler = nextHandler;
        return () => { unsubscribeCalls += 1; };
      },
    },
    context: { set: () => {} },
    humanEdit: { set: ({ state }) => { humanStates.push(state); } },
  };
  const view = {
    snapshot: async () => {
      snapshotCalls += 1;
      return content;
    },
    replace: async (next: string) => {
      content = next;
      replacements.push(next);
    },
    status: (state: BoardSaveStatus, message?: string) => { statuses.push({ state, message }); },
    label: (path?: string) => { labels.push(path); },
  };

  return {
    bridge,
    copies,
    emit(event: DocumentChange) { handler?.(event); },
    get content() { return content; },
    get humanStates() { return humanStates; },
    get labels() { return labels; },
    get reads() { return reads; },
    get replacements() { return replacements; },
    get snapshotCalls() { return snapshotCalls; },
    get statuses() { return statuses; },
    get subscriptions() { return subscriptions; },
    get unsubscribeCalls() { return unsubscribeCalls; },
    remote(next: DocumentEnvelope) { remote = next; },
    setContent(next: string) { content = next; },
    readResults,
    writeResults,
    writes,
    view,
  };
}

function recoveryFixture(initial: BoardRecoveryDraft | null = null) {
  let draft = initial;
  let revision: string | null = initial ? "journal-1" : null;
  let next = 1;
  const writes: Array<BoardRecoveryDraft | null> = [];
  return {
    get draft() { return draft; },
    get revision() { return revision; },
    writes,
    bridge: {
      async read() { return { revision, draft }; },
      async write(input: { expectedRevision: string | null; draft: BoardRecoveryDraft | null }) {
        if (input.expectedRevision !== revision) throw new Error("Another editor changed the recovery copy.");
        draft = input.draft;
        revision = `journal-${++next}`;
        writes.push(draft);
        return { revision };
      },
    },
  };
}

describe("BoardSession crash recovery", () => {
  const record = (content: string, exact = true): BoardRecoveryDraft => ({
    version: 1, content, exact, baseSha256: sha(1), baseRevision: 1,
  });

  test("opens a recovery draft when the saved file is unavailable and saves only a copy", async () => {
    const f = createFixture();
    const journal = recoveryFixture(record("unsaved work"));
    f.bridge.recovery = journal.bridge;
    f.readResults.push(Promise.reject(new Error("File moved or deleted")));
    const session = new BoardSession(f.bridge, f.view);
    await session.start();
    expect(f.content).toBe("unsaved work");
    expect(session.canClose).toBe(false);
    expect(f.statuses.at(-1)?.state).toBe("conflict");
    expect(f.statuses.at(-1)?.message).toContain("saved file is unavailable");
    await session.save();
    expect(f.writes).toHaveLength(0);
    await session.saveCopy();
    expect(f.copies).toEqual(["unsaved work"]);
    expect(journal.draft?.content).toBe("unsaved work");
  });

  test("revalidates an unavailable base before saving recovered edits after reconnect", async () => {
    const f = createFixture();
    f.bridge.recovery = recoveryFixture(record("unsaved work")).bridge;
    f.readResults.push(Promise.reject(new Error("Storage unavailable")));
    const session = new BoardSession(f.bridge, f.view);
    await session.start();
    f.writeResults.push({ kind: "saved", sha256: sha(2), revision: 2 });
    f.emit({ type: "reconnected" });
    await settle();
    expect(f.writes).toEqual([{ content: "unsaved work", base: { ...envelope("initial", 1), conflictPolicy: "strict" } }]);
  });

  test.each([true, false])("never overwrites a changed or incompletely recovered file (exact=%s)", async (exact) => {
    const f = createFixture();
    const journal = recoveryFixture(record("unsaved work", exact));
    f.bridge.recovery = journal.bridge;
    f.readResults.push(Promise.reject(new Error("File unavailable")));
    const session = new BoardSession(f.bridge, f.view);
    await session.start();
    if (exact) f.remote(envelope("someone else's changes", 2));
    f.emit({ type: "reconnected" });
    await settle();
    expect(f.content).toBe("unsaved work");
    expect(f.writes).toHaveLength(0);
    expect(f.statuses.at(-1)?.state).toBe("conflict");
    expect(journal.draft?.content).toBe("unsaved work");
  });

  test("does not invent an empty recovery draft when both original and journal are absent", async () => {
    const f = createFixture();
    f.bridge.recovery = recoveryFixture().bridge;
    f.readResults.push(Promise.reject(new Error("Original unavailable")));
    const session = new BoardSession(f.bridge, f.view);
    await rejects(session.start(), /Original unavailable/);
    expect(f.replacements).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
  });

  test("checkpoints focused text independently of an unacknowledged canonical save", async () => {
    const f = createFixture();
    const journal = recoveryFixture();
    f.bridge.recovery = journal.bridge;
    let pendingText = "first edit";
    const session = new BoardSession(f.bridge, { ...f.view, recoverySnapshot: () => ({ content: pendingText, exact: true }) });
    await session.start();
    const blocked = deferred<WriteResult>();
    f.writeResults.push(blocked.promise);
    f.setContent("first edit");
    session.changed();
    await settle();
    expect(f.writes).toHaveLength(1);
    session.setLocalEditing(true);
    pendingText = "still focused, with newer text";
    session.changed();
    await session.persistRecovery();
    expect(journal.draft).toEqual(record(pendingText));
    expect(f.content).toBe("first edit");
    expect(f.writes).toHaveLength(1);
    blocked.resolve({ kind: "saved", sha256: sha(2), revision: 2 });
    await settle();
    expect(journal.draft).toEqual({ ...record(pendingText), baseSha256: sha(2), baseRevision: 2 });
    expect(session.dirty).toBe(true);
    session.dispose();
  });

  test("keeps an inexact recovery checkpoint while a clean image placement is pending", async () => {
    const f = createFixture();
    const journal = recoveryFixture();
    f.bridge.recovery = journal.bridge;
    const session = new BoardSession(f.bridge, {
      ...f.view,
      recoverySnapshot: () => ({ content: f.content, exact: false }),
    });
    await session.start();

    session.setLocalEditing(true);
    await settle();

    expect(session.dirty).toBe(false);
    expect(f.writes).toEqual([]);
    expect(journal.draft).toEqual(record("initial", false));

    session.setLocalEditing(false);
    await settle();

    expect(f.writes).toEqual([]);
    expect(journal.draft).toBeNull();
    expect(f.statuses.at(-1)?.state).toBe("saved");
  });

  test("restores an exact draft after a new session starts and saves against its original base", async () => {
    const f = createFixture();
    const journal = recoveryFixture(record("recovered text"));
    f.bridge.recovery = journal.bridge;
    f.writeResults.push({ kind: "saved", sha256: sha(2), revision: 2 });
    const session = new BoardSession(f.bridge, f.view);
    await session.start();
    await settle();
    expect(f.replacements).toEqual(["recovered text"]);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({ content: "recovered text", base: { baseSha256: sha(1), baseRevision: 1 } });
    expect(session.dirty).toBe(false);
    expect(journal.draft).toBeNull();
    expect(journal.revision).not.toBeNull();
    session.dispose();
  });

  test.each([true, false])("holds a recovered draft in conflict on base drift or incomplete capture (exact=%s)", async exact => {
    const f = createFixture(exact ? envelope("new remote version", 2) : undefined);
    const journal = recoveryFixture(record("recovered text", exact));
    f.bridge.recovery = journal.bridge;
    const session = new BoardSession(f.bridge, f.view);
    await session.start();
    await settle();
    expect(f.content).toBe("recovered text");
    expect(f.writes).toHaveLength(0);
    expect(f.statuses.at(-1)?.state).toBe("conflict");
    expect(session.canClose).toBe(false);
    expect(journal.draft?.content).toBe("recovered text");
    session.dispose();
  });

  test("a lost save acknowledgement restores the already saved file without a second write", async () => {
    const f = createFixture(envelope("already saved", 2));
    const journal = recoveryFixture(record("already saved"));
    f.bridge.recovery = journal.bridge;
    const session = new BoardSession(f.bridge, f.view);
    await session.start();
    await settle();
    expect(session.canClose).toBe(true);
    expect(f.writes).toHaveLength(0);
    expect(journal.draft).toBeNull();
    session.dispose();
  });

  test("an unfinished board operation remains visible even when its last snapshot equals the saved file", async () => {
    const f = createFixture();
    const journal = recoveryFixture(record("initial", false));
    f.bridge.recovery = journal.bridge;
    const session = new BoardSession(f.bridge, f.view);
    await session.start();
    await settle();
    expect(f.statuses.at(-1)?.state).toBe("conflict");
    expect(f.statuses.at(-1)?.message).toContain("unfinished operation");
    expect(journal.draft).toEqual(record("initial", false));
    expect(journal.writes).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
    expect(session.canClose).toBe(false);
    session.dispose();
  });

  test("explicit reload discards the journal only after the replacement is adopted", async () => {
    const f = createFixture(envelope("new remote", 2));
    const journal = recoveryFixture(record("old recovered draft"));
    f.bridge.recovery = journal.bridge;
    const session = new BoardSession(f.bridge, f.view);
    await session.start();
    await session.reload();
    await settle();
    expect(f.content).toBe("new remote");
    expect(journal.draft).toBeNull();
    expect(session.canClose).toBe(true);
    session.dispose();
  });

  test("preview never reads, writes or restores a private draft", async () => {
    const f = createFixture();
    const journal = recoveryFixture(record("private unsaved text"));
    f.bridge.context = { mode: "preview", set() {} };
    f.bridge.recovery = { ...journal.bridge, read: async () => { throw new Error("preview must not read"); } };
    const session = new BoardSession(f.bridge, f.view);
    await session.start();
    expect(f.content).toBe("initial");
    expect(journal.writes).toHaveLength(0);
    expect(f.statuses.at(-1)?.state).toBe("saved");
    session.dispose();
  });

  test.each([false, true])("save retries a failed journal opening without replacing a discovered older draft (older=%s)", async older => {
    const f = createFixture();
    const journal = recoveryFixture(older ? record("previous unsaved work") : null);
    let openingReads = 0;
    f.bridge.recovery = { ...journal.bridge, async read() {
      if (++openingReads === 1) throw new Error("temporary local storage failure");
      return journal.bridge.read();
    } };
    const session = new BoardSession(f.bridge, { ...f.view, recoverySnapshot: () => ({ content: "new focused text", exact: true }) });
    await session.start();
    session.setLocalEditing(true);
    session.changed();
    await session.save();
    await settle();
    expect(openingReads).toBe(2);
    expect(f.writes).toHaveLength(0);
    expect(journal.draft?.content).toBe(older ? "previous unsaved work" : "new focused text");
    if (older) {
      expect(journal.writes).toHaveLength(0);
      expect(f.statuses.at(-1)?.message).toContain("previous recovery copy");
    }
    session.dispose();
  });

  test("focused typing retries transient recovery opening without a blur or canonical save", async () => {
    const f = createFixture();
    const journal = recoveryFixture();
    const reopened = deferred<Awaited<ReturnType<typeof journal.bridge.read>>>();
    let openingReads = 0;
    f.bridge.recovery = { ...journal.bridge, async read() {
      if (++openingReads === 1) throw new Error("temporary opening failure");
      return reopened.promise;
    } };
    const session = new BoardSession(f.bridge, { ...f.view, recoverySnapshot: () => ({ content: "latest focused text", exact: true }) });
    await session.start();
    session.setLocalEditing(true);
    session.changed();
    session.changed();
    await settle();
    expect(openingReads).toBe(2);
    reopened.resolve({ revision: null, draft: null });
    await settle();
    expect(journal.draft?.content).toBe("latest focused text");
    expect(f.content).toBe("initial");
    expect(f.writes).toHaveLength(0);
    expect(session.canClose).toBe(false);
    session.dispose();
  });

  test("an acknowledged lifecycle copy clears recovery and does not restore into the original", async () => {
    const f = createFixture();
    const journal = recoveryFixture();
    f.bridge.recovery = journal.bridge;
    const session = new BoardSession(f.bridge, f.view);
    await session.start();
    session.setLocalEditing(true);
    f.setContent("copied unsaved draft");
    session.changed();
    await session.persistRecovery();
    expect(journal.draft?.content).toBe("copied unsaved draft");

    await session.saveCopy(() => session.setLocalEditing(false));
    expect(journal.draft?.content).toBe("copied unsaved draft");
    await session.finalizeRecoveryCopy("copied unsaved draft");
    expect(journal.draft).toBeNull();
    session.dispose();

    const reopened = createFixture();
    reopened.bridge.recovery = journal.bridge;
    const next = new BoardSession(reopened.bridge, reopened.view);
    await next.start();
    await settle();
    expect(reopened.content).toBe("initial");
    expect(reopened.writes).toHaveLength(0);
    next.dispose();
  });

  test("a notice copy retains recovery until lifecycle explicitly acknowledges it", async () => {
    const f = createFixture();
    const journal = recoveryFixture();
    f.bridge.recovery = journal.bridge;
    const session = new BoardSession(f.bridge, f.view);
    await session.start();
    session.setLocalEditing(true);
    f.setContent("keep journaling this notice copy");
    session.changed();
    await session.persistRecovery();

    await session.saveCopy(() => session.setLocalEditing(false));
    expect(journal.draft?.content).toBe("keep journaling this notice copy");
    session.dispose();
  });

  test("a failed recovery clear rejects close and a newer edit journals again", async () => {
    const f = createFixture();
    const journal = recoveryFixture();
    f.bridge.recovery = journal.bridge;
    const session = new BoardSession(f.bridge, f.view);
    await session.start();
    session.setLocalEditing(true);
    f.setContent("copied before clear failure");
    session.changed();
    await session.persistRecovery();
    await session.saveCopy(() => session.setLocalEditing(false));

    const write = journal.bridge.write;
    let failClear = true;
    journal.bridge.write = async input => {
      if (failClear && input.draft === null) {
        failClear = false;
        throw new Error("recovery disk unavailable");
      }
      return write(input);
    };
    await rejects(session.finalizeRecoveryCopy("copied before clear failure"), /recovery disk unavailable/);
    expect(journal.draft?.content).toBe("copied before clear failure");

    session.setLocalEditing(true);
    f.setContent("new edit after blocked close");
    session.changed();
    await session.persistRecovery();
    expect(journal.draft?.content).toBe("new edit after blocked close");
    session.dispose();
  });

  test("a delayed pre-copy snapshot cannot resurrect recovery after finalization", async () => {
    const f = createFixture();
    const journal = recoveryFixture();
    f.bridge.recovery = journal.bridge;
    const delayed = deferred<string>();
    let delayNextSnapshot = false;
    const view = { ...f.view, async snapshot() {
      if (delayNextSnapshot) {
        delayNextSnapshot = false;
        return delayed.promise;
      }
      return f.content;
    } };
    const session = new BoardSession(f.bridge, view);
    await session.start();
    session.setLocalEditing(true);
    await settle();
    f.setContent("copied while an old checkpoint waits");
    delayNextSnapshot = true;
    session.changed();
    await settle();

    await session.saveCopy(() => session.setLocalEditing(false));
    await session.finalizeRecoveryCopy("copied while an old checkpoint waits");
    expect(journal.draft).toBeNull();
    delayed.resolve("copied while an old checkpoint waits");
    await settle();
    expect(journal.draft).toBeNull();
    expect(journal.writes.at(-1)).toBeNull();
    session.dispose();
  });

  test("finalization checks copied content and generation even without a recovery bridge", async () => {
    const f = createFixture();
    const session = new BoardSession(f.bridge, f.view);
    await session.start();
    session.setLocalEditing(true);
    f.setContent("browser copy");
    session.changed();
    await session.saveCopy(() => session.setLocalEditing(false));
    await session.finalizeRecoveryCopy("browser copy");

    session.setLocalEditing(true);
    f.setContent("newer browser edit");
    session.changed();
    await rejects(session.finalizeRecoveryCopy("browser copy"), /changed after the recovery copy/);
    session.dispose();
  });

  test("finalization fails closed when a configured recovery bridge is not ready", async () => {
    const f = createFixture();
    const journal = recoveryFixture();
    f.bridge.recovery = { ...journal.bridge, read: async () => { throw new Error("recovery unavailable"); } };
    const session = new BoardSession(f.bridge, f.view);
    await session.start();
    await session.saveCopy();

    await rejects(session.finalizeRecoveryCopy("initial"), /Crash recovery is unavailable/);
    expect(journal.writes).toHaveLength(0);
    session.dispose();
  });
});

async function started(initial?: DocumentEnvelope) {
  const fixture = createFixture(initial);
  const session = new BoardSession(fixture.bridge, fixture.view);
  await session.start();
  fixture.replacements.length = 0;
  fixture.statuses.length = 0;
  fixture.labels.length = 0;
  return { fixture, session };
}

describe("BoardSession", () => {
  test("autosaves a changed document", async () => {
    const { fixture, session } = await started();
    fixture.setContent("draft");
    fixture.writeResults.push({ kind: "saved", sha256: sha(2), revision: 2 });

    session.changed();
    await settle();

    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]).toMatchObject({
      content: "draft",
      base: { baseSha256: sha(1), baseRevision: 1 },
    });
    expect(session.dirty).toBe(false);
    expect(fixture.statuses.at(-1)).toEqual({ state: "saved", message: undefined });
  });

  test("queues edits made during a pending save against the acknowledged revision", async () => {
    const { fixture, session } = await started();
    const first = deferred<WriteResult>();
    fixture.writeResults.push(first.promise, { kind: "saved", sha256: sha(3), revision: 3 });
    fixture.setContent("first draft");
    session.changed();
    await settle();
    expect(fixture.writes).toHaveLength(1);

    fixture.setContent("second draft");
    session.changed();
    first.resolve({ kind: "saved", sha256: sha(2), revision: 2 });
    await settle();

    expect(fixture.writes).toHaveLength(2);
    expect(fixture.writes[0]).toMatchObject({
      content: "first draft",
      base: { baseSha256: sha(1), baseRevision: 1 },
    });
    expect(fixture.writes[1]).toMatchObject({
      content: "second draft",
      base: { baseSha256: sha(2), baseRevision: 2 },
    });
    expect(session.dirty).toBe(false);
  });

  test("a stale conflict never retries or overwrites the local draft", async () => {
    const { fixture, session } = await started();
    fixture.setContent("local draft");
    fixture.writeResults.push({ kind: "conflict" });
    session.changed();
    await settle();

    session.changed();
    fixture.remote(envelope("remote replacement", 2));
    fixture.emit({ type: "changed" });
    await settle();

    expect(fixture.writes).toHaveLength(1);
    expect(fixture.content).toBe("local draft");
    expect(fixture.replacements).toEqual([]);
    expect(fixture.statuses.at(-1)?.state).toBe("conflict");
  });

  test("holds a local draft when a remote change arrives before autosave", async () => {
    const { fixture, session } = await started();
    fixture.setContent("local draft");
    fixture.remote(envelope("remote replacement", 2));

    session.changed();
    fixture.emit({ type: "changed" });
    await settle();

    expect(fixture.content).toBe("local draft");
    expect(fixture.replacements).toEqual([]);
    expect(fixture.writes).toEqual([]);
    expect(fixture.statuses.at(-1)?.state).toBe("conflict");
  });

  test("refuses a remote replacement while an admitted local edit is still active", async () => {
    const { fixture, session } = await started();
    fixture.setContent("editing draft");
    session.setLocalEditing(true);
    fixture.remote(envelope("remote replacement", 2));
    fixture.emit({ type: "changed" });
    await settle();

    expect(fixture.content).toBe("editing draft");
    expect(fixture.replacements).toEqual([]);
    expect(fixture.statuses.at(-1)?.state).toBe("conflict");
    expect(fixture.humanStates.at(-1)).toBe("conflict");
  });

  test("defers a dirty save until the admitted local edit becomes inactive", async () => {
    const { fixture, session } = await started();
    fixture.setContent("editing draft");
    fixture.writeResults.push({ kind: "saved", sha256: sha(2), revision: 2 });
    session.setLocalEditing(true);
    session.changed();
    await settle();

    expect(fixture.writes).toEqual([]);
    expect(fixture.humanStates.at(-1)).toBe("dirty");
    session.setLocalEditing(false);
    await settle();

    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]).toMatchObject({ content: "editing draft" });
    expect(session.dirty).toBe(false);
  });

  test("restores clean state without saving when an admitted edit makes no mutation", async () => {
    const { fixture, session } = await started();

    session.setLocalEditing(true);
    expect(fixture.humanStates.at(-1)).toBe("dirty");
    session.setLocalEditing(false);
    await settle();

    expect(session.dirty).toBe(false);
    expect(fixture.writes).toEqual([]);
    expect(fixture.statuses.at(-1)?.state).toBe("saved");
    expect(fixture.humanStates.at(-1)).toBe("clean");
  });

  test("refreshes a clean session from the authoritative read rather than an event envelope", async () => {
    const { fixture } = await started();
    fixture.remote(envelope("authoritative content", 7, "/Renamed.sheets"));

    fixture.emit({ type: "patch_applied", envelope: envelope("stale event content", 2) });
    await settle();

    expect(fixture.content).toBe("authoritative content");
    expect(fixture.replacements).toEqual(["authoritative content"]);
    expect(fixture.labels).toEqual(["/Renamed.sheets"]);
  });

  test("an echo event does not discard a newer local draft", async () => {
    const { fixture, session } = await started();
    fixture.writeResults.push({ kind: "saved", sha256: sha(2), revision: 2 });
    fixture.setContent("saved draft");
    session.changed();
    await settle();
    fixture.remote(envelope("saved draft", 2));

    fixture.setContent("newer local draft");
    session.changed();
    fixture.emit({ type: "changed" });
    await settle();

    expect(fixture.content).toBe("newer local draft");
    expect(fixture.replacements).toEqual([]);
  });

  test("preserves newer edits and blocks when persisted content differs from the submitted snapshot", async () => {
    const { fixture, session } = await started();
    const pending = deferred<WriteResult>();
    fixture.writeResults.push(pending.promise);
    fixture.setContent("submitted draft");
    session.changed();
    await settle();
    fixture.setContent("newer local draft");
    session.changed();

    pending.resolve({ kind: "saved", sha256: sha(2), revision: 2, persistedContent: "normalized remote content" });
    await settle();

    expect(fixture.content).toBe("newer local draft");
    expect(fixture.replacements).toEqual([]);
    expect(fixture.statuses.at(-1)?.state).toBe("conflict");
  });

  test("retains dirty state after a failed save and lets an explicit retry succeed", async () => {
    const { fixture, session } = await started();
    fixture.setContent("draft");
    fixture.writeResults.push(
      { kind: "error", message: "disk full" },
      { kind: "saved", sha256: sha(2), revision: 2 },
    );
    session.changed();
    await settle();

    expect(session.dirty).toBe(true);
    expect(fixture.statuses.at(-1)).toEqual({ state: "error", message: "disk full" });
    await session.save();

    expect(fixture.writes).toHaveLength(2);
    expect(session.dirty).toBe(false);
    expect(fixture.statuses.at(-1)?.state).toBe("saved");
  });

  test("retries a transient failed save when a document signal confirms unchanged authority", async () => {
    const { fixture, session } = await started();
    fixture.setContent("draft");
    fixture.writeResults.push(
      { kind: "error", message: "relay unavailable" },
      { kind: "saved", sha256: sha(2), revision: 2 },
    );
    session.changed();
    await settle();

    expect(fixture.writes).toHaveLength(1);
    fixture.emit({ type: "changed" });
    await settle();

    expect(fixture.writes).toHaveLength(2);
    expect(fixture.writes[1]).toMatchObject({
      content: "draft",
      base: { baseSha256: sha(1), baseRevision: 1 },
    });
    expect(session.dirty).toBe(false);
    expect(fixture.statuses.at(-1)?.state).toBe("saved");
  });

  test("acknowledges an uncertain write when fresh authority contains the failed submission", async () => {
    const { fixture, session } = await started();
    fixture.setContent("committed despite disconnect");
    fixture.writeResults.push(Promise.reject(new Error("connection closed")));
    session.changed();
    await settle();

    fixture.remote(envelope("committed despite disconnect", 2));
    fixture.emit({ type: "changed" });
    await settle();

    expect(fixture.writes).toHaveLength(1);
    expect(fixture.replacements).toEqual([]);
    expect(session.dirty).toBe(false);
    expect(fixture.statuses.at(-1)?.state).toBe("saved");
  });

  test("blocks after a failed save when fresh authority contains a concurrent write", async () => {
    const { fixture, session } = await started();
    fixture.setContent("local draft");
    fixture.writeResults.push({ kind: "error", message: "relay unavailable" });
    session.changed();
    await settle();

    fixture.remote(envelope("someone else's change", 2));
    fixture.emit({ type: "changed" });
    await settle();

    expect(fixture.writes).toHaveLength(1);
    expect(fixture.content).toBe("local draft");
    expect(fixture.replacements).toEqual([]);
    expect(session.dirty).toBe(true);
    expect(fixture.statuses.at(-1)?.state).toBe("conflict");
  });

  test("acknowledging an uncertain save does not clear or replace an active raw draft", async () => {
    const { fixture, session } = await started();
    fixture.setContent("submitted content");
    fixture.writeResults.push({ kind: "error", message: "relay unavailable" });
    session.changed();
    await settle();

    session.setLocalEditing(true);
    fixture.setContent("submitted content plus raw draft");
    fixture.remote(envelope("submitted content", 2));
    fixture.emit({ type: "changed" });
    await settle();

    expect(fixture.content).toBe("submitted content plus raw draft");
    expect(fixture.replacements).toEqual([]);
    expect(fixture.writes).toHaveLength(1);
    expect(session.dirty).toBe(false);
    expect(fixture.humanStates.at(-1)).toBe("dirty");
  });

  test("saves a host copy without writing the open document", async () => {
    const { fixture, session } = await started();
    fixture.setContent("copy this draft");

    await session.saveCopy();

    expect(fixture.copies).toEqual(["copy this draft"]);
    expect(fixture.writes).toEqual([]);
    expect(fixture.statuses.at(-1)).toEqual({
      state: "saved",
      message: "Copy saved as Recovery.board.html. Your open file is unchanged.",
    });
  });

  test("a failed host copy keeps the draft and does not report success", async () => {
    const { fixture, session } = await started();
    fixture.setContent("keep this draft");
    fixture.bridge.document.saveCopy = async () => { throw new Error("Folder unavailable"); };
    await rejects(session.saveCopy(), /Folder unavailable/);
    expect(fixture.content).toBe("keep this draft");
    expect(fixture.copies).toHaveLength(0);
    expect(fixture.statuses.at(-1)).toEqual({ state: "error", message: "Folder unavailable" });
  });

  test("ignores document events after disposal", async () => {
    const { fixture, session } = await started();
    const readsBeforeDispose = fixture.reads;
    session.dispose();
    fixture.remote(envelope("remote replacement", 2));
    fixture.emit({ type: "changed" });
    await settle();

    expect(fixture.unsubscribeCalls).toBe(1);
    expect(fixture.reads).toBe(readsBeforeDispose);
    expect(fixture.replacements).toEqual([]);
    expect(fixture.statuses).toEqual([]);
  });

  test("unsubscribes and does not touch the view when disposed during its initial read", async () => {
    const fixture = createFixture();
    const initialRead = deferred<DocumentEnvelope>();
    fixture.readResults.push(initialRead.promise);
    const session = new BoardSession(fixture.bridge, fixture.view);

    const start = session.start();
    await settle();
    expect(fixture.reads).toBe(1);
    session.dispose();
    initialRead.resolve(envelope("late initial document", 2));
    await start;

    expect(fixture.subscriptions).toBe(1);
    expect(fixture.unsubscribeCalls).toBe(1);
    expect(fixture.replacements).toEqual([]);
    expect(fixture.labels).toEqual([]);
    expect(fixture.statuses).toEqual([]);
    expect(fixture.humanStates).toEqual([]);
  });

  test("keeps remote subscription after a failed opening and successful retry", async () => {
    const fixture = createFixture();
    const session = new BoardSession(fixture.bridge, fixture.view);
    fixture.readResults.push(Promise.reject(new Error("offline")));
    expect(session.start()).rejects.toThrow("offline");
    await session.reload();
    fixture.remote(envelope("remote after retry", 2));
    fixture.emit({ type: "changed" });
    await settle();
    expect(fixture.content).toBe("remote after retry");
    expect(fixture.subscriptions).toBe(1);
    session.dispose();
    expect(fixture.unsubscribeCalls).toBe(1);
  });

  test("does not call the view after disposal while a save is in flight", async () => {
    const { fixture, session } = await started();
    const pendingWrite = deferred<WriteResult>();
    fixture.writeResults.push(pendingWrite.promise);
    fixture.setContent("draft");
    session.changed();
    await settle();
    expect(fixture.writes).toHaveLength(1);
    const callsAtDispose = {
      labels: fixture.labels.length,
      replacements: fixture.replacements.length,
      snapshots: fixture.snapshotCalls,
      statuses: fixture.statuses.length,
      humanStates: fixture.humanStates.length,
    };

    session.dispose();
    pendingWrite.resolve({
      kind: "saved",
      sha256: sha(2),
      revision: 2,
      persistedContent: "canonical draft",
    });
    await settle();

    expect(fixture.labels).toHaveLength(callsAtDispose.labels);
    expect(fixture.replacements).toHaveLength(callsAtDispose.replacements);
    expect(fixture.snapshotCalls).toBe(callsAtDispose.snapshots);
    expect(fixture.statuses).toHaveLength(callsAtDispose.statuses);
    expect(fixture.humanStates).toHaveLength(callsAtDispose.humanStates);
  });
});


for (const persistedContent of ["submitted", "canonical changed"]) {
  test(`protects a newly active raw draft while save acknowledges ${persistedContent}`, async () => {
    const { fixture, session } = await started();
    const pending = deferred<WriteResult>();
    fixture.writeResults.push(pending.promise);
    fixture.setContent("submitted"); session.changed();
    await settle();
    expect(fixture.writes).toHaveLength(1);
    session.setLocalEditing(true);
    pending.resolve({ kind: "saved", sha256: sha(2), revision: 2, persistedContent });
    await settle();
    expect(fixture.replacements).toEqual([]);
    expect(session.canClose).toBe(false);
    expect(fixture.statuses.at(-1)?.state).toBe(persistedContent === "submitted" ? "unsaved" : "conflict");
    session.dispose();
  });
}
