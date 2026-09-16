/**
 * NautiloDocStore — a `DocStore` decorator wrapping Wafflebase's `MemDocStore`
 * that bridges the editor to Nautilo's M193 patch collaboration.
 *
 * Design (mirrors the Spreadsheet `autosave.ts` pattern, adapted to the docs
 * engine's store-as-mutation-sink model):
 *   - Every editor mutation flows through a DocStore method. We delegate reads
 *     transparently to an inner MemDocStore, and on each MUTATING method we
 *     schedule a debounced flush.
 *   - flush(): serialize the current Document → text container → derive an
 *     AnchoredTextPatch against the last-saved text → hand it to the injected
 *     writer (the nautiloApp bridge). Text-only, so M193 applies as-is.
 *   - applyRemotePatch(): a patch arrived from another writer (human or agent).
 *     Rebase local dirty edits onto the remote container, then setDocument so
 *     the engine re-renders. Never silently drops local edits.
 *
 * The engine calls `resetAfterDocumentReplace()` + `render()` on its side after
 * we setDocument via the surface; this store only owns document state + wire.
 */
import { serializeJson } from "@nautilo/office-docs/node";
import type {
  Block,
  BlockStyle,
  BlockType,
  CellStyle,
  DocStore,
  DocStyles,
  Document,
  HeaderFooter,
  HeadingLevel,
  Inline,
  InlineStyle,
  NamedStyleDef,
  PageSetup,
  StyleId,
  TableCell,
  TableRow,
} from "@nautilo/office-docs/node";
import {
  deriveExactAnchoredTextPatch,
  mergeTextHumanPriority,
  type AnchoredTextPatch,
} from "@nautilo/types";
import {
  createDefaultManifest,
  parseWriterHtml,
  serializeWriterHtml,
  validateWafflebaseDocument,
  type WriterHtmlManifest,
} from "./office-document";
import { applyDocumentOperations } from "./document-ops";
import type { ResolvedProposalOperation } from "./proposal-resolver";

/** Injected side-effects so the store is unit-testable without the real bridge. */
export interface NautiloDocStoreDeps {
  /**
   * Construct the inner store from an initial document. Production passes
   * `(doc) => new MemDocStore(doc)`. Injected because `MemDocStore` lives in the
   * browser bundle only (the headless `@nautilo/office-docs/node` entry omits it), so
   * this module must not statically import it or it becomes node-unloadable.
   */
  createStore: (doc: Document) => DocStore;
  /**
   * Persist the serialized container as an anchored-text patch (the bridge).
   * Return `false` when the write was REJECTED (conflict or an honest error
   * like exceeding the size limit) so the store does NOT advance its saved
   * baseline — otherwise the local snapshot diverges from the server and every
   * subsequent edit conflicts. `true`/`undefined` = persisted (or no bridge).
   */
  writePatch: (input: {
    container: string;
    patch: AnchoredTextPatch;
    baseSha256: string;
  }) => void | boolean | Promise<void | boolean>;
  /**
   * Fired synchronously on every local mutation (before the debounced flush).
   * The app uses this to mark the doc dirty for the agent context summary.
   */
  onLocalChange?: () => void;
  /** Fired after an accepted write advances the canonical saved baseline. */
  onPersisted?: (state: { dirty: boolean }) => void;
  /** Debounce window (ms) before a flush. Default 800. */
  debounceMs?: number;
  /** Test seam for the timer. */
  now?: () => number;
}

export type ApplyRemoteResult =
  | { ok: true; rebased: boolean }
  | { ok: false; reason: "conflict" | "parse_error" };

export type AcceptedBatchResult =
  | { ok: true; persisted: boolean }
  | { ok: false; reason: "stale_base" | "apply_error" | "persistence_error"; message: string };

