# Background authorization transport boundary

`@nautilo/lattice-bridge/client/background` exposes portable transport and
device responders. Current Stenographer work uses the processor variant of the
V2 background descriptor through `@nautilo/lattice-crypto/background`.

## V2 subjects and compatibility

The signed descriptor's `subject.kind` selects Agent or processor work. Existing
Agent V2 descriptors, grants and response signatures retain their exact byte
encoding. Stenographer uses `kind: "processor"`, with no Agent identity or Agent
authorization revision. Both variants use the V2 exact Namespace-bound input
bindings, output slots and recipient fields. The processor variant additionally
binds current admitted-device authority through its credential, and current
Domain keys and Namespace bundles through its descriptor. Agent-only consumers
explicitly reject processor descriptors; unknown subjects and versions never
fall back to another authorization path.

Processor credentials carry the current Domain key and a temporary output signer,
sealed to one request recipient. Their separate public signer certificate contains
no key custody and remains verifiable against retained issuance authority after
that attempt expires. This is a processor-specific V2 credential, not an Agent
AI-root grant with its fields repurposed. Confidential access and enforcement stay
inside Lattice; Stenographer does not select policy-specific data repositories.

The replaced, unshipped V3 experiment is not an accepted runtime protocol. Applied
migrations and experimental database rows are preserved; signed bytes are never
relabelled as V2. A QA database containing those experimental requests/results is
not evidence of a V2 end-to-end run. Existing V1 historical verification remains.

## Portable transport

The transport encodes compact UTF-8 JSON with version, request ID, recipient
generation and canonical unpadded base64url byte fields. Requests preserve
the descriptor bytes and hash. Fulfillments preserve response, credential and
ephemeral signer evidence; refusals carry a fixed reason code without a free
text message. Codecs check exact fields, byte bounds, hashes and duplicated
coordinates. Unknown versions, duplicate JSON fields, noncanonical encodings
and inconsistent coordinates fail with typed errors. This is structural
validation, not permission or signature verification.

The authenticated host must pass the received bytes directly into the
decoder. Parsing and reserializing JSON first would discard duplicate-field
evidence. The decoder's envelope bounds derive from existing inner wire
bounds, portable IDs, numeric widths and fixed JSON syntax. No body is
truncated to fit the transport.

The responder takes cryptography and current authority through injected
ports. Platform custody, networking, wakeups and application lifetime belong
to the host. The portable leaf must not import platform crypto defaults or
the broad package barrels. Tests inspect the runtime import graph before
tree shaking and separately qualify a browser bundle. Native Mobile and Mobile Web activation are separate work. Shared byte codecs
and injected custody keep this contract independent of Browser/Electron APIs;
this change does not implement or claim Mobile processor support.

## Offline recipient rotation

The existing request ledger keeps waiting work while an unused recipient
expires or is lost. Rotation advances the recipient generation and invalidates
old responses without spending an execution retry. Once execution begins,
failures consume the existing bounded retry budget; explicit provider failures
and publication reconciliation retries remain bounded as well. Repository CAS
checks preserve this history and reconstruct retry transitions through the
canonical lifecycle. The generated retry-constraint migration preserves
existing rows and allows a waiting reason with zero execution failures.

Older binaries reject that new valid zero-failure waiting state. A rollback
must account for such rows; do not erase waiting work or rewrite its history
to make an older parser accept it.
