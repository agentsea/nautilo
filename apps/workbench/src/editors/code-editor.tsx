import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { memo, useEffect, useMemo, useRef, useState } from "react";

// CSS variables follow the workbench theme immediately, including mounted cards.
const workbenchSyntax = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.typeName, tags.namespace], color: "var(--label-user)" },
  { tag: [tags.string, tags.regexp], color: "var(--success)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--error)" },
  { tag: tags.function(tags.variableName), color: "var(--primary)" },
  { tag: [tags.variableName, tags.propertyName, tags.operator, tags.punctuation], color: "var(--foreground)" },
  { tag: tags.comment, color: "var(--foreground-muted)", fontStyle: "italic" },
]));

const workbenchCodeMirrorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--background-panel)",
    color: "var(--foreground)",
    height: "100%",
  },
  ".cm-editor": {
    backgroundColor: "var(--background-panel)",
    color: "var(--foreground)",
    fontSize: "0.75rem",
    height: "100%",
  },
  ".cm-scroller": {
    backgroundColor: "var(--background-panel)",
    color: "var(--foreground)",
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  },
  ".cm-content": {
    caretColor: "var(--primary)",
    fontSize: "0.75rem",
    lineHeight: "1.625",
  },
  ".cm-line": {
    lineHeight: "1.625",
  },
  ".cm-gutterElement": {
    fontSize: "0.75rem",
    lineHeight: "1.625",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--primary)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--primary-muted)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--primary-muted)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--background-element)",
    color: "var(--foreground-muted)",
    borderRightColor: "var(--border)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--primary-muted)",
    color: "var(--foreground)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    color: "var(--foreground-muted)",
  },
}, { dark: false });

export function languageExtensionsForPath(path: string): Extension[] {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return [javascript({ typescript: true, jsx: ext === "tsx" })];
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return [javascript({ typescript: false, jsx: ext === "jsx" })];
    case "html":
    case "htm":
      return [html()];
    case "css":
    case "scss":
      return [css()];
    case "json":
      return [json()];
    case "py":
      return [python()];
    case "yaml":
    case "yml":
      return [yaml()];
    case "xml":
      return [xml()];
    case "md":
    case "markdown":
      return [markdown()];
    case "sh":
    case "bash":
    case "txt":
    case "plaintext":
      return [];
    default:
      return [];
  }
}

export type CodeEditorProps = {
  value: string;
  onChange: (value: string) => void;
  path: string;
};

export function CodeEditor({ value, onChange, path }: CodeEditorProps) {
  const extensions = useMemo(() => [workbenchSyntax, ...languageExtensionsForPath(path)], [path]);

  return (
    <CodeMirror
      value={value}
      height="100%"
      theme={workbenchCodeMirrorTheme}
      extensions={extensions}
      onChange={onChange}
      className="h-full [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
    />
  );
}


/** Read-only, virtualized source in task/tool cards; all received bytes remain accessible. */
const previewBasicSetup = { lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false };
export const CodePreview = memo(function CodePreview({ value, path, firstLine = 1 }: { value: string; path: string; firstLine?: number }) {
  const extensions = useMemo(() => [
    workbenchSyntax,
    ...languageExtensionsForPath(path),
    lineNumbers({ formatNumber: (line) => String(firstLine + line - 1) }),
    EditorView.contentAttributes.of({ "aria-label": `Source code: ${path || "tool result"}` }),
  ], [path, firstLine]);
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [focused, setFocused] = useState(false);
  const height = useRef<number | undefined>(undefined);
  useEffect(() => {
    const element = container.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      // Preserve actual geometry when destroying an offscreen editor; do not
      // add scroll space or retain an EditorView for every historical read.
      if (!entry.isIntersecting && element.querySelector(".cm-editor")) height.current = element.getBoundingClientRect().height;
      setVisible(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={container} onFocusCapture={() => setFocused(true)}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    {visible || focused ? <CodeMirror value={value} theme={workbenchCodeMirrorTheme} extensions={extensions}
      readOnly editable={false} maxHeight="24rem"
      basicSetup={previewBasicSetup}
      className="overflow-hidden rounded border border-border text-xs [&_.cm-scroller]:overflow-auto" />
      : <pre aria-hidden className="m-0 max-h-96 overflow-hidden rounded border border-border text-xs leading-relaxed"
        style={height.current ? { height: height.current } : undefined}>{value}</pre>}
  </div>;
});
