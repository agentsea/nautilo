/**
 * In-app editor state for the design canvas. Holds the current
 * `DesignDocument` (the source of truth), the active page, and the selection.
 * Supported durable node mutations go through the canonical transaction
 * kernel, including transient vector-network editing. Mutations retain a
 * minimal undo/redo stack; live
 * drag/resize use transient kernel transforms and commit a single undo entry
 * on release.
 *
 * The store is renderer-neutral: it emits change notifications and lets the
 * mount (main.ts) wire them to render, autosave, and context publishing.
 */

import {
  findPage,
  type DesignBooleanOp,
  type DesignDocument,
  type DesignConnector,
  type DesignFill,
  type DesignNode,
  type DesignStroke,
  type DesignTextAlign,
} from "../scene-graph";
import {
  applyDesignTransaction,
  type CreateTransaction,
  type ConnectorPatch,
  type DesignTransactionRequest,
  type DesignTransactionResult,
  type GeometryPatch,
  type StylePatch,
  type TextPatch,
} from "../transactions";
import type { GeometryMatrix } from "../geometry";
import { copyDesignFragment, type DesignFragment, type OrganizationTransaction } from "../organization";
import { mergeThreeWayDesignScenes } from "../scene-merge";
import type { VectorNetwork } from "../vector";
import { connectorGeometry } from "./connector";
import { applySelection, type SelectMode } from "./selection";

export type ChangeReason = "select" | "document" | "interaction" | "remote";

export type EditorState = {
  document: DesignDocument;
  activePageId: string;
  selection: string[];
};

export type NodePatch = {
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  opacity?: number;
  fills?: DesignFill[];
  /** `null` removes the stroke via the canonical style transaction. */
  stroke?: DesignStroke | null;
  radius?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string | number;
  textAlign?: DesignTextAlign;
  lineHeight?: number;
  textWrap?: boolean;
  color?: string;
};

export type Box = { x: number; y: number; width: number; height: number };

export type StoreListener = (reason: ChangeReason, state: EditorState) => void;


export class DesignStore {
  private state: EditorState;
  private undoStack: DesignDocument[] = [];
  private redoStack: DesignDocument[] = [];
  private transientBase: DesignDocument | null = null;
  private readonly listeners = new Set<StoreListener>();

  constructor(document: DesignDocument, activePageId?: string) {
    const pageId = activePageId ?? document.pages[0]?.id ?? "page-1";
    this.state = { document, activePageId: pageId, selection: [] };
  }

  getState(): EditorState {
    return this.state;
  }

  getDocument(): DesignDocument {
    return this.state.document;
  }

