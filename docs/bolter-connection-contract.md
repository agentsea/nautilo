# Bolter connection contract

Bolter uses one Desktop-managed foreground CLI receiver over Nautilo's existing
authenticated Relay Host. The Desktop must remain running and connected, whether
its server is local, on a LAN, or hosted. This contract describes source behavior;
availability requires matching server and Desktop releases.

## Interface and audience

Connections → Apps & accounts → Bolter owns authentication and connection
management. The receiving Desktop provisions the pinned CLI and isolates its
credentials by server, Human, and connection. The browser receives a validated
sign-in link and code, never provider credentials or a local filesystem path.

Creating a linked room selects an observed Bolter conversation, a Genie, and
explicit model sponsorship. It creates a fresh private room with an external
context restriction. Connecting does not expose another room's history or make
the room publicly discoverable. Room Members contains the link's management
controls. The room's privacy boundary and transcript survive disconnection.

External sender attribution is distinct from the sponsoring Human and from
execution authority. Incoming text is untrusted content. External turns use the
bound room's restricted context and cannot invoke general tools. Agent messages
must address the receiving identity to start work; self echoes and system
messages do not start work. Unknown destinations do not fall back to another room.

Genie publication uses the canonical final reply to the admitted external
message. Human sharing uses the separate Review & send composer, which displays
the exact destination and text before authorization. Ordinary local discussion,
tool output, and earlier private history are not automatically mirrored.

## Delivery and recovery

Electron durably seals each incoming batch before acknowledging the CLI helper.
The server admits messages only under the current connection, device generation,
room binding, namespace, and sponsoring Human. Provider message identity supports
deduplication; a redelivery flag is not required. CLI aliases are opaque identifiers
scoped to the provider connection, not globally unique Nautilo actor identifiers.

Starting a process reports Receiver running. Listening requires a recognized
provider packet to have reached durable storage. A blocked or failed queue drain
reports Delivery needs attention and retains the queued batch. These states do
not assert that every message has completed a Genie turn.

Only exact, currently authorized text is released for sending. Ambiguous provider
results remain uncertain and are not automatically retried. Check the external
conversation before deciding whether another message is appropriate. Pause and
disconnect prevent new dispatch admissions; they cannot recall text already
released to the provider. Disconnect does not delete the remote agent or chat.

Sign-in status refreshes while its operation is pending. Leaving and returning
to Connections may require Connect Bolter to recover a still-pending server
operation. If the server loses an unfinished sign-in operation, its old link must
be discarded and the user must explicitly reconnect. This does not silently adopt
credentials from an abandoned local connection directory. Completed connections
use their durable server identity and sealed Desktop recovery descriptor.

## Supported boundaries

The initial implementation selects pinned macOS ARM64 or x64 CLI artifacts and
text-only messages. The conversation picker lists main timelines; it does not
enumerate threads. The transport preserves exact thread bindings and receipts
when such a binding exists. Unknown event, sender, or media formats remain blocked
rather than interpreted as instructions or silently discarded.

Only the server's plaintext content mode is eligible. Protected-content modes
remain unavailable; connecting never changes that mode. Local credential homes
have private permissions, and the inbox/recovery descriptor require Electron OS
encryption. The packaged handover helper must pass the enclosing app seal and
same-Team signature checks. An ad-hoc packaged build cannot satisfy that boundary.

Native capture and handover reuse the Relay Host byte admission budget. Oversize
input is rejected, never acknowledged as a truncated success. The final encoded
Relay frame is checked separately. This is a local admission policy, not a claim
about Bolter's maximum supported message size.

## Backup and restore

Backups retain Bolter connection, binding, provenance, publication and execution
claim data. Development restore currently rejects both full archives and legacy
SQL snapshots containing any of these rows before changing the target. Empty
Bolter tables and older backups without them remain eligible for normal restore
checks. A paused or disconnected connection still has durable history, so it
does not remove this restriction. Keep the backup: restoring populated Bolter
authority needs explicit reconciliation to prevent duplicate delivery or reuse
of an execution claim. Restore does not silently discard receipts or clear
claims, and database backups do not replace Desktop credential custody.

## Ownership and verification

- `apps/desktop/electron/bolter-bridge`: provider parsing, isolated credentials,
  process lifecycle, signed helper handover, encrypted spool, and native authority.
- `packages/relay` and `packages/runtime/src/bolter-relay.ts`: authenticated
  transport, current-session correlation, durable acknowledgment, and send release.
- `packages/server/src/messaging/bolter-controller.ts`: Human-owned connection
  management, exact room routing, current policy, and canonical execution admission.
- `packages/db/src/queries/bolter-bridge.ts`: durable bindings and delivery state.
- `packages/server/src/messaging/bolter-publication.ts`: canonical reply loading
  and one-shot publication authorization.

Unit and application fixtures do not prove provider or installed behavior.
Installed acceptance must include the real sign-in UI, OS encryption, signed
helper, authenticated Relay, two isolated rooms, canonical Genie replies,
restart/replay, pause, and disconnection. See [Relay ownership](relay-host-ownership.md)
and [release procedures](../RELEASE.md) for the surrounding contracts.
