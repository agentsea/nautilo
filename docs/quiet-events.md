# Quiet events

## Approved behavior

Quiet events is a personal preference on the current server. In the Events
header, choose one hour, tomorrow at 09:00 in the current device's timezone,
a custom future local time, or until manually resumed. The client sends an
absolute timestamp so other devices agree on the same end instant.

While quiet, the Events bell becomes a crossed-out bell and its numbered badge disappears
entirely. It remains clickable. The open Events panel shows the quiet status
and a Resume action. History, unread markers inside the feed, category filters,
and read/unread actions remain available. Resuming restores the unread bell
count without replaying old alerts or marking anything read.

This control affects only Events. Chat notifications, approvals, other Humans,
and accounts on other servers are independent. Current Events delivery is a
durable feed plus a bell count; it has no native toast/push delivery to suppress.
Native Mobile currently has no Events feed surface. Any future Events alert
delivery must consult this preference before alerting.

## Ownership and persistence

- `packages/types/src/event-feed.ts`: strict active/quiet/snoozed contract and
  deadline interpretation. Expiry is derived from the absolute timestamp;
  there is no cleanup job or backlog replay.
- `packages/db/src/schema/notification-intelligence.ts`: two additive columns
  on the existing Human notification-settings row. Existing accounts remain
  active. Quiet updates preserve chat settings and all feed facts/read state.
- `packages/db/src/queries/event-feed-preferences.ts`: typed, user-keyed reads
  and upserts. The generated migration adds columns and a consistency check.
- `packages/server/src/routes/event-feed-preferences.ts`: authenticated
  GET/PUT `/api/event-feed/preference`; identity comes exclusively from the
  session. Reject unknown fields and past or invalid snooze timestamps.
- `apps/workbench/src/event-feed/event-feed-context.tsx`: one scoped provider
  serializes preference reads/writes with feed reconciliation. Existing
  user-targeted `event_feed.changed` invalidation, reconnect, focus, visibility,
  credential refresh and visible-session refresh synchronize sessions.

## Recovery and verification

Do not show a numbered badge before the preference is known. Retain the last
confirmed preference on a read failure, and show a recoverable preference error
without hiding feed history. A failed save is never presented as success; read
back the current preference after an uncertain response. Disconnect disables
editing. Scope remounts fence responses from the previous authenticated viewer.
Timed snoozes expire locally, including after sleep, without mutating storage.

The menu supports keyboard navigation through native controls, Escape, outside
click, focus return, custom-time validation, pending saves and narrow screens.
Test ownership, validation, cross-session invalidation, independent chat policy,
expiry, failed saves, viewer changes, history retention and complete badge
suppression. Apply migrations only through the normal release path; no live
database changes are required to develop the feature. Rolling back application
code can leave the additive columns in place; older clients ignore quiet mode.