  getSelectedNodes(): DesignNode[] {
    return this.state.selection
      .map((id) => this.state.document.nodes[id])
      .filter((node): node is DesignNode => node !== undefined);
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(reason: ChangeReason): void {
    for (const listener of this.listeners) listener(reason, this.state);
  }

  // ----- selection -----

  setSelection(ids: readonly string[]): void {
    const filtered = ids.filter((id) => this.state.document.nodes[id] !== undefined);
    this.state = { ...this.state, selection: [...filtered] };
    this.emit("select");
  }

  select(hitId: string | null, mode: SelectMode = "replace"): void {
    const next = applySelection(this.state.selection, hitId, mode);
    this.state = { ...this.state, selection: next };
    this.emit("select");
  }

  clearSelection(): void {
    if (this.state.selection.length === 0) return;
    this.state = { ...this.state, selection: [] };
    this.emit("select");
  }

  setActivePage(pageId: string): void {
    if (this.state.activePageId === pageId) return;
    this.state = { ...this.state, activePageId: pageId, selection: [] };
    this.emit("select");
  }

  // ----- remote / full replacement (no undo entry) -----

  replaceDocument(document: DesignDocument, opts?: { keepSelection?: boolean }): void {
    const rebasedHistory = this.rebaseHistory(document);
    const activePageId = findPage(document, this.state.activePageId)
      ? this.state.activePageId
      : document.pages[0]?.id ?? this.state.activePageId;
    const selection = opts?.keepSelection
      ? this.state.selection.filter((id) => document.nodes[id] !== undefined)
      : [];
    this.transientBase = null;
    this.undoStack = rebasedHistory?.undo ?? [];
    this.redoStack = rebasedHistory?.redo ?? [];
    this.state = { document, activePageId, selection };
    this.emit("remote");
  }

  private rebaseHistory(
    incoming: DesignDocument,
  ): { undo: DesignDocument[]; redo: DesignDocument[] } | null {
    const current = this.state.document;
    const rebase = (snapshot: DesignDocument): DesignDocument | null => {
      const result = mergeThreeWayDesignScenes(current, snapshot, incoming);
      return result.ok ? result.document : null;
    };
    const undo = this.undoStack.map(rebase);
    const redo = this.redoStack.map(rebase);
    if (undo.some((snapshot) => snapshot === null) || redo.some((snapshot) => snapshot === null)) {
      return null;
    }
    return { undo: undo as DesignDocument[], redo: redo as DesignDocument[] };
  }

  // ----- transactional mutations -----

  private commit(next: DesignDocument, selection?: string[]): void {
    if (next === this.state.document && selection === undefined) return;
    this.undoStack.push(this.state.document);
    this.redoStack = [];
    this.state = {
      ...this.state,
      document: next,
      selection: this.pruneSelection(selection ?? this.state.selection, next),
    };
    this.emit("document");
  }

  private pruneSelection(ids: readonly string[], doc: DesignDocument): string[] {
    return ids.filter((id) => doc.nodes[id] !== undefined);
  }

  private clampActivePage(doc: DesignDocument): string {
    return findPage(doc, this.state.activePageId)
      ? this.state.activePageId
      : doc.pages[0]?.id ?? this.state.activePageId;
  }

  private commitKernelRequests(
    requests: readonly DesignTransactionRequest[],
    selection?: string[],
  ): boolean {
    let next = this.state.document;
    for (const request of requests) {
      const result = applyDesignTransaction(next, request);
      if (!result.ok) return false;
      next = result.document;
    }
    this.commit(next, selection);
    return true;
  }

  /** Expose canonical structural intents and their actionable errors to UI adapters. */
  transact(request: DesignTransactionRequest, selectChanged = false): DesignTransactionResult {
    const result = applyDesignTransaction(this.state.document, request);
    if (result.ok) this.commit(result.document, selectChanged ? result.receipt.changedNodeIds.filter((id) => result.document.nodes[id]?.parentId === null) : undefined);
    return result;
  }

  copySelection(): DesignFragment { return copyDesignFragment(this.state.document, this.state.selection); }

  organize(request: OrganizationTransaction): DesignTransactionResult {
    const result = applyDesignTransaction(this.state.document, request);
    if (!result.ok) return result;
    const newIds = result.receipt.changedNodeIds.filter((id) => result.document.nodes[id] && !this.state.document.nodes[id]);
    const roots = newIds.filter((id) => !newIds.includes(result.document.nodes[id]!.parentId ?? ""));
    this.commit(result.document, roots.length ? roots : undefined);
    return result;
  }

  /**
   * Apply a renderer receipt's explicit kernel Revert without altering local
   * Cmd-Z/Cmd-Shift-Z history. It still emits a durable document change so the
   * ordinary autosave path persists it.
   */
  applyEphemeralRevert(request: Extract<DesignTransactionRequest, { kind: "revert" }>): DesignTransactionResult {
    const result = applyDesignTransaction(this.state.document, request);
    if (!result.ok || result.receipt.outcome === "noop") return result;
    const rebasedHistory = this.rebaseHistory(result.document);
    if (!rebasedHistory) {
      return {
        ok: false,
        error: {
          code: "stale_revert",
          message: "Revert no longer applies because local undo history overlaps the agent change.",
          path: "history",
        },
      };
    }
    this.undoStack = rebasedHistory.undo;
    this.redoStack = rebasedHistory.redo;
    this.state = {
      ...this.state,
      document: result.document,
      selection: this.pruneSelection(this.state.selection, result.document),
    };
    this.emit("document");
    return result;
  }

  // ----- node operations -----

  addNode(
    kind: CreateTransaction["node"]["type"],
    opts: {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      parentId?: string | null;
      pageId?: string;
      name?: string;
      text?: string;
      fills?: DesignFill[];
      stroke?: DesignStroke;
      radius?: number;
      fontSize?: number;
    } = {},
  ): string {
    const style: StylePatch = {
      ...(opts.fills !== undefined ? { fills: opts.fills } : {}),
      ...(opts.stroke !== undefined ? { stroke: opts.stroke } : {}),
      ...(opts.radius !== undefined ? { radius: opts.radius } : {}),
    };
    const text: TextPatch = {
      ...(opts.text !== undefined ? { text: opts.text } : {}),
      ...(opts.fontSize !== undefined ? { fontSize: opts.fontSize } : {}),
    };
    const result = applyDesignTransaction(this.state.document, {
      kind: "create",
      pageId: opts.pageId ?? this.state.activePageId,
      ...(opts.parentId !== undefined ? { parentId: opts.parentId } : {}),
      node: {
        type: kind,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.x !== undefined ? { x: opts.x } : {}),
        ...(opts.y !== undefined ? { y: opts.y } : {}),
        ...(opts.width !== undefined ? { width: opts.width } : {}),
        ...(opts.height !== undefined ? { height: opts.height } : {}),
        ...(Object.keys(style).length > 0 ? { style } : {}),
        ...(Object.keys(text).length > 0 ? { text } : {}),
      },
    });
    if (!result.ok || result.receipt.changedNodeIds[0] === undefined) {
      throw new Error(result.ok ? "Create transaction returned no created node." : result.error.message);
    }
    const id = result.receipt.changedNodeIds[0];
    this.commit(result.document, [id]);
    return id;
  }

