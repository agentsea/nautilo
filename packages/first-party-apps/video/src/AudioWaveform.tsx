import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

/** Render host-decoded peaks at the card's display resolution; never decode media here. */
export function AudioWaveform({ peaks }: { peaks: readonly number[] }): ReactElement {
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(1);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(1, element.getBoundingClientRect().width));
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  const path = useMemo(() => {
    // One bar per three CSS pixels. Every source peak contributes, including
    // the end of long files; this is display downsampling, not a duration cap.
    const bars = Math.max(1, Math.floor(width / 3));
    const segments: string[] = [];
    for (let bar = 0; bar < bars; bar++) {
      const from = Math.floor(bar / bars * peaks.length);
      const to = Math.ceil((bar + 1) / bars * peaks.length);
      let peak = 0;
      for (let index = from; index < to; index++) {
        const value = peaks[index] ?? 0;
        if (Number.isFinite(value)) peak = Math.max(peak, Math.min(1, Math.abs(value)));
      }
      const height = Math.max(1, peak * 60);
      segments.push(`M${(bar + 0.5) / bars * width} ${(64 - height) / 2}v${height}`);
    }
    return segments.join(" ");
  }, [peaks, width]);
  return <svg ref={svg} className="video-audio-waveform" role="img" aria-label="Audio waveform" viewBox={`0 0 ${width} 64`} preserveAspectRatio="none">
    <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>;
}
