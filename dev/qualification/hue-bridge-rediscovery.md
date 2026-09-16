# Hue bridge rediscovery

## Reproduced defect

An existing OpenHue configuration retained an IP that subsequently belonged to
a different LAN device. Reading lights returned `openhue api error: 404`.
OpenHue 0.24 `discover` independently returned `no bridge found`, while macOS
DNS-SD found the Hue Bridge through `_hue._tcp.local.` immediately. The installed
Desktop included the working OpenHue executable and had a connected relay.
The shared Hue adapter was unchanged by the Relay Host extraction.

These observations establish an address/discovery/recovery defect. They do not
establish why the Go multicast implementation failed in this environment.
OpenHue's [discovery implementation](https://github.com/openhue/openhue-cli/blob/5884b0848cbefd4de0e953e31630ab6928faaf3e/cmd/setup/discover.go)
uses its own resolver with a two-second discovery window.

## Change and recovery

- On macOS, use the OS DNS-SD resolver before OpenHue discovery, retaining
  OpenHue when the native resolver is unavailable or finds no usable records.
- Return complete Hue SRV/TXT pairs with bridge IDs and stable `.local`
  hostnames. A bounded observation is explicitly not an exhaustive inventory.
- Use a discovered hostname for automatic setup. Several candidates require
  selection; explicit selection is preserved.
- On an unavailable saved address or pairing, return fresh discovery candidates
  and concrete setup/verification instructions. Never automatically repeat a
  lighting mutation or transfer an old credential to another address.
- The shared `hue_lights` description instructs every Genie to rediscover when
  needed, use available recovery candidates, prefer stable hostnames, verify
  with `list_lights`, and ask for an IP only after fresh discovery fails.

The existing OpenHue setup flow owns credential creation and persistence.
Pairing still requires the physical bridge button. Using a hostname in that
flow avoids persisting a transient DHCP address.

## Deadline review

Native discovery defaults to the existing provider's two-second observation
window. This is a **soft default**, not a protocol limit or a claim that two
seconds proves absence. `discoveryTimeoutMs` can extend the window, bounded by
the caller's remaining action deadline. Tests cover longer windows, expired
deadlines, and invalid/zero windows without launching an unbounded child.

The existing executor terminates and reaps the continuous `dns-sd` process;
only complete observed records survive. The live checks left no `dns-sd`
process behind. Empty discovery can be retried; no durable state is discarded.
The original command/setup deadlines remain in place across discovery and
execution, rather than receiving a fresh budget for each stage.

Manual review covers the local-variable timeout expression even though the
current primary limit scanner does not emit an observation for it. Existing
Hue command/setup timeout debt is not newly certified by this change.

## Verification

- Shared relay unit suite, including discovery, deadline, ambiguity, and stale
  address regressions.
- Agent tool contract and recovery-instruction tests; Desktop and headless
  relay dispatch tests.
- Relay TypeScript check and ESLint on changed source/tests.
- Read-only live calls through the patched handler found the actual bridge
  and turned the stale-address 404 into recovery candidates.
- A temporary configuration containing a deliberately invalid diagnostic key
  reached the bridge through its `.local` hostname and received the expected
  wrong-key error. This verified OpenHue hostname resolution without moving
  existing credentials or creating a pairing.

The initial read-only checks did not change lighting state. They were not
proof of end-to-end control.

## Populated-clone acceptance follow-up

The first control attempt incorrectly retained the synthetic invalid-key
fixture from the discovery test. It therefore required pairing unnecessarily.
The attempt exposed a real mismatch: the server abandoned Hue setup after
60 seconds while the local OpenHue pairing process continued. That exact
leftover test process was stopped.

After restoring the clone's saved credential and selecting the freshly
discovered hostname, `list_lights` succeeded without new physical pairing.
The Genie changed two lights to warm amber at 50 percent and performed a new
`list_lights` read, reporting both on at 50.2 percent (the bridge's returned
value). Installed Desktop and the protected source instance were untouched.
This proves local relay control with a valid saved pairing; it does not prove
automatic migration of an old saved address or a fresh physical-button pairing.

The live run also exposed numeric `transitionTime` being rejected by the relay
despite being accepted by the Genie schema. The relay now converts numeric
milliseconds to OpenHue duration arguments, retaining existing string callers.

Setup now derives its server wait from the relay's existing two-minute process
deadline, plus a five-second terminal-receipt grace. The grace is a soft
operational default, not a Hue protocol requirement or extra process runtime.
Normal executor expiry still kills and reaps the owned process before returning;
the server no longer abandons that normal attempt at the generic one-minute
deadline. Explicit caller deadlines retain their existing behavior. Broader
disconnect/cancellation semantics are not certified by this change.
The scanner does not emit the derived registry timeout or receipt-grace site;
this paragraph records the manual review. Existing setup-timeout debt remains.

The shared prompt gives button instructions before the blocking setup call.
The shared tool card also displays the instruction while setup is running,
including when collapsed or initially receiving partial arguments, and removes
it when the attempt ends. Regression tests cover those state transitions, the
server/local deadline ordering, and transition-duration conversion.

Packaged Desktop and deployed server adoption, and a new physical pairing,
remain separate acceptance steps.
