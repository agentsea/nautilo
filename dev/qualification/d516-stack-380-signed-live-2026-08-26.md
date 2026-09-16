# D516 Stack 380 Signed-Live Qualification Ledger

## Candidate

- Candidate SHA: `03fd1dfe8fcb1bb764b9f0e8c192446bb06355ea`
- Qualification workflow: `32997982621`
- Installed bundle: signed, notarized, updater-disabled qualification build at
  `/Applications/Nautilo.app`
- Server: isolated local default-clone instance `agent-lab-380-b9c4`
- Cua: signed `0.22.0`
- Stable Nautilo backup remains outside the test bundle and was not modified.

This ledger records sanitized semantic results. It intentionally excludes
native window IDs, opaque target references, provider generations, account
credentials, and private document contents.

## NAUTILO-CUA-380-0001 — Exact multiwindow TextEdit vertical

- **Result:** PASS.
- From a room with more than twelve TextEdit windows, Genie launched TextEdit,
  invoked one semantic `create_window`, received one uniquely attributed fresh
  window, selected its sole fresh-document text area, typed once through the
  background accessibility route, and verified the exact sentinel across two
  stable samples.
- No existing document was selected for the write and no mutation was replayed.

## NAUTILO-CUA-380-0002 — Plain-language useful workflow

- **Result:** PASS.
- Prompt: open one brand-new TextEdit document, write one exact sentinel, and
  verify it without changing existing documents.
- Genie independently chose the same five-call semantic route:
  `launch_app -> create_window -> window_state(text_area) -> type_text -> verify`.
- The final value was satisfied across two stable samples.

## NAUTILO-CUA-380-0003 — Existing-window identification and safe refusal

- **Result:** PASS for truthful selection and no-mutation recovery; existing
  document append remains unsupported by this first vertical.
- `application_windows` returned the complete eighteen-window TextEdit set.
  Genie checked candidates with exact value verification, rejected the first,
  and uniquely identified the second as the requested existing document.
- Role-only `window_state` correctly minted no fresh-document writer authority.
  A subsequent end-of-document key action was rejected before dispatch with
  `not_completed`, `not_delivered`, `not_changed`, and no replay.
- Independent signed-Cua verification proved the document still held exactly
  its original sentinel across two stable samples.

## NAUTILO-CUA-380-0004 — Human-takeover attempt became a positive control

- **Result:** NOT A TAKEOVER PASS; positive workflow control only.
- No Human-input epoch advance was observed during the run. Genie completed the
  normal fresh-document route and verified the exact sentinel across two stable
  samples.
- This run must not be cited as physical-interference qualification.

## NAUTILO-CUA-380-0005 — One-shot element authority and no replay

- **Result:** PASS.
- Genie created one fresh document and delivered the first exact write through
  one fresh element target: 26 of 26 characters, background accessibility,
  confirmed by value readback.
- A requested second write through the consumed logical authority failed at
  target resolution as stale: 0 of 7 characters delivered, state not changed.
  Genie stopped without guessing or replaying.
- Independent signed-Cua verification proved the new document contained only
  the first sentinel across two stable samples.
- Nautilo rendered the complete live tool sequence, blocked second action, and
  final explanation without a renderer restart.

## Remaining signed-live gate

- Coordinate a physical Human mouse/keyboard event during an awaited boundary.
- Accept only the closed `desktop_external_interference` result or conservative
  context fencing with no successor authority, no write, and no replay.
- Independently verify that the takeover sentinel was not written.

## NAUTILO-CUA-380-0006 — Physical-takeover coordination attempt had no host HID event

- **Result:** INVALID / NOT A TAKEOVER PASS OR PRODUCT FAILURE.
- The prompted fresh-document workflow completed normally and verified its
  sentinel because macOS reported no Human-input epoch advance.
- A following direct diagnostic sampled `IOHIDSystem.HIDIdleTime` forty times
  over approximately nine seconds. Every sample increased monotonically; none
  reset. The host therefore observed no physical mouse or keyboard input during
  the cue interval.
