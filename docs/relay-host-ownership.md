# Relay host ownership map

This document describes the shared Relay library, Desktop-managed Relay Host,
and Electron execution authority. The Host is a private child process, not a
generic plugin service.

## Decision

Nautilo now has three deliberately different Relay boundaries:

- `@nautilo/relay` is the Electron-independent protocol/client library.
- `nautilo-relay-host` is the private Electron-free child that constructs
  `RelayClient` for Desktop and owns its authenticated server WebSocket.
- Electron consumes that child over inherited pipes and supplies fixed
  Desktop-owned authority and execution ports.
- `bin/nautilo-relay` remains the independently operated headless consumer of
  the same library, with its own device-pairing and service lifecycle.

For the Desktop path, the private child is the sole process that constructs
`RelayClient`. `RelayClient` remains the one logical owner of WebSocket
connection, reconnect, registration, heartbeat, dispatch correlation and
cancellation, capability update/acknowledgement, authenticated topology, and
socket-generation host deactivation. Electron supervises one exact child
generation and keeps all Human-, session-, grant-, policy-, permission-, and
UI-bearing execution authority. The child has no listener, pairing ceremony,
daemon/service manager, remote updater, tool registry, or downloaded code.

The stable shape is:

```text
Server / Agent
  model-facing schemas and semantic admission
        │ authenticated Relay protocol
        ▼
nautilo-relay-host / RelayClient         headless nautilo-relay
  Desktop WebSocket lifecycle             independent CLI consumer
  registration + cancellation
  capability revision + topology
        │ private inherited pipes
        ▼
Electron authority/composition root
  local authorities + fixed handlers
        │
        ├── managed Computer Use Host
        └── future earned capability-family Hosts, not arbitrary plugins
```

This is a transport/process separation, not a claim that every local executor
left Electron. Fixed Desktop dispatch lives in `relay-dispatch/` modules;
Desktop authority and UI/native adapters remain local by design. Large executor families such as
local shell may earn their own signed Host later under the rule below. Small or
UI-bound adapters do not become processes merely to reduce an Electron file.

### Capability revisions across replacement

Electron retains the highest acknowledged Desktop capability revision for its
process lifetime. Each private Relay Host launch starts with a fresh revision
above that value, including child crash recovery and relay-client recreation.
The revision seed carries no authority: readiness and dispatch still require
an acknowledgement from the new authenticated socket and exact current
Human, pairing, Desktop session, profile and grant bindings. Disconnect clears
acknowledged readiness without clearing the sequence floor or saved consent.
A new Electron process has a new Desktop session identity.

The server's workstation status uses the same live binding check as shell
admission. A retained but incoherent session is not reported ready; a coherent
reconnect can recover without revoking consent. Revision rollback remains a
fail-closed denial with the expected and observed revisions in its error.

## Current consumer lifecycle

| Consumer | Construction | Loss and teardown | Truthful local surface |
| --- | --- | --- | --- |
| Desktop | `startRelay` creates one `DesktopRelaySession`, one capability publisher, one MCP handle, the fixed handler composition, and one `DesktopRelaySidecarClient`. Electron launches the app-sealed Host program with the already bundled Bun runtime; only the child constructs `RelayClient`. | Failed start and stop retire the exact child generation, disconnect the child-owned client, drain admitted Desktop work, and sweep session resources. One established child crash may consume one automatic replacement; public handoff is generation-fenced and serialized. | Electron authorities, Computer Use broker, PTYs, BrowserView/CDP, grants/profiles/folders, document commits, hosted agent ports, and local adapters. |
| Headless CLI | `main` constructs `RelayClient` directly with the shared portable sandbox policy and its smaller handler set. | One first-request-wins shutdown stops MCP before disconnecting the client, attempts both steps after a failure, and exits once. | Filesystem/sandboxed shell plus other explicitly advertised headless handlers; no Electron-only authority is manufactured. |

Both consumers therefore share the canonical transport lifecycle and only the
execution policy that is genuinely portable. They intentionally do not have
feature parity.

## Desktop session ownership

`DesktopRelaySession` owns values that must die on failed start, stop, server
handoff, or replacement:

- sidecar client/supervisor, capability publisher, and MCP host handle;
- run-shell retained-output store and browser page snapshot store;
- media session records, byte accounting, and browser coordinate scales;
- the exact server-bound Google OAuth tuple;
- the session's structured SSH runtime reference and status callback; and
- admitted asynchronous work that must settle before a replacement begins.

Retirement makes its ports inert before returning, zeroes retained media bytes,
clears output and snapshot state, rejects late attachments, and performs a
second sweep after bound work drains.

The following deliberately remain outside that session:

