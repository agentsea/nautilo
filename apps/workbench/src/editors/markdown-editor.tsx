import {
  BoldItalicUnderlineToggles,
  ChangeCodeMirrorLanguage,
  codeBlockPlugin,
  codeMirrorPlugin,
  ConditionalContents,
  CreateLink,
  diffSourcePlugin,
  DiffSourceToggleWrapper,
  headingsPlugin,
  InsertCodeBlock,
  InsertTable,
  linkPlugin,
  listsPlugin,
  ListsToggle,
  markdownShortcutPlugin,
  MDXEditor,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  UndoRedo,
  type IconKey,
  type MDXEditorMethods,
} from "@mdxeditor/editor";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Bold,
  Check,
  ChevronDown,
  Code,
  Copy,
  Ellipsis,
  EllipsisVertical,
  ExternalLink,
  FileText,
  GitCompareArrows,
  Highlighter,
  Image as ImageIcon,
  Info,
  Italic,
  Link,
  Link2Off,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Pencil,
  Plus,
  Redo2,
  Settings,
  Square,
  Strikethrough,
  Subscript,
  Superscript,
  Table,
  Trash2,
  Type,
  Underline,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, type ReactElement } from "react";
import { useWorkbenchPortalContainer } from "../components/workbench-portals";
import "@mdxeditor/editor/style.css";

// codeBlockPlugin alone registers import/export for fenced code, but MDXEditor
// refuses to import mdast `code` nodes unless a CodeBlock editor descriptor
// exists. codeMirrorPlugin supplies that catch-all — without it, any fence
// (```bash, ```js, …) fails rich-text parse with type:"code".
const CODE_BLOCK_LANGUAGES: Record<string, string> = {
  txt: "Plain Text",
  bash: "Bash",
  shell: "Shell",
  sh: "Shell",
  js: "JavaScript",
  jsx: "JavaScript (JSX)",
  ts: "TypeScript",
  tsx: "TypeScript (TSX)",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  py: "Python",
  python: "Python",
  md: "Markdown",
  markdown: "Markdown",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
  toml: "TOML",
};

// Map MDXEditor's built-in icon keys to our lucide-react design language so the
// toolbar, table controls, and trash/delete buttons match the rest of the
// Workbench instead of MDXEditor's bundled (Material-Symbols-derived) glyphs.
const ICON_FOR: Partial<Record<IconKey, LucideIcon>> = {
  undo: Undo2,
  redo: Redo2,
  format_bold: Bold,
  format_italic: Italic,
  format_underlined: Underline,
  code: Code,
  strikeThrough: Strikethrough,
  superscript: Superscript,
  subscript: Subscript,
  format_list_bulleted: List,
  format_list_numbered: ListOrdered,
  format_list_checked: ListChecks,
  format_highlight: Highlighter,
  link: Link,
  link_off: Link2Off,
  add_photo: ImageIcon,
  table: Table,
  horizontal_rule: Minus,
  frame_source: Code,
  arrow_drop_down: ChevronDown,
  admonition: Info,
  rich_text: Type,
  difference: GitCompareArrows,
  markdown: FileText,
  open_in_new: ExternalLink,
  edit: Pencil,
  content_copy: Copy,
  more_horiz: Ellipsis,
  more_vert: EllipsisVertical,
  close: X,
  settings: Settings,
  delete_big: Trash2,
  delete_small: Trash2,
  format_align_center: AlignCenter,
  format_align_left: AlignLeft,
  format_align_right: AlignRight,
  add_row: Plus,
  add_column: Plus,
  insert_col_left: ArrowLeftToLine,
  insert_col_right: ArrowRightToLine,
  insert_row_above: ArrowUpToLine,
  insert_row_below: ArrowDownToLine,
  check: Check,
};

export function iconComponentFor(name: IconKey): ReactElement {
  const Icon = ICON_FOR[name] ?? Square;
  return <Icon aria-hidden="true" className="h-[18px] w-[18px]" strokeWidth={1.75} />;
}

export type MarkdownEditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  diffMarkdown?: string;
};

