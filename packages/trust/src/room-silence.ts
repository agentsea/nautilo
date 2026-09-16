import {
  and,
  actors,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lte,
  lt,
  or,
  roomMembers,
  rooms,
  roomSilenceState,
  sessionMessages,
  sessions,
  sql,
  type DirectDatabase,
  type RoomSilenceState,
  acquireRoomWriteLock,
} from "@nautilo/db";
import type { ActiveRoomSilenceDto } from "@nautilo/types";

export type { ActiveRoomSilenceDto };

export type SilenceKind = "mute" | "deaf";

export type RoomSilenceDb = DirectDatabase;

/** D190 MR6 — default 30 minutes, capped at 24 hours. */
export const DEFAULT_SILENCE_DURATION_MS = 30 * 60 * 1000;
export const MAX_SILENCE_DURATION_MS = 24 * 60 * 60 * 1000;

export type RoomSilenceSystemEventPayload =
  | {
      kind: "silence_set";
      silenceKind: SilenceKind;
      setByDisplayName: string;
      durationLabel: string;
      botDisplayName?: string;
    }
  | {
      kind: "silence_cleared";
      reason: "manual" | "expired";
    };

type SilenceRow = Pick<
  RoomSilenceState,
  "id" | "kind" | "botActorId" | "setByUserId" | "startedAt" | "expiresAt"
>;

/**
 * Pure fold over preloaded rows — single source for precedence + matching.
 * deaf wins over mute when both windows match the same bot at `now`.
 */
export function resolveActiveSilence(
  rows: Pick<RoomSilenceState, "kind" | "botActorId" | "startedAt" | "expiresAt">[],
  botActorId: string,
  now: Date,
): SilenceKind | null {
  let mute = false;
  for (const row of rows) {
    if (now < row.startedAt || now > row.expiresAt) continue;
    if (row.botActorId != null && row.botActorId !== botActorId) continue;
    if (row.kind === "deaf") return "deaf";
    if (row.kind === "mute") mute = true;
  }
  return mute ? "mute" : null;
}

/**
 * D279 Phase 3 — active silence window for (room, bot) at `now`.
 * Returns `'deaf'` | `'mute'` | null. deaf takes precedence over mute.
 */
/**
 * D279 Phase 3.6 — one room-scoped query for all active silence windows.
 * Conductor filters members in memory (replaces per-candidate N+1).
 */
export async function loadActiveSilenceForRoom(
  db: RoomSilenceDb,
  roomId: string,
  now: Date,
): Promise<Array<{ botActorId: string | null; kind: SilenceKind }>> {
  const rows = await db
    .select({
      kind: roomSilenceState.kind,
      botActorId: roomSilenceState.botActorId,
      startedAt: roomSilenceState.startedAt,
      expiresAt: roomSilenceState.expiresAt,
    })
    .from(roomSilenceState)
    .where(
      and(
        eq(roomSilenceState.roomId, roomId),
        lte(roomSilenceState.startedAt, now),
        gte(roomSilenceState.expiresAt, now),
      ),
    );
  return rows.map((row) => ({ botActorId: row.botActorId, kind: row.kind }));
}

export async function activeSilence(
  db: RoomSilenceDb,
  roomId: string,
  botActorId: string,
  now: Date,
): Promise<SilenceKind | null> {
  const rows = await db
    .select({
      kind: roomSilenceState.kind,
      botActorId: roomSilenceState.botActorId,
      startedAt: roomSilenceState.startedAt,
      expiresAt: roomSilenceState.expiresAt,
    })
    .from(roomSilenceState)
    .where(
      and(
        eq(roomSilenceState.roomId, roomId),
        lte(roomSilenceState.startedAt, now),
        gte(roomSilenceState.expiresAt, now),
        or(
          isNull(roomSilenceState.botActorId),
          eq(roomSilenceState.botActorId, botActorId),
        ),
      ),
    );
  return resolveActiveSilence(rows, botActorId, now);
}

export function clampSilenceDurationMs(durationMs: number | undefined): number {
  const raw = durationMs ?? DEFAULT_SILENCE_DURATION_MS;
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_SILENCE_DURATION_MS;
  }
  return Math.min(Math.floor(raw), MAX_SILENCE_DURATION_MS);
}

export function formatSilenceDurationLabel(durationMs: number): string {
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.round(totalMinutes / 60);
  return `${hours}h`;
}

/** D190 MR4 — human-readable audit line for room system rows. */
export function formatRoomSilenceSystemLine(event: RoomSilenceSystemEventPayload): string {
  if (event.kind === "silence_cleared") {
    return "Bots returned to the room";
  }
  const who = event.setByDisplayName.trim() || "Someone";
  const duration = event.durationLabel;
  const bot = event.botDisplayName?.trim();
  if (event.silenceKind === "deaf") {
    return bot
      ? `${who} put ${bot} out of the room for ${duration}`
      : `${who} put bots out of the room for ${duration}`;
  }
  return bot ? `${who} muted ${bot} for ${duration}` : `${who} muted bots for ${duration}`;
}

