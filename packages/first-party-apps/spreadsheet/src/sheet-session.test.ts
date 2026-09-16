import { describe, expect, test } from "bun:test";
import type { DocumentChange, DocumentEnvelope, SheetsBridge, WriteResult } from "./sheet-bridge";
import { SheetSession } from "./sheet-session";
import type { SheetsShellStatus } from "./sheets-shell";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function envelope(content: string, revision: number, path = "/Budget.sheets"): DocumentEnvelope {
  return { content, baseSha256: `sha-${revision}`, baseRevision: revision, path };
}

async function settle(): Promise<void> {
  for (let step = 0; step < 12; step += 1) await Promise.resolve();
}

function createFixture(initial = envelope("initial", 1)) {
  let remote = initial;
  let handler: ((event: DocumentChange) => void) | undefined;
  const writes: Array<{ content: string; base: Pick<DocumentEnvelope, "baseSha256" | "baseRevision"> }> = [];
  const copies: string[] = [];
  const replacements: string[] = [];
  const statuses: Array<{ state: SheetsShellStatus; message?: string }> = [];
  const labels: Array<string | undefined> = [];
  const humanStates: string[] = [];
  const readResults: Array<DocumentEnvelope | Promise<DocumentEnvelope>> = [];
  const writeResults: Array<WriteResult | Promise<WriteResult>> = [];
  let reads = 0;
  let snapshotCalls = 0;
  let subscriptions = 0;
  let unsubscribeCalls = 0;
  let content = initial.content;

  const bridge: SheetsBridge = {
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
    status: (state: SheetsShellStatus, message?: string) => { statuses.push({ state, message }); },
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

async function started(initial?: DocumentEnvelope) {
  const fixture = createFixture(initial);
  const session = new SheetSession(fixture.bridge, fixture.view);
  await session.start();
  fixture.replacements.length = 0;
  fixture.statuses.length = 0;
  fixture.labels.length = 0;
  return { fixture, session };
}

describe("SheetSession", () => {
  test("autosaves a changed document", async () => {
    const { fixture, session } = await started();
    fixture.setContent("draft");
    fixture.writeResults.push({ kind: "saved", sha256: "sha-2", revision: 2 });

    session.changed();
    await settle();

    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]).toMatchObject({
      content: "draft",
      base: { baseSha256: "sha-1", baseRevision: 1 },
    });
    expect(session.dirty).toBe(false);
    expect(fixture.statuses.at(-1)).toEqual({ state: "saved", message: undefined });
  });

  test("queues edits made during a pending save against the acknowledged revision", async () => {
    const { fixture, session } = await started();
    const first = deferred<WriteResult>();
    fixture.writeResults.push(first.promise, { kind: "saved", sha256: "sha-3", revision: 3 });
    fixture.setContent("first draft");
    session.changed();
    await settle();
    expect(fixture.writes).toHaveLength(1);

    fixture.setContent("second draft");
    session.changed();
    first.resolve({ kind: "saved", sha256: "sha-2", revision: 2 });
    await settle();

    expect(fixture.writes).toHaveLength(2);
    expect(fixture.writes[0]).toMatchObject({
      content: "first draft",
      base: { baseSha256: "sha-1", baseRevision: 1 },
    });
    expect(fixture.writes[1]).toMatchObject({
      content: "second draft",
      base: { baseSha256: "sha-2", baseRevision: 2 },
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
    fixture.writeResults.push({ kind: "saved", sha256: "sha-2", revision: 2 });
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
    fixture.writeResults.push({ kind: "saved", sha256: "sha-2", revision: 2 });
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

    pending.resolve({ kind: "saved", sha256: "sha-2", revision: 2, persistedContent: "normalized remote content" });
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
      { kind: "saved", sha256: "sha-2", revision: 2 },
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
      { kind: "saved", sha256: "sha-2", revision: 2 },
    );
    session.changed();
    await settle();

    expect(fixture.writes).toHaveLength(1);
    fixture.emit({ type: "changed" });
    await settle();

    expect(fixture.writes).toHaveLength(2);
    expect(fixture.writes[1]).toMatchObject({
      content: "draft",
      base: { baseSha256: "sha-1", baseRevision: 1 },
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

  test("downloads a snapshot without writing the open document", async () => {
    const { fixture, session } = await started();
    fixture.setContent("copy this draft");

    await session.downloadCopy();

    expect(fixture.copies).toEqual(["copy this draft"]);
    expect(fixture.writes).toEqual([]);
    expect(fixture.statuses.at(-1)).toEqual({
      state: "saved",
      message: "Copy downloaded. Your open file is unchanged.",
    });
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

  test("does not subscribe or touch the view when disposed during its initial read", async () => {
    const fixture = createFixture();
    const initialRead = deferred<DocumentEnvelope>();
    fixture.readResults.push(initialRead.promise);
    const session = new SheetSession(fixture.bridge, fixture.view);

    const start = session.start();
    await settle();
    expect(fixture.reads).toBe(1);
    session.dispose();
    initialRead.resolve(envelope("late initial document", 2));
    await start;

    expect(fixture.subscriptions).toBe(0);
    expect(fixture.replacements).toEqual([]);
    expect(fixture.labels).toEqual([]);
    expect(fixture.statuses).toEqual([]);
    expect(fixture.humanStates).toEqual([]);
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
      sha256: "sha-2",
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