| State | Owner | Lifetime |
| --- | --- | --- |
| Agent Browser, gog, and OpenHue resolved paths | Existing tool-runtime cache | Electron process, with explicit invalidation |
| PTY pool, Human handoff, controller consent | `terminal-host` | Electron process until explicit kill or app quit |
| BrowserView/CDP and visible Browser authority | Electron main/renderer owners | Visible application surface lifetime |
| Filesystem grants, profiles, Current Folder, protected-path policy | Existing Electron stores/controllers | Durable/local authority lifetime |
| Document mutation/journal/commit coordination | Existing document owners | Exact local mutation transaction lifetime |
| Computer Use grant, route, broker, managed runtime | Electron Computer Use authorities | Server/installation/grant/Host generations, not Relay-session storage |

## Capability publication

The child-owned `RelayClient.getAcknowledgedCapabilityRevision()` exposes only
the revision the server accepted for the active socket. The child projects that
truth through the closed private protocol. The Desktop capability publisher
owns one session-local full capability builder and preserves a trailing rebuild
when local authority changes during an in-flight publication. It does not own
grant, profile, provider, or policy truth.

An advertisement remains readiness, never authority. Every local executor
revalidates its current binding immediately before work. A retired publisher
cannot refresh through a replacement session.

## Fixed Desktop dispatch order

Two security-sensitive lanes run before the closed 14-family router:

1. `security_scan` uses its dedicated coordinator and cannot inherit generic
   roots, sandbox, or shell authority.
2. `executionClass: "computer_use"` requires the exact server-minted Desktop
   Automation binding and the injected Computer Use dispatcher. Relay recognizes no
   public Computer Use tool name or Cua operation.

The fixed router then executes this compile-time order:

1. structured SSH and its retained output;
2. retained `run_shell` output continuation;
3. Current Folder prepare/commit/select and paired-directory work;
4. browser research;
5. real-workstation execution;
6. Hue;
7. media;
8. interactive browser;
9. Google Workspace;
10. direct local-file/document work;
11. filesystem transport;
12. sandboxed local search;
13. sandboxed `run_shell` and typed Git; and
14. terminal, followed by the unknown-tool fallback.

Handlers are a closed tuple. They cannot register dynamically, download code,
or grant authority. There is no legacy Desktop/Peekaboo handler.

## Computer Use boundary

Computer Use separates semantic validation from transport and local authority:

```text
Agent catalogue and contract schemas
        │ contract descriptor + canonical arguments
        ▼
Relay generic computer_use lane
        │ exact authority binding and structural request
        ▼
Desktop broker
        │ inherited private pipes
        ▼
signed managed nautilo-computer-use-host
        │
        ▼
signed CUA driver
```

The structural package `@nautilo/computer-use-host-protocol` owns only protocol
v3 framing, canonical JSON identity, descriptors, authority/generation fences,
settlement, and PNG attachment metadata. Its reviewed bounds are 16 MiB for a
control message and 32 MiB for a PNG attachment. The semantic package
`@nautilo/computer-use-contracts` owns the operation schemas and descriptors;
Relay does not import it. The managed Host performs exact semantic validation
and provider translation.

Relay/Desktop retain authenticated device/server/Relay/Human/Genie/run/grant/
session binding, acknowledged capability revision, cancellation/revocation,
effect and replay policy, single settlement, attachment integrity, and the
protocol-major gate. A server label cannot downgrade the Host-attested effect.
Raw CUA responses, native identifiers, provider paths/prose, and undeclared
attachments do not enter Relay or model context.

### Computer Use contract compatibility

Desktop advertises the running signed Host's exact `ready.contracts` as optional
`computerUseHostContracts` capability metadata, separate from the existing grant
tuple. This is structural discovery, not tool schemas or permission to execute.
The server intersects these descriptors with the signed catalogue and selects
the newest matching variant of each tool for the authenticated Desktop. The
selection is checkpointed for the model/action cycle and isolated across runs;
normal authority and exact Host descriptor checks still apply at dispatch.

The catalogue and Host retain explicit, tested prior native contracts alongside
new native contracts. Desktops predating descriptor advertisement use only the
catalogue's marked compatibility baseline. An empty or malformed advertisement
is not legacy omission. Unsupported tools are withheld before schema creation;
the server never relabels a new schema with an old version or replays an action
against a replacement Host. A fresh model cycle can select newly adopted support.
Compatibility is release-reviewed, not a promise to support every past version.
This advertisement requires a generic Desktop update; future operation schemas
continue to belong to the independently released Host and catalogue.

### Computer Use execution lifetime

