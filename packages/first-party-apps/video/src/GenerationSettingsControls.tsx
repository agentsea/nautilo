import { VIDEO_GENERATION_CATALOG_MODELS, type VideoGenerationCatalogModelId, type VideoGenerationRequestedSettings } from "./generation-plan";

export function GenerationSettingsControls({ model, settings, onChange, includeDuration = true, durationScope = "default", onDurationChange }: { durationScope?: "default" | "video"; onDurationChange?: (duration: number | undefined) => void; includeDuration?: boolean; model: VideoGenerationCatalogModelId; settings: VideoGenerationRequestedSettings; onChange: (settings: VideoGenerationRequestedSettings) => void }) {
  const minimax = model === VIDEO_GENERATION_CATALOG_MODELS.minimaxH3;
  return <div className="generator-settings" role="group" aria-label="Generation settings">
    {includeDuration && <label>{durationScope === "video" ? "Duration (seconds)" : "Default seconds"}<input aria-label="Generation duration in seconds" type="number" step="1" placeholder="Auto" value={settings.durationSeconds ?? ""} onInput={event => {
      const duration = event.currentTarget.value ? Number(event.currentTarget.value) : undefined;
      if (duration !== undefined && (!Number.isSafeInteger(duration) || duration <= 0)) return;
      if (onDurationChange) { onDurationChange(duration); return; }
      const next = { ...settings }; if (duration !== undefined) next.durationSeconds = duration; else delete next.durationSeconds; onChange(next);
    }} /></label>}
    <label>Resolution<select aria-label="Generation resolution" value={settings.resolution ?? ""} onChange={event => {
      const next = { ...settings }; if (event.currentTarget.value) next.resolution = event.currentTarget.value; else delete next.resolution; onChange(next);
    }}><option value="">Auto</option>{(minimax ? ["768P", "2K"] : ["480p", "720p", "1080p"]).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
    {!minimax && <label>Generated audio<select aria-label="Generated audio" value={settings.audio === undefined ? "" : String(settings.audio)} onChange={event => {
      const next = { ...settings }; if (event.currentTarget.value) next.audio = event.currentTarget.value === "true"; else delete next.audio; onChange(next);
    }}><option value="">Auto</option><option value="false">Off</option><option value="true">On</option></select></label>}
    <small>{includeDuration && durationScope === "default" ? "Scene durations override the default. Exact cost is confirmed before generation." : "Review the exact cost before generation."}</small>
  </div>;
}