function pickDisplaySilenceRow(rows: SilenceRow[], now: Date): SilenceRow | null {
  const active = rows.filter((row) => now >= row.startedAt && now <= row.expiresAt);
  if (active.length === 0) return null;
  const roomWide = active.filter((row) => row.botActorId == null);
  const pool = roomWide.length > 0 ? roomWide : active;
  const deaf = pool.find((row) => row.kind === "deaf");
  if (deaf) return deaf;
  return pool.find((row) => row.kind === "mute") ?? null;
}

async function resolveUserDisplayName(
  db: RoomSilenceDb,
  userId: string,
): Promise<string> {
  const [row] = await db
    .select({ displayName: actors.displayName })
    .from(actors)
    .where(and(eq(actors.ownerId, userId), eq(actors.kind, "user")))
    .limit(1);
  return row?.displayName?.trim() || "Someone";
}

async function resolveActorDisplayName(db: RoomSilenceDb, actorId: string): Promise<string> {
  const [row] = await db
    .select({ displayName: actors.displayName })
    .from(actors)
    .where(eq(actors.id, actorId))
    .limit(1);
  return row?.displayName?.trim() || "Someone";
}

async function appendRoomSilenceSystemMessages(
  db: RoomSilenceDb,
  roomId: string,
  event: RoomSilenceSystemEventPayload,
): Promise<void> {
  const [roomRow] = await db
    .select({
      kind: rooms.kind,
      graphThreadId: rooms.graphThreadId,
    })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!roomRow || roomRow.kind === "subthread") {
    return;
  }

  const threadSeed =
    roomRow.graphThreadId?.trim().length > 0 ? roomRow.graphThreadId.trim() : `room:${roomId}`;
  const content = formatRoomSilenceSystemLine(event);
  const sidecarJson = JSON.stringify(event);

  const memberOwners = await db
    .select({ ownerId: actors.ownerId })
    .from(roomMembers)
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .where(and(eq(roomMembers.roomId, roomId), eq(actors.kind, "user"), isNotNull(actors.ownerId)));

  const ownerIds = [
    ...new Set(
      memberOwners
        .map((m) => m.ownerId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];

  for (const ownerUserId of ownerIds) {
    await db.transaction(async (tx) => {
      // M219 — each fan-out copy retains its existing independent failure
      // boundary, but its message id is allocated only after the Room lock.
      await acquireRoomWriteLock(tx, roomId);

      const existing = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.ownerId, ownerUserId),
            eq(sessions.roomId, roomId),
            sql`${sessions.threadId} NOT LIKE 'subagent:%'`,
          ),
        )
        .orderBy(desc(sessions.startedAt))
        .limit(1);

      let sessionId = existing[0]?.id;
      if (!sessionId) {
        const inserted = await tx
          .insert(sessions)
          .values({
            threadId: threadSeed,
            ownerId: ownerUserId,
            personaId: "owner",
            roomId,
          })
          .returning({ id: sessions.id });
        sessionId = inserted[0]?.id;
      }
      if (!sessionId) return;

      await tx.insert(sessionMessages).values({
        sessionId,
        role: "system",
        content,
        toolCalls: sidecarJson,
      });

      await tx
        .update(sessions)
        .set({
          messageCount: sql`${sessions.messageCount} + 1`,
          endedAt: new Date(),
        })
        .where(eq(sessions.id, sessionId));
    });
  }
}

/**
 * Lazy expiry — deletes past-window rows and emits one audit line when any
 * expired rows are removed. Idempotent: timer + lazy GET backstop share this
 * path; only the caller that actually deletes rows emits the audit line.
 */
export async function finalizeExpiredSilenceWindows(
  db: RoomSilenceDb,
  roomId: string,
  now: Date,
): Promise<boolean> {
  const deleted = await db
    .delete(roomSilenceState)
    .where(and(eq(roomSilenceState.roomId, roomId), lt(roomSilenceState.expiresAt, now)))
    .returning({ id: roomSilenceState.id });
  if (deleted.length === 0) {
    return false;
  }
  await appendRoomSilenceSystemMessages(db, roomId, {
    kind: "silence_cleared",
    reason: "expired",
  });
  return true;
}

/** Per-window expiry timers — cleared on server restart (lazy GET backstop). */
const expiryTimersByWindowId = new Map<string, ReturnType<typeof setTimeout>>();
const windowIdsByRoomId = new Map<string, Set<string>>();

export function cancelSilenceWindowExpiry(windowId: string): void {
  const timer = expiryTimersByWindowId.get(windowId);
  if (timer != null) {
    clearTimeout(timer);
    expiryTimersByWindowId.delete(windowId);
  }
  for (const [roomId, ids] of windowIdsByRoomId) {
    if (ids.delete(windowId) && ids.size === 0) {
      windowIdsByRoomId.delete(roomId);
    }
  }
}

export function cancelAllSilenceWindowExpiryForRoom(roomId: string): void {
  const ids = windowIdsByRoomId.get(roomId);
  if (!ids) return;
  for (const windowId of [...ids]) {
    cancelSilenceWindowExpiry(windowId);
  }
}

