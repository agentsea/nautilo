import { describe, expect, test } from "bun:test";
import { createTableBlock } from "@nautilo/office-docs/node";
import { applyAnchoredTextPatch, type AnchoredTextPatch } from "@nautilo/types";
import { NautiloDocStore, type NautiloDocStoreDeps } from "./nautilo-doc-store";
import {
  createEmptyWriterHtml,
  parseWriterHtml,
  createDefaultManifest,
  serializeWriterHtml,
  type WriterHtmlManifest,
} from "./office-document";

type Write = { container: string; patch: AnchoredTextPatch; baseSha256: string };

/**
 * Minimal store stand-in for isolated flush/rebase wiring. The real owned
 * MemDocStore contract is exercised separately in owned-doc-store.test.ts.
 */
function fakeInnerFactory(history: { snapshots: number } = { snapshots: 0 }) {
  return (doc: { blocks: unknown[] }) => {
    let current: { blocks: unknown[] } = { blocks: [...(doc.blocks ?? [])] };
    const undoStack: Array<{ blocks: unknown[] }> = [];
    const redoStack: Array<{ blocks: unknown[] }> = [];
    return {
      getDocument: () => ({ blocks: [...current.blocks] }),
      setDocument: (d: { blocks: unknown[] }) => {
        current = { blocks: [...(d.blocks ?? [])] };
      },
      insertBlock: (index: number, block: unknown) => {
        current.blocks.splice(index, 0, block);
      },
      snapshot: () => {
        history.snapshots += 1;
        undoStack.push(structuredClone(current));
        redoStack.length = 0;
      },
      canUndo: () => undoStack.length > 0,
      canRedo: () => redoStack.length > 0,
      undo: () => {
        const previous = undoStack.pop();
        if (!previous) return;
        redoStack.push(structuredClone(current));
        current = previous;
      },
      redo: () => {
        const next = redoStack.pop();
        if (!next) return;
        undoStack.push(structuredClone(current));
        current = next;
      },
    } as unknown as ReturnType<NautiloDocStoreDeps["createStore"]>;
  };
}

function normalizingInnerFactory() {
  const normalize = (doc: { blocks: Array<Record<string, unknown>> }) => ({
    ...structuredClone(doc),
    blocks: doc.blocks.map((block) => ({
      ...structuredClone(block),
      style: { alignment: "left", ...(block.style as Record<string, unknown> | undefined) },
    })),
  });
  return (doc: { blocks: Array<Record<string, unknown>> }) => {
    let current = normalize(doc);
    return {
      getDocument: () => structuredClone(current),
      setDocument: (next: { blocks: Array<Record<string, unknown>> }) => {
        current = normalize(next);
      },
      snapshot: () => undefined,
    } as unknown as ReturnType<NautiloDocStoreDeps["createStore"]>;
  };
}

function makeStore(
  initial: string | null,
  onLocalChange?: () => void,
  writePatch?: (write: Write) => void | boolean | Promise<void | boolean>,
  debounceMs = 0,
  onPersisted?: (state: { dirty: boolean }) => void,
) {
  const writes: Write[] = [];
  const history = { snapshots: 0 };
  const store = new NautiloDocStore(initial, {
    createStore: fakeInnerFactory(history),
    writePatch: (w) => {
      writes.push(w);
      return writePatch?.(w);
    },
    debounceMs,
    ...(onLocalChange ? { onLocalChange } : {}),
    ...(onPersisted ? { onPersisted } : {}),
  });
  return { store, writes, history };
}

const flushWait = () => new Promise((r) => setTimeout(r, 5));

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

function docWith(text: string): string {
  const block = { id: "b1", type: "paragraph", inlines: [{ text, style: {} }] };
  return serializeWriterHtml(createDefaultManifest(), { blocks: [block] });
}

function testManifest(): WriterHtmlManifest {
  const manifest = createDefaultManifest();
  manifest.metadata = { createdBy: "writer-store-test", updatedAt: "2026-01-01T00:00:00.000Z" };
  return manifest;
}

function docWithBlocks(texts: readonly string[], manifest = testManifest()): string {
  return serializeWriterHtml(manifest, {
    blocks: texts.map((text, index) => ({
      id: `b${index + 1}`,
      type: "paragraph",
      inlines: [{ text, style: {} }],
    })),
  });
}