function findScrollableAncestor(start: HTMLElement | null): HTMLElement | null {
  let el = start?.parentElement ?? null;
  while (el) {
    const overflowY = window.getComputedStyle(el).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      el.scrollHeight > el.clientHeight
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

type RichTextSelectionSnapshot = {
  anchorOffset: number;
  focusOffset: number;
  textContent: string;
  isBackward: boolean;
};

function focusedRichTextEditable(container: HTMLElement | null): HTMLElement | null {
  const editable = container?.querySelector<HTMLElement>(
    ".mdxeditor-rich-text-editor [contenteditable='true']",
  );
  return editable && document.activeElement === editable ? editable : null;
}

function textOffsetWithin(root: HTMLElement, node: Node, offset: number): number | null {
  if (node.nodeType === 3) {
    const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT);
    let textOffset = 0;
    let textNode = walker.nextNode() as Text | null;
    while (textNode) {
      if (textNode === node) return textOffset + Math.min(offset, textNode.data.length);
      textOffset += textNode.data.length;
      textNode = walker.nextNode() as Text | null;
    }
    return null;
  }
  try {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function captureFocusedRichTextSelection(container: HTMLElement | null): RichTextSelectionSnapshot | null {
  const editable = focusedRichTextEditable(container);
  const selection = window.getSelection();
  if (!editable || !selection?.anchorNode || !selection.focusNode) return null;
  if (!editable.contains(selection.anchorNode) || !editable.contains(selection.focusNode)) return null;

  const anchorOffset = textOffsetWithin(editable, selection.anchorNode, selection.anchorOffset);
  const focusOffset = textOffsetWithin(editable, selection.focusNode, selection.focusOffset);
  if (anchorOffset === null || focusOffset === null) return null;
  return {
    anchorOffset,
    focusOffset,
    textContent: editable.textContent ?? "",
    isBackward: anchorOffset > focusOffset,
  };
}

function mapTextOffsetThroughUpdate(offset: number, before: string, after: string): number {
  let prefixLength = 0;
  const sharedLength = Math.min(before.length, after.length);
  while (prefixLength < sharedLength && before[prefixLength] === after[prefixLength]) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < sharedLength - prefixLength &&
    before[before.length - suffixLength - 1] === after[after.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const previousChangeEnd = before.length - suffixLength;
  const nextChangeEnd = after.length - suffixLength;
  if (offset <= prefixLength) return offset;
  if (offset >= previousChangeEnd) return nextChangeEnd + offset - previousChangeEnd;

  // A point inside a replacement has no shared character to follow. Preserve
  // its relative position within the inserted span when possible, otherwise
  // clamp to that span's end.
  const insertedLength = nextChangeEnd - prefixLength;
  return prefixLength + Math.min(offset - prefixLength, insertedLength);
}

function textPointAtOffset(root: HTMLElement, requestedOffset: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT);
  let remaining = requestedOffset;
  let node = walker.nextNode() as Text | null;
  let lastTextNode: Text | null = null;
  while (node) {
    lastTextNode = node;
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
    node = walker.nextNode() as Text | null;
  }
  return lastTextNode ? { node: lastTextNode, offset: lastTextNode.data.length } : null;
}

function restoreFocusedRichTextSelection(
  container: HTMLElement | null,
  snapshot: RichTextSelectionSnapshot,
): void {
  const editable = container?.querySelector<HTMLElement>(
    ".mdxeditor-rich-text-editor [contenteditable='true']",
  );
  const selection = window.getSelection();
  if (!editable || !selection) return;

  const nextText = editable.textContent ?? "";
  const anchor = textPointAtOffset(
    editable,
    mapTextOffsetThroughUpdate(snapshot.anchorOffset, snapshot.textContent, nextText),
  );
  const focus = textPointAtOffset(
    editable,
    mapTextOffsetThroughUpdate(snapshot.focusOffset, snapshot.textContent, nextText),
  );
  if (!anchor || !focus) return;

  // This is intentionally gated by capture above: only restore focus when the
  // rich-text editor owned it before the external update.
  editable.focus({ preventScroll: true });
  selection.removeAllRanges();
  if (snapshot.isBackward && typeof selection.setBaseAndExtent === "function") {
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    return;
  }
  const range = document.createRange();
  if (snapshot.anchorOffset <= snapshot.focusOffset) {
    range.setStart(anchor.node, anchor.offset);
    range.setEnd(focus.node, focus.offset);
  } else {
    range.setStart(focus.node, focus.offset);
    range.setEnd(anchor.node, anchor.offset);
  }
  selection.addRange(range);
}

export function MarkdownEditor({ value, onChange, diffMarkdown }: MarkdownEditorProps) {
  const editorRef = useRef<MDXEditorMethods | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastAppliedValueRef = useRef(value);
  const overlayContainer = useWorkbenchPortalContainer();

  useEffect(() => {
    if (lastAppliedValueRef.current === value) return;

    const editor = editorRef.current;
    if (!editor) {
      lastAppliedValueRef.current = value;
      return;
    }

    // The editor may already render the incoming document — e.g. an autosave
    // round-trip or a no-op patch fed `value` back unchanged from what the user
    // is already looking at. Re-applying it would call `setMarkdown`, which
    // resets the Lexical selection to the document start; the browser then
    // scrolls that caret into view, yanking the reader to the top. Skip it.
    let current: string | null = null;
    try {
      current = editor.getMarkdown();
    } catch {
      current = null;
    }
    if (current === value) {
      lastAppliedValueRef.current = value;
      return;
    }

    lastAppliedValueRef.current = value;

    // A genuine external change (remote patch / rebase / resync). Apply it, but
    // preserve the viewport: `setMarkdown` moves the caret to the top and the
    // browser scrolls it into view. Capture the scroll offset and restore it on
    // the next frame so the reader stays where they were. MDXEditor does not
    // expose Lexical's selection, so retain the focused rich-text DOM range as
    // logical text offsets and restore it after the imported tree is mounted.
    // Source mode is deliberately excluded: its CodeMirror view has a separate
    // selection API which MDXEditor does not expose through this ref.
    const scroller = findScrollableAncestor(containerRef.current);
    const previousScrollTop = scroller ? scroller.scrollTop : null;
    const previousSelection = captureFocusedRichTextSelection(containerRef.current);

    editor.setMarkdown(value);

    if (
      ((scroller && previousScrollTop !== null) || previousSelection) &&
      typeof requestAnimationFrame === "function"
    ) {
      requestAnimationFrame(() => {
        if (previousSelection) {
          restoreFocusedRichTextSelection(containerRef.current, previousSelection);
        }
        if (scroller && previousScrollTop !== null) {
          scroller.scrollTop = previousScrollTop;
        }
      });
    }
  }, [value]);

  return (
    <div ref={containerRef} className="contents">
    <MDXEditor
      ref={editorRef}
      markdown={value}
      overlayContainer={overlayContainer}
      iconComponentFor={iconComponentFor}
      onChange={(markdown) => {
        lastAppliedValueRef.current = markdown;
        onChange(markdown);
      }}
      className="nautilo-mdx-editor"
      plugins={[
        headingsPlugin(),
        listsPlugin(),
        quotePlugin(),
        thematicBreakPlugin(),
        linkPlugin(),
        tablePlugin(),
        codeBlockPlugin({ defaultCodeBlockLanguage: "txt" }),
        codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
        markdownShortcutPlugin(),
        diffSourcePlugin({
          viewMode: "rich-text",
          diffMarkdown: diffMarkdown ?? value,
        }),
        toolbarPlugin({
          toolbarContents: () => (
            <DiffSourceToggleWrapper>
              <ConditionalContents
                options={[
                  {
                    when: (editor) => editor?.editorType === "codeblock",
                    contents: () => <ChangeCodeMirrorLanguage />,
                  },
                  {
                    fallback: () => (
                      <>
                        <UndoRedo />
                        <BoldItalicUnderlineToggles />
                        <ListsToggle />
                        <InsertTable />
                        <InsertCodeBlock />
                        <CreateLink />
                      </>
                    ),
                  },
                ]}
              />
            </DiffSourceToggleWrapper>
          ),
        }),
      ]}
      contentEditableClassName="prose max-w-none outline-none"
    />
    </div>
  );
}
