# Bolter connection contract

Bolter uses one Desktop-managed foreground CLI receiver over Nautilo's existing
authenticated Relay Host. The Desktop must remain running and connected, whether
its server is local, on a LAN, or hosted. This contract describes source behavior;
availability requires matching server and Desktop releases.

## Interface and audience

Connections → Apps & accounts → Bolter owns authentication and connection
management. The receiving Desktop acquires the latest provider CLI and isolates its
credentials by server, Human, and connection. The browser receives a validated
sign-in link and code, never provider credentials or a local filesystem path.

Creating a linked room selects an observed Bolter conversation, a Genie, and
explicit model sponsorship. It creates a fresh room classified as External, with
restricted membership and a permanent external context restriction. Connecting does not expose another room's history or make
the room publicly discoverable. Room Members contains the link's management
controls. The room's privacy boundary and transcript survive disconnection.
Linked rooms appear as normal room entries in Groups. Their External classification
is read-only: Genies can use only this room's context, and the room cannot be
switched to Private or Public. This classification does not grant public-by-ID
access or self-join permission.

External sender attribution is distinct from the sponsoring Human and from
execution authority. Incoming text is untrusted content. External turns use the
bound room's restricted context and cannot invoke general tools. Agent messages
must address the receiving identity to start work; self echoes and system
messages do not start work. Unknown destinations do not fall back to another room.

Genie publication uses the canonical final reply to the admitted external
message. Human sharing uses a separate foldaway composer that keeps the destination
and posting identity visible. Review before sending is enabled by default and
remembered per Human and connection. Turning it off skips the final preview; it
does not change authorization or the private context boundary. Review is a Human
confirmation, not sensitive-data scanning or redaction. Ordinary local discussion,
tool output, and earlier private history are not automatically mirrored.

Files selected through this composer have their own queue. Paperclip, file drop,
and clipboard files use the existing Room-scoped upload capability and file chips.
Uploads remain private to Nautilo until the Human sends. Text, images, audio, PDF,
and validated Office documents use the existing file admission policies. Document
sharing stores inert bytes; it does not enable document extraction in the ordinary
message upload path. The share fingerprint covers file order, names, MIME types,
byte counts, and checksums. Acceptance retains the selected blobs in the same
transaction as the canonical Human message and outbox.

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
Creating the linked room refreshes the Human's live room subscriptions and
catalogue before the receiver starts, so the open Desktop can receive its first
message and completion updates without reconnecting.

Only exact, currently authorized text and explicitly selected files are released
for sending. File uploads use the connected chat's Bolter file area, without public
access grants. Storage filenames use compatible ASCII names; Nautilo and the
outgoing link labels retain the original filenames. The provider's returned URLs
become links in one outgoing message.
Each upload and the final message revalidate the same immutable publication claim;
connection retirement prevents subsequent native dispatch. A failed partial upload
may leave files in Bolter without a posted message. Ambiguous provider
results remain uncertain and are not automatically retried. Check the external
conversation before deciding whether another message is appropriate. Pause and
disconnect prevent new dispatch admissions; they cannot recall content already
released to the provider. Disconnect does not delete the remote agent or chat.
Removing a Nautilo attachment does not delete a copy already stored in Bolter.
Delivery settlement invalidates the owner-scoped UI state. The composer checks its
exact outbox or request identity automatically and never clears a newer draft when
an earlier receipt arrives. Unknown HTTP outcomes retain the same request for
explicit recovery; they do not create a replacement send.
Status reads select the current receipt rather than transferring delivery history;
connection counters aggregate only pending and uncertain outbox states.

Sign-in status refreshes while its operation is pending. Leaving and returning
to Connections may require Connect Bolter to recover a still-pending server
operation. If the server loses an unfinished sign-in operation, its old link must
be discarded and the user must explicitly reconnect. This does not silently adopt
credentials from an abandoned local connection directory. Completed connections
use their durable server identity and sealed Desktop recovery descriptor.

## Supported boundaries

The implementation selects the latest macOS ARM64 or x64 CLI through Bolter's
fixed HTTPS download endpoint. Incoming messages remain text-only. Outgoing file
sharing requires negotiated Relay protocol v31 and the Desktop's file-sharing
observation. Older peers retain text sharing and do not advertise attachment
support. The endpoint must
resolve to an exact version on Bolter's CDN. Acquired bytes have a private local
size/hash receipt and their architecture and reported version are verified before
activation. Acquisition trusts Bolter's HTTPS endpoints; a local receipt detects
later changes but is not an independent provider signature or release approval.
Connecting or restarting a stopped receiver checks the latest release. A CLI or
receiver failure checks for a newer build and retries a safe operation once only
when the version changed. A failed recovery stops rather than looping. A released
send with an uncertain outcome is never replayed; an update repairs future work.
Updates retain the same credential home, sealed identity and pending inbox batches,
and retire the old receiver before another process can use that home.
Pause and disconnection cancel their pending acquisition without interrupting a
shared download still needed by another current connection.
Response parsers accept additive metadata while validating the fields used for
identity, routing, text and receipts. Unsupported incoming media remains unavailable. The conversation picker lists main timelines; it does not
enumerate threads. The transport preserves exact thread bindings and receipts
when such a binding exists. Unknown provider events, including `profile_requested`,
are ignored and logged locally by event kind without their text or payload. They
do not reach a Genie or block later queued messages, and do not establish Listening
on their own. Profile requests currently receive no response. Malformed recognized
events and unqualified message, sender, or media formats remain blocked.

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
- `packages/server/src/messaging/bolter-publication.ts`: canonical reply loading,
  one-shot content release and immutable claim revalidation during file sharing.

Unit and application fixtures do not prove provider or installed behavior.
Installed acceptance must include the real sign-in UI, OS encryption, signed
helper, authenticated Relay, two isolated rooms, canonical Genie replies,
restart/replay, pause, and disconnection. See [Relay ownership](relay-host-ownership.md)
and [release procedures](../RELEASE.md) for the surrounding contracts.
