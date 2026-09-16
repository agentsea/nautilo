import { useEffect, useRef, useState } from "react";
import type { GenerationBrief, GenerationReference } from "./generation-brief";
import type { GenerationReferenceScope } from "./generation-reference-scope";

export function ReferenceScopeDialog({ reference, shots, scope, currentShotId, onSave, onClose }: {
  reference: GenerationReference;
  shots: GenerationBrief["shots"];
  scope: GenerationReferenceScope;
  currentShotId: string | undefined;
  onSave: (scope: GenerationReferenceScope) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [all, setAll] = useState(scope === "all");
  const [selected, setSelected] = useState<readonly string[]>(scope === "all" ? currentShotId ? [currentShotId] : [] : scope);
  const chosen = selected.filter(id => shots.some(shot => shot.id === id));
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => { element?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className="video-rate-dialog generator-reference-scope-dialog" aria-labelledby="reference-scope-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h3 id="reference-scope-title">Use reference in…</h3><button autoFocus type="button" aria-label="Close reference settings" onClick={onClose}>×</button></header>
    <p>{reference.name}</p>
    <label className="generator-reference-scope-choice"><input type="radio" name="reference-scope" checked={all} onChange={() => setAll(true)} /><span>All scenes<small>Every scene, including scenes you add later.</small></span></label>
    <label className="generator-reference-scope-choice"><input type="radio" name="reference-scope" checked={!all} onChange={() => setAll(false)} /><span>Selected scenes<small>Only the scenes you choose below.</small></span></label>
    {!all ? <div className="generator-reference-scope-scenes">{shots.map((shot, index) => <label key={shot.id}><input type="checkbox" checked={selected.includes(shot.id)} onChange={event => { const checked = event.currentTarget.checked; setSelected(current => checked ? [...current, shot.id] : current.filter(id => id !== shot.id)); }} /><span>{index + 1} · {shot.title || "Untitled"}{shot.id === currentShotId ? " (current)" : ""}</span></label>)}</div> : null}
    {!all && !chosen.length ? <p role="status">Choose at least one scene.</p> : null}
    <footer><button type="button" onClick={onClose}>Cancel</button><button type="button" className="video-button--primary" disabled={!all && !chosen.length} onClick={() => onSave(all ? "all" : chosen)}>Save changes</button></footer>
  </dialog>;
}
