import { useState } from "react";
import { createRoot } from "react-dom/client";
import { HtmlTextEditor } from "../../../apps/workbench/src/editors/html-text-editor";
import { fixture } from "./fixture";

const storageKey = "nautilo-html-text-prototype";
function Harness() {
  const [saved, setSaved] = useState(() => localStorage.getItem(storageKey) ?? fixture);
  const [draft, setDraft] = useState(saved);
  const [mode, setMode] = useState<"text" | "source">("text");
  const [generation, setGeneration] = useState(0);
  const save = () => { localStorage.setItem(storageKey, draft); setSaved(draft); };
  return <><header><h1>HTML text editing prototype</h1><span role="status">{draft === saved ? "Saved" : "Unsaved"}</span><button onClick={() => setMode(mode === "text" ? "source" : "text")}>{mode === "text" ? "Source" : "Text"}</button><button onClick={save}>Save</button><button onClick={() => { setDraft(saved); setGeneration(g => g + 1); }}>Reopen saved</button><button onClick={() => { localStorage.removeItem(storageKey); setSaved(fixture); setDraft(fixture); setGeneration(g => g + 1); }}>Reset example</button></header><main>{mode === "text" ? <HtmlTextEditor key={generation} value={draft} onChange={setDraft} onSave={save} /> : <textarea aria-label="HTML source" value={draft} onChange={event => setDraft(event.target.value)} />}</main></>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