  /**
   * Create a `vector` node from a built network (origin-local, min at 0,0) plus
   * its node box, link it to the active page, and select it. Gets a default
   * stroke so it is visible immediately.
   */
  addVectorNode(
    built: { network: VectorNetwork; x: number; y: number; width: number; height: number },
    opts: { name?: string; stroke?: DesignStroke; fills?: DesignFill[] } = {},
  ): string {
    const result = applyDesignTransaction(this.state.document, {
      kind: "create",
      pageId: this.state.activePageId,
      node: {
        type: "vector",
        x: built.x,
        y: built.y,
        width: built.width,
        height: built.height,
        vectorNetwork: built.network,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        style: {
          ...(opts.stroke !== undefined ? { stroke: opts.stroke } : { stroke: { color: "#0f172a", width: 2 } }),
          ...(opts.fills !== undefined ? { fills: opts.fills } : {}),
        },
      },
    });
    if (!result.ok || result.receipt.changedNodeIds[0] === undefined) {
      throw new Error(result.ok ? "Vector create transaction returned no created node." : result.error.message);
    }
    const id = result.receipt.changedNodeIds[0];
    this.commit(result.document, [id]);
    return id;
  }

  /** Create a durable connector as an ordinary vector node in one undo step. */
  addConnector(
    connector: DesignConnector,
    opts: { name?: string; stroke?: DesignStroke } = {},
  ): string {
    const geometry = connectorGeometry(this.state.document, connector);
    const result = applyDesignTransaction(this.state.document, {
      kind: "create",
      pageId: this.state.activePageId,
      node: {
        type: "vector",
        name: opts.name ?? "Connector",
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
        vectorNetwork: geometry.network,
        connector,
        style: { stroke: opts.stroke ?? { color: "#0f172a", width: 2, cap: "round", join: "round" } },
      },
    });
    if (!result.ok || result.receipt.changedNodeIds[0] === undefined) {
      throw new Error(result.ok ? "Connector create transaction returned no created node." : result.error.message);
    }
    const id = result.receipt.changedNodeIds[0];
    this.commit(result.document, [id]);
    return id;
  }

