import { useEffect, useRef, useState, type ReactElement } from "react";
import type { FrameRate } from "./edl";
import type { FirstSourceRateDecision } from "./commands";

export function formatFrameRate(rate: FrameRate): string {
  return `${Number((rate.numerator / rate.denominator).toFixed(3))} fps`;
}

export function FrameRateDialog({ source, project, onChoose, onCancel }: {
  source: FrameRate; project: FrameRate;
  onChoose: (decision: FirstSourceRateDecision, remember: boolean) => void;
  onCancel: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className="video-rate-dialog" aria-labelledby="video-rate-title" onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <h2 id="video-rate-title">Match this project to your video?</h2>
    <p>Your video is <strong>{formatFrameRate(source)}</strong>. This empty project is <strong>{formatFrameRate(project)}</strong>.</p>
    <p>Match the video for a consistent editing frame rate. Existing projects are never changed automatically.</p>
    <label><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.currentTarget.checked)} />Remember my choice for new projects</label>
    <div className="video-rate-dialog__actions">
      <button type="button" onClick={onCancel}>Cancel import</button>
      <button type="button" onClick={() => onChoose("keep-project-rate", remember)}>Keep {formatFrameRate(project)}</button>
      <button autoFocus type="button" className="video-button--primary" onClick={() => onChoose("adopt-source-rate", remember)}>Change project to {formatFrameRate(source)}</button>
    </div>
  </dialog>;
}
