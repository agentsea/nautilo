import { useEffect, useRef } from "react";
import { mountGeneratedMediaAmbient, type GeneratedMediaAmbientController, type GeneratedMediaAmbientState } from "@nautilo/generated-media-ui";

function VideoGenerationAmbient({ state }: { state: GeneratedMediaAmbientState }) {
  const container = useRef<HTMLDivElement>(null);
  const controller = useRef<GeneratedMediaAmbientController | null>(null);
  const currentState = useRef(state);
  currentState.current = state;
  useEffect(() => { controller.current?.setState(state); }, [state]);
  useEffect(() => {
    if (!container.current) return;
    const mounted = mountGeneratedMediaAmbient(container.current, "video", currentState.current);
    controller.current = mounted;
    return () => { mounted.dispose(); controller.current = null; };
  }, []);
  return <div ref={container} />;
}

export type GenerationProgressItem = Readonly<{
  takeId: string;
  label: string;
  state: string;
  message: string;
  timing: string | null;
}>;

/** Observes existing takes only. This view cannot submit or cancel a job. */
export function GenerationProgress({ items, enabled, onReconnect }: { items: readonly GenerationProgressItem[]; enabled: boolean; onReconnect?: (() => void) | undefined }) {
  if (!items.length) return null;
  const active = items.find((item) => item.state !== "reconnecting" && item.state !== "saved");
  const state = active?.state === "downloading" || active?.state === "saving"
    ? active.state : active?.state === "generating" ? "generating" : "queued";
  return <section className="generator-progress" aria-label="Generation progress">
    <header><strong>{active ? "Making your video" : items.some((item) => item.state === "saved") ? "Video saved" : "Reconnecting to generation"}</strong><span>Completed videos save to Workspace.</span></header>
    {active && enabled ? <VideoGenerationAmbient state={state} /> : null}
    {items.map((item) => <div className="generator-progress__take" key={item.takeId}>
      <div role="status"><strong>{item.label}</strong><p>{item.message}</p></div>
      {item.timing ? <p className="generator-progress__timing">{item.timing}</p> : null}
    </div>)}
    {onReconnect && items.some((item) => item.state === "saved" || item.state === "reconnecting") ? <button type="button" onClick={onReconnect}>Reconnect Media Bin</button> : null}
  </section>;
}
