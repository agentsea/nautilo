export const views = ["orb", "prompt", "chat"] as const;
export const docks = ["free", "top", "bottom", "left", "right"] as const;
export const states = ["idle", "listening", "thinking", "speaking", "muted", "error"] as const;
export const visuals = ["nautilo", "persona"] as const;
export type View = typeof views[number];
export type Dock = typeof docks[number];
export type DemoState = typeof states[number];
export type Visual = typeof visuals[number];
export interface Rect { x: number; y: number; width: number; height: number }
export interface LabState {
  view: View;
  dock: Dock;
  state: DemoState;
  visual: Visual;
  reducedMotion: boolean;
}
export const initialState: LabState = {
  view: "prompt", dock: "bottom", state: "idle", visual: "nautilo", reducedMotion: false,
};
export type LabCommand =
  | { type: "view"; value: View }
  | { type: "dock"; value: Dock }
  | { type: "state"; value: DemoState }
  | { type: "visual"; value: Visual }
  | { type: "menu" | "drag-start" | "drag-move" | "drag-end" | "drag-cancel" };

export function isCommand(value: unknown): value is LabCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as { type?: unknown; value?: unknown };
  switch (c.type) {
    case "view": return views.some(v => v === c.value);
    case "dock": return docks.some(v => v === c.value);
    case "state": return states.some(v => v === c.value);
    case "visual": return visuals.some(v => v === c.value);
    case "menu": case "drag-start": case "drag-move": case "drag-end": case "drag-cancel": return true;
    default: return false;
  }
}

export interface LabBridge {
  getState(): Promise<LabState>;
  command(command: LabCommand): void;
  subscribe(callback: (state: LabState) => void): () => void;
}
