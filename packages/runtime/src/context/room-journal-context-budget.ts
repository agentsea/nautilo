import type { EffectiveRoomEvent, RoomEventRollupView } from "../stenographer/types";

/** Bound prompt-visible Journal text, not confidential Record provenance bytes. */
export function roomJournalContextByteLength(journal: Readonly<{
  rollup: Pick<RoomEventRollupView, "content"> | null;
  events: readonly Pick<EffectiveRoomEvent, "status" | "kind" | "statement">[];
}>): number {
  const lines: string[] = [];
  if (journal.rollup?.content.trim()) lines.push(journal.rollup.content.trim());
  for (const event of journal.events) {
    if (event.status === "active") lines.push(`- [${event.kind}] ${event.statement}`);
  }
  return new TextEncoder().encode(lines.join("\n")).length;
}
