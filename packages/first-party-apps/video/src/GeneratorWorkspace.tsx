import { useEffect, useRef, useState, type ReactNode } from "react";
import type { VideoProject } from "./edl";
import { getNautiloApp, type NautiloVideoGenerationTakeStatus, type NautiloVideoGenerationTakeSummary } from "./bridge";
import {
  appendGenerationShot, createEmptyGenerationBrief, createGenerationShotId, deleteGenerationShot, duplicateGenerationShot,
  moveGenerationShot, updateGenerationShot, effectiveGenerationDirectionBlocks, materializeGenerationDirectionBlocks, updateGenerationDirectionBlock, type GenerationBrief, type GenerationReference,
} from "./generation-brief";
import { assetForGenerationReference, beginSceneDesign, referenceMentions, setSharedGenerationReferences, setSimpleGenerationPrompt, sharedGenerationReferences, simpleGenerationPrompt } from "./generator-composer";
import { GenerationProgress, generationStageLabel, isGenerationActive, type GenerationProgressItem } from "./GenerationProgress";
import { MediaBinPreview } from "./MediaBinPreview";
import { VIDEO_MEDIA_DRAG_TYPE } from "./timeline/TimelineTrack";

type Props = {
  project: VideoProject;
  savedMediaIds: ReadonlySet<string>;
  /** Stable host document identity; import results must not cross documents. */
  documentKey?: string | undefined;
  /** Persisted reference identity/source pairs, supplied by the document host. */
  savedReferenceKeys?: ReadonlySet<string>;
  enabled: boolean;
  mutate: (fn: (brief: GenerationBrief) => GenerationBrief) => unknown;
  onGenerate: (shotIds?: string[]) => void;
  onPlaceMedia: (mediaId: string) => void;
  onPlaceSequence: (mediaIds: string[]) => void;
  onReturn: () => void;
  beforePick?: () => Promise<boolean>;
  busy: boolean;
  modelControl: ReactNode;
  /** Advanced-only model controls omit the global duration because a scene owns it. */
  sceneModelControl?: ReactNode | undefined;
  /** The persisted default used when a scene has not overridden its duration. */
  defaultDurationSeconds?: number | undefined;
  feedback: ReactNode;
  takes: readonly NautiloVideoGenerationTakeSummary[];
  statuses: Record<string, NautiloVideoGenerationTakeStatus>;
  unavailableIds: readonly string[];
  progressForTake: (takeId: string) => string;
  onReconnectMedia?: () => void;
  timingForTake?: (takeId: string) => string | null;
};