- The remaining gate requires explicit Human confirmation before sampling, then
  a locally observed HID reset during the operation. This run must not be cited
  as either interference detection success or detector failure.

## 2026-08-29 addendum — signed Cua 0.22.2 browser/dialog boundary

This addendum records direct signed-driver and production Host evidence from
stack 384. The driver was `/Applications/CuaDriver.app/Contents/MacOS/cua-driver`
version `0.22.2`; matching source was inspected at upstream commit
`f415cc9ae942fdb5f312e52b03cab138018f4ad2`. All GUI probes used the owned
Electron fixture in `packages/computer-use-host/tests/fixtures/browser/main.ts`.

### Direct signed-driver probes

- `/Applications/CuaDriver.app/Contents/MacOS/cua-driver describe browser_dialog --json`
  advertised `inspect`, `accept`,
  and `dismiss` for an exactly bound page-owned JavaScript dialog.
- `bun packages/computer-use-host/tests/live/signed-cua-dialog-direct.ts`
  reached the alert-opening click, then its five-second watchdog reported
  `dialog_inspect_timeout`.
- `NAUTILO_CUA_DIALOG_PROBE=snapshot_then_inspect bun packages/computer-use-host/tests/live/signed-cua-dialog-direct.ts`
  reported `fresh_snapshot_timeout`; taking another browser snapshot after the
  Electron alert opened did not recover the route.
- `NAUTILO_CUA_DIALOG_PROBE=prime_then_inspect bun packages/computer-use-host/tests/live/signed-cua-dialog-direct.ts`
  first returned the exact bounded family `{status:"ok",present:false}`, then
  the post-alert inspect still reported `dialog_inspect_timeout`.
- The same primed fixture with
  `NAUTILO_CUA_DIALOG_PROBE=prime_then_resolve_probe` and respectively
  `NAUTILO_CUA_DIALOG_RESOLUTION=accept` and `dismiss` reported
  `dialog_accept_probe_timeout` and `dialog_dismiss_probe_timeout`. The guessed
  first dialog generation was used only to compare dispatch boundaries; no
  product code guesses or exposes Cua dialog identifiers.
- `NAUTILO_CUA_DIALOG_PROBE=native_after_alert bun packages/computer-use-host/tests/live/signed-cua-dialog-direct.ts`
  settled successfully but returned no actionable AX elements for the modal.

The matching source cause is in
`libs/cua-driver/rust/crates/cua-driver-core/src/browser/tools.rs` around
`BrowserDialogTool::invoke`: every dialog action calls
`revalidate_for_mutation` before it consults the already-journaled dialog
state. Electron's native page modal blocks that fresh CDP attachment, so the
tool never reaches its recorded-dialog branch.

### Production Host proof and active disposition

- `bun packages/computer-use-host/tests/live/signed-cua-browser.ts` ran through
  the production Host-owned signed-Cua lifecycle. Type, click, hover,
  right-click, double-click, scroll down, scroll up, drag, HTTP navigation, and
  `about:` navigation all completed with fresh semantic verification before
  the terminal dialog probe.
- Native modal recovery was not promoted into a false fallback success. The
  exact window observation remained `completed` but `degraded:true` and
  `completeness:"partial"`, with only `focus_target` recovery. Exact focus
  returned `unknown_completion`, was not replayed, and a fresh reacquisition
  still produced no window PNG/pixel capability.
- The blocked Host dialog inspection was cancelled after five seconds and
  settled `cancelled`. Host shutdown then reported
  `host_owned_cua_child_cleanup_completed`; the owned Cua child was reaped.
- The Host implementation and descriptor remain available for a future signed
  Cua/Host qualification. The current bundled catalogue does not activate
  `browser.dialog`, so Genie cannot be offered a capability that signed 0.22.2
  did not complete in this fixture.
