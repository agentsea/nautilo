import type { CompanionSnapshot } from "../../../desktop/electron/companion-contract";

/** Playback and Room work can overlap; neither operation masks the other. */
export function companionStatus(snapshot: Pick<CompanionSnapshot, "capture" | "busy" | "workRunning" | "speaking" | "stopState">): string {
  if (snapshot.stopState === "stopping") return snapshot.speaking ? "Stopping action · speaking" : "Stopping action…";
  if (snapshot.capture === "requesting") return "Opening microphone…";
  if (snapshot.capture === "listening") return "Listening · tap mic to send";
  if (snapshot.capture === "transcribing") return "Transcribing…";
  if (snapshot.busy) return snapshot.speaking ? "Sending · speaking" : "Sending…";
  if (snapshot.speaking) return snapshot.workRunning ? "Speaking · action running" : "Speaking · tap to stop";
  if (snapshot.workRunning) return "Working · microphone off";
  return "Microphone off";
}
