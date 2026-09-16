# Encryption data-operation ownership

Supported product operations delegate representation decisions to
`packages/lattice-bridge/src/transition/encryption-data-operation-owner.ts`.
The owner receives a live policy binding and lazy entity operations. It does
not own keys, storage, authorization, or a second persistence protocol.

| Mode | Consumption | Publication and repair |
| --- | --- | --- |
| Plain | Ordinary only; no custody prerequisite | Ordinary; no crypto repair |
| Fallback Shadow | Protected first; only typed availability/key waiting permits ordinary fallback | Dual publication; existing authorized forward/reverse repair |
| Strict Shadow | Verified protected content; no ordinary consumption fallback | Dual publication; existing authorized forward/reverse repair |
| Full | Protected only; no ordinary body loader | Protected only; no ordinary-source or reverse repair |

Integrity, authority, stale identity, cancellation, and unknown errors do not
permit fallback. Entity adapters retain exact revision checks and atomic server
publication fences. A successful prepare followed by an ambiguous publication
failure must not be retried as an ordinary write.

## Production seams

- Workbench binds current admission generation in
  `apps/workbench/src/lib/encryption-data-operation-policy.ts`. Main and child
  Rooms use `room-message-operations.ts`; Memory UI uses
  `memory-read-operations.ts`. UI callers supply product intent, not mode flags.
- `room-history-data-adapter.ts` owns the existing device read/acknowledgement
  transport. `room-history-row-access.ts` binds exact selected revisions to
  authenticated outcomes independently, so one waiting row does not discard
  unrelated verified rows. Failed integrity results never become ordinary
  fallback projections.
- Human Memory delegates through `authorized-human-memory-client.ts`; Agent
  Memory through `active-memory-composition.ts`. These retain the existing
  signed intents, retry journal, receipts, access checks, and repair ports.
- Runtime binds current server policy in `live-shadow-turn-context.ts`, and
  checks it against the admitted policy before body access. History, Journal,
  Memory, Record selection, streaming, and publication delegate actual lazy
  operations. Conductor's actual ordinary/protected routing callbacks use the
  same owner in `packages/server/src/messaging/dispatch.ts`.
- Legacy ordinary Message edits still enforce current server publication
  policy and canonical revision/mapping mutation. A direct client cannot
  bypass Full by calling the older endpoint.

## Embedding provider compatibility

Ordinary Memory, protected Human/Agent Memory, and Reflection accept OpenAI,
OpenRouter, and Venice embedding provenance. The qualified Venice route is
`venice:text-embedding-3-small` with 1,536 dimensions. BGE-M3 is not a compatible
replacement for the existing vector storage.

Server → Models owns the optional database-backed embedding selection. A saved
qualified model overrides operator runtime configuration. A saved empty string
means Automatic; null means inherit the operator configuration. Unqualified or
empty runtime defaults choose Venice, then OpenRouter, then OpenAI by credential
presence. This order applies to existing installations too. Qualified provider
choices remain pinned and provider errors never trigger cross-provider failover.
The selector exposes the qualified 1,536-dimensional routes and their credential
availability, plus the effective selection; credential presence is not a live
provider-health or credit check. Explicitly changing the model does not rebuild
existing embeddings.
The effective-model display uses the same process snapshot as embedding requests.
If a saved selection has not reached that snapshot, the UI reports it as pending;
reloading the settings retries reconciliation. Missing credentials leave a pinned
choice unavailable without preventing unrelated settings changes.

The approved provider and model remain bound to the signed request. Changing
either after preparation requires a new request. Searches compare only matching
provider/model/dimension/contract provenance; existing OpenAI/OpenRouter vectors
must not be relabelled as Venice vectors. Changing the configured route does not
automatically make old projections compatible or trigger a corpus rebuild.

Venice extends the accepted provider text in existing wire formats; it does not
change field order, signature bytes for existing providers, or vector dimensions.
The database migration widens the provider constraint without rewriting rows.
Older clients reject Venice in processor metadata and signed requests, so update
clients along with the server before using Venice for protected Human Memory.
After Venice provenance is persisted, rolling back to a server that rejects it
leaves those rows unsupported; restore compatible code before consuming them.

Memory/query plaintext reaches the configured embedding provider through the
existing authorized transient disclosure boundary. Adding Venice does not change
that disclosure or make the stored search vectors encrypted.

## Deliberately retained policy observations

These are not alternative confidential-data selection algorithms:

- Main Workbench Runtime observes policy to assemble Browser/Desktop custody,
  expose admission/access presentation, and preserve the existing conversation
  cache policy. It does not call raw Room send/history APIs for product work.
- Runtime session representation and durable Job input-reference framing must
  match the admitted wire protocol. Current-policy checks still fence access.
- Server publication authority and database fences independently reject stale
  or forbidden publication plans; a client-side owner is not authorization.
- Enrollment, admission, mode labels, and administrator mode controls still
  describe policy. They do not consume confidential bodies.

The bounded source guard in
`packages/encryption-invariants/src/node/data-operation-localization.ts` names
migrated consumers and exact trusted seams. Its unit tests run in the normal
unit lane and encryption decision-coverage lane; they are paired with behavior
tests at the operation factories. This is not a replacement for reviewing new
consumer call sites.

This consolidation does not activate unsupported encrypted families or new
execution authority. In particular, Full around-message history and protected
heterogeneous Record evidence expansion retain explicit unsupported gates.
