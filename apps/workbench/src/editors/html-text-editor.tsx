import { useCallback, useEffect, useRef, useState } from "react";
import {
  $createParagraphNode, ParagraphNode, TextNode, $getRoot, $setSelection,
  COMMAND_PRIORITY_HIGH, createEditor, KEY_ENTER_COMMAND,
  REDO_COMMAND, UNDO_COMMAND, SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG, type EditorState, type LexicalEditor,
} from "@mdxeditor/lexical";
import { registerPlainText } from "@mdxeditor/lexical-plain-text";
import { applyHtmlRegionTexts, buildHtmlTextModel, deleteHtmlParagraph, type HtmlTextModel, type HtmlTextRegion } from "./html-text-model";
import { insertHtmlTextBreak } from "./html-text-breaks";
import { htmlPageLinkTargets, prepareHtmlPageLinkTarget } from "./html-page-links";
import { HtmlTextDocumentHistory, type HtmlTextHistoryView } from "./html-text-history";
import { HtmlSourceInlineNode, inlineAppearance, $appendHtmlRegionRuns, $reconcileHtmlRegion } from "./html-text-inline-node";
import { HtmlFormattingToolbar, type HtmlFormattingMark, type HtmlFormattingSelection, type HtmlLinkDialogState } from "./html-formatting-toolbar";
import { describeHtmlFormatting, emptyHtmlFormattingSelection, mapHtmlSourceOwners } from "./html-formatting-selection";
import { applyHtmlFormatting, htmlFormattingLinkRange, insertHtmlTextAfterAnnotation, normalizeHtmlLinkUrl, type HtmlFormattingAction } from "./html-text-formatting";
import { $htmlTextSelectionOffsets, $htmlTextSelectionAtOffsets, captureHtmlDomSelection, type HtmlTextSelectionOffsets } from "./html-text-selection";

export type HtmlTextEditorProps = {
  value: string;
  onChange: (source: string) => void;
  onSave?: () => void;
  history?: HtmlTextDocumentHistory;
  /** A hidden Text surface retains its live session while Source is visible. */
  active?: boolean;
};

// Parent-owned editing code can access this frame; authored scripts never can.
const EDIT_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const EDIT_STYLE = `
html { scroll-behavior: auto !important; }
[data-nautilo-html-region] { cursor: text; }
[data-nautilo-html-region]:empty { min-height: 1em; }
[data-nautilo-html-region]:hover { outline: 1px dashed #64748b; outline-offset: 3px; }
[data-nautilo-html-region]:focus { outline: 2px solid #6366f1; outline-offset: 3px; }
[data-nautilo-html-region][contenteditable=true] > p { all: unset; display: contents; }
/* An empty display:contents wrapper has no caret box in Chromium. Keep
   Lexical's empty line editable without inserting placeholder source text. */
[data-nautilo-html-region][contenteditable=true] > p:empty,
[data-nautilo-html-region][contenteditable=true] > p:has(> br:only-child) { display: block; min-height: 1em; }
`;
const RESTORE_TAG = SKIP_SCROLL_INTO_VIEW_TAG;
type TextView = Extract<HtmlTextHistoryView, { kind: "text" }>;
type EditCoordinates = { regionIndex: number; anchor: number; focus: number; scrollX: number; scrollY: number };
function createModel(source: string): HtmlTextModel { return buildHtmlTextModel(source, { previewCsp: EDIT_CSP, previewStyle: EDIT_STYLE }); }

