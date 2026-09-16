import { eq } from "drizzle-orm";
import { eventFeedPreferenceSchema, EventFeedQueryError, type EventFeedPreference } from "@nautilo/types";
import type { DirectDatabase } from "../config/direct-database";
import { userNotificationSettings } from "../schema/notification-intelligence";

/** Caller identity is supplied by the authenticated route, never by its body. */
export function createEventFeedPreferenceStore(database: DirectDatabase) {
  return {
    async get(userId: string): Promise<EventFeedPreference> {
      const [row] = await database.select({
        mode: userNotificationSettings.eventFeedQuietMode,
        until: userNotificationSettings.eventFeedQuietUntil,
      }).from(userNotificationSettings).where(eq(userNotificationSettings.userId, userId));
      if (!row) return { mode: "active" };
      return eventFeedPreferenceSchema.parse({
        mode: row.mode,
        ...(row.mode === "snoozed" ? { until: row.until?.toISOString() } : {}),
      });
    },
    async set(userId: string, input: EventFeedPreference): Promise<EventFeedPreference> {
      const parsed = eventFeedPreferenceSchema.safeParse(input);
      if (!parsed.success || (parsed.data.mode === "snoozed" && Date.parse(parsed.data.until) <= Date.now())) {
        throw new EventFeedQueryError("invalid_input");
      }
      const preference = parsed.data;
      const fields = {
        eventFeedQuietMode: preference.mode,
        eventFeedQuietUntil: preference.mode === "snoozed" ? new Date(preference.until) : null,
        updatedAt: new Date(),
      };
      // Update only Events columns. Concurrent chat-policy changes are preserved.
      await database.insert(userNotificationSettings).values({ userId, ...fields })
        .onConflictDoUpdate({ target: userNotificationSettings.userId, set: fields });
      return preference;
    },
  };
}
