import { useEffect, useRef } from "react";
import { mountGeneratedMediaAmbient, type GeneratedMediaAmbientController, type GeneratedMediaAmbientState } from "@nautilo/generated-media-ui";
import type { MediaAsset } from "./edl";
import { MediaBinPreview } from "./MediaBinPreview";

function VideoGenerationAmbient({ state }: { state: GeneratedMediaAmbientState }) {
  const container = useRef<HTMLDivElement>(null);
  const controller = useRef<GeneratedMediaAmbientController | null>(null);
  useEffect(() => { controller.current?.setState(state); }, [state]);
  useEffect(() => {
    if (!container.current) return;
    const mounted = mountGeneratedMediaAmbient(container.current, "video", state);
    controller.current = mounted;
    return () => { mounted.dispose(); controller.current = null; };
  }, []);
  return <div ref={container} />;
}

export const isGenerationActive = (state: string) => ["preparing", "queued", "submitting", "generating", "downloading", "saving"].includes(state);
export const generationStageLabel = (state: string): string => ({
  preparing: "Checking progress", queued: "Queued", submitting: "Submitted", generating: "Generating", downloading: "Downloading", saving: "Saving",
  ready: "Saved to Media Bin", saved: "Video saved · reconnecting Media Bin", reconnecting: "Status unavailable", failed: "Generation failed", unknown: "Needs attention", "needs-action": "Needs attention",
})[state] ?? "Checking progress";

export type GenerationProgressItem = Readonly<{
  takeId: string;
  shotId: string;
  label: string;
  state: string;
  message: string;
  timing: string | null;
  asset?: MediaAsset | undefined;
}>;

/** Read-only presentation of one submitted take. Navigation never cancels or retries a job. */
export function GenerationProgress({ item, enabled, sceneNumber, sceneCount, onReconnect, onDesign, onPlace, onReviewNext, playing, onPlay }: {
  item: GenerationProgressItem; enabled: boolean; sceneNumber: number; sceneCount: number;
  onReconnect?: (() => void) | undefined; onDesign: () => void; onPlace: (mediaId: string) => void;
  onReviewNext?: (() => void) | undefined; playing: boolean; onPlay: () => void;
}) {
  const active = isGenerationActive(item.state);
  const ready = item.state === "ready" && !!item.asset;
  const ambientState = item.state === "downloading" || item.state === "saving" ? item.state : item.state === "generating" ? "generating" : "queued";
  const heading = ready ? "Your scene is ready" : item.state === "saved" ? "Video saved" : item.state === "reconnecting" ? "Couldn’t check this take"
    : item.state === "failed" ? "Generation failed" : !active ? "This scene needs attention" : item.state === "downloading" || item.state === "saving" ? "Saving your scene" : "Making your scene";
  return <section className="generator-progress generator-progress--stage" aria-label="Generation progress">
    <header><p className="generator-eyebrow">{sceneNumber > 0 ? `Scene ${sceneNumber} of ${sceneCount}` : "Your video"}</p><h3>{heading}</h3><p>{item.label}</p></header>
    <div className="generator-progress__visual" data-theme="dark">
      {ready ? <MediaBinPreview asset={item.asset} enabled={enabled} active={playing} timelinePlaying={false} onPlay={onPlay} />
        : active && enabled ? <VideoGenerationAmbient state={ambientState} />
          : <div className="generator-progress__still"><span aria-hidden="true">{item.state === "saved" ? "✓" : item.state === "failed" ? "!" : "⋯"}</span><strong>{generationStageLabel(item.state)}</strong></div>}
    </div>
    <div className="generator-progress__take"><div role="status"><strong>{generationStageLabel(item.state)}</strong><p>{item.message}</p></div>
      {item.timing ? <p className="generator-progress__timing">{item.timing}</p> : null}
    </div>
    {active || ready ? <ol className="generator-progress__steps" aria-label="Generation stages">
      <li data-state="done">✓ Submitted</li><li data-state={ready || ["downloading", "saving"].includes(item.state) ? "done" : "active"}>{ready || ["downloading", "saving"].includes(item.state) ? "✓ Generated" : "Generating"}</li><li data-state={ready ? "done" : ["downloading", "saving"].includes(item.state) ? "active" : "waiting"}>{ready ? "✓ Saved to Media Bin" : "Save to Media Bin"}</li>
    </ol> : null}
    <footer className="generator-progress__actions">
      <button type="button" onClick={onDesign}>Back to scene design</button>
      {ready ? <><button type="button" onClick={() => onPlace(item.asset!.id)}>Add at playhead</button>{onReviewNext ? <button type="button" className="video-button--primary" onClick={onReviewNext}>Review next scene</button> : null}</> : null}
      {onReconnect && !active && !ready ? <button type="button" onClick={onReconnect}>{item.state === "saved" ? "Reconnect Media Bin" : "Check status"}</button> : null}
    </footer>
    <p className="generator-progress__note">{ready ? "Saved to Workspace and your Media Bin." : active ? "You can keep working. Your video saves to the Media Bin automatically." : "Checking status never submits another generation."}</p>
  </section>;
}
