# Group room member presence

## Product contract

A Room member can see Online, Idle, or Offline beside each Human in the existing group conversation roster on a Nautilo instance served by one server process. Workbench and Desktop share the same implementation; Mobile uses the same server snapshot. Availability describes the Human's connection to that server, not whether they are reading this particular Room.

The existing surfaces are Workbench's full Members panel, compact avatar rail, management dialog, and Mobile's member sheet. Human rows have a dot and status label beside their names; compact avatars expose the name and status accessibly. Existing member order, roles, entry points, and Agent controls remain intact.

## Status rules

- **Online:** at least one fresh authenticated Human chat socket does not report idle.
- **Idle:** one or more Human chat sockets are fresh, and all report idle.
- **Offline:** no fresh Human chat socket remains. A fresh connection on a second device prevents a false Offline when the first closes.
- **Unavailable:** initial, failed, denied, or unsupported reads show a neutral dash with the accessible label “Status unavailable.” They never assert Offline.

Relay connections and running Genie work do not establish Human presence. Idle means inactivity inside Nautilo. No OS-wide activity monitoring, input contents, coordinates, or client-supplied Human identity are transmitted.

A client reports idle after five minutes without app input. It includes an optional boolean `idle` on the existing 15-second ping. The server seeds freshness on authenticated admission, records ping receipt time, and ignores sockets that are closed or have missed five intervals (75 seconds). Older clients without the flag count as active while their socket remains fresh.

Visible rosters refresh immediately on activation and 15 seconds after each completed read, only while the viewer's app is active. Normal status propagation is about 30 seconds plus request latency; an unclean network loss takes about 90 seconds plus request latency. Explicit disconnect is reflected on the next read. Mobile backgrounding and browser tab suspension retain their existing socket lifecycle.

## Implementation owners

| Concern | Owner |
| --- | --- |
| Local timestamp and optional idle ping | `packages/realtime-client/src/human-activity.ts`, `packages/realtime-client/src/ws-client.ts` |
| Workbench input observation | `apps/workbench/src/adapters/human-activity.ts`, `nautilo-runtime.tsx` |
| Mobile touch/composer activity and socket lifecycle | `apps/mobile/src/lib/human-activity.ts`, `src/providers/realtime.tsx`, root layout and room composer |
| Authenticated socket map and freshness aggregation | `packages/server/src/realtime/ws-publisher.ts`, `packages/server/src/routes/ws.ts` |
| Current Room membership and batched read | `packages/server/src/routes/rooms.ts`, canonical `getRoomDetailForMember` |
| Typed read and cancellable refresh | `packages/api-client/src/client.ts`, `packages/api-client/src/room-presence.ts` |
| Workbench roster | `apps/workbench/src/modes/rooms/shape/use-room-presence.ts`, `MembersManagerPanel.tsx`, `AgentCard.tsx`, `MemberFocusAvatar.tsx`, `MembersPanel.tsx` |
| Mobile roster | `apps/mobile/src/hooks/use-room-presence.ts`, `apps/mobile/src/components/members-sheet.tsx` |

`GET /api/rooms/:id/presence` returns `{ members: [{ actorId, status }] }` for current Human members only. The route requires ordinary Room membership on every read; it does not require management permission. It returns no device identifiers or activity timestamps and uses `Cache-Control: no-store`.

One batch read serves a roster. Closing, hiding, or changing Room/account/server cancels and invalidates old reads. A failed refresh clears previously displayed statuses. Later replies from an old scope cannot overwrite the new scope. Older servers returning 404 show unavailable.

`users.last_seen_at` and the legacy per-user last-seen route remain historical HTTP activity. Background polling can update that field, so it must not classify Online, Idle, or Offline.

## Verification contract

Focused tests cover clock boundaries, multiple devices, authenticated identity binding, member authorization/removal, roster filtering, old-client pings, unsupported/malformed API reads, abort/disposal, visibility and identity changes, and all four display states. The real WebSocket handler and Room read are exercised together with synthetic authenticated Humans. UI tests cover the existing roster entry points and accessible compact status.

Live acceptance additionally checks two Humans through the actual browser/Desktop roster and native Mobile sheet: Online → Idle → Online → Offline, second-device aggregation, background/resume, removal and failed reads. Native touch/gesture behavior and visual layout require platform acceptance; unit tests alone do not establish that qualification.

## Scope boundary and rollback

No schema/migration, new package/service, Redis, distributed presence, separate heartbeat transport, event replay, history/last-seen UI, invisible/DND settings, notifications, status sorting, or new directory surface. Multiple server processes and federation are outside this contract. Direct-message header indicators, native store publication, and server deployment are separate work.

Rollback is code-only: no durable presence state or data migration needs reversal. New clients against an older server show unavailable; older clients against the new server remain Online while connected and fresh.
