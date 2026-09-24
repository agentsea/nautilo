import { AudioLines, Square } from "lucide-react";

/** Interrupt this reply; the speaker icon is reserved for the sound preference. */
export function StopTalkingIcon() {
  return <span aria-hidden className="relative inline-flex h-[18px] w-[18px] shrink-0 items-center">
    <AudioLines size={15} />
    <Square size={8} fill="currentColor" className="absolute -right-px bottom-0 rounded-sm bg-background" />
  </span>;
}
