import type {
  EffectiveRoomEvent,
  RoomEventKind,
  StenographerOperation,
} from "./types";

export interface PlannedEventStatusUpdate {
  eventId: string;
  fromStatus: "active";
  toStatus: "superseded" | "resolved";
}

export interface PlannedEventInsert {
  batchLocalOrdinal: number;
  sequence: number;
  kind: RoomEventKind;
  statement: string;
  sourceMessageIds: number[];
  status: "active";
  supersedesEventId: string | null;
  resolvesEventId: string | null;
}

export interface EventTransitionPlan {
  statusUpdates: PlannedEventStatusUpdate[];
  inserts: PlannedEventInsert[];
  foldedBatchLocalOrdinals: number[];
  nextSequence: number;
}

export type EventTransitionPlanResult =
  | { ok: true; plan: EventTransitionPlan }
  | {
      ok: false;
      reason:
        | "invalid_existing_graph"
        | "target_not_found"
        | "target_cross_room"
        | "target_not_active";
    };

export function normalizedEventKey(
  kind: RoomEventKind,
  statement: string,
): string {
  return JSON.stringify([
    kind,
    statement.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(),
  ]);
}

function existingGraphIsAcyclic(events: readonly EffectiveRoomEvent[]): boolean {
  const byId = new Map(events.map((event) => [event.id, event]));
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (eventId: string): boolean => {
    if (visited.has(eventId)) return true;
    if (visiting.has(eventId)) return false;
    visiting.add(eventId);
    const event = byId.get(eventId);
    if (!event) {
      visiting.delete(eventId);
      visited.add(eventId);
      return true;
    }
    const references = [
      event.supersedesEventId,
      event.resolvesEventId,
    ].filter((id): id is string => id !== null && id !== undefined);
    for (const reference of references) {
      if (reference === eventId || !visit(reference)) return false;
    }
    visiting.delete(eventId);
    visited.add(eventId);
    return true;
  };

  return events.every((event) => visit(event.id));
}

export function planEventTransitions(input: {
  roomId: string;
  events: readonly EffectiveRoomEvent[];
  operations: readonly StenographerOperation[];
}): EventTransitionPlanResult {
  const roomEvents = input.events.filter((event) => event.roomId === input.roomId);
  if (!existingGraphIsAcyclic(roomEvents)) {
    return { ok: false, reason: "invalid_existing_graph" };
  }

  const duplicateSequences = new Set<number>();
  const seenSequences = new Set<number>();
  for (const event of roomEvents) {
    if (seenSequences.has(event.sequence)) {
      duplicateSequences.add(event.sequence);
    }
    seenSequences.add(event.sequence);
  }
  if (duplicateSequences.size > 0) {
    return { ok: false, reason: "invalid_existing_graph" };
  }

  const bySequence = new Map<number, EffectiveRoomEvent>();
  for (const event of input.events) {
    // Preserve a same-Room target over a cross-Room fixture with the same
    // sequence, while still allowing an exclusively cross-Room target to fail.
    const current = bySequence.get(event.sequence);
    if (!current || event.roomId === input.roomId) {
      bySequence.set(event.sequence, event);
    }
  }
  const currentStatus = new Map(roomEvents.map((event) => [event.id, event.status]));
  const activeKeys = new Set(
    roomEvents
      .filter((event) => event.status === "active")
      .map((event) => normalizedEventKey(event.kind, event.statement)),
  );
  const statusUpdates: PlannedEventStatusUpdate[] = [];
  const inserts: PlannedEventInsert[] = [];
  const foldedBatchLocalOrdinals: number[] = [];
  let sequence =
    roomEvents.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;

  for (const [batchLocalOrdinal, operation] of input.operations.entries()) {
    if (operation.op === "append") {
      const key = normalizedEventKey(operation.kind, operation.statement);
      if (activeKeys.has(key)) {
        foldedBatchLocalOrdinals.push(batchLocalOrdinal);
        continue;
      }
      inserts.push({
        batchLocalOrdinal,
        sequence,
        kind: operation.kind,
        statement: operation.statement,
        sourceMessageIds: [...operation.sourceMessageIds],
        status: "active",
        supersedesEventId: null,
        resolvesEventId: null,
      });
      activeKeys.add(key);
      sequence += 1;
      continue;
    }

    const target = bySequence.get(operation.eventSequence);
    if (!target) return { ok: false, reason: "target_not_found" };
    if (target.roomId !== input.roomId) {
      return { ok: false, reason: "target_cross_room" };
    }
    if (currentStatus.get(target.id) !== "active") {
      return { ok: false, reason: "target_not_active" };
    }

    const toStatus = operation.op === "supersede"
      ? "superseded"
      : "resolved";
    statusUpdates.push({
      eventId: target.id,
      fromStatus: "active",
      toStatus,
    });
    currentStatus.set(target.id, toStatus);
    activeKeys.delete(normalizedEventKey(target.kind, target.statement));

    const kind = operation.op === "supersede" ? operation.kind : target.kind;
    inserts.push({
      batchLocalOrdinal,
      sequence,
      kind,
      statement: operation.statement,
      sourceMessageIds: [...operation.sourceMessageIds],
      status: "active",
      supersedesEventId: operation.op === "supersede" ? target.id : null,
      resolvesEventId: operation.op === "resolve" ? target.id : null,
    });
    activeKeys.add(normalizedEventKey(kind, operation.statement));
    sequence += 1;
  }

  return {
    ok: true,
    plan: {
      statusUpdates,
      inserts,
      foldedBatchLocalOrdinals,
      nextSequence: sequence,
    },
  };
}