function blocksWithTexts(texts: readonly string[]) {
  return {
    blocks: texts.map((text, index) => ({
      id: `b${index + 1}`,
      type: "paragraph",
      inlines: [{ text, style: {} }],
    })),
  };
}

function currentBlockTexts(store: NautiloDocStore): string[] {
  return (store.getDocument().blocks as Array<{ inlines: Array<{ text: string }> }>).map(
    (block) => block.inlines.map((inline) => inline.text).join(""),
  );
}

function tableDocument() {
  const table = createTableBlock(2, 2);
  table.id = "table";
  for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
    const cell = table.tableData!.rows[row]!.cells[col]!;
    cell.blocks[0]!.id = `table-${row}-${col}`;
    cell.blocks[0]!.inlines = [{ text: `${row}:${col}`, style: {} }];
  }
  return { blocks: [table] };
}

describe("NautiloDocStore", () => {
  test("a mutation flushes a patch through the bridge", async () => {
    const { store, writes } = makeStore(createEmptyWriterHtml());
    await store.initBase();
    store.insertBlock(0, { id: "b1", type: "paragraph", inlines: [{ text: "hello", style: {} }] } as never);
    await flushWait();
    expect(writes.length).toBe(1);
    expect(writes[0]!.patch.kind).toBe("anchored_text");
    const parsed = parseWriterHtml(writes[0]!.container);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.document.document.blocks).toHaveLength(1);
  });

  test("preserves unique block IDs through container parse and M193-style patch reparse after a move", async () => {
    const originalBlocks = [
      {
        id: "paragraph-intro",
        type: "paragraph",
        inlines: [
          { text: "A ", style: {} },
          { text: "formatted", style: { bold: true, italic: true } },
          { text: " paragraph.", style: {} },
        ],
        style: {},
      },
      {
        id: "heading-review",
        type: "heading",
        headingLevel: 2,
        inlines: [{ text: "Review heading", style: { underline: true } }],
        style: {},
      },
      {
        id: "list-decision",
        type: "list-item",
        listKind: "ordered",
        listLevel: 0,
        inlines: [{ text: "Keep this list item.", style: {} }],
        style: {},
      },
    ];
    const base = serializeWriterHtml(createDefaultManifest(), { blocks: originalBlocks });
    const initial = parseWriterHtml(base);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;

    expect(initial.document.document.blocks.map((block) => (block as { id: string }).id)).toEqual([
      "paragraph-intro",
      "heading-review",
      "list-decision",
    ]);
    expect(new Set(initial.document.document.blocks.map((block) => (block as { id: string }).id)).size).toBe(3);

    const { store, writes } = makeStore(base);
    await store.initBase();
    // A structural move reorders the existing block object; it must not mint an ID.
    store.setDocument({
      blocks: [originalBlocks[2], originalBlocks[0], originalBlocks[1]],
    } as never);
    await store.flush();

    expect(writes).toHaveLength(1);
    expect(writes[0]?.patch.kind).toBe("anchored_text");
    const applied = applyAnchoredTextPatch(base, writes[0]!.patch);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.text).toBe(writes[0]!.container);

    const reparsed = parseWriterHtml(applied.text);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const blocks = reparsed.document.document.blocks as Array<{
      id: string;
      type: string;
      inlines: Array<{ text: string; style: Record<string, unknown> }>;
    }>;
    expect(blocks.map((block) => block.id)).toEqual([
      "list-decision",
      "paragraph-intro",
      "heading-review",
    ]);
    expect(new Set(blocks.map((block) => block.id)).size).toBe(3);
    expect(blocks.find((block) => block.id === "paragraph-intro")?.inlines[1]).toEqual({
      text: "formatted",
      style: { bold: true, italic: true },
    });
    expect(blocks.find((block) => block.id === "heading-review")?.type).toBe("heading");
    expect(blocks.find((block) => block.id === "list-decision")?.type).toBe("list-item");
  });

  test("fires onLocalChange synchronously on every local mutation (before the debounced flush)", async () => {
    let calls = 0;
    const { store } = makeStore(createEmptyWriterHtml(), () => {
      calls += 1;
    });
    await store.initBase();
    store.insertBlock(0, { id: "b1", type: "paragraph", inlines: [{ text: "a", style: {} }] } as never);
    // Fires synchronously in touch(), not on the debounced flush.
    expect(calls).toBe(1);
    store.insertBlock(1, { id: "b2", type: "paragraph", inlines: [{ text: "b", style: {} }] } as never);
    expect(calls).toBe(2);
  });

  test("publishes an exact dirty draft patch and clears it after persistence", async () => {
    const base = createEmptyWriterHtml();
    const { store } = makeStore(base);
    await store.initBase();
    expect(store.humanEditDraftPatch()).toBeUndefined();

    store.insertBlock(0, { id: "b1", type: "paragraph", inlines: [{ text: "human", style: {} }] } as never);
    const patch = store.humanEditDraftPatch();
    expect(patch).toBeDefined();
    const applied = applyAnchoredTextPatch(base, patch!);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      const parsed = parseWriterHtml(applied.text);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.document.document.blocks[0]?.id).toBe("b1");
    }

    await store.flush();
    expect(store.humanEditDraftPatch()).toBeUndefined();
  });

  test("an edit arriving during persistence remains dirty after the accepted snapshot", async () => {
    let releaseWrite: (() => void) | undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const persisted: Array<{ dirty: boolean }> = [];
    const { store } = makeStore(
      createEmptyWriterHtml(),
      undefined,
      async () => {
        await writeGate;
      },
      60_000,
      (state) => persisted.push(state),
    );
    await store.initBase();
    store.insertBlock(0, { id: "b1", type: "paragraph", inlines: [{ text: "first", style: {} }] } as never);
    const saving = store.flush();
    await Promise.resolve();
    store.insertBlock(1, { id: "b2", type: "paragraph", inlines: [{ text: "second", style: {} }] } as never);
    releaseWrite?.();
    await saving;

    expect(persisted).toEqual([{ dirty: true }]);
    expect(store.humanEditDraftPatch()).toBeDefined();
    await store.flush();
  });

  test("serializes a follow-up save against the canonical receipt-confirmed base", async () => {
    let releaseWrite: (() => void) | undefined;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let firstWrite = true;
    const { store, writes } = makeStore(
      createEmptyWriterHtml(),
      undefined,
      async () => {
        if (!firstWrite) return true;
        firstWrite = false;
        await firstWriteGate;
        return true;
      },
      60_000,
    );
    await store.initBase();
    store.insertBlock(0, { id: "b1", type: "paragraph", inlines: [{ text: "first", style: {} }] } as never);
    const firstSave = store.flush();
    await Promise.resolve();
    expect(writes).toHaveLength(1);

    store.insertBlock(1, { id: "b2", type: "paragraph", inlines: [{ text: "second", style: {} }] } as never);
    const followUpSave = store.flush();
    expect(writes).toHaveLength(1);

    releaseWrite?.();
    await firstSave;
    await followUpSave;

    expect(writes).toHaveLength(2);
    expect(writes[1]!.baseSha256).toBe(await sha256(writes[0]!.container));
  });

  test("no-op flush does not write", async () => {
    const { store, writes } = makeStore(createEmptyWriterHtml());
    await store.initBase();
    await store.flush();
    expect(writes.length).toBe(0);
  });

  test("applyRemotePatch with no local edits loads remote (no rebase)", async () => {
    const { store } = makeStore(createEmptyWriterHtml());
    await store.initBase();
    const res = store.applyRemotePatch(docWith("from peer"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rebased).toBe(false);
    expect(store.getDocument().blocks).toHaveLength(1);
  });

  test("an immediate Human flush after superseding remote updates uses the latest exact SHA", async () => {
    const { store, writes } = makeStore(docWith("original"));
    await store.initBase();
    store.applyRemotePatch(docWith("first peer"));
    const remote = docWith("latest peer");
    store.applyRemotePatch(remote);
    store.insertBlock(1, { id: "human", type: "paragraph", inlines: [{ text: "Human addition", style: {} }] } as never);
    await store.flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.baseSha256).toBe(await sha256(remote));
    expect(applyAnchoredTextPatch(remote, writes[0]!.patch)).toEqual({ ok: true, text: writes[0]!.container });
  });

  test("identical non-canonical remote events do not become phantom Human drafts", async () => {
    const remote = docWith("from peer").replace("<title>Document</title>", "<title>Older Writer document</title>");
    const writes: Write[] = [];
    const store = new NautiloDocStore(createEmptyWriterHtml(), {
      createStore: normalizingInnerFactory(),
      writePatch: (write) => { writes.push(write); },
      debounceMs: 60_000,
    });
    await store.initBase();

    expect(store.applyRemotePatch(remote)).toEqual({ ok: true, rebased: false });
    expect(store.hasUnsavedLocalEdits()).toBe(false);
    expect(store.humanEditDraftPatch()).toBeUndefined();
    await store.flush();
    expect(writes).toHaveLength(0);
    expect(store.applyRemotePatch(remote)).toEqual({ ok: true, rebased: false });
    expect(store.hasUnsavedLocalEdits()).toBe(false);

    const base = structuredClone(store.getDocument());
    const prepared = store.prepareAcceptedContent(base, [{
      kind: "replace",
      blockId: "b1",
      scope: { kind: "range", start: 0, end: 4 },
      range: { start: 0, end: 4 },
      text: "FROM",
    }] as never);
    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) return;
    const accepted = parseWriterHtml(prepared.content);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.document.document.blocks[0]?.style).toBeUndefined();
    expect(accepted.document.document.blocks[0]?.inlines.map((inline) => inline.text).join("")).toBe("FROM peer");

    await new Promise((resolve) => setTimeout(resolve, 0));
    const edited = structuredClone(store.getDocument()) as { blocks: Array<{ inlines: Array<{ text: string }> }> };
    edited.blocks[0]!.inlines[0]!.text = "human edit";
    store.setDocument(edited as never);
    await store.flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.baseSha256).toBe(await sha256(remote));
    const applied = applyAnchoredTextPatch(remote, writes[0]!.patch);
    expect(applied).toEqual({ ok: true, text: writes[0]!.container });
  });

  test("non-canonical remote baselines preserve real Human edits through rebase and exact wire patches", async () => {
    const base = docWithBlocks(["one", "two"]).replace(
      "<title>Document</title>",
      "<title>Older Writer document</title>",
    );
    const remote = docWithBlocks(["one", "agent two"]).replace(
      "<title>Document</title>",
      "<title>Older Writer document</title>",
    );
    const writes: Write[] = [];
    const store = new NautiloDocStore(createEmptyWriterHtml(), {
      createStore: normalizingInnerFactory(),
      writePatch: (write) => { writes.push(write); },
      debounceMs: 60_000,
    });
    await store.initBase();
    expect(store.applyRemotePatch(base)).toEqual({ ok: true, rebased: false });

    const human = structuredClone(store.getDocument()) as { blocks: Array<{ inlines: Array<{ text: string }> }> };
    human.blocks[0]!.inlines[0]!.text = "human one";
    store.setDocument(human as never);
    expect(store.applyRemotePatch(remote)).toEqual({ ok: true, rebased: true });
    expect(currentBlockTexts(store)).toEqual(["human one", "agent two"]);
    expect(store.hasUnsavedLocalEdits()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.baseSha256).toBe(await sha256(remote));
    expect(applyAnchoredTextPatch(remote, writes[0]!.patch)).toEqual({
      ok: true,
      text: writes[0]!.container,
    });
  });

  test("a non-canonical remote postimage equal to the Human draft becomes clean", async () => {
    const base = docWith("before").replace("<title>Document</title>", "<title>Older Writer document</title>");
    const remote = docWith("same outcome").replace("<title>Document</title>", "<title>Older Writer document</title>");
    const store = new NautiloDocStore(createEmptyWriterHtml(), {
      createStore: normalizingInnerFactory(),
      writePatch: () => undefined,
      debounceMs: 60_000,
    });
    await store.initBase();
    expect(store.applyRemotePatch(base)).toEqual({ ok: true, rebased: false });

    const human = structuredClone(store.getDocument()) as { blocks: Array<{ inlines: Array<{ text: string }> }> };
    human.blocks[0]!.inlines[0]!.text = "same outcome";
    store.setDocument(human as never);
    expect(store.applyRemotePatch(remote)).toEqual({ ok: true, rebased: false });
    expect(store.hasUnsavedLocalEdits()).toBe(false);
    expect(store.humanEditDraftPatch()).toBeUndefined();
  });

  test("applyRemotePatch reapplies local dirty edits when the anchor survives in remote", async () => {
    const base = createEmptyWriterHtml();
    const { store } = makeStore(base);
    await store.initBase();
    // local dirty edit not yet flushed
    store.insertBlock(0, { id: "b1", type: "paragraph", inlines: [{ text: "local", style: {} }] } as never);
    // remote arrives unchanged vs base → local edit's anchor is present → rebase applies
    const res = store.applyRemotePatch(base);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rebased).toBe(true);
    expect(store.getDocument().blocks).toHaveLength(1);
  });

  test("applyRemotePatch surfaces a conflict when the local anchor is gone from remote", async () => {
    const { store } = makeStore(createEmptyWriterHtml());
    await store.initBase();
    store.insertBlock(0, { id: "b1", type: "paragraph", inlines: [{ text: "local", style: {} }] } as never);
    // an unrelated remote container — the local anchor no longer matches → conflict
    const res = store.applyRemotePatch(docWith("totally different remote content"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("conflict");
    // Conflict never installs remote text over the dirty human draft.
    expect(currentBlockTexts(store)).toEqual(["local"]);
    expect(store.hasUnsavedLocalEdits()).toBe(true);
  });

  test("applyRemotePatch rebases disjoint multi-hunk human drafts and keeps them dirty", async () => {
    const base = docWithBlocks(["one", "two", "three", "four"]);
    const { store, writes } = makeStore(base);
    await store.initBase();

    // Two human edits force the general merge path rather than a single
    // contiguous anchored replacement.
    store.setDocument(blocksWithTexts(["human one", "two", "three", "human four"]) as never);
    const res = store.applyRemotePatch(docWithBlocks(["one", "agent two", "three", "four"]));

    expect(res).toEqual({ ok: true, rebased: true });
    expect(currentBlockTexts(store)).toEqual(["human one", "agent two", "three", "human four"]);
    // Rebased text is a local human draft against the remote postimage, not a
    // newly saved document and not an implicit agent/human write.
    expect(store.hasUnsavedLocalEdits()).toBe(true);
    expect(writes).toHaveLength(0);
  });

  test("applyRemotePatch preserves an overlapping human draft without conflict markers", async () => {
    const base = docWithBlocks(["same", "untouched"]);
    const { store, writes } = makeStore(base);
    await store.initBase();
    store.setDocument(blocksWithTexts(["human wording", "untouched"]) as never);

    const res = store.applyRemotePatch(docWithBlocks(["agent wording", "untouched"]));

    expect(res).toEqual({ ok: false, reason: "conflict" });
    expect(currentBlockTexts(store)).toEqual(["human wording", "untouched"]);
    expect(store.hasUnsavedLocalEdits()).toBe(true);
    expect(writes).toHaveLength(0);
  });

  test("overlap → Reload latest explicitly installs the remote postimage and discards the human draft", async () => {
    const base = docWithBlocks(["same", "untouched"]);
    const remote = docWithBlocks(["agent wording", "untouched"]);
    const { store } = makeStore(base);
    await store.initBase();
    store.setDocument(blocksWithTexts(["human wording", "untouched"]) as never);

    expect(store.applyRemotePatch(remote)).toEqual({ ok: false, reason: "conflict" });
    expect(store.installAcceptedContent(remote, await sha256(remote))).toEqual({ ok: true, rebased: false });
    expect(currentBlockTexts(store)).toEqual(["agent wording", "untouched"]);
    expect(store.hasUnsavedLocalEdits()).toBe(false);
  });

  test("overlap → Keep mine retains the pre-conflict base instead of writing against the remote", async () => {
    const base = docWithBlocks(["same", "untouched"]);
    const remote = docWithBlocks(["agent wording", "untouched"]);
    const { store, writes } = makeStore(base);
    await store.initBase();
    store.setDocument(blocksWithTexts(["human wording", "untouched"]) as never);

    expect(store.applyRemotePatch(remote)).toEqual({ ok: false, reason: "conflict" });
    await store.flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.baseSha256).toBe(await sha256(base));
    expect(writes[0]?.baseSha256).not.toBe(await sha256(remote));
    expect(currentBlockTexts(store)).toEqual(["human wording", "untouched"]);
  });

  test("applyRemotePatch preserves Unicode and CRLF/LF exactly across disjoint edits", async () => {
    const base = docWithBlocks(["α\r\nbeta", "middle", "尾\nline"]);
    const { store } = makeStore(base);
    await store.initBase();
    store.setDocument(blocksWithTexts(["α\r\nhuman beta", "middle", "尾\nline"]) as never);

    const res = store.applyRemotePatch(docWithBlocks(["α\r\nbeta", "middle", "尾\nagent line"]));

    expect(res).toEqual({ ok: true, rebased: true });
    expect(currentBlockTexts(store)).toEqual(["α\r\nhuman beta", "middle", "尾\nagent line"]);
    expect(store.hasUnsavedLocalEdits()).toBe(true);
  });

  test("applyRemotePatch clears the dirty draft when the agent produced the identical payload", async () => {
    const base = docWithBlocks(["before"]);
    const identicalPostimage = docWithBlocks(["same outcome"]);
    const { store } = makeStore(base);
    await store.initBase();
    store.setDocument(blocksWithTexts(["same outcome"]) as never);

    expect(store.applyRemotePatch(identicalPostimage)).toEqual({ ok: true, rebased: false });
    expect(currentBlockTexts(store)).toEqual(["same outcome"]);
    expect(store.hasUnsavedLocalEdits()).toBe(false);
  });

  test("an identical agent postimage cancels a pending human debounce instead of publishing phantom dirty truth", async () => {
    const base = docWithBlocks(["before"]);
    const identicalPostimage = docWithBlocks(["same outcome"]);
    let localChanges = 0;
    const { store, writes } = makeStore(base, () => { localChanges += 1; }, undefined, 50);
    await store.initBase();
    store.setDocument(blocksWithTexts(["same outcome"]) as never);
    expect(localChanges).toBe(1);
    expect(store.hasUnsavedLocalEdits()).toBe(true);

    expect(store.applyRemotePatch(identicalPostimage)).toEqual({ ok: true, rebased: false });
    expect(store.hasUnsavedLocalEdits()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(writes).toEqual([]);
  });

  test("rebases canonical payload only, retains the agent manifest, and round-trips exact Writer bytes", async () => {
    const base = docWithBlocks(["human target", "agent target"]);
    const { store, writes } = makeStore(base);
    await store.initBase();
    store.setDocument(blocksWithTexts(["human revision", "agent target"]) as never);

    const agentManifest = testManifest();
    agentManifest.payloadId = "agent-postimage-payload";
    agentManifest.metadata = { createdBy: "agent", updatedAt: "2026-01-02T00:00:00.000Z" };
    const agentPostimage = docWithBlocks(["human target", "agent revision"], agentManifest);
    const merged = store.applyRemotePatch(agentPostimage);

    expect(merged).toEqual({ ok: true, rebased: true });
    expect(currentBlockTexts(store)).toEqual(["human revision", "agent revision"]);
    // Rebase does not emit a bridge write under an agent identity; the only
    // later write is the human draft's normal existing serialization path.
    expect(writes).toHaveLength(0);
    await store.flush();
    expect(writes).toHaveLength(1);
    const parsed = parseWriterHtml(writes[0]!.container);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.manifest).toEqual(agentManifest);
    expect(
      serializeWriterHtml(parsed.document.manifest, parsed.document.document),
    ).toBe(writes[0]!.container);
  });

  test("commits a multi-operation accepted batch as one snapshot and one write", async () => {
    const initial = serializeWriterHtml(createDefaultManifest(), {
      blocks: [
        { id: "b1", type: "paragraph", inlines: [{ text: "one", style: {} }] },
        { id: "b2", type: "paragraph", inlines: [{ text: "two", style: {} }] },
      ],
    });
    const { store, writes, history } = makeStore(initial);
    await store.initBase();
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
    expect(history.snapshots).toBe(0);
    const base = structuredClone(store.getDocument());
    const result = await store.commitAcceptedBatch(base, [
      { kind: "replace", blockId: "b1", scope: { kind: "range", start: 0, end: 3 }, range: { start: 0, end: 3 }, text: "ONE" },
      { kind: "replace", blockId: "b2", scope: { kind: "range", start: 0, end: 3 }, range: { start: 0, end: 3 }, text: "TWO" },
    ] as never);

    expect(result).toEqual({ ok: true, persisted: true });
    expect(writes).toHaveLength(1);
    // The one snapshot is the local undo boundary for the complete accepted turn.
    expect(history.snapshots).toBe(1);
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);
    expect((store.getDocument().blocks[0] as { inlines: Array<{ text: string }> }).inlines[0]?.text).toBe("ONE");
    expect((store.getDocument().blocks[1] as { inlines: Array<{ text: string }> }).inlines[0]?.text).toBe("TWO");
    store.undo();
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(true);
    expect((store.getDocument().blocks[0] as { inlines: Array<{ text: string }> }).inlines[0]?.text).toBe("one");
    store.redo();
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);
    expect((store.getDocument().blocks[0] as { inlines: Array<{ text: string }> }).inlines[0]?.text).toBe("ONE");
  });

  test("does not write stale accepted batches and restores the canonical document on persistence failure", async () => {
    const initial = docWith("before");
    let acceptWrites = false;
    const { store, writes, history } = makeStore(initial, undefined, () => acceptWrites);
    await store.initBase();
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
    const base = structuredClone(store.getDocument());
    store.insertBlock(1, { id: "human", type: "paragraph", inlines: [{ text: "human", style: {} }] } as never);
    const stale = await store.commitAcceptedBatch(base, [] as never);
    expect(stale).toMatchObject({ ok: false, reason: "stale_base" });
    expect(writes).toHaveLength(0);

    const current = structuredClone(store.getDocument());
    const failed = await store.commitAcceptedBatch(current, [
      { kind: "replace", blockId: "b1", scope: { kind: "range", start: 0, end: 6 }, range: { start: 0, end: 6 }, text: "after" },
    ] as never);
    expect(failed).toMatchObject({ ok: false, reason: "persistence_error" });
    expect(writes).toHaveLength(1);
    expect(history.snapshots).toBe(0);
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
    expect((store.getDocument().blocks[0] as { inlines: Array<{ text: string }> }).inlines[0]?.text).toBe("before");
  });

  test("rejects an empty accepted batch without persistence or history", async () => {
    const { store, writes, history } = makeStore(docWith("before"));
    await store.initBase();
    const result = await store.commitAcceptedBatch(structuredClone(store.getDocument()), []);
    expect(result).toMatchObject({ ok: false, reason: "apply_error" });
    expect(writes).toHaveLength(0);
    expect(history.snapshots).toBe(0);
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
  });

  test("commits table structure as one persisted undoable batch", async () => {
    const initial = serializeWriterHtml(createDefaultManifest(), tableDocument());
    const { store, writes, history } = makeStore(initial);
    await store.initBase();
    const base = structuredClone(store.getDocument());

    const result = await store.commitAcceptedBatch(base, [
      { kind: "replace", blockId: "table-0-0", scope: { kind: "range", start: 0, end: 3 }, range: { start: 0, end: 3 }, text: "changed" },
      { kind: "set-table-cell-style", tableBlockId: "table", cell: { rowIndex: 0, colIndex: 0 }, style: { backgroundColor: "#abc" } },
      { kind: "insert-table-row", tableBlockId: "table", rowIndex: 2 },
      { kind: "delete-table-row", tableBlockId: "table", rowIndex: 2 },
      { kind: "insert-table-column", tableBlockId: "table", colIndex: 2 },
      { kind: "delete-table-column", tableBlockId: "table", colIndex: 2 },
      { kind: "merge-table-cells", tableBlockId: "table", start: { rowIndex: 0, colIndex: 0 }, end: { rowIndex: 1, colIndex: 1 } },
      { kind: "split-table-cell", tableBlockId: "table", cell: { rowIndex: 0, colIndex: 0 } },
    ] as never);

    expect(result).toEqual({ ok: true, persisted: true });
    expect(writes).toHaveLength(1);
    expect(history.snapshots).toBe(1);
    const table = store.getDocument().blocks[0]!.tableData!;
    expect(table.rows).toHaveLength(2);
    expect(table.columnWidths).toHaveLength(2);
    expect(table.rows[0]!.cells[0]!.blocks[0]!.inlines[0]!.text).toBe("changed");
    expect(table.rows[0]!.cells[0]!.style).toMatchObject({ backgroundColor: "#abc" });
    expect(table.rows.flatMap((row) => row.cells).every((cell) => cell.colSpan !== 0)).toBe(true);

    store.undo();
    expect(store.getDocument().blocks[0]!.tableData!.rows).toHaveLength(2);
    expect(store.getDocument().blocks[0]!.tableData!.rows[0]!.cells[0]!.blocks[0]!.inlines[0]!.text).toBe("0:0");
    store.redo();
    expect(store.getDocument().blocks[0]!.tableData!.rows[0]!.cells[0]!.blocks[0]!.inlines[0]!.text).toBe("changed");
  });

  test("undo and redo restore the pre/post table shapes for an accepted batch", async () => {
    const initial = serializeWriterHtml(createDefaultManifest(), tableDocument());
    const { store, writes, history } = makeStore(initial);
    await store.initBase();

    const result = await store.commitAcceptedBatch(structuredClone(store.getDocument()), [
      { kind: "insert-table-row", tableBlockId: "table", rowIndex: 2 },
    ] as never);

    expect(result).toEqual({ ok: true, persisted: true });
    expect(writes).toHaveLength(1);
    expect(history.snapshots).toBe(1);
    expect(store.getDocument().blocks[0]!.tableData!.rows).toHaveLength(3);
    store.undo();
    expect(store.getDocument().blocks[0]!.tableData!.rows).toHaveLength(2);
    store.redo();
    expect(store.getDocument().blocks[0]!.tableData!.rows).toHaveLength(3);
  });

  test("restores table snapshot without history when persistence fails", async () => {
    const initial = serializeWriterHtml(createDefaultManifest(), tableDocument());
    const { store, writes, history } = makeStore(initial, undefined, () => false);
    await store.initBase();

    const result = await store.commitAcceptedBatch(structuredClone(store.getDocument()), [
      { kind: "merge-table-cells", tableBlockId: "table", start: { rowIndex: 0, colIndex: 0 }, end: { rowIndex: 1, colIndex: 1 } },
    ] as never);

    expect(result).toMatchObject({ ok: false, reason: "persistence_error" });
    expect(writes).toHaveLength(1);
    expect(history.snapshots).toBe(0);
    const table = store.getDocument().blocks[0]!.tableData!;
    expect(table.rows).toHaveLength(2);
    expect(table.rows.flatMap((row) => row.cells).every((cell) => cell.colSpan !== 0)).toBe(true);
  });

  test("prepareAcceptedContent serializes from the saved canonical baseline", async () => {
    const manifest = createDefaultManifest();
    manifest.payloadId = "saved-canonical-payload";
    const initial = serializeWriterHtml(manifest, {
      blocks: [{ id: "b1", type: "paragraph", inlines: [{ text: "before", style: {} }] }],
    });
    const { store } = makeStore(initial);
    await store.initBase();
    const base = structuredClone(store.getDocument());
    const prepared = store.prepareAcceptedContent(base, [
      { kind: "replace", blockId: "b1", scope: { kind: "range", start: 0, end: 6 }, range: { start: 0, end: 6 }, text: "after" },
    ] as never);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const parsed = parseWriterHtml(prepared.content);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.manifest.payloadId).toBe("saved-canonical-payload");
    expect((parsed.document.document.blocks[0] as { inlines: Array<{ text: string }> }).inlines[0]?.text).toBe("after");
  });

  test("prepareAcceptedContent refuses dirty canonical state", async () => {
    const { store } = makeStore(docWith("before"));
    await store.initBase();
    const dirty = structuredClone(store.getDocument()) as { blocks: Array<{ id: string; inlines: Array<{ text: string }> }> };
    dirty.blocks[0]!.inlines[0]!.text = "human before";
    store.setDocument(dirty as never);
    const base = structuredClone(store.getDocument());
    const prepared = store.prepareAcceptedContent(base, [
      { kind: "replace", blockId: "b1", scope: { kind: "range", start: 0, end: 6 }, range: { start: 0, end: 6 }, text: "after" },
    ] as never);
    expect(prepared).toMatchObject({ ok: false, reason: "stale_base" });
  });

  test("installs accepted content and its confirmed SHA as one synchronous baseline", async () => {
    const { store, writes } = makeStore(docWith("before"));
    await store.initBase();

    const installed = store.installAcceptedContent(docWith("accepted"), "confirmed-accepted-sha");
    expect(installed).toEqual({ ok: true, rebased: false });
    store.insertBlock(1, {
      id: "b2",
      type: "paragraph",
      inlines: [{ text: "immediate edit", style: {} }],
    } as never);

    await expect(store.flush()).resolves.toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.baseSha256).toBe("confirmed-accepted-sha");
    const parsed = parseWriterHtml(writes[0]!.container);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect((parsed.document.document.blocks[0] as { inlines: Array<{ text: string }> }).inlines[0]?.text)
        .toBe("accepted");
    }
  });
});