export function HtmlTextEditor({ value, onChange, onSave, history: sharedHistory, active = true }: HtmlTextEditorProps) {
  const ownedHistory = useRef<HtmlTextDocumentHistory | null>(null);
  ownedHistory.current ??= new HtmlTextDocumentHistory(value);
  const history = sharedHistory ?? ownedHistory.current;
  const [session, setSession] = useState(() => ({ model: createModel(value), identity: {}, generation: 0 }));
  const liveSession = useRef(session);
  const initializeFrameRef = useRef<() => void>(() => {});
  const [formatSelection, setFormatSelection] = useState<HtmlFormattingSelection>(emptyHtmlFormattingSelection);
  const [canDeleteParagraph, setCanDeleteParagraph] = useState(false);
  const deleteParagraphRef = useRef<() => void>(() => {});
  const [linkDialog, setLinkDialog] = useState<HtmlLinkDialogState | null>(null);
  const linkDialogRef = useRef(linkDialog);
  linkDialogRef.current = linkDialog;
  const [linkError, setLinkError] = useState<string | null>(null);
  const pendingMarks = useRef<{ regionIndex: number; offset: number; marks: Partial<Record<HtmlFormattingMark, boolean>> } | null>(null);
  const formatCoordinates = useRef<EditCoordinates | null>(null);
  const formatting = useRef<{ toggle: (mark: HtmlFormattingMark) => void; openLink: () => void; applyLink: (remove?: boolean) => void; cancelLink: () => void }>({ toggle: () => {}, openLink: () => {}, applyLink: () => {}, cancelLink: () => {} });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [historyStatus, setHistoryStatus] = useState(() => history.getSnapshot());
  const historyStatusRef = useRef(historyStatus);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const activeEditor = useRef<LexicalEditor | null>(null);
  const disposeFrame = useRef<() => void>(() => {});
  const restoreInFrame = useRef<(view: TextView, focus: boolean) => boolean>(() => false);
  const pendingRestore = useRef<TextView | null>(null);
  const emittedSource = useRef(value);
  const renderedSource = useRef(value);
  const isActive = useRef(active);
  isActive.current = active;
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };

  const rebuild = useCallback((source: string) => {
    disposeFrame.current();
    restoreInFrame.current = () => false;
    activeEditor.current = null;
    renderedSource.current = source;
    setActiveLabel(null); setError(null); setLinkDialog(null); setLinkError(null);
    setFormatSelection(emptyHtmlFormattingSelection); setCanDeleteParagraph(false); pendingMarks.current = null;
    const next = { model: createModel(source), identity: {}, generation: liveSession.current.generation + 1 };
    liveSession.current = next;
    setSession(next);
  }, []);

  useEffect(() => history.subscribe(event => {
    const previousStatus = historyStatusRef.current;
    historyStatusRef.current = history.getSnapshot();
    setHistoryStatus(historyStatusRef.current);
    if (event.kind === "record") { setNotice(null); return; }
    if (event.kind === "reset" && (previousStatus.canUndo || previousStatus.canRedo)) setNotice("Document updated elsewhere; undo history restarted.");
    pendingMarks.current = null; setLinkDialog(null); linkDialogRef.current = null; setLinkError(null);
    emittedSource.current = event.source;
    const view = event.view?.kind === "text" ? event.view : null;
    pendingRestore.current = view;
    if (event.kind === "restore" && view && restoreInFrame.current(view, isActive.current)) {
      renderedSource.current = event.source;
      if (isActive.current) pendingRestore.current = null;
    } else if (isActive.current) rebuild(event.source);
    if (!sharedHistory) callbacks.current.onChange(event.source);
  }), [history, rebuild, sharedHistory]);

  useEffect(() => {
    if (value === emittedSource.current) return;
    emittedSource.current = value;
    if (history.getSnapshot().source !== value) history.reset(value);
    else if (active && renderedSource.current !== value) rebuild(value);
  }, [value, active, history, rebuild]);

  useEffect(() => {
    if (!active) return;
    const source = history.getSnapshot().source;
    if (renderedSource.current !== source) { rebuild(source); return; }
    const view = pendingRestore.current;
    if (view && restoreInFrame.current(view, true)) pendingRestore.current = null;
  }, [active, history, rebuild]);
  useEffect(() => () => disposeFrame.current(), []);

  const initializeFrame = useCallback(() => {
    disposeFrame.current();
    const frame = iframeRef.current;
    const doc = frame?.contentDocument;
    if (!doc || !frame?.contentWindow) return;
    const frameWindow = frame.contentWindow;
    const currentSession = liveSession.current;
    const model = currentSession.model;
    const edits = new Map<string, string>();
    const editors = new Map<HTMLElement, LexicalEditor>();
    const cleanups: Array<() => void> = [];
    const originalMarkup = new Map<HTMLElement, string>();
    let beforeInput: { regionId: string; text: string; offsets: HtmlTextSelectionOffsets; scroll: { x: number; y: number } } | null = null;

    const viewFor = (editorState: EditorState, region: HtmlTextRegion, scroll = { x: frameWindow.scrollX, y: frameWindow.scrollY }): TextView => ({
      kind: "text", session: currentSession.identity, regionId: region.id, regionIndex: model.regions.indexOf(region), regionCount: model.regions.length, regionTagName: region.tagName, state: editorState,
      ...editorState.read($htmlTextSelectionOffsets), scrollX: scroll.x, scrollY: scroll.y,
    });

    type Target = { editor: LexicalEditor; element: HTMLElement; region: HtmlTextRegion; regionIndex: number; offsets: HtmlTextSelectionOffsets; view: TextView; description: ReturnType<typeof describeHtmlFormatting>; sourceInlineStyles: Record<number, string> };
    let linkTarget: Target | null = null;
    let linkSource: string | null = null;
    let composition: { target: Target; text: string; source: string; exitAnnotation: boolean;
      marks: Partial<Record<HtmlFormattingMark, boolean>> } | null = null;
    let compositionFrame: number | null = null;
    const captureTarget = (includeSourceStyles = false): Target | null => {
      const anchor = frameWindow.getSelection()?.anchorNode;
      const element = (anchor?.nodeType === 1 ? anchor as Element : anchor?.parentElement)?.closest<HTMLElement>("[data-nautilo-html-region]");
      const editor = element && editors.get(element);
      const regionIndex = model.regions.findIndex(region => region.id === element?.dataset.nautiloHtmlRegion);
      if (!element || !editor || regionIndex < 0) return null;
      const offsets = captureHtmlDomSelection(element, editor);
      if (!offsets) return null;
      const description = describeHtmlFormatting(element, offsets);
      const sourceInlineStyles: Record<number, string> = {};
      const ancestors: Element[] = [];
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) ancestors.push(ancestor);
      if (includeSourceStyles) for (const candidate of [element, ...ancestors, ...element.querySelectorAll<HTMLElement>("[data-nautilo-html-source]")]) {
        const offset = candidate.getAttribute("data-nautilo-html-source");
        if (offset !== null) sourceInlineStyles[Number(offset)] = inlineAppearance(frameWindow.getComputedStyle(candidate), { includeResourceUrls: false });
      }
      const view = { ...viewFor(editor.getEditorState(), model.regions[regionIndex]), ...offsets };
      return { editor, element, region: model.regions[regionIndex], regionIndex, offsets, view, description, sourceInlineStyles };
    };
    const refreshFormatting = () => {
      if (linkDialogRef.current) return;
      const target = captureTarget();
      if (!target) { pendingMarks.current = null; setFormatSelection(emptyHtmlFormattingSelection); setCanDeleteParagraph(false); return; }
      setCanDeleteParagraph(!!target.region.paragraph);
      const pending = pendingMarks.current;
      if (!composition && pending && (pending.regionIndex !== target.regionIndex || pending.offset !== target.offsets.anchor || target.offsets.anchor !== target.offsets.focus)) pendingMarks.current = null;
      const selection = target.description.selection;
      if (pendingMarks.current) for (const [mark, enabled] of Object.entries(pendingMarks.current.marks)) selection.marks[mark as HtmlFormattingMark] = enabled ? "on" : "off";
      setFormatSelection(selection);
    };
    const freshRegion = (source: string, target: Target) => {
      const fresh = createModel(source), region = fresh.regions[target.regionIndex];
      if (!region || fresh.regions.length !== model.regions.length || region.tagName !== target.region.tagName) throw new Error("The page changed. Select the text again.");
      return { fresh, region };
    };
    const applyAction = (source: string, target: Target, action: HtmlFormattingAction, offsets = target.offsets) => {
      const { fresh, region } = freshRegion(source, target);
      if (action.kind === "mark" && action.mark === "underline" && !action.enabled && target.description.unlocatedUnderline) throw new Error("This underline comes from an implicit page element. Use Source to change it.");
      const owners = action.kind === "mark" && action.mark === "underline" && !action.enabled
        ? mapHtmlSourceOwners(model.previewHtml, fresh.previewHtml, target.description.underlineOwners, target.description.underlineOwnerLines) : {};
      const sourceInlineStyles = action.kind === "link" || action.mark === "underline" || action.mark === "superscript" ? mapHtmlSourceOwners(model.previewHtml, fresh.previewHtml,
        Object.keys(target.sourceInlineStyles).map(Number), target.sourceInlineStyles).underlineOwnerLines : undefined;
      const result = applyHtmlFormatting(fresh, source, { regionId: region.id, ...offsets, action, ...owners, sourceInlineStyles });
      if (!result.ok) throw new Error(result.reason);
      return result;
    };
    const installModel = (next: typeof currentSession, coordinates: EditCoordinates | null, before: TextView, group?: object) => {
      const source = next.model.source;
      const parsed = new DOMParser().parseFromString(next.model.previewHtml, "text/html");
      // Reinstall only the inert preview. Canonical saving still uses the exact
      // source patch above. Synchronous focus restoration keeps rapid typing
      // after a collapsed formatting toggle in the same input stream.
      disposeFrame.current();
      activeEditor.current = null; setActiveLabel(null);
      liveSession.current = next; pendingRestore.current = null; formatCoordinates.current = coordinates;
      emittedSource.current = source; renderedSource.current = source;
      pendingMarks.current = null; setLinkDialog(null); linkDialogRef.current = null; setLinkError(null); setError(null);
      doc.replaceChild(doc.importNode(parsed.documentElement, true), doc.documentElement);
      initializeFrameRef.current();
      const region = coordinates && next.model.regions[coordinates.regionIndex];
      const afterEditor = activeEditor.current as LexicalEditor | null;
      if (coordinates && (!afterEditor || !region)) throw new Error("The edited text could not be focused.");
      const after: TextView | undefined = coordinates && region && afterEditor ? { kind: "text", session: next.identity, regionId: region.id,
        ...coordinates, regionCount: next.model.regions.length, regionTagName: region.tagName,
        state: afterEditor.getEditorState() } : undefined;
      if (!coordinates) { frame.focus(); frameWindow.scrollTo(before.scrollX, before.scrollY); }
      history.record(source, { before, after }, group);
      callbacks.current.onChange(source);
    };
    const installFormatting = (source: string, target: Target, offsets: HtmlTextSelectionOffsets, before = target.view, group?: object) => {
      if (source === history.getSnapshot().source) return;
      const next = { model: createModel(source), identity: {}, generation: currentSession.generation };
      const nextRegion = next.model.regions[target.regionIndex];
      if (next.model.regions.length !== model.regions.length || !nextRegion || nextRegion.tagName !== target.region.tagName) {
        throw new Error("This formatting would change the page's text areas. Use Source to edit this selection.");
      }
      installModel(next, { regionIndex: target.regionIndex, ...offsets, scrollX: before.scrollX, scrollY: before.scrollY }, before, group);
    };
    const removeParagraph = (target: Target, preferPrevious: boolean) => {
      try {
        const { fresh, region } = freshRegion(emittedSource.current, target);
        const result = deleteHtmlParagraph(fresh, emittedSource.current, region.id);
        if (!result.ok) throw new Error(result.reason);
        const next = { model: createModel(result.source), identity: {}, generation: currentSession.generation };
        const beforeCount = fresh.regions.filter(candidate => candidate.runs[0].startOffset < region.paragraph!.startOffset).length;
        const regionIndex = preferPrevious && beforeCount > 0 ? beforeCount - 1 : Math.min(beforeCount, next.model.regions.length - 1);
        const neighbour = next.model.regions[regionIndex];
        const offset = regionIndex < beforeCount && neighbour ? neighbour.text.length : 0;
        installModel(next, neighbour ? { regionIndex, anchor: offset, focus: offset, scrollX: target.view.scrollX, scrollY: target.view.scrollY } : null, target.view);
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not delete this paragraph."); }
    };
    const insertBreak = (soft: boolean) => {
      const target = captureTarget(true);
      if (!target || composition || linkDialogRef.current) return;
      try {
        const { fresh, region } = freshRegion(emittedSource.current, target);
        const styles = mapHtmlSourceOwners(model.previewHtml, fresh.previewHtml,
          Object.keys(target.sourceInlineStyles).map(Number), target.sourceInlineStyles).underlineOwnerLines;
        const result = insertHtmlTextBreak(fresh, region.id, target.offsets.anchor, target.offsets.focus, soft, styles);
        if (!result.ok) throw new Error(result.reason);
        const next = { model: createModel(result.source), identity: {}, generation: currentSession.generation };
        installModel(next, { regionIndex: result.regionIndex, anchor: result.offset, focus: result.offset,
          scrollX: target.view.scrollX, scrollY: target.view.scrollY }, target.view);
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not insert a break."); }
    };
    deleteParagraphRef.current = () => { const target = captureTarget(); if (target && !linkDialogRef.current) removeParagraph(target, false); };
    const restoreTarget = (target: Target) => {
      target.editor.update(() => { $setSelection($htmlTextSelectionAtOffsets(target.offsets.anchor, target.offsets.focus)); }, { discrete: true, tag: RESTORE_TAG });
      target.element.focus({ preventScroll: true }); frameWindow.scrollTo(target.view.scrollX, target.view.scrollY);
    };
    formatting.current = {
      toggle(mark) {
        const target = captureTarget(true);
        if (!target) { setFormatSelection(emptyHtmlFormattingSelection); return; }
        const pending = pendingMarks.current;
        const existing = pending?.regionIndex === target.regionIndex && pending.offset === target.offsets.anchor ? pending.marks[mark] : undefined;
        const enabled = existing === undefined ? target.description.selection.marks[mark] !== "on" : !existing;
        if (target.offsets.anchor === target.offsets.focus) {
          pendingMarks.current = { regionIndex: target.regionIndex, offset: target.offsets.anchor,
            marks: { ...(pending?.regionIndex === target.regionIndex && pending.offset === target.offsets.anchor ? pending.marks : {}), [mark]: enabled } };
          restoreTarget(target); refreshFormatting(); return;
        }
        try { const result = applyAction(emittedSource.current, target, { kind: "mark", mark, enabled }); installFormatting(result.source, target, result); }
        catch (caught) { setError(caught instanceof Error ? caught.message : "Could not format this selection."); }
      },
      openLink() {
        const target = captureTarget(true); if (!target) return;
        const { fresh, region } = freshRegion(emittedSource.current, target);
        const current = target.offsets.anchor === target.offsets.focus ? htmlFormattingLinkRange(fresh, region.id, target.offsets.anchor) : null;
        setFormatSelection(target.description.selection);
        linkTarget = target; linkSource = emittedSource.current;
        const dialog = { url: current?.href ?? target.description.selection.link?.href ?? "", text: "",
          editingExisting: !!current || !!target.description.selection.link, canRemove: !!current || target.description.anyLink,
          pageTargets: htmlPageLinkTargets(emittedSource.current) };
        setLinkError(null); setLinkDialog(dialog); linkDialogRef.current = dialog;
      },
      applyLink(remove = false) {
        const target = linkTarget, dialog = linkDialogRef.current;
        if (!target || !dialog) return;
        if (linkSource !== emittedSource.current) { setLinkError("The document changed. Cancel and select the text again."); return; }
        const href = remove ? null : normalizeHtmlLinkUrl(dialog.url);
        if (!remove && !href) { setLinkError("Enter a valid web, email, phone, or relative link."); return; }
        try {
          const pageLink = !remove && dialog.pageTarget !== undefined ? prepareHtmlPageLinkTarget(emittedSource.current, dialog.pageTarget) : null;
          const result = applyAction(pageLink?.source ?? emittedSource.current, target, { kind: "link", href: pageLink?.href ?? href,
            ...(target.description.selection.collapsed && !dialog.editingExisting && !remove ? { text: dialog.text || href! } : {}) });
          if (result.source === emittedSource.current) { formatting.current.cancelLink(); return; }
          installFormatting(result.source, target, dialog.editingExisting && target.description.selection.collapsed ? target.offsets : result);
        } catch (caught) { setLinkError(caught instanceof Error ? caught.message : "Could not update this link."); }
      },
      cancelLink() {
        setLinkDialog(null); linkDialogRef.current = null; setLinkError(null);
        if (linkTarget) restoreTarget(linkTarget);
        linkTarget = null; linkSource = null; refreshFormatting();
      },
    };

    function activate(element: HTMLElement, region: HtmlTextRegion): LexicalEditor {
      const existing = editors.get(element);
      if (existing) { activeEditor.current = existing; setActiveLabel(region.label); return existing; }
      const appearances = new Map<string, string>();
      for (const run of region.runs) for (const inline of run.inlinePath ?? []) {
        const original = element.querySelector<HTMLElement>(`[data-nautilo-html-inline="${inline.id}"]`);
        if (original && !appearances.has(inline.id)) appearances.set(inline.id, inlineAppearance(frameWindow.getComputedStyle(original)));
      }
      const editor = createEditor({ namespace: "html-text-region", nodes: [HtmlSourceInlineNode], onError: caught => setError(caught.message) });
      originalMarkup.set(element, element.innerHTML);
      const originalWhiteSpace = frameWindow.getComputedStyle(element).whiteSpace;
      element.contentEditable = "true";
      element.setAttribute("role", "textbox"); element.setAttribute("aria-label", region.label); element.setAttribute("aria-multiline", "true");
      editor.setRootElement(element);
      element.style.whiteSpace = originalWhiteSpace;
      const unregisterPlain = registerPlainText(editor);
      editor.update(() => {
        const paragraph = $createParagraphNode();
        $appendHtmlRegionRuns(paragraph, region.runs, appearances);
        $getRoot().clear().append(paragraph);
      }, { discrete: true });
      const unregisterUpdate = editor.registerUpdateListener(({ editorState, prevEditorState, dirtyElements, dirtyLeaves, tags }) => {
        if (!dirtyElements.size && !dirtyLeaves.size) return;
        const text = editorState.read(() => $getRoot().getTextContent());
        const previousText = prevEditorState.read(() => $getRoot().getTextContent());
        if (text === previousText) return;
        edits.set(region.id, text);
        const result = applyHtmlRegionTexts(model, model.source, [...edits].map(([regionId, nextText]) => ({ regionId, text: nextText })));
        if (!result.ok) { setError(result.reason); return; }
        setError(null); emittedSource.current = result.source; renderedSource.current = result.source;
        // Selection-only focus tags can be batched with the next keystroke.
        // Suppress an actual history restore, never a new text change.
        if ((tags.has(RESTORE_TAG) || tags.has(SKIP_DOM_SELECTION_TAG)) && result.source === history.getSnapshot().source) return;
        const captured = beforeInput?.regionId === region.id && beforeInput.text === previousText ? beforeInput : null;
        const beforeView = viewFor(prevEditorState, region, captured?.scroll);
        if (captured) Object.assign(beforeView, captured.offsets);
        beforeInput = null;
        const pending = pendingMarks.current;
        if (pending?.regionIndex === model.regions.indexOf(region) && !composition && !editor.isComposing()) {
          let start = 0, suffix = 0;
          while (start < previousText.length && start < text.length && previousText[start] === text[start]) start++;
          while (suffix < previousText.length - start && suffix < text.length - start && previousText[previousText.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
          if (text.length - suffix > start) {
            const target = captureTarget(true);
            if (target) {
              try {
                let formatted = result.source;
                for (const mark of ["underline", "bold", "italic", "superscript"] as const) {
                  const enabled = pending.marks[mark];
                  if (enabled !== undefined) formatted = applyAction(formatted, target, { kind: "mark", mark, enabled }, { anchor: start, focus: text.length - suffix }).source;
                }
                const after = editorState.read($htmlTextSelectionOffsets);
                installFormatting(formatted, target, after, beforeView);
                if (pending.marks.superscript) pendingMarks.current = { regionIndex: target.regionIndex, offset: after.focus, marks: { superscript: true } };
                return;
              } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not format the inserted text."); }
            }
            pendingMarks.current = null;
          } else pending.offset = editorState.read($htmlTextSelectionOffsets).focus;
        }
        history.record(result.source, { before: beforeView, after: viewFor(editorState, region) }, composition ?? undefined);
        callbacks.current.onChange(result.source);
      });
      const reconcile = () => {
        const selection = $htmlTextSelectionOffsets();
        if ($reconcileHtmlRegion(region, appearances)) $setSelection($htmlTextSelectionAtOffsets(selection.anchor, selection.focus));
      };
      const unregisterTextTransform = editor.registerNodeTransform(TextNode, reconcile);
      const unregisterParagraphTransform = editor.registerNodeTransform(ParagraphNode, reconcile);
      const unregisterUndo = editor.registerCommand(UNDO_COMMAND, () => history.undo(), COMMAND_PRIORITY_HIGH);
      const unregisterRedo = editor.registerCommand(REDO_COMMAND, () => history.redo(), COMMAND_PRIORITY_HIGH);
      const unregisterEnter = editor.registerCommand(KEY_ENTER_COMMAND, event => { event?.preventDefault(); insertBreak(event?.shiftKey ?? false); return true; }, COMMAND_PRIORITY_HIGH);
      const focus = () => { activeEditor.current = editor; setActiveLabel(region.label); };
      element.addEventListener("focus", focus);
      cleanups.push(() => {
        unregisterPlain(); unregisterUpdate(); unregisterEnter(); unregisterUndo(); unregisterRedo();
        unregisterTextTransform(); unregisterParagraphTransform();
        element.removeEventListener("focus", focus); editor.setRootElement(null);
      });
      editors.set(element, editor); focus();
      return editor;
    }

    restoreInFrame.current = (view, focus) => {
      if (view.session !== currentSession.identity) return false;
      const region = model.regions.find(r => r.id === view.regionId);
      const element = doc.querySelector<HTMLElement>(`[data-nautilo-html-region="${view.regionId}"]`);
      if (!region || !element) return false;
      const editor = activate(element, region);
      // The DOM caret captured before input can be newer than this state's
      // selection (e.g. End navigation immediately followed by typing).
      const selection = view.state.read(() => $htmlTextSelectionAtOffsets(view.anchor, view.focus));
      editor.setEditorState(view.state.clone(selection), { tag: focus ? RESTORE_TAG : SKIP_DOM_SELECTION_TAG });
      if (focus) {
        element.focus({ preventScroll: true });
        frameWindow.scrollTo(view.scrollX, view.scrollY);
      }
      return true;
    };
    for (const region of model.regions) {
      const element = doc.querySelector<HTMLElement>(`[data-nautilo-html-region="${region.id}"]`);
      if (!element) continue;
      if (!region.text.trim()) element.style.minHeight = "1em";
      element.tabIndex = 0; element.setAttribute("aria-description", `Edit ${region.label}`);
      const focus = () => { const isNew = !editors.has(element); const editor = activate(element, region); if (isNew) editor.focus(undefined, { defaultSelection: "rootStart" }); };
      element.addEventListener("focus", focus); cleanups.push(() => element.removeEventListener("focus", focus));
    }
    const pointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const element = target?.closest<HTMLElement>("[data-nautilo-html-region]");
      const region = model.regions.find(candidate => candidate.id === element?.dataset.nautiloHtmlRegion);
      if (!element || !region || editors.has(element)) return;
      event.preventDefault(); const editor = activate(element, region);
      if (!region.text) {
        editor.update(() => { $setSelection($htmlTextSelectionAtOffsets(0, 0)); }, { discrete: true });
        element.focus({ preventScroll: true }); return;
      }
      editor.focus(() => {
        const pointDoc = doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null; caretRangeFromPoint?: (x: number, y: number) => Range | null };
        const point = pointDoc.caretPositionFromPoint?.(event.clientX, event.clientY);
        const range = pointDoc.caretRangeFromPoint?.(event.clientX, event.clientY) ?? doc.createRange();
        if (point) { range.setStart(point.offsetNode, point.offset); range.collapse(true); }
        if (element.contains(range.startContainer)) { const selection = frameWindow.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
      }, { defaultSelection: "rootStart" });
    };
    const click = (event: MouseEvent) => event.preventDefault();
    const captureBeforeInput = () => {
      const selection = frameWindow.getSelection();
      const anchor = selection?.anchorNode;
      const element = (anchor?.nodeType === 1 ? anchor as Element : anchor?.parentElement)?.closest<HTMLElement>("[data-nautilo-html-region]");
      const editor = element && editors.get(element);
      const regionId = element?.dataset.nautiloHtmlRegion;
      if (!element || !editor || !regionId) return null;
      const offsets = captureHtmlDomSelection(element, editor);
      if (!offsets) return null;
      beforeInput = { regionId, offsets, text: editor.getEditorState().read(() => $getRoot().getTextContent()), scroll: { x: frameWindow.scrollX, y: frameWindow.scrollY } };
      return { editor, element, offsets };
    };
    const insertAfterAnnotation = (text: string): boolean => {
      const target = captureTarget();
      if (!target || target.offsets.anchor !== target.offsets.focus || pendingMarks.current?.marks.superscript === true || !target.region.runs.some(run => run.inlinePath?.some(inline => inline.tagName === "sup" || inline.tagName === "sub"))) return false;
      try {
        const { fresh, region } = freshRegion(emittedSource.current, target);
        const result = insertHtmlTextAfterAnnotation(fresh, region.id, target.offsets.focus, text);
        if (!result) return false;
        if (!result.ok) throw new Error(result.reason);
        let source = result.source;
        const pending = pendingMarks.current;
        if (pending?.regionIndex === target.regionIndex) target.sourceInlineStyles = captureTarget(true)?.sourceInlineStyles ?? {};
        if (pending?.regionIndex === target.regionIndex) for (const mark of ["underline", "bold", "italic", "superscript"] as const) {
          const enabled = pending.marks[mark];
          if (enabled !== undefined) source = applyAction(source, target, { kind: "mark", mark, enabled }, { anchor: target.offsets.focus, focus: result.focus }).source;
        }
        installFormatting(source, target, result);
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not insert text after this citation."); }
      return true;
    };
    const paste = (event: ClipboardEvent) => {
      const captured = captureBeforeInput();
      if (!captured || !event.clipboardData || composition) return;
      const target = captureTarget();
      if (!target) return;
      const whiteSpace = frameWindow.getComputedStyle(target.element).whiteSpace;
      const clipboardText = event.clipboardData.getData("text/plain") || event.clipboardData.getData("text/uri-list");
      if (!clipboardText) return;
      const text = whiteSpace === "normal" || whiteSpace === "nowrap" ? clipboardText.replace(/\r\n?|\n/g, " ") : clipboardText;
      event.preventDefault(); event.stopPropagation();
      if (insertAfterAnnotation(text)) return;
      // Inserting plain text at the DOM range avoids raw node insertion moving
      // a paste to the end of an authored inline wrapper.
      captured.editor.update(() => {
        const selection = $htmlTextSelectionAtOffsets(captured.offsets.anchor, captured.offsets.focus);
        selection.style = "all:unset;display:contents";
        $setSelection(selection); selection.insertText(text);
      }, { discrete: true });
    };
    const input = (event: InputEvent) => {
      if (!event.isComposing && (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak")) {
        event.preventDefault(); event.stopPropagation(); insertBreak(event.inputType === "insertLineBreak"); return;
      }
      const captured = captureBeforeInput();
      if (!captured || event.isComposing || event.inputType !== "insertText" || event.data === null) return;
      // Native contenteditable under authored normal white-space can discard a
      // leading/trailing typed space. Controlled insertion keeps exact text and
      // uses the real DOM caret, while composition remains with Lexical/browser.
      event.preventDefault(); event.stopPropagation();
      const data = event.data;
      if (insertAfterAnnotation(data)) return;
      captured.editor.update(() => {
        const selection = $htmlTextSelectionAtOffsets(captured.offsets.anchor, captured.offsets.focus);
        selection.style = "all:unset;display:contents";
        $setSelection(selection); selection.insertText(data);
      }, { discrete: true });
    };
    const compositionStart = () => {
      const target = captureTarget(), pending = pendingMarks.current;
      if (target) {
        const marks = pending?.regionIndex === target.regionIndex ? { ...pending.marks } : {};
        const fresh = createModel(emittedSource.current), region = fresh.regions[target.regionIndex];
        const exitAnnotation = !!region && target.offsets.anchor === target.offsets.focus && !marks.superscript &&
          insertHtmlTextAfterAnnotation(fresh, region.id, target.offsets.focus, "x") !== null;
        if (exitAnnotation || Object.keys(marks).length) composition = { target,
          text: target.editor.getEditorState().read(() => $getRoot().getTextContent()), source: emittedSource.current, exitAnnotation, marks };
      }
    };
    const compositionEnd = () => {
      if (!composition) return;
      // Compositionend may precede the browser's final input event. Wait for
      // that transaction's commit, without guessing from an intermediate IME value.
      compositionFrame = frameWindow.requestAnimationFrame(() => {
        compositionFrame = null;
        const completed = composition;
        composition = null;
        if (!completed || liveSession.current.identity !== currentSession.identity) return;
        const target = captureTarget(true);
        if (!target || target.regionIndex !== completed.target.regionIndex) { pendingMarks.current = null; return; }
        const text = target.editor.getEditorState().read(() => $getRoot().getTextContent());
        const start = Math.min(completed.target.offsets.anchor, completed.target.offsets.focus);
        const end = Math.max(completed.target.offsets.anchor, completed.target.offsets.focus);
        const prefix = completed.text.slice(0, start), suffix = completed.text.slice(end);
        if (text === completed.text) { refreshFormatting(); return; }
        if (!text.startsWith(prefix) || !text.endsWith(suffix)) {
          pendingMarks.current = null; setError("The composition changed outside its selection. Select the committed text to format it."); return;
        }
        try {
          let source = emittedSource.current;
          if (completed.exitAnnotation) {
            const baseline = createModel(completed.source);
            const region = baseline.regions[completed.target.regionIndex];
            const inserted = text.slice(prefix.length, text.length - suffix.length);
            const continuation = region && insertHtmlTextAfterAnnotation(baseline, region.id, start, inserted);
            if (!continuation) throw new Error("The citation boundary changed during composition. Select the committed text and try again.");
            if (!continuation.ok) throw new Error(continuation.reason);
            source = continuation.source;
          }
          for (const mark of ["underline", "bold", "italic", "superscript"] as const) {
            const enabled = completed.marks[mark];
            if (enabled !== undefined) source = applyAction(source, target, { kind: "mark", mark, enabled }, { anchor: start, focus: text.length - suffix.length }).source;
          }
          installFormatting(source, target, target.offsets, completed.target.view, completed);
          if (completed.marks.superscript) pendingMarks.current = { regionIndex: target.regionIndex, offset: target.offsets.focus, marks: { superscript: true } };
        } catch (caught) { pendingMarks.current = null; setError(caught instanceof Error ? caught.message : "Select the committed text to format it."); }
      });
    };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || composition) return;
      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault(); event.stopPropagation(); insertBreak(event.shiftKey); return;
      }
      if ((event.key === "Backspace" || event.key === "Delete") && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const target = captureTarget();
        if (target?.region.paragraph?.wholeRegion && !target.editor.getEditorState().read(() => $getRoot().getTextContent()) && !linkDialogRef.current) {
          event.preventDefault(); event.stopPropagation(); removeParagraph(target, event.key === "Backspace"); return;
        }
      }
      captureBeforeInput();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); callbacks.current.onSave?.(); }
      else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.shiftKey && (event.key === "+" || event.key === "=")) {
        event.preventDefault(); event.stopPropagation(); formatting.current.toggle("superscript");
      }
      else if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && ["b", "i", "u", "k"].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopPropagation();
        const key = event.key.toLowerCase();
        if (key === "k") formatting.current.openLink();
        else formatting.current.toggle(key === "b" ? "bold" : key === "i" ? "italic" : "underline");
      }
      else if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
        event.preventDefault(); event.stopPropagation();
        if (event.shiftKey || event.key.toLowerCase() === "y") history.redo(); else history.undo();
      } else if (event.key === "Escape") { (doc.activeElement as HTMLElement | null)?.blur(); iframeRef.current?.focus(); }
    };
    doc.addEventListener("compositionstart", compositionStart, true); doc.addEventListener("compositionend", compositionEnd, true);
    doc.addEventListener("selectionchange", refreshFormatting);
    doc.addEventListener("pointerdown", pointerDown, true); doc.addEventListener("click", click);
    doc.addEventListener("keydown", key, true); doc.addEventListener("beforeinput", input, true); doc.addEventListener("paste", paste, true); doc.addEventListener("cut", captureBeforeInput, true);
    disposeFrame.current = () => {
      if (compositionFrame !== null) frameWindow.cancelAnimationFrame(compositionFrame);
      doc.removeEventListener("compositionstart", compositionStart, true); doc.removeEventListener("compositionend", compositionEnd, true);
      doc.removeEventListener("selectionchange", refreshFormatting);
      doc.removeEventListener("pointerdown", pointerDown, true); doc.removeEventListener("click", click);
      doc.removeEventListener("keydown", key, true); doc.removeEventListener("beforeinput", input, true); doc.removeEventListener("paste", paste, true); doc.removeEventListener("cut", captureBeforeInput, true);
      for (const cleanup of cleanups) cleanup();
      for (const [element, markup] of originalMarkup) { element.innerHTML = markup; element.removeAttribute("contenteditable"); }
      cleanups.length = 0;
    };
    const coordinates = formatCoordinates.current;
    if (coordinates) {
      formatCoordinates.current = null;
      const region = model.regions[coordinates.regionIndex];
      const element = region && doc.querySelector<HTMLElement>(`[data-nautilo-html-region="${region.id}"]`);
      if (element && region) {
        const editor = activate(element, region);
        editor.update(() => { $setSelection($htmlTextSelectionAtOffsets(coordinates.anchor, coordinates.focus)); }, { discrete: true, tag: RESTORE_TAG });
        element.focus({ preventScroll: true }); frameWindow.scrollTo(coordinates.scrollX, coordinates.scrollY);
      }
    }
    const pending = pendingRestore.current;
    if (pending && isActive.current) {
      const candidate = model.regions[pending.regionIndex];
      const expectedText = pending.state.read(() => $getRoot().getTextContent());
      const region = model.regions.length === pending.regionCount && candidate?.tagName === pending.regionTagName && candidate.text === expectedText ? candidate : undefined;
      const element = region && doc.querySelector<HTMLElement>(`[data-nautilo-html-region="${region.id}"]`);
      if (element && region) {
        const editor = activate(element, region);
        editor.update(() => {
          $setSelection($htmlTextSelectionAtOffsets(pending.anchor, pending.focus));
        }, { discrete: true, tag: RESTORE_TAG });
        element.focus({ preventScroll: true }); frameWindow.scrollTo(pending.scrollX, pending.scrollY);
      }
      pendingRestore.current = null;
    }
    refreshFormatting();
  }, [history]);
  initializeFrameRef.current = initializeFrame;

  if (session.model.blockedReason) return <div className="p-4 text-sm text-foreground-muted">{session.model.blockedReason} Use its app or Source to edit this document.</div>;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="html-text-editor">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs text-foreground-muted">
        <span>{activeLabel ? `Editing ${activeLabel}. Enter for a paragraph, Shift+Enter for a line break, Esc to finish.` : "Click text to edit. Tab moves between text areas."}</span>
        <span className="ml-auto">Page scripts paused while editing.</span>
      </div>
      <HtmlFormattingToolbar selection={formatSelection} onToggle={mark => formatting.current.toggle(mark)}
        canUndo={historyStatus.canUndo} canRedo={historyStatus.canRedo} onUndo={() => history.undo()} onRedo={() => history.redo()}
        canDeleteParagraph={canDeleteParagraph} onDeleteParagraph={() => deleteParagraphRef.current()}
        onOpenLink={() => formatting.current.openLink()} linkDialog={linkDialog}
        onLinkUrlChange={url => { setLinkDialog(current => current ? { ...current, url, pageTarget: undefined } : null); setLinkError(null); }}
        onLinkPageTargetChange={offset => { setLinkDialog(current => current ? { ...current, pageTarget: offset,
          url: current.pageTargets?.find(target => target.offset === offset)?.href ?? current.url } : null); setLinkError(null); }}
        onLinkTextChange={text => setLinkDialog(current => current ? { ...current, text } : null)}
        onLinkApply={() => formatting.current.applyLink()} onLinkRemove={() => formatting.current.applyLink(true)}
        onLinkCancel={() => formatting.current.cancelLink()} error={linkError} />
      {notice ? <p role="status" className="px-3 py-2 text-xs text-foreground-muted">{notice}</p> : null}
      {error ? <p role="alert" className="p-3 text-sm text-[var(--error)]">{error}</p> : null}
      {liveSession.current.model.regions.length === 0 ? <p className="p-3 text-sm text-foreground-muted">No editable text was found. Use Undo to restore deleted text, or Source to add content.</p> : null}
      <iframe key={session.generation} ref={iframeRef} title="Edit HTML text" sandbox="allow-same-origin" srcDoc={session.model.previewHtml} onLoad={initializeFrame} className="min-h-0 w-full flex-1 border-0 bg-white" />
    </div>
  );
}