  /** Update connector routing/attachments through its dedicated validated transaction. */
  updateConnector(id: string, patch: ConnectorPatch): boolean {
    if (!this.state.document.nodes[id]?.connector) return false;
    return this.commitKernelRequests([{ kind: "connector", nodeId: id, patch }]);
  }

  /**
   * Wrap 2+ selected nodes (sharing one parent/page) in a new `group` node
   * carrying `booleanOp`. The operands are re-parented into the group in their
   * original z-order, and the group is inserted where the topmost operand sat.
   * A single undo reverts the whole operation. Returns the new group id, or
   * `null` when the selection can't be grouped (fewer than two, or mixed
   * parents).
   */
  groupAsBoolean(ids: readonly string[], op: DesignBooleanOp): string | null {
    const unique = [...new Set(ids)].filter((id) => this.state.document.nodes[id] !== undefined);
    const result = applyDesignTransaction(this.state.document, { kind: "boolean", nodeIds: unique, op });
    if (!result.ok || result.receipt.changedNodeIds[0] === undefined) return null;
    const groupId = result.receipt.changedNodeIds[0];
    this.commit(result.document, [groupId]);
    return groupId;
  }

  updateNode(id: string, patch: NodePatch): void {
    this.updateNodes([id], patch);
  }

  /**
   * Apply `patch` to every id in `ids` in a single undo entry. Missing ids are
   * skipped. With a single id this is identical to the former `updateNode`.
   */
  private requestsForPatch(ids: readonly string[], patch: NodePatch): DesignTransactionRequest[] {
    // Keep the old UI-facing missing-id behavior: stale selections are skipped,
    // while every surviving target is validated by the kernel.
    const nodeIds = [...new Set(ids)].filter((id) => this.state.document.nodes[id] !== undefined);
    if (nodeIds.length === 0) return [];
    const geometry: GeometryPatch = {
      ...(patch.x !== undefined ? { x: patch.x } : {}),
      ...(patch.y !== undefined ? { y: patch.y } : {}),
      ...(patch.width !== undefined ? { width: patch.width } : {}),
      ...(patch.height !== undefined ? { height: patch.height } : {}),
    };
    const style: StylePatch = {
      ...(patch.opacity !== undefined ? { opacity: patch.opacity } : {}),
      ...(patch.fills !== undefined ? { fills: patch.fills } : {}),
      ...(patch.stroke !== undefined ? { stroke: patch.stroke } : {}),
      ...(patch.radius !== undefined ? { radius: patch.radius } : {}),
    };
    const text: TextPatch = {
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.fontSize !== undefined ? { fontSize: patch.fontSize } : {}),
      ...(patch.fontFamily !== undefined ? { fontFamily: patch.fontFamily } : {}),
      ...(patch.fontWeight !== undefined ? { fontWeight: patch.fontWeight } : {}),
      ...(patch.textAlign !== undefined ? { textAlign: patch.textAlign } : {}),
      ...(patch.lineHeight !== undefined ? { lineHeight: patch.lineHeight } : {}),
      ...(patch.textWrap !== undefined ? { textWrap: patch.textWrap } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
    };
    const requests: DesignTransactionRequest[] = [];
    if (Object.keys(geometry).length > 0) {
      requests.push({ kind: "transform", updates: nodeIds.map((nodeId) => ({ nodeId, ...geometry })) });
    }
    if (patch.rotation !== undefined) requests.push({ kind: "rotate", nodeIds, rotation: patch.rotation });
    if (patch.name !== undefined) requests.push({ kind: "rename", nodeIds, name: patch.name });
    if (Object.keys(style).length > 0) requests.push({ kind: "style", nodeIds, patch: style });
    if (Object.keys(text).length > 0) {
      for (const nodeId of nodeIds) requests.push({ kind: "text", nodeId, patch: text });
    }
    return requests;
  }

