# Computer Use Host live runners

These source-tree runners exercise the real `ComputerUseHost.dispatch` path but do not, by themselves, prove an ordinary Genie run or a signed production release. The runner records every measurement with `qualification: "unverified"`: `source-live` means only that the source-tree scenario called a live Host, not that its executable, catalogue, permission holder, release, or Genie path was signed or qualified. Reserve `simulated` for controlled handlers and deterministic fixtures.

Existing runner command shapes (not run as part of unit validation):

```bash
bun packages/computer-use-host/tests/live/real-chrome-open-url.ts
bun packages/computer-use-host/tests/live/signed-cua-browser.ts
bun packages/computer-use-host/tests/live/signed-cua-dialog-direct.ts
```

Warning: these live commands start the Computer Use Host and Cua driver, and may create or interact with native applications or browser tabs. Inspect the individual scenario and establish its disposable target and permissions before running it. Only `tests/support/host-contract-runner.ts`, the shared in-process helper, starts no driver, application, service, or socket by itself.

The caller must supply the exact authority scope and Host/driver/cancellation generations. Do not invent production permission, start a driver or application implicitly, or add a timeout inside the shared runner. A live lane must verify its signed permission holder and executable/schema provenance before calling the Host. Missing permission stops that lane without weakening authority or changing workstation permissions.

Each returned PNG is matched to the request, generation, byte count and digest. Dispose it after its effect oracle has completed; disposing the runner also zeroizes all retained attachments and cancels only its own still-active calls. Every dispatched request records one terminal sample, including cancellation, transport rejection and invalid result or attachment frames. Keep measurements content-free: durations, request/accepted-result counts, argument/result-payload/image byte sizes, release tuple, warm/cold condition, outcome and settlement are evidence; prompts, payloads, image bytes, private paths and user content are not. These payload-only counters do not measure the full Host envelopes, provider prompt/schema bytes, model timing, graph/checkpoint timing or release qualification; those remain separate future instrumentation surfaces.
