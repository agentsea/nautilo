import { describe, expect, test } from "bun:test";
import type { ComputerUseHostContract } from "@nautilo/computer-use-host-protocol";
import { ComputerUseHost } from "../../src/runtime.ts";

const authority = { authorityLeaseId: "lease-1", authorityGeneration: 1 } as const;
const fence = { hostGeneration: "host-1", driverGeneration: "driver-1", cancellationGeneration: 1 } as const;
const browserReadContract = { contractNamespace: "nautilo.computer_use", contractId: "browser.read_page", contractVersion: 1, schemaDigest: "sha256:2cfdca7707a07eea9256ce9316c64feb0623563ad734e96c64a1b58c9fcb5fe4", effectClass: "read", replayClass: "safe", authorityClass: "standing_computer_use", attachmentClass: "none", disclosureClass: "semantic" } as const;
const request = (contract: ComputerUseHostContract = browserReadContract) => ({ kind: "request", protocol: { major: 3, minor: 0 }, requestId: "request-1", authority, fence, contract, arguments: { query: "Example" } } as const);

describe("Computer Use Host", () => {
  test("generation revocation fences queued and late output without replaying a mutation", async () => {
    for (const mutate of [false, true]) {
      const gate = Promise.withResolvers<void>();
      const contract: ComputerUseHostContract = {
        ...browserReadContract,
        effectClass: mutate ? "mutate" : "read",
        replayClass: mutate ? "at_most_once" : "safe",
        attachmentClass: "png",
        disclosureClass: "semantic_and_visual",
      };
      const bytes = new Uint8Array([1, 2, 3]);
      let calls = 0;
      const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: [{
        contract,
        async execute() {
          calls += 1;
          await gate.promise;
          return { settlement: "completed", result: { complete: true },
            attachment: { bytes, width: 1, height: 1, coordinateSpace: "window_snapshot_pixels" } };
        },
      }] });
      const pending = host.dispatch(request(contract));
      host.revoke();
      host.revoke();
      expect(await host.dispatch({ ...request(contract), requestId: "later" }))
        .toMatchObject({ settlement: "stale" });
      gate.resolve();
      expect(await pending).toMatchObject({ settlement: mutate ? "unknown_completion" : "stale" });
      expect(calls).toBe(1);
      expect(bytes).toEqual(new Uint8Array([0, 0, 0]));
      expect(host.takeAttachment("request-1")).toBeNull();
    }
  });
  test("advertises versioned contracts and dispatches without a Desktop tool enum", async () => {
    const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: [{
      contract: browserReadContract,
      async execute(argumentsValue) { return { settlement: "completed", result: { query: argumentsValue["query"] ?? null, complete: true } }; },
    }] });
    expect(host.ready().contracts).toEqual([browserReadContract]);
    expect(await host.dispatch(request())).toMatchObject({ settlement: "completed", result: { query: "Example", complete: true } });
    expect(await host.dispatch(request({ ...browserReadContract, contractId: "browser.unknown" }))).toMatchObject({ settlement: "fenced", result: { reason: "unsupported_contract" } });
    expect(await host.dispatch(request({ ...browserReadContract, effectClass: "mutate" }))).toMatchObject({ settlement: "fenced", result: { reason: "unsupported_contract" } });
  });

  test("rejects stale generations and cancels only exact authority", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: [{
      contract: browserReadContract,
      async execute(_arguments, context) { await Promise.race([wait, new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }))]); if (context.signal.aborted) throw new Error("cancelled"); return { settlement: "completed", result: { complete: true } }; },
    }] });
    expect(await host.dispatch({ ...request(), fence: { ...fence, hostGeneration: "host-old" } })).toMatchObject({ settlement: "stale", result: { reason: "stale_generation" } });
    const pending = host.dispatch(request());
    expect(host.cancel({ kind: "cancel", protocol: { major: 3, minor: 0 }, requestId: "request-1", authority: { ...authority, authorityLeaseId: "lease-2" }, fence })).toBe(false);
    expect(host.cancel({ kind: "cancel", protocol: { major: 3, minor: 0 }, requestId: "request-1", authority, fence })).toBe(true);
    expect(await pending).toMatchObject({ settlement: "cancelled", result: { reason: "cancelled" } });
    release();
  });

  test("does not erase a handler's known settlement when cancellation races after its boundary", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: [{
      contract: browserReadContract,
      async execute() { await wait; return { settlement: "completed", result: { status: "observed" } }; },
    }] });
    const pending = host.dispatch(request());
    expect(host.cancel({ kind: "cancel", protocol: { major: 3, minor: 0 }, requestId: "request-1", authority, fence })).toBe(true);
    release();
    expect(await pending).toMatchObject({ settlement: "completed", result: { status: "observed" } });
  });
});
