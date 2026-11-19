import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { HtmlTextEditor } from "../../../apps/workbench/src/editors/html-text-editor";
import { HtmlTextDocumentHistory } from "../../../apps/workbench/src/editors/html-text-history";
import { CodeEditor, type CodeEditorSelection } from "../../../apps/workbench/src/editors/code-editor";
import { fixture } from "./fixture";

const storageKey = "nautilo-html-text-prototype";
function Harness() {
  const [saved, setSaved] = useState(() => localStorage.getItem(storageKey) ?? fixture);
  const [draft, setDraft] = useState(saved);
  const [mode, setMode] = useState<"text" | "source">("text");
  const [generation, setGeneration] = useState(0);
  const [history] = useState(() => new HtmlTextDocumentHistory(saved));
  const [snapshot, setSnapshot] = useState(() => history.getSnapshot());
  const [restoreSelection, setRestoreSelection] = useState<CodeEditorSelection>();
  const externalHistory = useMemo(() => ({ undo: () => { history.undo(); }, redo: () => { history.redo(); } }), [history]);
  useEffect(() => history.subscribe(event => {
    setSnapshot(event);
    if (event.kind === "restore") {
      setDraft(event.source);
      if (event.view?.kind === "source") { setMode("source"); setRestoreSelection(event.view); }
      else if (event.view?.kind === "text") setMode("text");
    }
  }), [history]);
  useEffect(() => {
    if (history.getSnapshot().source !== draft) history.reset(draft);
  }, [draft, history]);
  const save = () => { localStorage.setItem(storageKey, draft); setSaved(draft); };
  const reopen = (source: string) => {
    history.reset(source); setDraft(source); setGeneration(g => g + 1);
  };
  return <><header><h1>HTML text editing prototype</h1><span role="status">{draft === saved ? "Saved" : "Unsaved"}</span><button onClick={() => setMode(mode === "text" ? "source" : "text")}>{mode === "text" ? "Source" : "Text"}</button><button onClick={save}>Save</button><button onClick={() => setDraft(current => current.replace("</body>", '<p id="external-update">A neighbour published this updated programme.</p></body>'))}>Simulate external update</button><button onClick={() => reopen(saved)}>Reopen saved</button><button onClick={() => { localStorage.removeItem(storageKey); setSaved(fixture); setMode("text"); reopen(fixture); }}>Reset example</button></header>
    <pre hidden data-testid="canonical-source">{draft}</pre>
    <main>
      <div hidden={mode !== "text"} style={{ display: mode === "text" ? "flex" : "none", height: "100%", minHeight: 0, flexDirection: "column" }}>
        <HtmlTextEditor key={generation} value={draft} onChange={setDraft} onSave={save} history={history} active={mode === "text"} />
      </div>
      {mode === "source" ? <section aria-label="HTML source" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div><button disabled={!snapshot.canUndo} onClick={() => history.undo()}>Undo</button><button disabled={!snapshot.canRedo} onClick={() => history.redo()}>Redo</button></div>
        <CodeEditor value={draft} path="fixture.html" externalHistory={externalHistory} {...(restoreSelection ? { restoreSelection } : {})} onChange={(next, selection) => {
          history.record(next, selection ? { before: { kind: "source", ...selection.before }, after: { kind: "source", ...selection.after } } : {});
          setDraft(next);
        }} />
      </section> : null}
    </main></>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
