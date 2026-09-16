import type { GeneratedMediaAmbientKind, GeneratedMediaAmbientRuntime, GeneratedMediaAmbientState } from "./generated-media-ambient-runtime";

export type GeneratedMediaKind = GeneratedMediaAmbientKind;
export interface GeneratedMediaAmbientController {
  setState(state: GeneratedMediaAmbientState): void;
  dispose(): void;
}

type Palette = Readonly<{ background: string; coral: string; cyan: string; ink: string; frame: string; theme: "light" | "dark" }>;

function paletteFor(container: HTMLElement): Palette {
  const computed = getComputedStyle(container);
  const hostTheme = container.closest<HTMLElement>("[data-theme]")?.dataset["theme"] ?? document.documentElement.dataset["theme"] ?? "";
  const dark = hostTheme === "dark" || (hostTheme !== "light" && (Boolean(container.closest(".dark")) || computed.colorScheme.trim() === "dark"));
  return dark
    ? { theme: "dark", background: "#090e1b", coral: "#ff886a", cyan: "#53dedc", ink: "#929bff", frame: "#243148" }
    : { theme: "light", background: "#f0e9e1", coral: "#d14932", cyan: "#067f8f", ink: "#363b9a", frame: "#d7cec4" };
}

function applyPalette(container: HTMLElement): void {
  const palette = paletteFor(container);
  container.style.setProperty("--generation-ambient-theme", palette.theme);
  container.style.setProperty("--generation-ambient-background", palette.background);
  container.style.setProperty("--generation-ambient-coral", palette.coral);
  container.style.setProperty("--generation-ambient-cyan", palette.cyan);
  container.style.setProperty("--generation-ambient-ink", palette.ink);
  container.style.setProperty("--generation-ambient-frame", palette.frame);
}

/** Mounts decorative, bounded feedback without owning status or progress. */
export function mountGeneratedMediaAmbient(container: HTMLDivElement, mediaKind: GeneratedMediaKind, initialState: GeneratedMediaAmbientState): GeneratedMediaAmbientController {
  applyPalette(container);
  container.setAttribute("aria-hidden", "true");
  container.dataset["testid"] = "generated-media-ambient";
  Object.assign(container.style, {
    pointerEvents: "none", position: "relative", isolation: "isolate",
    height: "clamp(10rem, 25vw, 16rem)", overflow: "hidden",
    borderRadius: "var(--radius, 0.375rem)",
    border: "1px solid var(--generation-ambient-frame)",
    background: "var(--generation-ambient-background)",
  });
  const fallback = document.createElement("div");
  fallback.dataset["testid"] = "generated-media-ambient-fallback";
  Object.assign(fallback.style, {
    position: "absolute", inset: "0",
    background: "radial-gradient(ellipse at 23% 35%, color-mix(in srgb, var(--generation-ambient-coral) 28%, transparent), transparent 49%), radial-gradient(ellipse at 78% 63%, color-mix(in srgb, var(--generation-ambient-cyan) 24%, transparent), transparent 52%), var(--generation-ambient-background)",
  });
  const frame = document.createElement("div");
  Object.assign(frame.style, {
    position: "absolute", left: "14%", right: "14%", top: "20%", bottom: "20%", borderRadius: "0.45rem",
    border: "1px solid color-mix(in srgb, var(--generation-ambient-cyan) 56%, var(--generation-ambient-frame))",
    boxShadow: "-0.9rem 0.65rem 0 -1px color-mix(in srgb, var(--generation-ambient-coral) 42%, transparent), 0.9rem -0.55rem 0 -1px color-mix(in srgb, var(--generation-ambient-ink) 34%, transparent)", opacity: "0.78",
  });
  const centerLine = document.createElement("div");
  Object.assign(centerLine.style, {
    position: "absolute", left: "1.25rem", right: "1.25rem", top: "50%", height: "1px",
    background: "linear-gradient(to right, transparent, var(--generation-ambient-ink), transparent)", opacity: "0.58",
  });
  container.append(fallback, frame, centerLine);

  let state = initialState;
  let runtime: GeneratedMediaAmbientRuntime | null = null;
  let destroyed = false;
  let importInFlight = false;
  let inViewport = typeof IntersectionObserver === "undefined";
  let documentVisible = document.visibilityState !== "hidden";
  let contextLost = false;
  const motionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  let reducedMotion = motionQuery?.matches ?? false;
  const permitted = () => inViewport && documentVisible && !reducedMotion && !contextLost;
  const stopAndDispose = () => { runtime?.dispose(); runtime = null; };
  const syncRuntime = () => {
    if (destroyed) return;
    if (runtime) { runtime.resize(); runtime.setRunning(permitted()); return; }
    if (!permitted() || importInFlight) return;
    importInFlight = true;
    void import("@nautilo/generated-media-ui/runtime").then(({ createGeneratedMediaAmbientRuntime }) => {
      importInFlight = false;
      if (destroyed || !permitted() || runtime) return;
      let nextRuntime: GeneratedMediaAmbientRuntime | null = null;
      nextRuntime = createGeneratedMediaAmbientRuntime(container, mediaKind, () => {
        contextLost = true;
        nextRuntime?.dispose();
        if (!destroyed) runtime = null;
      });
      if (!nextRuntime) return;
      if (destroyed || !permitted()) { nextRuntime.dispose(); return; }
      runtime = nextRuntime;
      nextRuntime.setState(state);
      nextRuntime.resize();
      nextRuntime.setRunning(true);
    }).catch(() => { importInFlight = false; });
  };
  const refreshTheme = () => { applyPalette(container); runtime?.resize(); };
  const onWindowResize = () => runtime?.resize();
  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => runtime?.resize());
  resizeObserver?.observe(container);
  if (!resizeObserver) window.addEventListener("resize", onWindowResize);
  const intersectionObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
    inViewport = entries.some((entry) => entry.isIntersecting); syncRuntime();
  }, { threshold: 0.01 });
  intersectionObserver?.observe(container);
  const onVisibilityChange = () => { documentVisible = document.visibilityState !== "hidden"; syncRuntime(); };
  const onMotionChange = (event: MediaQueryListEvent) => { reducedMotion = event.matches; if (reducedMotion) stopAndDispose(); syncRuntime(); };
  const themeObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(refreshTheme);
  const themeHost = container.parentElement?.closest<HTMLElement>("[data-theme]") ?? document.documentElement;
  themeObserver?.observe(themeHost, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
  const pointerHost = container.parentElement ?? container;
  const onPointerMove = (event: PointerEvent) => {
    const bounds = pointerHost.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    runtime?.setPointer?.(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -(((event.clientY - bounds.top) / bounds.height) * 2 - 1));
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  motionQuery?.addEventListener("change", onMotionChange);
  pointerHost.addEventListener("pointermove", onPointerMove, { passive: true });
  syncRuntime();
  return {
    setState(nextState) { state = nextState; runtime?.setState(nextState); },
    dispose() {
      if (destroyed) return;
      destroyed = true;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", onWindowResize);
      intersectionObserver?.disconnect();
      themeObserver?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      motionQuery?.removeEventListener("change", onMotionChange);
      pointerHost.removeEventListener("pointermove", onPointerMove);
      stopAndDispose();
      container.replaceChildren();
    },
  };
}
