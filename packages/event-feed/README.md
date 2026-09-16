# Personal event feed

This package records passive, persistent events for an explicit set of Human
recipients. It does not deliver native notifications, resolve Room membership,
or change resource access. The server composes it with the database-owned
`createEventFeedStorage` adapter and a user-private WebSocket hint.

Call `recordBestEffort` only after the business operation commits successfully.
Supply the true initiating Actor, a stable occurrence key, a supported event
payload containing references only, and recipient user IDs. An accepted record
and all its recipients commit atomically in a separate transaction. Repeating
an occurrence neither changes its audience nor resets read state. Reusing a key
with different event facts fails safely. A later real occurrence needs a new key.
Validation, recording, logging and hint failures cannot change business success;
a crash before recording may lose the event. There is no retry queue or backfill.

The read API lives under `/api/event-feed`:

- `GET /api/event-feed`: cursor pages; optional `unreadOnly`, repeated `types`,
  and `limit` (1–50). `nextCursor` exposes continuation; this is not a history cap.
- `GET /api/event-feed/unread-count`: the caller's durable unread count.
- `PUT /api/event-feed/:eventId/read`: `{ "read": true }` or `{ "read": false }`.
- `POST /api/event-feed/mark-all-read`: all caller-owned unread rows visible to
  one update statement, across types; later commits remain unread.

Authentication supplies the Human identity. No route accepts a selectable owner
or exposes generic event publication. The adapter uses a transaction-local `nautilo_feed_reader` role for read paths,
with forced row-level policies on both feed tables. This is a non-login role
without BYPASSRLS; it shares the existing pool and has no credential. Canonical
Compose/hosted admin bootstrap provisions it before application migrations.
The Agent and crypto roles cannot assume it and have no table privileges. The trusted
recording adapter enables its writer context only within its owned transaction.
Resource IDs in events are references, never access grants. Readers must resolve
names and navigation through current authorized resource paths and use safe
placeholders after access loss. Unknown future event types project to content-free
entries; malformed known types fail validation.

Read state changes only through explicit read operations. `event_feed.changed`
is a content-free, best-effort invalidation delivered to the Human's sessions;
the database remains authoritative when a hint is missed. No UI or business
producers are installed by this foundation package.