  updateNodes(ids: readonly string[], patch: NodePatch): boolean {
    return this.commitKernelRequests(this.requestsForPatch(ids, patch));
  }

  updateNodePatches(patches: Array<{ nodeId: string; patch: NodePatch }>): void {
    this.commitKernelRequests(patches.flatMap(({ nodeId, patch }) => this.requestsForPatch([nodeId], patch)));
  }

  deleteNodes(ids: readonly string[]): void {
    const nodeIds = [...new Set(ids)].filter((id) => this.state.document.nodes[id] !== undefined);
    if (nodeIds.length > 0) this.commitKernelRequests([{ kind: "delete", nodeIds }]);
  }

  reorderPageChild(orderedIds: string[], pageId?: string): void {
    this.commitKernelRequests([{ kind: "reorder", parentId: null, pageId: pageId ?? this.state.activePageId, orderedIds }]);
  }

  /** Move a same-parent selection through z-order in one undoable transaction. */
  reorderNodes(
    ids: readonly string[],
    direction: "forward" | "backward" | "front" | "back",
  ): boolean {
    const nodes = [...new Set(ids)].map((id) => this.state.document.nodes[id]).filter((node): node is DesignNode => node !== undefined);
    if (nodes.length === 0 || !nodes.every((node) => node.parentId === nodes[0]!.parentId)) return false;
    const parentId = nodes[0]!.parentId;
    const pageId = parentId === null
      ? this.state.document.pages.find((page) => nodes.every((node) => page.children.includes(node.id)))?.id
      : undefined;
    if (parentId === null && !pageId) return false;
    const current = parentId === null
      ? this.state.document.pages.find((page) => page.id === pageId)?.children
      : this.state.document.nodes[parentId]?.childIds;
    if (!current) return false;
    const selected = new Set(nodes.map((node) => node.id));
    let ordered = [...current];
    if (direction === "front") {
      ordered = [...ordered.filter((id) => !selected.has(id)), ...ordered.filter((id) => selected.has(id))];
    } else if (direction === "back") {
      ordered = [...ordered.filter((id) => selected.has(id)), ...ordered.filter((id) => !selected.has(id))];
    } else if (direction === "forward") {
      for (let index = ordered.length - 2; index >= 0; index -= 1) {
        if (selected.has(ordered[index]!) && !selected.has(ordered[index + 1]!)) {
          [ordered[index], ordered[index + 1]] = [ordered[index + 1]!, ordered[index]!];
        }
      }
    } else {
      for (let index = 1; index < ordered.length; index += 1) {
        if (selected.has(ordered[index]!) && !selected.has(ordered[index - 1]!)) {
          [ordered[index - 1], ordered[index]] = [ordered[index]!, ordered[index - 1]!];
        }
      }
    }
    if (ordered.every((id, index) => id === current[index])) return false;
    return parentId === null
      ? this.commitKernelRequests([{ kind: "reorder", parentId, pageId: pageId!, orderedIds: ordered }])
      : this.commitKernelRequests([{ kind: "reorder", parentId, orderedIds: ordered }]);
  }

  /**
   * Append a new empty page to the document and switch to it (a single undo
   * entry). The page id reuses the scene-graph's deterministic generator; the
   * name defaults to `Page <n>` derived from that id.
   */
  addPage(name?: string): string {
    const result = applyDesignTransaction(this.state.document, { kind: "page", ...(name !== undefined ? { name } : {}) });
    if (!result.ok || result.receipt.changedPageIds?.[0] === undefined) {
      throw new Error(result.ok ? "Page transaction returned no created page." : result.error.message);
    }
    const id = result.receipt.changedPageIds[0];
    this.pushUndo(this.state.document);
    this.state = { document: result.document, activePageId: id, selection: [] };
    this.emit("document");
    return id;
  }

  private pushUndo(doc: DesignDocument): void {
    this.undoStack.push(doc);
    this.redoStack = [];
  }

  // ----- transient interactions (single undo entry on release) -----

  beginTransient(): void {
    this.transientBase = this.state.document;
  }

