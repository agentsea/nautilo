import { useEffect, useRef, type ReactElement } from "react";
import { normalizeVideoExportSettings, videoExportDimensions, type VideoExportSettings } from "@nautilo/types";
import type { FrameRate } from "./edl";
import { formatFrameRate } from "./FrameRateDialog";

export function ExportDialog({ settings, frameRate, publishToWorkspace, workspaceSupported, onChange, onPublishChange, onExport, onCancel }: {
  settings: VideoExportSettings; frameRate: FrameRate; publishToWorkspace: boolean; workspaceSupported: boolean;
  onChange: (settings: VideoExportSettings) => void; onPublishChange: (value: boolean) => void;
  onExport: () => void; onCancel: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); previous?.focus(); };
  }, []);
  const dimensions = videoExportDimensions(settings);
  const valid = normalizeVideoExportSettings(settings) !== null;
  return <dialog ref={dialog} className="video-rate-dialog video-export-dialog" aria-labelledby="video-export-title"
    onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <form onSubmit={(event) => { event.preventDefault(); if (valid) onExport(); }}>
      <h2 id="video-export-title">Export video</h2>
      <p>Save your finished video as an MP4.</p>
      <div className="video-export-dialog__fields">
        <label><span id="video-export-resolution">Resolution</span><select aria-labelledby="video-export-resolution" autoFocus value={settings.resolution} onChange={(event) => onChange({ ...settings, resolution: event.currentTarget.value as VideoExportSettings["resolution"] })}>
          <option value="720p">720p · 1280 × 720</option><option value="1080p">1080p · 1920 × 1080</option><option value="4k">4K · 3840 × 2160</option>
        </select></label>
        <label><span id="video-export-quality">Quality</span><select aria-labelledby="video-export-quality" value={settings.quality} onChange={(event) => {
          const quality = event.currentTarget.value as VideoExportSettings["quality"];
          const { videoBitrateKbps: bitrate, ...rest } = settings;
          onChange({ ...rest, quality, ...(quality === "custom" ? { videoBitrateKbps: bitrate ?? 8000 } : {}) });
        }}>
          <option value="smaller">Smaller file</option><option value="balanced">Balanced</option><option value="high">High quality</option><option value="custom">Custom bitrate…</option>
        </select></label>
      </div>
      <p className="video-export-dialog__hint">{settings.quality === "smaller" ? "More compression for easier sharing." : settings.quality === "high" ? "Less compression, with larger files." : settings.quality === "custom" ? "Target average bitrate; actual bitrate and file size vary." : "A balance of picture quality and file size."}</p>
      <details open={settings.quality === "custom" || undefined}>
        <summary>Advanced</summary>
        {settings.quality === "custom" ? <label>Video bitrate (Mbps)<input type="number" min="0.000001" step="any" required
          value={Number.isFinite(settings.videoBitrateKbps) ? settings.videoBitrateKbps! / 1000 : ""}
          onChange={(event) => onChange({ ...settings, videoBitrateKbps: event.currentTarget.value === "" ? Number.NaN : Number(event.currentTarget.value) * 1000 })} /></label>
          : <p>Choose Custom bitrate under Quality to set a target video bitrate.</p>}
        <label><span id="video-export-audio-quality">Audio quality</span><select aria-labelledby="video-export-audio-quality" value={settings.audioBitrateKbps} onChange={(event) => onChange({ ...settings, audioBitrateKbps: Number(event.currentTarget.value) as VideoExportSettings["audioBitrateKbps"] })}>
          <option value={128}>Standard · 128 kbps</option><option value={192}>High · 192 kbps</option><option value={320}>Highest · 320 kbps</option>
        </select></label>
      </details>
      <p className="video-export-dialog__hint">{dimensions.width} × {dimensions.height} · {formatFrameRate(frameRate)} (project rate) · H.264 / AAC<br />Keeps the current framing. A larger resolution cannot add missing source detail.</p>
      {workspaceSupported ? <label className="video-export-dialog__workspace"><input type="checkbox" checked={publishToWorkspace} onChange={(event) => onPublishChange(event.currentTarget.checked)} />Also save a copy to Workspace</label> : null}
      {!valid ? <p role="alert">Enter a positive video bitrate.</p> : null}
      <div className="video-rate-dialog__actions"><button type="button" onClick={onCancel}>Cancel</button><button type="submit" className="video-button--primary" disabled={!valid}>Export MP4</button></div>
    </form>
  </dialog>;
}
