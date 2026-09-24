import { ArrowUp, LoaderCircle } from "lucide-react";
import type { CompanionSnapshot } from "../../../desktop/electron/companion-contract";

/** Sending stays separate from the persistent microphone toggle. */
export function CompanionSendButton({ capture, sending, disabled, hasContent, onSend }: {
  capture: CompanionSnapshot["capture"];
  sending: boolean;
  disabled: boolean;
  hasContent: boolean;
  onSend: () => void;
}) {
  const transcribing = capture === "transcribing";
  const pending = sending || transcribing;
  return <button type="button" className={`companion-send${pending ? " companion-send-recording" : ""}`}
    disabled={disabled || !hasContent || pending || capture === "listening" || capture === "requesting"}
    aria-busy={pending} aria-label={sending ? "Sending message" : transcribing ? "Transcribing recording" : "Send to Genie"} onClick={onSend}>
    {pending ? <><LoaderCircle className="companion-spinner" size={15} /><span>{sending ? "Sending…" : "Transcribing…"}</span></> : <ArrowUp size={17} />}
  </button>;
}