An admitted, signal-owned `computer_use` dispatch has no generic Relay RPC
execution deadline. Its turn/authority signal, executor completion and transport
lifecycle own termination. An explicit caller deadline still applies; callers
without a cancellation owner retain the existing fallback. This is a structural
execution-class rule, not a list of tool names, apps or provider operations.

Cancellation requests cleanup, not a claimed effect. The private Relay Host
forwards abort to Electron but retains the Computer Use callback for its final
receipt. Pipe retirement still rejects owned callbacks. Server receipt loss after
an explicit deadline or cancellation is outcome-unknown with the initiating
reason preserved, including compatibility with older callback-dropping Hosts.
Never infer Human Stop or zero delivery from a generic callback error.

Computer Use has no post-cancel receipt-expiry timer. After forwarding Stop or
an explicit deadline once, the registry retains the exact invocation until the
executor settles or its authenticated connection retires. The broker preserves
the checked receipt even when its signal is aborted, including partial delivery;
a retired Host session cannot publish a late result into its replacement.
An executor that never settles while its connection remains live remains pending,
not falsely completed or safe to replay. Connection retirement settles it as
outcome-unknown and releases its listeners.

The separate embedded Browser mutation path retains its existing post-cancel
receipt grace (5 seconds, configurable up to 10). That grace and the generic
60-second fallback for unrelated/unowned calls are not validated by this
Computer Use repair.

Peekaboo is out. It has no executable, packaging, runtime route, fallback, or
handler. The only remaining source mention is a strict legacy local-state
decoder so older policy bytes can be recognized and migrated without reviving
the provider.

## Workstation authority

Ready-to-work retains
contained workstation tools and supported identity, while Direct Mac changes
containment only. A raw credential in arbitrary shell environment is not an
acceptable implementation of that contract. Exact-value output redaction does
not prevent transformation, file write, or exfiltration, and GitHub-specific
credential code does not belong in `relay.ts`. The workstation capability must
arrive through a narrow Desktop-owned broker/module (and ultimately the earned
Local Execution Host boundary below), with no raw credential exposed to the
model-controlled shell.

Headless pairing and service behavior need their own tests. Browser/mobile pairing is
separate surface acceptance and cannot substitute for the Electron journey.

## Follow-on rule for independently updateable executors

A clean typed contract does not imply a separately released executable. The
extra process is justified only for a large capability family with meaningful
upstream/runtime churn, native/process supervision, security-sensitive parsing,
and a demonstrated need for fixes between Desktop releases.

`run_shell` is the first earned candidate. Its surface includes raw sandboxed
execution, real-workstation execution, typed Git, Current Folder/profile/grant
binding, protected-path and network policy, progress, redaction, retained
output, cancellation, process-tree cleanup, and result classification. A
separate follow-on should define one Managed Local Execution Host:

- Server/Agent owns model schema, guidance, and semantic contract version.
- Relay/Desktop owns device/session identity, approval, grants, profiles,
  Current Folder, protected paths, effect floor, cancellation, and revocation.
- The signed Host owns exact request parsing, sandbox/process supervision,
  typed Git, output redaction/continuation, and private diagnostics.

Raw shell is always arbitrary-process, high-risk, and non-replay-safe; neither
catalogue nor Host self-description can downgrade that security floor.

Reuse the Computer Use Host's artifact-lifecycle primitives—signature/digest admission,
immutable version roots, health checks, atomic activation, last-known-good,
rollback, and generation fencing—but use a dedicated Local Execution protocol.
Do not reuse Computer Use wire semantics and do not invent a universal Host or
plugin protocol.

Other decisions:

- Codex, ACP, and Claude already have substantial host packages and changing
  upstream runtimes. They may share artifact-lifecycle implementation while
  keeping provider protocols and authority separate.
- Structured SSH should keep a clean dedicated contract; independent runtime
  delivery is earned only by release/churn evidence.
- Browser/research should improve its Electron ports first because visible
  BrowserView/CDP authority remains in Electron.
- PTY terminal, filesystem grants, Current Folder, document commit, Google
  OAuth, media, Hue, and other small or UI-bound adapters remain Desktop-owned
  unless later evidence crosses the same threshold.

## Locked constraints

- Exactly one private Desktop-managed Relay Host child. No second Relay
  lifecycle owner, local Relay socket/listener, independently installed Desktop
  daemon, generic start/stop facade, or remote Host updater.
- No dynamic handler registry, executable catalogue, marketplace, arbitrary
  code download, or third-party plugin contract.
- No authority transfer merely to make a module appear portable.
- No Electron/headless parity claim beyond genuinely shared policy.
- No new timeout, retry, size, retention, or concurrency bound without its own
  producer-to-consumer limit review.
- Any future managed Host is first-party signed, privately launched, narrowly
  versioned, independently health-checked, generation-fenced, and rollbackable.
