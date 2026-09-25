import type { CompanionSnapshot } from "../../../desktop/electron/companion-contract";

/** One primary action, independent of view changes, speaker mute and Room work. */
export function bubbleInteraction(snapshot: Pick<CompanionSnapshot, "capture" | "busy" | "stopState" | "sendUncertain" | "error" | "canStopTalking" | "speaking">): {
  label: string; disabled: boolean; cue: "mic" | "send" | "pending" | "error";
} {
  if (snapshot.sendUncertain) return { label: "Send not confirmed — expand to check chat", disabled: true, cue: "error" };
  if (snapshot.busy) return { label: "Sending message", disabled: true, cue: "pending" };
  if (snapshot.capture === "requesting") return { label: "Opening microphone — Escape cancels", disabled: true, cue: "pending" };
  if (snapshot.capture === "transcribing") return { label: "Transcribing message — Escape cancels", disabled: true, cue: "pending" };
  if (snapshot.stopState === "stopping") return { label: "Stopping action", disabled: true, cue: "pending" };
  if (snapshot.capture === "listening") return { label: "Tap to send — Escape discards recording", disabled: false, cue: "send" };
  if (snapshot.error) return { label: `${snapshot.error} — tap to record a new message`, disabled: false, cue: "error" };
  return { label: snapshot.canStopTalking || snapshot.speaking ? "Interrupt and talk" : "Tap to talk", disabled: false, cue: "mic" };
}