/** Same document and media bin as Edit. No provider execution or approval authority here. */
export function GeneratorWorkspace(props: Props) {
  const { project, enabled, mutate } = props;
  const brief = project.generationBrief ?? createEmptyGenerationBrief();
  const composer = useRef<HTMLElement>(null);
  const seenProgress = useRef(new Set<string>());
  const [progressTakeId, setProgressTakeId] = useState<string | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  const [modeChoice, setMode] = useState<"simple" | "advanced" | null>(null);
  const mode = modeChoice ?? (brief.shots.length ? "advanced" : "simple");
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [chosenTakes, setChosenTakes] = useState<Record<string, string>>({});
  const [sourcePlaying, setSourcePlaying] = useState<string | null>(null);
  const [dragScene, setDragScene] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const currentDocumentKey = useRef(props.documentKey);
  const mounted = useRef(true);
  currentDocumentKey.current = props.documentKey;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setImportBusy(false); setMessage(null); seenProgress.current.clear(); setProgressTakeId(null); setShowProgress(false); setSourcePlaying(null); }, [props.documentKey]);
  const references = sharedGenerationReferences(brief);
  const mentions = referenceMentions(references);
  const selectedScene = mode === "simple" ? brief.shots[0] : brief.shots.find((shot) => shot.id === sceneId) ?? brief.shots[0];
  const sceneTakes = props.takes.filter((take) => mode === "simple" && !brief.shots.length ? take.shotId === "quick-brief" : take.shotId === selectedScene?.id);
  const sceneKey = selectedScene?.id ?? "quick-brief";
  const selectedTake = sceneTakes.find((take) => take.takeId === chosenTakes[sceneKey])
    ?? [...sceneTakes].sort((a, b) => b.documentRevision - a.documentRevision)[0];
  const completed = project.generatedTakes?.find((take) => take.id === selectedTake?.takeId);
  const previewAsset = completed ? project.media.find((asset) => asset.source?.kind === "workspace-artifact" && asset.source.artifactId === completed.artifact.artifactId) : undefined;
  const status = selectedTake ? props.statuses[selectedTake.takeId] : undefined;
  const sequenceAssets = brief.shots.map((shot) => {
    const takes = [...(project.generatedTakes ?? [])].filter((take) => take.shotId === shot.id);
    const chosen = chosenTakes[shot.id];
    const take = chosen ? takes.find((item) => item.id === chosen) : takes.sort((a, b) => b.briefRevision - a.briefRevision)[0];
    return take
      ? project.media.find((asset) => asset.source?.kind === "workspace-artifact" && asset.source.artifactId === take.artifact.artifactId)
      : undefined;
  });
  const sequenceReady = sequenceAssets.length > 0 && sequenceAssets.every((asset) => asset && props.savedMediaIds.has(asset.id));
  const generationProgress: GenerationProgressItem[] = props.takes.map((take) => {
    const takeStatus = props.statuses[take.takeId];
    const persisted = project.generatedTakes?.find(item => item.id === take.takeId);
    const artifact = takeStatus?.artifact ?? persisted?.artifact;
    const asset = artifact ? project.media.find(item => item.source?.kind === "workspace-artifact" && item.source.artifactId === artifact.artifactId) : undefined;
    const saved = !!artifact && (!takeStatus || ["ready", "cleanup-pending"].includes(takeStatus.state));
    const ready = saved && !!asset && props.savedMediaIds.has(asset.id);
    const reconnecting = props.unavailableIds.includes(take.takeId);
    const state = ready ? "ready" : saved ? "saved" : reconnecting ? "reconnecting" : takeStatus?.state ?? "preparing";
    return {
      takeId: take.takeId, shotId: take.shotId, label: take.shotLabel || "Your video", state, asset: ready ? asset : undefined,
      message: ready ? "Your video is ready to preview or add to the timeline."
        : saved ? "Saved in Workspace. Reconnecting this video to your Media Bin…"
        : reconnecting ? "Take status is unavailable. Your generation has not been restarted. Check status to try again."
        : state === "unknown" ? "Submission could not be confirmed. Check this take before generating again."
        : takeStatus?.failure?.message ?? (takeStatus ? props.progressForTake(take.takeId) : "Checking this take’s status…"),
      timing: saved || reconnecting ? null : props.timingForTake?.(take.takeId) ?? null,
    };
  });
  const progressItem = generationProgress.find(item => item.takeId === progressTakeId);
  useEffect(() => {
    const pending = generationProgress.filter(item => isGenerationActive(item.state) || ["saved", "reconnecting", "unknown", "needs-action"].includes(item.state));
    const newlyObserved = pending.find(item => !seenProgress.current.has(item.takeId) && (props.statuses[item.takeId] || !project.generatedTakes?.some(take => take.id === item.takeId)));
    pending.forEach(item => seenProgress.current.add(item.takeId));
    if (newlyObserved) { setProgressTakeId(newlyObserved.takeId); setShowProgress(true); setSourcePlaying(null); }
  }, [props.documentKey, props.takes, props.statuses, props.unavailableIds]);
  // Changing the pane must bring its heading into view even when Generate was
  // pressed at the bottom of a long prompt. Do not steal keyboard focus.
  useEffect(() => { if (enabled && showProgress) composer.current?.scrollTo?.({ top: 0 }); }, [enabled, showProgress, progressTakeId]);
  const openProgress = (takeId: string) => { setProgressTakeId(takeId); setShowProgress(true); setSourcePlaying(null); };
  const progressBanner = progressItem ? <div className="generator-progress-return" role="status"><span>{progressItem.label} · {generationStageLabel(progressItem.state)}</span><button type="button" onClick={() => openProgress(progressItem.takeId)}>{progressItem.state === "ready" ? "View result" : "View generation progress"}</button></div> : null;
  const progressIndex = brief.shots.findIndex(shot => shot.id === progressItem?.shotId);
  const nextScene = brief.shots[progressIndex + 1];
  const progressView = progressItem && showProgress ? <GenerationProgress item={progressItem} enabled={enabled} sceneNumber={progressIndex + 1} sceneCount={brief.shots.length} onReconnect={props.onReconnectMedia} onDesign={() => { setShowProgress(false); setSourcePlaying(null); }} onPlace={props.onPlaceMedia}
    onReviewNext={nextScene && progressIndex >= 0 && !props.busy && !generationProgress.some(item => item.shotId === nextScene.id && (isGenerationActive(item.state) || item.state === "ready")) ? () => { setSceneId(nextScene.id); props.onGenerate([nextScene.id]); } : undefined}
    playing={sourcePlaying === "progress-result"} onPlay={() => setSourcePlaying("progress-result")} /> : null;
  const directionBlocks = effectiveGenerationDirectionBlocks(brief);
  const firstGoalId = directionBlocks.find((block) => block.kind === "goal")?.id;
  const savedDirection = directionBlocks.flatMap((block) => {
    const keys = block.kind === "goal" ? ["goal", ...(block.quickBrief && (brief.shots.length > 0 || block.id !== firstGoalId) ? ["quickBrief"] : [])]
      : block.kind === "continuity" ? ["continuity"] : block.kind === "audio" ? ["audio"] : block.kind === "exclusions" ? ["exclusions"] : block.kind === "note" ? ["note"] : [];
    return keys.filter((key) => !!block[key as keyof typeof block]).map((key) => ({ block, key: key as "goal" | "quickBrief" | "continuity" | "audio" | "exclusions" | "note" }));
  });

  const addMedia = (mediaId: string, replacing?: string) => {
    const asset = project.media.find((item) => item.id === mediaId);
    if (!asset || asset.kind === "audio") return;
    const reference: GenerationReference = { id: replacing ?? `ref_${crypto.randomUUID().replaceAll("-", "")}`, name: asset.label ?? asset.id, mediaKind: asset.kind, source: { kind: "project-media", mediaId } };
    mutate((current) => {
      const library = sharedGenerationReferences(current);
      return setSharedGenerationReferences(current, replacing ? library.map((item) => item.id === replacing ? { ...item, ...reference } : item) : [...library, reference]);
    });
  };
  const chooseReferences = async (replacing?: string) => {
    const sourceDocumentKey = props.documentKey;
    const media = getNautiloApp()?.media;
    if (!media?.pick) { setMessage("The media browser requires an updated host. Reopen Video after updating Nautilo."); return; }
    setImportBusy(true); setMessage(null);
    try {
      if (props.beforePick && !await props.beforePick()) { setMessage("Save this project before choosing references."); return; }
      if (!mounted.current || currentDocumentKey.current !== sourceDocumentKey) return;
      const result = await media.pick({ purpose: "references", multiple: !replacing });
      if (!mounted.current || currentDocumentKey.current !== sourceDocumentKey) return;
      if (result.kind !== "ready") { if (result.code !== "cancelled") setMessage(`References could not be added (${result.code}). Try Add references again.`); return; }
      const additions: GenerationReference[] = [
        ...result.references.map(asset => ({ id: `ref_${crypto.randomUUID().replaceAll("-", "")}`, name: asset.label, mediaKind: asset.mediaKind, source: { kind: "workspace-artifact" as const, artifactId: asset.artifactId, path: asset.path, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes } })),
        ...result.mediaIds.flatMap(id => { const asset = project.media.find(item => item.id === id); return asset && asset.kind !== "audio" ? [{ id: `ref_${crypto.randomUUID().replaceAll("-", "")}`, name: asset.label ?? asset.id, mediaKind: asset.kind, source: { kind: "project-media" as const, mediaId: id } }] : []; }),
      ];
      if (additions.length) mutate(current => {
        const library = sharedGenerationReferences(current);
        if (replacing) return setSharedGenerationReferences(current, library.map(item => item.id === replacing ? { ...item, ...additions[0]!, id: replacing } : item));
        const keys = new Set(library.map(item => JSON.stringify(item.source)));
        return setSharedGenerationReferences(current, [...library, ...additions.filter(item => { const key = JSON.stringify(item.source); if (keys.has(key)) return false; keys.add(key); return true; })]);
      });
      if (result.failures.length) setMessage(`Could not add ${result.failures.map(f => `${f.label} (${f.code})`).join(", ")}.`);
    } catch { if (mounted.current && currentDocumentKey.current === sourceDocumentKey) setMessage("References could not be added. Your existing references are unchanged. Try again."); }
    finally { if (mounted.current && currentDocumentKey.current === sourceDocumentKey) setImportBusy(false); }
  };
  const presets = (sceneTitle: string, label: "Camera" | "Motion", value: string, onChange: (value: string) => void) => {
    const options = label === "Camera" ? ["", "Static", "Pan", "Tracking", "Dolly in", "Dolly out", "Reveal", "Orbit"] : ["", "Still", "Slow", "Smooth", "Gentle", "Dynamic"];
    return <label>{label}<select aria-label={`${label} for ${sceneTitle}`} value={value} onChange={(event) => onChange(event.currentTarget.value)}>{!options.includes(value) ? <option value={value}>{value}</option> : null}{options.map((option) => <option key={option} value={option}>{option || "Auto"}</option>)}</select></label>;
  };
  const effectiveDuration = (shot: GenerationBrief["shots"][number]) => shot.durationSec ?? props.defaultDurationSeconds;
  const hasAutoDuration = brief.shots.some((shot) => effectiveDuration(shot) === undefined);
  const totalDuration = brief.shots.reduce((total, shot) => total + (effectiveDuration(shot) ?? 0), 0);
  const addScene = () => { const newId = createGenerationShotId(); mutate((current) => appendGenerationShot(current, { title: `Scene ${current.shots.length + 1}` }, () => newId)); setSceneId(newId); setShowProgress(false); };
  const sceneEditor = selectedScene && (() => {
    const index = brief.shots.findIndex((shot) => shot.id === selectedScene.id);
    return <section className="generator-selected-scene" aria-label={`Edit ${selectedScene.title || "scene"}`}>
      <header className="generator-selected-scene__header"><div><p className="generator-eyebrow">Scene {index + 1} of {brief.shots.length}</p><input className="generator-scene-title" aria-label={`Scene ${index + 1} title`} value={selectedScene.title} onChange={(event) => mutate((current) => updateGenerationShot(current, selectedScene.id, { title: event.currentTarget.value }))} /></div><div className="generator-scene-manage"><button aria-label={`Duplicate scene ${index + 1}`} onClick={() => mutate((current) => duplicateGenerationShot(current, selectedScene.id))}>Duplicate</button><button aria-label={`Delete scene ${index + 1}`} onClick={() => { mutate((current) => deleteGenerationShot(current, selectedScene.id)); setSceneId(brief.shots[index + 1]?.id ?? brief.shots[index - 1]?.id ?? null); }}>Delete</button></div></header>
      <div className="generator-writing"><header><strong>What happens in this scene?</strong><span>Use {references.length ? "@ references" : "scene direction"}</span></header><textarea aria-label={`Scene ${index + 1} prompt`} value={selectedScene.description} placeholder="Describe the action, feeling, and image you want to make…" onChange={(event) => mutate((current) => updateGenerationShot(current, selectedScene.id, { description: event.currentTarget.value }))} /><footer>{references.map((reference) => <span className="generator-mention" key={reference.id}>{mentions.get(reference.id)}</span>)}</footer></div>
      {(index > 0 || selectedScene.continueFromPrevious) ? <label className="generator-continuation"><input type="checkbox" checked={selectedScene.continueFromPrevious === true} onChange={event => mutate(current => updateGenerationShot(current, selectedScene.id, { continueFromPrevious: event.currentTarget.checked }))} /> Continue from previous scene <small>Uses its completed video as the starting reference.</small></label> : null}
      <details className="generator-scene-direction"><summary>More scene direction</summary><div>{(["framing", "audio", "continuity", "exclusions"] as const).map((field) => <label key={field}>{field}<textarea rows={2} value={selectedScene[field]} onChange={(event) => mutate((current) => updateGenerationShot(current, selectedScene.id, { [field]: event.currentTarget.value }))} /></label>)}{selectedScene.references.map((reference) => <p key={reference.id}>{reference.name} · Scene reference <button onClick={() => mutate((current) => updateGenerationShot(current, selectedScene.id, { references: (current.shots.find((item) => item.id === selectedScene.id)?.references ?? []).filter((item) => item.id !== reference.id) }))}>Remove</button></p>)}</div></details>
      <section className="generator-settings"><label className="generator-duration">Duration (seconds)<input aria-label={`Duration for ${selectedScene.title || `scene ${index + 1}`}`} type="number" min="1" step="1" placeholder={props.defaultDurationSeconds ? `Inherited (${props.defaultDurationSeconds}s)` : "Auto"} value={selectedScene.durationSec ?? ""} onChange={(event) => { const value = event.currentTarget.value; mutate((current) => updateGenerationShot(current, selectedScene.id, { durationSec: value ? Number(value) : undefined })); }} /></label>{presets(selectedScene.title, "Camera", selectedScene.camera, (camera) => mutate((current) => updateGenerationShot(current, selectedScene.id, { camera })))}{presets(selectedScene.title, "Motion", selectedScene.motion, (motion) => mutate((current) => updateGenerationShot(current, selectedScene.id, { motion })))}{props.sceneModelControl ?? props.modelControl}</section>
      <footer className="generator-scene-action"><div><strong>Generate this scene</strong><small>Review the exact cost before this scene is submitted.</small></div><button className="video-button--primary" disabled={props.busy} onClick={() => props.onGenerate([selectedScene.id])}>{props.busy ? "Generating…" : "Generate scene"}</button></footer>
      {renderResults()}
    </section>;
  })();
  return <section ref={composer} className="generator-composer" aria-label="Generate video" aria-hidden={!enabled} inert={!enabled} hidden={!enabled}>
    <header className="generator-composer__header"><div><h2>Generate video</h2><p>Bring your references. Build your scenes.</p></div><div role="group" aria-label="Generation mode"><button aria-pressed={mode === "simple"} onClick={() => setMode("simple")}>Simple</button><button aria-pressed={mode === "advanced"} onClick={() => { if (mutate(beginSceneDesign) !== null) setMode("advanced"); }}>Advanced</button></div><button onClick={props.onReturn}>Back to editor</button></header>
    {mode === "simple" ? <div className="generator-workspace" aria-label="Simple generation"><aside className="generator-scene-rail"><section className="generator-rail-references" aria-label="Shared references" onDragOver={(event) => { if (event.dataTransfer.types.includes(VIDEO_MEDIA_DRAG_TYPE)) event.preventDefault(); }} onDrop={(event) => { const id = event.dataTransfer.getData(VIDEO_MEDIA_DRAG_TYPE); if (id) { event.preventDefault(); addMedia(id); } }}><header><h3>References</h3><small>{brief.shots.length > 1 ? "Shared across scenes" : "Optional"}</small></header><div className="generator-references__tray">{references.map((reference) => renderReferenceCard(reference, true))}{renderReferenceAdder(true)}</div></section></aside><main className="generator-writing-pane">{progressView ?? <>{progressBanner}<section className="generator-selected-scene" aria-label="Simple video prompt"><header className="generator-selected-scene__header"><div><p className="generator-eyebrow">Single video</p><h3 className="generator-simple-title">Your video</h3></div></header><div className="generator-writing"><header><strong>What do you want to make?</strong><span>Use {references.length ? "@ references" : "your own direction"}</span></header><textarea aria-label="Video prompt" value={simpleGenerationPrompt(brief)} placeholder="Describe the video you want to make…" onChange={(event) => mutate((current) => setSimpleGenerationPrompt(current, event.currentTarget.value))} /><footer>{references.map((reference) => <span className="generator-mention" key={reference.id}>{mentions.get(reference.id)}</span>)}</footer></div>{brief.shots.length > 1 ? <p className="generator-simple-note">Simple edits Scene 1 only. Your other scenes remain in Advanced.</p> : null}<section className="generator-settings">{props.modelControl}</section><footer className="generator-scene-action"><div><strong>Generate this video</strong><small>Review the exact cost before your video is submitted.</small></div><button className="video-button--primary" disabled={props.busy} onClick={() => props.onGenerate(brief.shots[0] ? [brief.shots[0].id] : undefined)}>{props.busy ? "Generating…" : "Generate video"}</button></footer>{renderSavedDirection()}{renderResults()}</section></>}{props.feedback}</main></div> : <div className="generator-workspace" aria-label="Scene design"><aside className="generator-scene-rail"><section><header className="generator-scenes__heading"><h3>Scenes</h3><span>{brief.shots.length}</span></header><div className="generator-scene-list">{brief.shots.map((shot, index) => <div key={shot.id} className="generator-scene-list__item" onDragOver={(event) => { if (dragScene) event.preventDefault(); }} onDrop={(event) => { if (dragScene) { event.preventDefault(); mutate((current) => moveGenerationShot(current, dragScene, index)); setDragScene(null); } }}><button className="generator-scene-select" aria-pressed={(progressView ? progressItem?.shotId : selectedScene?.id) === shot.id} onClick={() => { setSceneId(shot.id); setShowProgress(false); setSourcePlaying(null); }}><span>{String(index + 1).padStart(2, "0")}</span><strong>{shot.title || "Untitled"}</strong><small>{effectiveDuration(shot) ? `${effectiveDuration(shot)}s` : "Auto duration"}{(() => { const latest = props.takes.filter(take => take.shotId === shot.id).sort((a, b) => b.documentRevision - a.documentRevision)[0]; const item = generationProgress.find(item => item.takeId === latest?.takeId); return item ? ` · ${generationStageLabel(item.state)}` : " · Awaiting review"; })()}</small></button><button className="generator-scene-grip" draggable aria-label={`Drag scene ${index + 1}`} onDragStart={() => setDragScene(shot.id)} onDragEnd={() => setDragScene(null)}>⠿</button><button disabled={index === 0} aria-label={`Move scene ${index + 1} up`} onClick={() => mutate((current) => moveGenerationShot(current, shot.id, index - 1))}>↑</button><button disabled={index === brief.shots.length - 1} aria-label={`Move scene ${index + 1} down`} onClick={() => mutate((current) => moveGenerationShot(current, shot.id, index + 1))}>↓</button></div>)}</div><button className="generator-add-scene" onClick={addScene}>+ Add scene</button>{brief.shots.length >= 2 ? <div className="generator-sequence-action"><button disabled={props.busy} onClick={() => props.onGenerate(brief.shots.map((shot) => shot.id))}>{props.busy ? "Generating…" : "Generate sequence"}<small>{brief.shots.length} scenes{hasAutoDuration ? (totalDuration ? ` · ${totalDuration}s + auto duration` : " · auto duration") : ` · ${totalDuration}s total`}</small></button><p>Each scene is reviewed at its exact cost before it is submitted.</p></div> : null}</section><section className="generator-rail-references" aria-label="Shared references" onDragOver={(event) => { if (event.dataTransfer.types.includes(VIDEO_MEDIA_DRAG_TYPE)) event.preventDefault(); }} onDrop={(event) => { const id = event.dataTransfer.getData(VIDEO_MEDIA_DRAG_TYPE); if (id) { event.preventDefault(); addMedia(id); } }}><header><h3>References</h3><small>Shared across scenes</small></header><div className="generator-references__tray">{references.map((reference) => renderReferenceCard(reference, true))}{renderReferenceAdder(true)}</div></section></aside><main className="generator-writing-pane">{progressView ?? <>{progressBanner}{sceneEditor}{renderSavedDirection()}{sequenceReady ? <button className="generator-place-sequence" onClick={() => props.onPlaceSequence(sequenceAssets.map((asset) => asset!.id))}>Add completed sequence at playhead</button> : null}</>}{props.feedback}</main></div>}
    {message ? <div className="video-banner video-banner--info" role="status"><span>{message}</span><button aria-label="Dismiss reference message" onClick={() => setMessage(null)}>×</button></div> : null}
  </section>;

  function renderReferenceCard(reference: GenerationReference, compact = false) {
    const asset = assetForGenerationReference(project, reference);
    const referenceSaved = props.savedReferenceKeys?.has(JSON.stringify([reference.id, reference.source])) ?? true;
    const previewEnabled = enabled && (reference.source?.kind === "workspace-artifact" ? referenceSaved : !!asset && props.savedMediaIds.has(asset.id));
    return <article key={reference.id} className={`generator-reference${compact ? " generator-reference--compact" : ""}`}><div className="generator-reference__media">{asset ? <MediaBinPreview asset={asset} enabled={previewEnabled} active={sourcePlaying === reference.id} timelinePlaying={false} onPlay={() => setSourcePlaying(reference.id)} /> : reference.source?.kind === "workspace-artifact" ? <MediaBinPreview reference={reference} enabled={previewEnabled} active={sourcePlaying === reference.id} timelinePlaying={false} onPlay={() => setSourcePlaying(reference.id)} /> : <div className="generator-reference__placeholder">{reference.mediaKind === "video" ? "▶" : "▧"}</div>}</div><button className="generator-reference__remove" aria-label={`Remove ${reference.name}`} onClick={() => mutate((current) => setSharedGenerationReferences(current, sharedGenerationReferences(current).filter((item) => item.id !== reference.id)))}>×</button><strong>{mentions.get(reference.id)}</strong><span title={reference.name}>{reference.name}</span><details><summary>{compact ? "Manage" : "Reference direction"}</summary>{(["role", "instruction"] as const).map((field) => <label key={field}>{field}<textarea rows={2} value={reference[field] ?? ""} onChange={(event) => mutate((current) => setSharedGenerationReferences(current, sharedGenerationReferences(current).map((item) => item.id === reference.id ? { ...item, [field]: event.currentTarget.value } : item)))} /></label>)}<button disabled={importBusy} onClick={() => void chooseReferences(reference.id)}>Replace reference…</button></details></article>;
  }
  function renderReferenceAdder(compact = false) { return <div className={`generator-reference generator-reference--add${compact ? " generator-reference--compact" : ""}`}><button disabled={importBusy} onClick={() => void chooseReferences()}>+ Add references</button><small>Artifacts · Media Bin · Computer</small>{importBusy ? <span role="status">Choosing references…</span> : null}</div>; }
  function renderSavedDirection() {
    return savedDirection.length ? <details className="generator-extra-direction"><summary>Additional saved direction</summary>{savedDirection.map(({ block, key }) => <label key={`${block.id}-${key}`}>{key === "quickBrief" ? "Shared prompt" : key === "note" ? "Note (not sent to generation)" : key}<textarea value={String(block[key] ?? "")} onChange={(event) => mutate((current) => updateGenerationDirectionBlock(materializeGenerationDirectionBlocks(current), block.id, { [key]: event.currentTarget.value }))} /></label>)}</details> : null;
  }
  function renderResults() {
    return <details className="generator-results"><summary>Preview and takes</summary><div className="generator-preview-stage">{previewAsset && props.savedMediaIds.has(previewAsset.id) ? <MediaBinPreview asset={previewAsset} enabled={enabled && props.savedMediaIds.has(previewAsset.id)} active={sourcePlaying === "result"} timelinePlaying={false} onPlay={() => setSourcePlaying("result")} /> : <div><strong>{selectedTake && props.unavailableIds.includes(selectedTake.takeId) ? "Preview reconnecting…" : status ? props.progressForTake(status.takeId) : "Your video will appear here"}</strong><p>{status?.failure?.message ?? status?.progress?.message ?? "Generate this scene to see its takes here."}</p></div>}</div>{previewAsset ? <div className="generator-preview-actions"><small>{props.savedMediaIds.has(previewAsset.id) ? "✓ Saved to Media Bin" : "Added to Media Bin · Saving…"}</small><button onClick={() => props.onPlaceMedia(previewAsset.id)}>Add at playhead</button></div> : null}<div className="generator-takes">{sceneTakes.map((take, takeIndex) => <button key={take.takeId} aria-pressed={selectedTake?.takeId === take.takeId} onClick={() => { setChosenTakes((current) => ({ ...current, [sceneKey]: take.takeId })); openProgress(take.takeId); }}>Take {takeIndex + 1}<small>{props.progressForTake(take.takeId)}</small></button>)}</div><p className="generator-bin-note">Completed media appears in the editor’s Media Bin automatically. No import or transfer step.</p></details>;
  }
}
