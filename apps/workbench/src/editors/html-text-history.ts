import type { EditorState } from "@mdxeditor/lexical";

export type HtmlTextHistoryView =
  | { kind: "source"; anchor: number; head: number; scrollTop: number }
  | { kind: "text"; session: object; regionId: string; regionIndex: number; regionCount: number; regionTagName: string; state: EditorState; anchor: number; focus: number; scrollX: number; scrollY: number };
export type HtmlTextHistorySnapshot = { source: string; canUndo: boolean; canRedo: boolean };
export type HtmlTextHistoryEvent = HtmlTextHistorySnapshot & { kind: "record" | "restore" | "reset"; view?: HtmlTextHistoryView };
type Entry = { group?: object; offset: number; before: string; after: string; beforeView?: HtmlTextHistoryView; afterView?: HtmlTextHistoryView };

/** One chronological history for the HTML document, independent of focused region or mode. */
export class HtmlTextDocumentHistory {
  private source: string;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private listeners = new Set<(event: HtmlTextHistoryEvent) => void>();

  constructor(source: string) { this.source = source; }
  getSnapshot(): HtmlTextHistorySnapshot {
    return { source: this.source, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
  }
  subscribe(listener: (event: HtmlTextHistoryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(kind: HtmlTextHistoryEvent["kind"], view?: HtmlTextHistoryView): void {
    const event = { ...this.getSnapshot(), kind, ...(view ? { view } : {}) };
    for (const listener of this.listeners) listener(event);
  }
  record(nextSource: string, views: { before?: HtmlTextHistoryView; after?: HtmlTextHistoryView } = {}, group?: object): boolean {
    if (nextSource === this.source) return false;
    // A composition updates the canonical draft continuously but remains one
    // undoable action, including formatting applied when composition commits.
    let base = this.source;
    let beforeView = views.before;
    const previous = this.undoStack.at(-1);
    if (group && previous?.group === group) {
      base = this.source.slice(0, previous.offset) + previous.before + this.source.slice(previous.offset + previous.after.length);
      beforeView = previous.beforeView;
      this.undoStack.pop();
    }
    if (nextSource === base) {
      this.source = nextSource; this.emit("record"); return true;
    }
    let offset = 0;
    while (offset < base.length && offset < nextSource.length && base[offset] === nextSource[offset]) offset++;
    let beforeEnd = base.length, afterEnd = nextSource.length;
    while (beforeEnd > offset && afterEnd > offset && base[beforeEnd - 1] === nextSource[afterEnd - 1]) { beforeEnd--; afterEnd--; }
    this.undoStack.push({ ...(group ? { group } : {}), offset, before: base.slice(offset, beforeEnd), after: nextSource.slice(offset, afterEnd), ...(beforeView ? { beforeView } : {}), ...(views.after ? { afterView: views.after } : {}) });
    this.source = nextSource;
    this.redoStack = [];
    this.emit("record");
    return true;
  }
  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    if (this.source.slice(entry.offset, entry.offset + entry.after.length) !== entry.after) throw new Error("HTML history no longer matches the current source.");
    this.redoStack.push(entry);
    this.source = this.source.slice(0, entry.offset) + entry.before + this.source.slice(entry.offset + entry.after.length);
    this.emit("restore", entry.beforeView);
    return true;
  }
  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    if (this.source.slice(entry.offset, entry.offset + entry.before.length) !== entry.before) throw new Error("HTML history no longer matches the current source.");
    this.undoStack.push(entry);
    this.source = this.source.slice(0, entry.offset) + entry.after + this.source.slice(entry.offset + entry.before.length);
    this.emit("restore", entry.afterView);
    return true;
  }
  /** External replacement establishes a new baseline; never call for own save echoes. */
  reset(source: string): void {
    this.source = source;
    this.undoStack = [];
    this.redoStack = [];
    this.emit("reset");
  }
}
