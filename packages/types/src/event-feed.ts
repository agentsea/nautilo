import { z } from "zod";

const uuidReferenceSchema = z.string().uuid().transform((value) => value.toLowerCase());
const artifactReferenceSchema = z.string().min(1);
const isoTimestampSchema = z.string().datetime({ offset: true });

/** Personal attention only: never changes event retention or read state. */
export const eventFeedPreferenceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("active") }).strict(),
  z.object({ mode: z.literal("quiet") }).strict(),
  z.object({ mode: z.literal("snoozed"), until: isoTimestampSchema.refine(value => Number.isFinite(Date.parse(value))) }).strict(),
]);
export type EventFeedPreference = z.infer<typeof eventFeedPreferenceSchema>;

export function isEventFeedQuiet(preference: EventFeedPreference, now = Date.now()): boolean {
  return preference.mode === "quiet"
    || (preference.mode === "snoozed" && Date.parse(preference.until) > now);
}

export const eventFeedTypeSchema = z.enum([
  "room.member_joined",
  "room.member_left",
  "artifact.added",
  "artifact.shared",
  "moderation.action",
]);

export type EventFeedType = z.infer<typeof eventFeedTypeSchema>;

/** One traversal batch; continuation remains available until history is exhausted. */
export const EVENT_FEED_PAGE_SIZE = 50;

export const eventFeedActorKindSchema = z.enum(["human", "agent"]);
export type EventFeedActorKind = z.infer<typeof eventFeedActorKindSchema>;

export const eventFeedDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("room"), roomId: uuidReferenceSchema }).strict(),
  z.object({ kind: z.literal("person"), userId: uuidReferenceSchema }).strict(),
]);
export type EventFeedDestination = z.infer<typeof eventFeedDestinationSchema>;

const memberJoinedDataSchema = z
  .object({ roomId: uuidReferenceSchema, userId: uuidReferenceSchema })
  .strict();
const memberLeftDataSchema = z
  .object({ roomId: uuidReferenceSchema, userId: uuidReferenceSchema })
  .strict();
const artifactAddedDataSchema = z
  .object({ artifactId: artifactReferenceSchema, roomId: uuidReferenceSchema })
  .strict();
const artifactSharedDataSchema = z
  .object({
    artifactId: artifactReferenceSchema,
    destination: eventFeedDestinationSchema,
  })
  .strict();

const moderationActionDataSchema = z.object({
  operationId: uuidReferenceSchema,
  userId: uuidReferenceSchema.nullable(),
  action: z.enum(["ban", "kick", "lift"]),
}).strict();

export const eventFeedRecordInputSchema = z.discriminatedUnion("type", [
  z.object({
    key: z.string().min(1), type: z.literal("moderation.action"),
    actorKind: z.literal("human"), actorId: uuidReferenceSchema,
    recipientUserIds: z.array(uuidReferenceSchema), data: moderationActionDataSchema,
  }).strict(),
  z
    .object({
      key: z.string().min(1),
      type: z.literal("room.member_joined"),
      actorKind: eventFeedActorKindSchema,
      actorId: uuidReferenceSchema,
      recipientUserIds: z.array(uuidReferenceSchema),
      data: memberJoinedDataSchema,
    })
    .strict(),
  z
    .object({
      key: z.string().min(1),
      type: z.literal("room.member_left"),
      actorKind: eventFeedActorKindSchema,
      actorId: uuidReferenceSchema,
      recipientUserIds: z.array(uuidReferenceSchema),
      data: memberLeftDataSchema,
    })
    .strict(),
  z
    .object({
      key: z.string().min(1),
      type: z.literal("artifact.added"),
      actorKind: eventFeedActorKindSchema,
      actorId: uuidReferenceSchema,
      recipientUserIds: z.array(uuidReferenceSchema),
      data: artifactAddedDataSchema,
    })
    .strict(),
  z
    .object({
      key: z.string().min(1),
      type: z.literal("artifact.shared"),
      actorKind: eventFeedActorKindSchema,
      actorId: uuidReferenceSchema,
      recipientUserIds: z.array(uuidReferenceSchema),
      data: artifactSharedDataSchema,
    })
    .strict(),
]);

export type EventFeedRecordInput = z.infer<typeof eventFeedRecordInputSchema>;