export type PreparedAcceptedContentResult =
  | { ok: true; content: string }
  | { ok: false; reason: "stale_base" | "apply_error"; message: string };

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class NautiloDocStore implements DocStore {
  private readonly inner: DocStore;
  private readonly deps: Required<Pick<NautiloDocStoreDeps, "debounceMs" | "now">> &
    Pick<NautiloDocStoreDeps, "writePatch" | "createStore" | "onLocalChange" | "onPersisted">;
  private manifest: WriterHtmlManifest;
  /** Exact persisted wire bytes (base for the next patch + CAS identity). */
  private savedContainer: string;
  /** Persisted document after the editor store materializes semantic defaults. */
  private savedSemanticContainer: string;
  private savedSha256 = "";
  private pendingBaseHash: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Serialize local Writer flushes so an older local response cannot replace a newer base. */
  private flushInFlight: Promise<boolean> | null = null;
  private batchDepth = 0;

  constructor(initialContainer: string | null, deps: NautiloDocStoreDeps) {
    this.deps = {
      debounceMs: deps.debounceMs ?? 800,
      now: deps.now ?? Date.now,
      writePatch: deps.writePatch,
      createStore: deps.createStore,
      ...(deps.onLocalChange ? { onLocalChange: deps.onLocalChange } : {}),
      ...(deps.onPersisted ? { onPersisted: deps.onPersisted } : {}),
    };
    let doc: Document = { blocks: [] } as unknown as Document;
    let manifest = createDefaultManifest();
    let wireContainer: string | null = null;
    if (initialContainer) {
      const parsed = parseWriterHtml(initialContainer);
      if (!parsed.ok) throw new Error(`Cannot open Writer document: ${parsed.error}`);
      manifest = parsed.document.manifest;
      doc = parsed.document.document as unknown as Document;
      wireContainer = initialContainer;
    }
    this.manifest = manifest;
    this.inner = this.deps.createStore(doc);
    this.savedSemanticContainer = serializeWriterHtml(manifest, this.currentPayload());
    this.savedContainer = wireContainer ?? this.savedSemanticContainer;
  }

  /** Mark the initial base sha (call once after construction; async). */
  async initBase(): Promise<void> {
    this.savedSha256 = await sha256Hex(this.savedContainer);
  }

  private currentPayload() {
    return validateWafflebaseDocument(serializeJson(this.inner.getDocument()) as unknown);
  }

  private serializeCurrent(): string {
    return serializeWriterHtml(this.manifest, this.currentPayload());
  }

  /** Called after every mutating delegate: notify + schedule a debounced flush. */
  private touch(): void {
    if (this.batchDepth > 0) return;
    this.deps.onLocalChange?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.deps.debounceMs);
  }

  /** Serialize → derive patch vs last-saved → write. Public for save-now. */
  async flush(): Promise<boolean> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pendingBaseHash) {
      const pending = this.pendingBaseHash;
      await pending;
      if (this.pendingBaseHash === pending) this.pendingBaseHash = null;
      // Another remote baseline may have arrived during hashing. Derive the
      // patch only once its exact canonical bytes and SHA agree.
      return this.flush();
    }
    if (this.flushInFlight) {
      const persisted = await this.flushInFlight;
      if (!persisted) return false;
      // Edits that arrived while the canonical write was pending must derive
      // their patch from the receipt-confirmed base, never from a stale one.
      return this.flush();
    }
    const next = this.serializeCurrent();
    if (next === this.savedSemanticContainer) return true;
    const persistence = this.persist(next);
    this.flushInFlight = persistence;
    try {
      return await persistence;
    } finally {
      if (this.flushInFlight === persistence) this.flushInFlight = null;
    }
  }

  private async persist(next: string): Promise<boolean> {
    const patch =
      deriveExactAnchoredTextPatch(this.savedContainer, next) ??
      // Whole-document replace (e.g. from empty) — send a full-scope patch.
      ({ kind: "anchored_text", oldString: this.savedContainer, newString: next } as AnchoredTextPatch);
    const result = await this.deps.writePatch({ container: next, patch, baseSha256: this.savedSha256 });
    // A rejected write (conflict / too-large / error) must NOT advance the
    // saved baseline, or the client would believe it holds a version the
    // server never accepted and diverge into a perpetual conflict loop.
    if (result === false) return false;
    this.savedContainer = next;
    this.savedSemanticContainer = next;
    this.savedSha256 = await sha256Hex(next);
    this.deps.onPersisted?.({ dirty: this.serializeCurrent() !== this.savedSemanticContainer });
    return true;
  }

  /** True when local edits have not yet been flushed to the saved baseline. */
  hasUnsavedLocalEdits(): boolean {
    return this.serializeCurrent() !== this.savedSemanticContainer;
  }

  /**
   * Exact human draft relative to the last authoritative container. The host
   * independently binds and validates this patch against canonical bytes.
   */
  humanEditDraftPatch(): AnchoredTextPatch | undefined {
    const current = this.serializeCurrent();
    if (current === this.savedSemanticContainer) return undefined;
    return deriveExactAnchoredTextPatch(this.savedContainer, current)
      ?? { kind: "anchored_text", oldString: this.savedContainer, newString: current };
  }

  /**
   * Build the accepted Writer container from the saved canonical baseline without
   * mutating live store state. Used by Current Folder live-review acceptance.
   */
  prepareAcceptedContent(
    baseDoc: Document,
    operations: readonly ResolvedProposalOperation[],
  ): PreparedAcceptedContentResult {
    if (this.hasUnsavedLocalEdits()) {
      return {
        ok: false,
        reason: "stale_base",
        message: "The document changed while this suggestion was being reviewed.",
      };
    }
    const semantic = parseWriterHtml(this.savedSemanticContainer);
    const wire = parseWriterHtml(this.savedContainer);
    if (!semantic.ok || !wire.ok) {
      return { ok: false, reason: "apply_error", message: "Saved document baseline could not be parsed." };
    }
    const semanticDoc = semantic.document.document as unknown as Document;
    if (JSON.stringify(semanticDoc) !== JSON.stringify(baseDoc)) {
      return {
        ok: false,
        reason: "stale_base",
        message: "The document changed while this suggestion was being reviewed.",
      };
    }
    // The semantic baseline proves that no Human edit intervened, but the
    // accepted wire payload must contain only the reviewed operations. Apply
    // them to the exact persisted document shape so editor-default
    // materialization cannot become an unreviewed style change.
    const applied = applyDocumentOperations(
      structuredClone(wire.document.document) as unknown as Document,
      operations,
    );
    if (!applied.ok) return { ok: false, reason: "apply_error", message: applied.message };
    return {
      ok: true,
      content: serializeWriterHtml(
        wire.document.manifest,
        validateWafflebaseDocument(serializeJson(applied.document) as unknown),
      ),
    };
  }

  /**
   * Install server-confirmed accepted content without an ordinary bridge write.
   * The host-confirmed SHA is installed synchronously with the canonical
   * replacement so an immediate mutation uses the accepted version as its base.
   * Establishes one local undo boundary after the canonical replacement.
   */
  installAcceptedContent(container: string, confirmedSha256: string): ApplyRemoteResult {
    const parsed = parseWriterHtml(container);
    if (!parsed.ok) return { ok: false, reason: "parse_error" };
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const before = structuredClone(this.inner.getDocument());
    this.manifest = parsed.document.manifest;
    this.inner.setDocument(parsed.document.document as unknown as Document);
    this.savedSemanticContainer = serializeWriterHtml(this.manifest, this.currentPayload());
    this.savedContainer = container;
    this.savedSha256 = confirmedSha256;
    this.inner.setDocument(before);
    this.inner.snapshot();
    this.inner.setDocument(parsed.document.document as unknown as Document);
    return { ok: true, rebased: false };
  }

  /**
   * Commit a reviewed proposal as one document replacement and one explicit
   * bridge flush. This deliberately bypasses touch(): one accepted batch must
   * not fan out into per-operation debounce writes.
   */
  async commitAcceptedBatch(
    baseDoc: Document,
    operations: readonly ResolvedProposalOperation[],
  ): Promise<AcceptedBatchResult> {
    const current = this.inner.getDocument();
    if (JSON.stringify(current) !== JSON.stringify(baseDoc)) {
      return {
        ok: false,
        reason: "stale_base",
        message: "The document changed while this suggestion was being reviewed.",
      };
    }
    if (operations.length === 0) {
      return { ok: false, reason: "apply_error", message: "No changes are selected." };
    }

    const applied = applyDocumentOperations(structuredClone(current), operations);
    if (!applied.ok) return { ok: false, reason: "apply_error", message: applied.message };

    const before = structuredClone(current);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.inner.setDocument(applied.document);
    try {
      const persisted = await this.flush();
      if (!persisted) {
        this.inner.setDocument(before);
        return {
          ok: false,
          reason: "persistence_error",
          message: "The accepted changes could not be saved.",
        };
      }
      // Persistence succeeded. Establish exactly one local history boundary
      // afterward so a failed write cannot leave a phantom undo entry.
      this.inner.setDocument(before);
      this.inner.snapshot();
      this.inner.setDocument(applied.document);
      return { ok: true, persisted: true };
    } catch (error) {
      this.inner.setDocument(before);
      return {
        ok: false,
        reason: "persistence_error",
        message: error instanceof Error ? error.message : "The accepted changes could not be saved.",
      };
    }
  }

  /**
   * Apply a container that arrived from another writer. When the human has an
   * unsaved draft, rebase it onto the authoritative remote postimage. A
   * non-overlap keeps the rebased human draft dirty against that remote base;
   * an overlap changes nothing locally and reports a conflict so the agent
   * must reread/reapply rather than overwriting the human.
   */
  applyRemotePatch(remoteContainer: string): ApplyRemoteResult {
    const current = this.serializeCurrent();
    const localDirty = current !== this.savedSemanticContainer;
    const authoritative = parseWriterHtml(remoteContainer);
    if (!authoritative.ok) return { ok: false, reason: "parse_error" };
    const normalizedRemoteStore = this.deps.createStore(
      structuredClone(authoritative.document.document) as unknown as Document,
    );
    const remoteSemanticContainer = serializeWriterHtml(
      authoritative.document.manifest,
      validateWafflebaseDocument(serializeJson(normalizedRemoteStore.getDocument()) as unknown),
    );
    let target = remoteContainer;
    let rebased = false;
    if (localDirty) {
      // Writer's persisted container intentionally renders the document twice:
      // once as the canonical Wafflebase JSON payload and once as a static HTML
      // preview. Merge the canonical payload, then render it once with the
      // authoritative remote manifest. Feeding both representations into diff3
      // can turn independent edits into a false overlap.
      const base = parseWriterHtml(this.savedSemanticContainer);
      const human = parseWriterHtml(current);
      const agent = parseWriterHtml(remoteSemanticContainer);
      if (!base.ok || !human.ok || !agent.ok) return { ok: false, reason: "parse_error" };
      const merge = mergeTextHumanPriority({
        base: JSON.stringify(base.document.document, null, 2),
        humanDraft: JSON.stringify(human.document.document, null, 2),
        agentPostimage: JSON.stringify(agent.document.document, null, 2),
      });
      if (!merge.ok) return { ok: false, reason: "conflict" };
      try {
        target = serializeWriterHtml(
          agent.document.manifest,
          validateWafflebaseDocument(JSON.parse(merge.text)),
        );
      } catch {
        return { ok: false, reason: "parse_error" };
      }
      rebased = target !== remoteSemanticContainer;
    }
    const parsed = rebased ? parseWriterHtml(target) : authoritative;
    if (!parsed.ok) return { ok: false, reason: "parse_error" };
    // A confirmed remote postimage supersedes any pending local debounce. If
    // it exactly equals the human draft, leaving that timer alive would later
    // publish stale "dirty" bookkeeping despite there being nothing to save.
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.manifest = parsed.document.manifest;
    this.inner.setDocument(parsed.document.document as unknown as Document);
    // Keep semantic comparisons in MemDocStore's materialized representation,
    // while the patch/CAS baseline remains the exact authoritative wire bytes.
    // Otherwise an identical legacy document can masquerade as a Human draft.
    this.savedSemanticContainer = remoteSemanticContainer;
    this.savedContainer = remoteContainer;
    this.pendingBaseHash = sha256Hex(remoteContainer).then((h) => {
      if (this.savedContainer === remoteContainer) this.savedSha256 = h;
    });
    return { ok: true, rebased };
  }

  // ── DocStore: reads / neutral (transparent delegation) ──────────────────
  getDocument(): Document { return this.inner.getDocument(); }
  getBlock(id: string): Block | undefined { return this.inner.getBlock(id); }
  getPageSetup(): PageSetup { return this.inner.getPageSetup(); }
  getDocStyles(): DocStyles { return this.inner.getDocStyles(); }
  getHeader(): HeaderFooter | undefined { return this.inner.getHeader(); }
  getFooter(): HeaderFooter | undefined { return this.inner.getFooter(); }
  snapshot(): void { this.inner.snapshot(); }
  canUndo(): boolean { return this.inner.canUndo(); }
  canRedo(): boolean { return this.inner.canRedo(); }

  batch(fn: () => void): void {
    if (this.batchDepth > 0) {
      this.inner.batch(fn);
      return;
    }
    const before = this.serializeCurrent();
    this.batchDepth++;
    try {
      this.inner.batch(fn);
    } finally {
      this.batchDepth--;
      // MemDocStore preserves partial writes on throw. Publish that surviving
      // draft too, so it remains visible, saveable and undoable after failure.
      if (this.serializeCurrent() !== before) this.touch();
    }
  }

  applyStyles(edits: Parameters<DocStore["applyStyles"]>[0]): void {
    this.batch(() => this.inner.applyStyles(edits));
  }

  insertBlocksAfter(siblingBlockId: string, blocks: Block[]): void {
    this.batch(() => this.inner.insertBlocksAfter(siblingBlockId, blocks));
  }

  // ── DocStore: mutations (delegate + debounced flush) ────────────────────
  setDocument(doc: Document): void { this.inner.setDocument(doc); this.touch(); }
  replaceDocument(doc: Document): void { this.inner.replaceDocument(doc); this.touch(); }
  updateBlock(id: string, block: Block): void { this.inner.updateBlock(id, block); this.touch(); }
  insertBlock(index: number, block: Block): void { this.inner.insertBlock(index, block); this.touch(); }
  deleteBlock(id: string): void { this.inner.deleteBlock(id); this.touch(); }
  deleteBlockByIndex(index: number): void { this.inner.deleteBlockByIndex(index); this.touch(); }
  setPageSetup(s: PageSetup): void { this.inner.setPageSetup(s); this.touch(); }
  setDocStyles(styles: DocStyles): void { this.inner.setDocStyles(styles); this.touch(); }
  updateStyleDefinition(styleId: StyleId, def: NamedStyleDef): void {
    this.inner.updateStyleDefinition(styleId, def);
    this.touch();
  }
  resetStyle(styleId: StyleId): void { this.inner.resetStyle(styleId); this.touch(); }
  resetAllStyles(): void { this.inner.resetAllStyles(); this.touch(); }
  setHeader(h: HeaderFooter | undefined): void { this.inner.setHeader(h); this.touch(); }
  setFooter(f: HeaderFooter | undefined): void { this.inner.setFooter(f); this.touch(); }
  undo(): void { this.inner.undo(); this.touch(); }
  redo(): void { this.inner.redo(); this.touch(); }
  insertTableRow(t: string, i: number, row: TableRow): void { this.inner.insertTableRow(t, i, row); this.touch(); }
  deleteTableRow(t: string, i: number): void { this.inner.deleteTableRow(t, i); this.touch(); }
  insertTableColumn(t: string, i: number, cells: TableCell[]): void { this.inner.insertTableColumn(t, i, cells); this.touch(); }
  deleteTableColumn(t: string, i: number): void { this.inner.deleteTableColumn(t, i); this.touch(); }
  updateTableCell(t: string, r: number, c: number, cell: TableCell): void { this.inner.updateTableCell(t, r, c, cell); this.touch(); }
  updateTableAttrs(t: string, attrs: { cols: number[]; rowHeights?: (number | undefined)[] }): void { this.inner.updateTableAttrs(t, attrs); this.touch(); }
  insertText(id: string, offset: number, text: string): void { this.inner.insertText(id, offset, text); this.touch(); }
  deleteText(id: string, offset: number, length: number): void { this.inner.deleteText(id, offset, length); this.touch(); }
  applyStyle(id: string, from: number, to: number, style: Partial<InlineStyle>): void { this.inner.applyStyle(id, from, to, style); this.touch(); }
  splitBlock(id: string, offset: number, newId: string, newType: BlockType): void { this.inner.splitBlock(id, offset, newId, newType); this.touch(); }
  mergeBlock(id: string, nextId: string): void { this.inner.mergeBlock(id, nextId); this.touch(); }
  setBlockType(id: string, type: BlockType, opts?: { headingLevel?: HeadingLevel; listKind?: "ordered" | "unordered"; listLevel?: number }): void { this.inner.setBlockType(id, type, opts); this.touch(); }
  applyBlockStyle(id: string, style: Partial<BlockStyle>): void { this.inner.applyBlockStyle(id, style); this.touch(); }
  applyCellStyle(t: string, r: number, c: number, style: Partial<CellStyle>): void { this.inner.applyCellStyle(t, r, c, style); this.touch(); }
  applyCellSpan(t: string, r: number, c: number, span: { colSpan?: number; rowSpan?: number }): void { this.inner.applyCellSpan(t, r, c, span); this.touch(); }
  insertImageInline(id: string, offset: number, inline: Inline): void { this.inner.insertImageInline(id, offset, inline); this.touch(); }
  insertBlockAfter(siblingId: string, block: Block): void { this.inner.insertBlockAfter(siblingId, block); this.touch(); }
}
