import { countCodePoints } from "@nautilo/reflection";
import type { EffectiveRoomEvent, RoomEventRollupView } from "./types";

function latestRollup(
  rollups: readonly RoomEventRollupView[],
): RoomEventRollupView | null {
  return (
    [...rollups].sort(
      (left, right) =>
        right.throughEventSequence - left.throughEventSequence,
    )[0] ?? null
  );
}

export interface JournalPromptProjection {
  rollup: RoomEventRollupView | null;
  events: EffectiveRoomEvent[];
  projectedBodyCodePoints: number;
}

/**
 * Runtime's agent-facing Journal view. Semantic planning and processing live
 * in Reflection; this projection remains here because it exposes durable
 * Runtime entities to the Room prompt.
 */
export function projectJournalPrompt(input: {
  rollups: readonly RoomEventRollupView[];
  events: readonly EffectiveRoomEvent[];
}): JournalPromptProjection {
  const rollup = latestRollup(input.rollups);
  const events = input.events
    .filter(
      (event) =>
        event.status === "active"
        && event.sequence > (rollup?.throughEventSequence ?? 0),
    )
    .sort((left, right) => left.sequence - right.sequence);
  return {
    rollup,
    events,
    projectedBodyCodePoints:
      (rollup ? countCodePoints(rollup.content) : 0)
      + events.reduce(
        (total, event) => total + countCodePoints(event.statement),
        0,
      ),
  };
}