const eventItemFields = {
  id: uuidReferenceSchema,
  actorKind: eventFeedActorKindSchema,
  actorId: uuidReferenceSchema.nullable(),
  /** Current authorized presentation only; never persisted in feed payloads. */
  actorDisplayName: z.string().nullable().optional(),
  createdAt: isoTimestampSchema,
  readAt: isoTimestampSchema.nullable(),
};

const knownEventFeedItemSchema = z.discriminatedUnion("type", [
  z.object({ ...eventItemFields, type: z.literal("moderation.action"), data: moderationActionDataSchema }).strict(),
  z.object({ ...eventItemFields, type: z.literal("room.member_joined"), data: memberJoinedDataSchema }).strict(),
  z.object({ ...eventItemFields, type: z.literal("room.member_left"), data: memberLeftDataSchema }).strict(),
  z.object({ ...eventItemFields, type: z.literal("artifact.added"), data: artifactAddedDataSchema }).strict(),
  z.object({ ...eventItemFields, type: z.literal("artifact.shared"), data: artifactSharedDataSchema }).strict(),
]);

const unsupportedEventFeedTypeSchema = z.string().min(1).refine(
  (type) => !eventFeedTypeSchema.safeParse(type).success,
  { message: "Known event types must satisfy their typed payload contract" },
);

/**
 * Read-only compatibility projection for event kinds introduced by a newer
 * server. It deliberately drops the original kind, payload, and attribution.
 */
export const unknownEventFeedItemSchema = z
  .object({
    id: uuidReferenceSchema,
    type: unsupportedEventFeedTypeSchema,
    createdAt: isoTimestampSchema,
    readAt: isoTimestampSchema.nullable(),
  })
  .passthrough()
  .transform(({ id, createdAt, readAt }) => ({
    id,
    type: "unknown" as const,
    actorKind: null,
    actorId: null,
    data: {},
    createdAt,
    readAt,
  }));

export const eventFeedItemSchema = z.union([
  knownEventFeedItemSchema,
  unknownEventFeedItemSchema,
]);

export type EventFeedItem = z.infer<typeof eventFeedItemSchema>;

export const eventFeedListOptionsSchema = z
  .object({
    cursor: z.string().min(1).optional(),
    unreadOnly: z.boolean().optional(),
    types: z.array(eventFeedTypeSchema).nonempty().optional(),
    limit: z.number().int().positive().max(EVENT_FEED_PAGE_SIZE).optional(),
  })
  .strict();

export type EventFeedListOptions = z.infer<typeof eventFeedListOptionsSchema>;

export const eventFeedPageSchema = z
  .object({
    events: z.array(eventFeedItemSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();
export type EventFeedPage = z.infer<typeof eventFeedPageSchema>;

export const eventFeedUnreadCountSchema = z
  .object({ unreadCount: z.number().int().nonnegative() })
  .strict();
export type EventFeedUnreadCount = z.infer<typeof eventFeedUnreadCountSchema>;

export const eventFeedSetReadRequestSchema = z.object({ read: z.boolean() }).strict();
export type EventFeedSetReadRequest = z.infer<typeof eventFeedSetReadRequestSchema>;

export const eventFeedReadMutationResultSchema = z
  .object({
    eventId: uuidReferenceSchema,
    readAt: isoTimestampSchema.nullable(),
    changed: z.boolean(),
  })
  .strict();
export type EventFeedReadMutationResult = z.infer<typeof eventFeedReadMutationResultSchema>;

export const eventFeedMarkAllReadResultSchema = z
  .object({ updatedCount: z.number().int().nonnegative() })
  .strict();
export type EventFeedMarkAllReadResult = z.infer<typeof eventFeedMarkAllReadResultSchema>;

export const eventFeedErrorCodeSchema = z.enum([
  "invalid_cursor",
  "invalid_input",
  "not_found",
]);
export type EventFeedErrorCode = z.infer<typeof eventFeedErrorCodeSchema>;

export class EventFeedQueryError extends Error {
  readonly code: EventFeedErrorCode;

  constructor(code: EventFeedErrorCode) {
    super(code);
    this.name = "EventFeedQueryError";
    this.code = code;
  }
}

export const eventFeedErrorResponseSchema = z
  .object({ error: z.literal("event_feed_error"), code: eventFeedErrorCodeSchema })
  .strict();
export type EventFeedErrorResponse = z.infer<typeof eventFeedErrorResponseSchema>;