  /** Apply an absolute gesture matrix to its starting snapshot, avoiding cumulative rounding. */
  transformTransient(ids: readonly string[], matrix: GeometryMatrix): void {
    const base = this.transientBase ?? this.state.document;
    const result = applyDesignTransaction(base, { kind: "affine", nodeIds: [...ids], matrix });
    if (!result.ok) return;
    this.state = { ...this.state, document: result.document };
    this.emit("interaction");
  }

  updateTransientConnector(id: string, patch: ConnectorPatch): void {
    const result = applyDesignTransaction(this.state.document, { kind: "connector", nodeId: id, patch });
    if (!result.ok) return;
    this.state = { ...this.state, document: result.document };
    this.emit("interaction");
  }

  updateTransientNodes(boxes: Map<string, Box>): void {
    const updates = [...boxes]
      .filter(([nodeId]) => {
        const node = this.state.document.nodes[nodeId];
        return node !== undefined && node.connector === undefined;
      })
      .map(([nodeId, box]) => ({ nodeId, ...box }));
    if (updates.length === 0) return;
    const result = applyDesignTransaction(this.state.document, { kind: "transform", updates });
    if (!result.ok || result.document === this.state.document) return;
    this.state = { ...this.state, document: result.document };
    this.emit("interaction");
  }

  nudgeNodes(ids: readonly string[], dx: number, dy: number): void {
    const updates = [...new Set(ids)]
      .map((nodeId) => this.state.document.nodes[nodeId])
      .filter((node): node is DesignNode => node !== undefined)
      .map((node) => ({ nodeId: node.id, x: node.x + dx, y: node.y + dy }));
    if (updates.length > 0) this.commitKernelRequests([{ kind: "transform", updates }]);
  }

  alignNodes(
    ids: readonly string[],
    axis: "horizontal" | "vertical",
    mode: "start" | "center" | "end",
  ): boolean {
    const nodeIds = [...new Set(ids)].filter((id) => this.state.document.nodes[id] !== undefined);
    return nodeIds.length >= 2 && this.commitKernelRequests([{ kind: "align", nodeIds, axis, mode }]);
  }

  distributeNodes(ids: readonly string[], axis: "horizontal" | "vertical"): boolean {
    const nodeIds = [...new Set(ids)].filter((id) => this.state.document.nodes[id] !== undefined);
    return nodeIds.length >= 3 && this.commitKernelRequests([{ kind: "distribute", nodeIds, axis }]);
  }

  /**
   * Transiently replace a vector node's network + box (node-edit drags). Uses
   * the same begin/endTransient wrapper as move/resize so a whole anchor/handle
   * drag collapses into a single undo entry.
   */
  updateTransientVector(id: string, network: VectorNetwork, box: Box): void {
    const node = this.state.document.nodes[id];
    if (!node || node.connector) return;
    const result = applyDesignTransaction(this.state.document, {
      kind: "vector",
      nodeId: id,
      vectorNetwork: network,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    });
    if (!result.ok || result.receipt.outcome === "noop") return;
    this.state = { ...this.state, document: result.document };
    this.emit("interaction");
  }

  cancelTransient(): void {
    const base = this.transientBase;
    this.transientBase = null;
    if (!base) return;
    this.state = { ...this.state, document: base };
    this.emit("interaction");
  }

  endTransient(): void {
    const base = this.transientBase;
    this.transientBase = null;
    if (!base) return;
    if (base === this.state.document) return;
    this.undoStack.push(base);
    this.redoStack = [];
    this.emit("document");
  }

  // ----- undo / redo -----

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.state.document);
    this.state = {
      ...this.state,
      document: previous,
      activePageId: this.clampActivePage(previous),
      selection: this.pruneSelection(this.state.selection, previous),
    };
    this.emit("document");
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.state.document);
    this.state = {
      ...this.state,
      document: next,
      activePageId: this.clampActivePage(next),
      selection: this.pruneSelection(this.state.selection, next),
    };
    this.emit("document");
  }
}
