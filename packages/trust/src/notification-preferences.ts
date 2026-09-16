import {
  actors,
  and,
  eq,
  getSharedDirectDb,
  isNull,
  notInArray,
  roomMembers,
  roomNotificationSettings,
  rooms,
  userNotificationSettings,
  type DirectDatabase,
} from "@nautilo/db";
import type {
  NotificationLevel,
  NotificationPreferencesDto,
  RoomNotificationPreferenceDto,
} from "@nautilo/types";

export const DEFAULT_NOTIFICATION_LEVEL: NotificationLevel = "direct";

export type NotificationPreferenceErrorReason =
  | "not_found"
  | "invalid_room"
  | "subthread_not_allowed";

export class NotificationPreferenceError extends Error {
  constructor(readonly reason: NotificationPreferenceErrorReason) {
    super(`NotificationPreferenceError:${reason}`);
    this.name = "NotificationPreferenceError";
  }
}

export function isNotificationLevel(value: unknown): value is NotificationLevel {
  return value === "none" || value === "direct" || value === "all";
}

export function resolveEffectiveNotificationLevel(input: {
  defaultLevel: NotificationLevel | null | undefined;
  overrideLevel: NotificationLevel | null | undefined;
}): NotificationLevel {
  return input.overrideLevel ?? input.defaultLevel ?? DEFAULT_NOTIFICATION_LEVEL;
}

export async function getNotificationPreferences(
  userId: string,
  database: DirectDatabase = getSharedDirectDb(),
): Promise<NotificationPreferencesDto> {
  const [account] = await database
    .select({ defaultLevel: userNotificationSettings.defaultLevel })
    .from(userNotificationSettings)
    .where(eq(userNotificationSettings.userId, userId))
    .limit(1);

  const overrides = await database
    .selectDistinct({
      roomId: roomNotificationSettings.roomId,
      level: roomNotificationSettings.level,
    })
    .from(roomNotificationSettings)
    .innerJoin(rooms, eq(roomNotificationSettings.roomId, rooms.id))
    .innerJoin(roomMembers, eq(roomNotificationSettings.roomId, roomMembers.roomId))
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .where(
      and(
        eq(roomNotificationSettings.userId, userId),
        eq(actors.kind, "user"),
        eq(actors.ownerId, userId),
        isNull(rooms.parentRoomId),
        isNull(rooms.archivedAt),
        notInArray(rooms.kind, ["task", "access", "subthread"]),
      ),
    );

  return {
    defaultLevel: account?.defaultLevel ?? DEFAULT_NOTIFICATION_LEVEL,
    roomOverrides: overrides,
  };
}

export async function setDefaultNotificationLevel(
  userId: string,
  defaultLevel: NotificationLevel,
  database: DirectDatabase = getSharedDirectDb(),
): Promise<NotificationPreferencesDto> {
  await database
    .insert(userNotificationSettings)
    .values({ userId, defaultLevel, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userNotificationSettings.userId,
      set: { defaultLevel, updatedAt: new Date() },
    });
  return getNotificationPreferences(userId, database);
}

async function requireTopLevelNotificationRoom(
  userId: string,
  roomId: string,
  database: DirectDatabase,
): Promise<void> {
  const [room] = await database
    .select({
      kind: rooms.kind,
      parentRoomId: rooms.parentRoomId,
      archivedAt: rooms.archivedAt,
    })
    .from(rooms)
    .innerJoin(roomMembers, eq(rooms.id, roomMembers.roomId))
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .where(
      and(
        eq(rooms.id, roomId),
        eq(actors.kind, "user"),
        eq(actors.ownerId, userId),
      ),
    )
    .limit(1);

  if (!room) throw new NotificationPreferenceError("not_found");
  if (room.kind === "subthread" || room.parentRoomId !== null) {
    throw new NotificationPreferenceError("subthread_not_allowed");
  }
  if (
    room.archivedAt !== null ||
    room.kind === "task" ||
    room.kind === "access"
  ) {
    throw new NotificationPreferenceError("invalid_room");
  }
}

export async function setRoomNotificationPreference(
  input: {
    userId: string;
    roomId: string;
    level: "inherit" | NotificationLevel;
  },
  database: DirectDatabase = getSharedDirectDb(),
): Promise<RoomNotificationPreferenceDto> {
  await requireTopLevelNotificationRoom(
    input.userId,
    input.roomId,
    database,
  );

  if (input.level === "inherit") {
    await database
      .delete(roomNotificationSettings)
      .where(
        and(
          eq(roomNotificationSettings.userId, input.userId),
          eq(roomNotificationSettings.roomId, input.roomId),
        ),
      );
  } else {
    const updatedAt = new Date();
    await database
      .insert(roomNotificationSettings)
      .values({
        userId: input.userId,
        roomId: input.roomId,
        level: input.level,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          roomNotificationSettings.userId,
          roomNotificationSettings.roomId,
        ],
        set: { level: input.level, updatedAt },
      });
  }

  const [account] = await database
    .select({ defaultLevel: userNotificationSettings.defaultLevel })
    .from(userNotificationSettings)
    .where(eq(userNotificationSettings.userId, input.userId))
    .limit(1);
  const overrideLevel = input.level === "inherit" ? null : input.level;

  return {
    roomId: input.roomId,
    effectiveLevel: resolveEffectiveNotificationLevel({
      defaultLevel: account?.defaultLevel,
      overrideLevel,
    }),
    inherited: overrideLevel === null,
    overrideLevel,
  };
}
