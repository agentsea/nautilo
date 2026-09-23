import type { ThreadMessageLike } from "@assistant-ui/core";
export const companionViews = ["orb", "waveform", "prompt", "chat"] as const;
export const companionDocks = ["free", "top", "bottom", "left", "right"] as const;
export type CompanionView = typeof companionViews[number];
export type CompanionDock = typeof companionDocks[number];
export interface CompanionBinding { roomId: string; agentId: string; botActorId: string; name: string }
export type CompanionMessage = ThreadMessageLike;
export interface CompanionAttachment { id: string; name: string; status: "pending" | "ready" | "error"; error: string | null }
export interface CompanionPickedFile { name: string; sizeBytes: number; base64: string }
export interface CompanionSnapshot {
  capture: "idle" | "requesting" | "listening" | "transcribing" | "error";
  voiceEnabled: boolean;
  speaking: boolean;
  workRunning: boolean;
  stopState: "idle" | "stopping" | "stopped" | "failed";
  canAttach: boolean;
  pickingAttachments: boolean;
  attachments: CompanionAttachment[];
  avatarDataUrl: string | null;
  binding: CompanionBinding;
  messages: CompanionMessage[];
  hasEarlier: boolean;
  busy: boolean;
  error: string | null;
  draft: string;
  draftRevision: number;
  draftBase: string;
  dictationText: string | null;
}
export interface CompanionWindowState {
  generation: string;
  snapshot: CompanionSnapshot;
  view: CompanionView;
  dock: CompanionDock;
  bubbleAppearance: "avatar" | "orb";
}
export type CompanionAction =
  | { type: "send"; text: string }
  | { type: "draft"; text: string }
  | { type: "remove-attachment"; id: string }
  | { type: "view"; value: CompanionView }
  | { type: "dock"; value: CompanionDock }
  | { type: "bubble-appearance"; value: "avatar" | "orb" }
  | { type: "mic" | "mute" | "stop-talking" | "stop-task" | "attach" | "off" | "return" | "refresh" | "menu" | "drag-start" | "drag-move" | "drag-end" | "drag-cancel" };
export interface CompanionOwnerAPI {
  enable(binding: CompanionBinding): Promise<string>;
  pickFiles(generation: string): Promise<CompanionPickedFile[]>;
  disable(generation: string): Promise<void>;
  publish(generation: string, snapshot: CompanionSnapshot): Promise<void>;
  onAction(callback: (generation: string, action: CompanionAction) => void): () => void;
  onClosed(callback: (generation: string) => void): () => void;
}
export interface CompanionWindowAPI {
  getState(): Promise<CompanionWindowState>;
  command(generation: string, action: CompanionAction): Promise<void>;
  subscribe(callback: (state: CompanionWindowState) => void): () => void;
}
export function isCompanionBinding(value: unknown): value is CompanionBinding {
  if (!value || typeof value !== "object") return false;
  const b = value as CompanionBinding;
  return [b.roomId, b.agentId, b.botActorId, b.name].every(v => typeof v === "string" && v.trim().length > 0);
}
export function isCompanionAvatar(value: unknown): value is string {
  return typeof value === "string" && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}
export function isCompanionSnapshot(value: unknown): value is CompanionSnapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as CompanionSnapshot;
  return ["idle", "requesting", "listening", "transcribing", "error"].includes(s.capture)
    && ["idle", "stopping", "stopped", "failed"].includes(s.stopState)
    && [s.voiceEnabled, s.speaking, s.workRunning, s.canAttach, s.pickingAttachments].every(v => typeof v === "boolean")
    && Array.isArray(s.attachments) && s.attachments.every(a => a && typeof a.id === "string" && typeof a.name === "string"
      && ["pending", "ready", "error"].includes(a.status) && (a.error === null || typeof a.error === "string"))
    && (s.avatarDataUrl === null || isCompanionAvatar(s.avatarDataUrl)) && isCompanionBinding(s.binding) && typeof s.busy === "boolean" && typeof s.hasEarlier === "boolean"
    && typeof s.draft === "string" && typeof s.draftBase === "string" && (s.dictationText === null || typeof s.dictationText === "string") && Number.isSafeInteger(s.draftRevision) && s.draftRevision >= 0 && (s.error === null || typeof s.error === "string")
    && Array.isArray(s.messages) && s.messages.every(m => m && typeof m.id === "string" && ["user", "assistant", "system"].includes(m.role) && Array.isArray(m.content));
}
export function isCompanionAction(value: unknown): value is CompanionAction {
  if (!value || typeof value !== "object") return false;
  const a = value as CompanionAction;
  switch (a.type) {
    case "remove-attachment": return typeof a.id === "string";
    case "send": case "draft": return typeof a.text === "string";
    case "view": return companionViews.includes(a.value);
    case "dock": return companionDocks.includes(a.value);
    case "bubble-appearance": return a.value === "avatar" || a.value === "orb";
    case "mic": case "mute": case "stop-talking": case "stop-task": case "attach":
    case "off": case "return": case "refresh": case "menu":
    case "drag-start": case "drag-move": case "drag-end": case "drag-cancel": return true;
    default: return false;
  }
}
export function shouldShowCompanion(input: { enabled: boolean; ownerCurrent: boolean; mainFocused: boolean; mainDialogFocused: boolean }): boolean {
  return input.enabled && input.ownerCurrent && !input.mainFocused && !input.mainDialogFocused;
}

export function emptyCompanionSnapshot(binding: CompanionBinding): CompanionSnapshot {
  return { binding, avatarDataUrl: null, messages: [], hasEarlier: false, busy: false, error: null, draft: "", draftRevision: 0, draftBase: "", dictationText: null,
    capture: "idle", voiceEnabled: false, speaking: false, workRunning: false, stopState: "idle",
    canAttach: false, pickingAttachments: false, attachments: [] };
}
