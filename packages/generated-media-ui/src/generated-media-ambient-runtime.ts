export type GeneratedMediaAmbientState =
  "queued" | "generating" | "downloading" | "saving";
export type GeneratedMediaAmbientKind = "video" | "music" | "image";
export interface GeneratedMediaAmbientRuntime {
  setState(state: GeneratedMediaAmbientState): void;
  setPointer(x: number, y: number): void;
  resize(): void;
  setRunning(running: boolean): void;
  dispose(): void;
}
// Motion intensity expresses the existing job state, never percentage or elapsed estimates.
const PROFILES: Record<GeneratedMediaAmbientState, number> = {
  queued: 0.35,
  generating: 1,
  downloading: 0.7,
  saving: 0.45,
};

/** Shared decorative ribbon motion. The controller owns visibility and reduced motion;
 * this renderer has no job, provider, timer-label or submission authority. */
export function createGeneratedMediaAmbientRuntime(
  container: HTMLDivElement,
  mediaKind: GeneratedMediaAmbientKind,
  onContextLoss: () => void,
): GeneratedMediaAmbientRuntime {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("A canvas context is unavailable for generation motion.");
  Object.assign(canvas.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
  });
  canvas.setAttribute("aria-hidden", "true");
  container.appendChild(canvas);
  let disposed = false,
    contextLost = false,
    running = false;
  let frame = 0,
    lastTime: number | null = null,
    elapsedMs = 0;
  let width = 1,
    height = 1,
    pointerX = 0,
    pointerY = 0;
  let state: GeneratedMediaAmbientState = "queued";
  let palette = {
    dark: false,
    cyan: "#067f8f",
    coral: "#d14932",
    ink: "#363b9a",
    background: "#f0e9e1",
    frame: "#d7cec4",
  };
  function resize(): void {
    if (disposed || contextLost) return;
    const style = getComputedStyle(container);
    const dark =
      style.getPropertyValue("--generation-ambient-theme").trim() === "dark";
    const color = (name: string, fallback: string) =>
      style.getPropertyValue(`--generation-ambient-${name}`).trim() || fallback;
    palette = {
      dark,
      cyan: color("cyan", dark ? "#53dedc" : "#067f8f"),
      coral: color("coral", dark ? "#ff886a" : "#d14932"),
      ink: color("ink", dark ? "#929bff" : "#363b9a"),
      background: color("background", dark ? "#090e1b" : "#f0e9e1"),
      frame: color("frame", dark ? "#243148" : "#d7cec4"),
    };
    width = Math.max(1, container.clientWidth || 1);
    height = Math.max(1, container.clientHeight || 1);
    // Retain the shared renderer's backing-store budget; geometry detail is presentation-only.
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context!.setTransform(ratio, 0, 0, ratio, 0, 0);
    render();
  }
  function render(): void {
    if (disposed || contextLost) return;
    const c = context!,
      w = width,
      h = height;
    const index = width < 240 ? 1 : 0;
    const { dark, cyan, coral, ink, background, frame: frameColor } = palette;
    const t = elapsedMs * 0.0003 * PROFILES[state];
    c.clearRect(0, 0, w, h);
    c.fillStyle = background;
    c.fillRect(0, 0, w, h);
    const sc = Math.min(w / 650, h / 260) * (index ? 1.35 : 1),
      cx = w * 0.5,
      cy = h * 0.47;
    function halo(x: number, y: number, r: number, col: string, alpha: number) {
      c.save();
      c.globalAlpha = alpha;
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, col);
      g.addColorStop(1, "transparent");
      c.fillStyle = g;
      c.fillRect(x - r, y - r, r * 2, r * 2);
      c.restore();
    }
    halo(cx - 110 * sc, cy, 200 * sc, coral, dark ? 0.21 : 0.12);
    halo(cx + 100 * sc, cy, 210 * sc, cyan, dark ? 0.18 : 0.1);
    // Hairline coordinates make the moving form legible without suggesting progress.
    c.strokeStyle = frameColor;
    c.lineWidth = 0.6;
    c.beginPath();
    c.moveTo(0, cy);
    c.lineTo(w, cy);
    c.stroke();
    for (let x = 24; x < w; x += 32) {
      c.beginPath();
      c.moveTo(x, h - 14);
      c.lineTo(x, h - 11);
      c.stroke();
    }
    c.save();
    c.translate(cx + pointerX * 5, cy + pointerY * 3);
    c.scale(sc, sc);
    // A twisting ribbon volume. Every strand changes shape, depth and velocity.
    const strands = index ? 24 : 48,
      segments = index ? 85 : 140;
    for (let band = 0; band < 3; band++) {
      for (let j = 0; j < strands; j++) {
        const q = j / (strands - 1),
          phase = t * (band === 1 ? -0.8 : 1) + band * 2.1;
        c.beginPath();
        for (let k = 0; k <= segments; k++) {
          const a = (k / segments) * Math.PI * 2;
          const ripple = Math.sin(a * 3 + phase * 1.6 + q * 0.9);
          const radius = 125 + q * 40 + ripple * 12;
          const x = Math.cos(a) * radius * 1.38;
          const z = Math.sin(a) * radius;
          const y =
            Math.sin(a * 2 + phase + band * 0.7) * (22 + q * 27) +
            Math.sin(a + phase) * 27;
          const tilt = 0.3 * Math.sin(phase * 0.46 + band);
          const xx = x * Math.cos(tilt) - y * Math.sin(tilt),
            yy = x * Math.sin(tilt) + y * Math.cos(tilt) + z * 0.21;
          if (k === 0) c.moveTo(xx, yy);
          else c.lineTo(xx, yy);
        }
        c.strokeStyle = band === 0 ? coral : band === 1 ? ink : cyan;
        c.globalAlpha =
          (dark ? 0.52 : 0.38) * (Math.sin(q * Math.PI) * 0.7 + 0.3);
        c.lineWidth = 0.8;
        if (j === Math.floor(strands * 0.55)) {
          c.globalAlpha = dark ? 0.95 : 0.85;
          c.lineWidth = 1.5;
          c.shadowColor = c.strokeStyle;
          c.shadowBlur = dark ? 7 : 0;
        }
        c.stroke();
        c.shadowBlur = 0;
      }
    }
    c.globalAlpha = 1;
    // The central media shape is part of the shared motion language.
    c.save();
    c.rotate(Math.sin(t * 0.7) * 0.055);
    if (mediaKind === "music") {
      for (let j = 0; j < 29; j++) {
        const x = (j - 14) * 5;
        const a =
          (Math.sin(j * 0.43 + t * 5) * 0.5 + 0.5) * (28 - Math.abs(j - 14)) +
          6;
        c.strokeStyle = j < 14 ? coral : cyan;
        c.lineWidth = 2.8;
        c.lineCap = "round";
        c.beginPath();
        c.moveTo(x, -a);
        c.lineTo(x, a);
        c.stroke();
      }
    } else {
      const rw = mediaKind === "video" ? 138 : 87,
        rh = mediaKind === "video" ? 79 : 113;
      for (let i = 3; i >= 0; i--) {
        const dx = i * 9 - 10 + Math.sin(t + i) * 3,
          dy = -i * 6 + 9;
        c.globalAlpha = i === 0 ? 1 : 0.2;
        c.fillStyle = background;
        c.strokeStyle = i % 2 ? cyan : coral;
        c.lineWidth = i === 0 ? 1.7 : 0.8;
        c.beginPath();
        c.roundRect(-rw / 2 + dx, -rh / 2 + dy, rw, rh, 5);
        if (i === 0) c.fill();
        c.stroke();
      }
      c.globalAlpha = 1;
      c.save();
      c.beginPath();
      c.roundRect(-rw / 2 - 10, -rh / 2 + 9, rw, rh, 5);
      c.clip();
      for (let j = 0; j < 18; j++) {
        c.beginPath();
        for (let k = 0; k <= 65; k++) {
          const x = -rw / 2 - 10 + (k / 65) * rw,
            y =
              Math.sin(k * 0.095 + t * 2.4 + j * 0.11) * (rh * 0.17) +
              j * 2 -
              rh * 0.2 +
              9;
          if (k === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.strokeStyle = j < 9 ? coral : cyan;
        c.globalAlpha = dark ? 0.8 : 0.7;
        c.lineWidth = 0.9;
        c.stroke();
      }
      c.restore();
    }
    c.restore();
    // Few fast highlights travel the volume, instead of a cloud of faint dots.
    for (let i = 0; i < (index ? 8 : 18); i++) {
      const a = t * (1.5 + (i % 3) * 0.24) + i * 2.399;
      const x = Math.cos(a) * (190 + (i % 4) * 12),
        y = Math.sin(a * 2 + t) * 34 + Math.sin(a) * 40;
      c.globalAlpha = 0.45 + 0.4 * Math.sin(a) ** 2;
      c.fillStyle = i % 2 ? cyan : coral;
      c.beginPath();
      c.arc(x, y, i % 4 === 0 ? 2 : 1.1, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
    c.globalAlpha = 1;
  }
  function loop(now: number): void {
    frame = 0;
    if (!running || disposed || contextLost) return;
    if (lastTime !== null) elapsedMs += Math.max(0, now - lastTime);
    lastTime = now;
    render();
    frame = requestAnimationFrame(loop);
  }
  function setRunning(next: boolean): void {
    if (disposed || contextLost || running === next) return;
    running = next;
    lastTime = null;
    if (next) {
      resize();
      frame = requestAnimationFrame(loop);
    } else if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }
  function handleContextLost(event: Event): void {
    if (disposed || contextLost) return;
    event.preventDefault();
    setRunning(false);
    contextLost = true;
    onContextLoss();
  }
  canvas.addEventListener("contextlost", handleContextLost);
  resize();
  return {
    setState(next) {
      state = next;
      if (!running) render();
    },
    setPointer(x, y) {
      pointerX = Math.max(-1, Math.min(1, x));
      pointerY = Math.max(-1, Math.min(1, y));
      if (!running) render();
    },
    resize,
    setRunning,
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      canvas.removeEventListener("contextlost", handleContextLost);
      canvas.remove();
      // Release the backing store even if a stale reference keeps the element alive.
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}