/**
 * D279 Phase 3.6 — schedule precise expiry for one silence window. Replaces
 * any prior timer for the same `windowId`. `onExpired` is wired by the server
 * (audit finalize + WS push); timers do not survive process restart.
 */
export function scheduleSilenceWindowExpiry(args: {
  roomId: string;
  windowId: string;
  expiresAt: Date;
  now: Date;
  onExpired: (roomId: string) => void | Promise<void>;
}): void {
  const { roomId, windowId, expiresAt, now, onExpired } = args;
  cancelSilenceWindowExpiry(windowId);

  let roomWindows = windowIdsByRoomId.get(roomId);
  if (!roomWindows) {
    roomWindows = new Set();
    windowIdsByRoomId.set(roomId, roomWindows);
  }
  roomWindows.add(windowId);

  const delayMs = Math.max(
    0,
    Math.min(expiresAt.getTime() - now.getTime(), MAX_SILENCE_DURATION_MS),
  );
  const timer = setTimeout(() => {
    cancelSilenceWindowExpiry(windowId);
    void onExpired(roomId);
  }, delayMs);
  expiryTimersByWindowId.set(windowId, timer);
}

export async function loadActiveRoomSilence(
  db: RoomSilenceDb,
  roomId: string,
  now: Date,
): Promise<ActiveRoomSilenceDto | null> {
  await finalizeExpiredSilenceWindows(db, roomId, now);

  const rows = await db
    .select({
      id: roomSilenceState.id,
      kind: roomSilenceState.kind,
      botActorId: roomSilenceState.botActorId,
      setByUserId: roomSilenceState.setByUserId,
      startedAt: roomSilenceState.startedAt,
      expiresAt: roomSilenceState.expiresAt,
    })
    .from(roomSilenceState)
    .where(eq(roomSilenceState.roomId, roomId));

  const display = pickDisplaySilenceRow(rows, now);
  if (!display) return null;

  const setByDisplayName = await resolveUserDisplayName(db, display.setByUserId);
  const botDisplayName =
    display.botActorId != null
      ? await resolveActorDisplayName(db, display.botActorId)
      : null;

  return {
    id: display.id,
    kind: display.kind,
    botActorId: display.botActorId,
    botDisplayName,
    setByDisplayName,
    expiresAt: display.expiresAt.toISOString(),
  };
}

export async function setRoomSilence(
  db: RoomSilenceDb,
  params: {
    roomId: string;
    setByUserId: string;
    kind: SilenceKind;
    botActorId?: string | null;
    durationMs?: number;
    now?: Date;
  },
): Promise<ActiveRoomSilenceDto> {
  const now = params.now ?? new Date();
  const durationMs = clampSilenceDurationMs(params.durationMs);
  const expiresAt = new Date(now.getTime() + durationMs);
  const setByDisplayName = await resolveUserDisplayName(db, params.setByUserId);
  const botDisplayName =
    params.botActorId != null
      ? await resolveActorDisplayName(db, params.botActorId)
      : null;

  const [inserted] = await db
    .insert(roomSilenceState)
    .values({
      roomId: params.roomId,
      botActorId: params.botActorId ?? null,
      kind: params.kind,
      setByUserId: params.setByUserId,
      startedAt: now,
      expiresAt,
    })
    .returning({
      id: roomSilenceState.id,
      kind: roomSilenceState.kind,
      botActorId: roomSilenceState.botActorId,
      expiresAt: roomSilenceState.expiresAt,
    });

  if (!inserted) {
    throw new Error("room_silence_insert_failed");
  }

  await appendRoomSilenceSystemMessages(db, params.roomId, {
    kind: "silence_set",
    silenceKind: params.kind,
    setByDisplayName,
    durationLabel: formatSilenceDurationLabel(durationMs),
    ...(botDisplayName ? { botDisplayName } : {}),
  });

  return {
    id: inserted.id,
    kind: inserted.kind,
    botActorId: inserted.botActorId,
    botDisplayName,
    setByDisplayName,
    expiresAt: inserted.expiresAt.toISOString(),
  };
}

export async function clearRoomSilence(
  db: RoomSilenceDb,
  params: {
    roomId: string;
    now?: Date;
  },
): Promise<{ cleared: number }> {
  const now = params.now ?? new Date();
  const active = await db
    .select({ id: roomSilenceState.id })
    .from(roomSilenceState)
    .where(
      and(
        eq(roomSilenceState.roomId, params.roomId),
        lte(roomSilenceState.startedAt, now),
        gte(roomSilenceState.expiresAt, now),
      ),
    );
  if (active.length === 0) {
    return { cleared: 0 };
  }

  await db
    .delete(roomSilenceState)
    .where(
      and(
        eq(roomSilenceState.roomId, params.roomId),
        lte(roomSilenceState.startedAt, now),
        gte(roomSilenceState.expiresAt, now),
      ),
    );

  await appendRoomSilenceSystemMessages(db, params.roomId, {
    kind: "silence_cleared",
    reason: "manual",
  });

  return { cleared: active.length };
}
