import { LoaderCircle, Mic, MicOff, Volume2, VolumeX } from "lucide-react";
import type { CompanionSnapshot } from "../../../desktop/electron/companion-contract";

/** Capture and playback are independent controls in every companion density. */
export function CompanionAudioControls({ capture, sound, onMic, onSound }: {
  capture: CompanionSnapshot["capture"];
  sound: boolean;
  onMic: () => void;
  onSound: () => void;
}) {
  const on = capture === "listening";
  const opening = capture === "requesting";
  const transcribing = capture === "transcribing";
  const MicIcon = opening || transcribing ? LoaderCircle : on ? Mic : MicOff;
  const micLabel = opening ? "Opening mic — cancel" : transcribing ? "Mic off — transcribing; click to cancel"
    : on ? "Mic on — finish recording" : "Mic off — start recording";
  return <>
    <button type="button" className="companion-audio-toggle companion-mic-toggle" aria-pressed={on}
      aria-label={micLabel} title={micLabel} onClick={onMic}>
      <MicIcon size={14} className={opening || transcribing ? "companion-spinner" : undefined} />
      <span>{opening ? "Opening…" : transcribing ? "Transcribing…" : on ? "Mic on" : "Mic off"}</span>
    </button>
    <button type="button" className="companion-audio-toggle" aria-pressed={sound}
      aria-label={sound ? "Sound on — mute spoken replies" : "Sound off — enable spoken replies"}
      title={sound ? "Sound on — mute spoken replies" : "Sound off — enable spoken replies"} onClick={onSound}>
      {sound ? <Volume2 size={14} /> : <VolumeX size={14} />}<span>Sound {sound ? "on" : "off"}</span>
    </button>
  </>;
}
