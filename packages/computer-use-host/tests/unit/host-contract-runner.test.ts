import { describe, expect, mock, test } from "bun:test";
import { COMPUTER_USE_NATIVE_CONTRACTS, NATIVE_CONTRACT_SCHEMAS } from "@nautilo/computer-use-contracts/native";
import type { ComputerUseHostContract } from "@nautilo/computer-use-host-protocol";

import type { CuaCheckedContextPort, CuaMainLifecycle } from "../../src/native-cua-lifecycle.ts";
import { createNativeCuaHost } from "../../src/native-host.ts";
import { ComputerUseHost } from "../../src/runtime.ts";
import { HostContractRunner } from "../support/host-contract-runner.ts";

const authority = { authorityLeaseId: "fixture-lease", authorityGeneration: 4 } as const;
const fence = { hostGeneration: "host-fixture", driverGeneration: "driver-fixture", cancellationGeneration: 2 } as const;
const contract = {
  contractNamespace: "nautilo.computer_use",
  contractId: "fixture.read",
  contractVersion: 1,
  schemaDigest: `sha256:${"1".repeat(64)}`,
  effectClass: "read",
  replayClass: "safe",
  authorityClass: "standing_computer_use",
  attachmentClass: "png",
  disclosureClass: "visual",
} satisfies ComputerUseHostContract;

function host(execute: ConstructorParameters<typeof ComputerUseHost>[0]["handlers"][number]["execute"]) {
  return new ComputerUseHost({ hostGeneration: fence.hostGeneration, driverGeneration: fence.driverGeneration, handlers: [{ contract, execute }] });
}

function invocation(requestId: string) {
  return { requestId, contract, arguments: { privateInput: "must-not-be-recorded" } } as const;
}

describe("HostContractRunner", () => {
  test("uses real Host result validation and records only monotonic content-free evidence", async () => {
    const evidence: unknown[] = [];
    const ticks = [10, 16];
    const runner = new HostContractRunner({
      host: host(async () => ({ settlement: "completed", result: { privateOutput: "also-secret" } })),
      authority,
      fence,
      evidenceMode: "simulated",
      now: () => ticks.shift()!,
      recordEvidence: (entry) => evidence.push(entry),
    });
    const outcome = await runner.execute(invocation("validated-result"));
    expect(outcome.result.result).toEqual({ privateOutput: "also-secret" });
    expect(outcome.evidence).toMatchObject({ evidenceMode: "simulated", qualification: "unverified", startedAtMs: 10, completedAtMs: 16, durationMs: 6, requestCount: 1, resultCount: 1, outcome: "accepted", settlement: "completed", imageBytes: 0 });
    expect(outcome.evidence.argumentBytes).toBeGreaterThan(0);
    expect(outcome.evidence.resultPayloadBytes).toBeGreaterThan(0);
    expect(JSON.stringify(evidence)).not.toContain("must-not-be-recorded");
    expect(JSON.stringify(evidence)).not.toContain("also-secret");
    await runner.dispose();
  });

  test("does not let a measurement callback rewrite a completed Host result", async () => {
    const runner = new HostContractRunner({
      host: host(async () => ({ settlement: "completed", result: { status: "ok" } })),
      authority,
      fence,
      evidenceMode: "simulated",
      recordEvidence: () => { throw new Error("private measurement sink failure"); },
    });
    await expect(runner.execute(invocation("evidence-failure"))).resolves.toMatchObject({
      result: { settlement: "completed", result: { status: "ok" } },
    });
    await runner.dispose();
  });

  test("rejects a mismatched result envelope through the production result gate", async () => {
    const evidence: unknown[] = [];
    const real = host(async () => ({ settlement: "completed", result: { status: "ok" } }));
    const proxy = {
      cancel: real.cancel.bind(real),
      async dispatch(message: Parameters<typeof real.dispatch>[0]) {
        const result = await real.dispatch(message);
        return result?.kind === "result" ? { ...result, requestId: "another-request" } : result;
      },
      takeAttachment: real.takeAttachment.bind(real),
    };
    const runner = new HostContractRunner({ host: proxy, authority, fence, evidenceMode: "simulated", recordEvidence: (entry) => evidence.push(entry) });
    await expect(runner.execute(invocation("expected-request"))).rejects.toMatchObject({ code: "invalid_message" });
    expect(evidence).toEqual([expect.objectContaining({ outcome: "invalid_result", requestCount: 1, resultCount: 0, settlement: null, resultPayloadBytes: 0 })]);
    expect(JSON.stringify(evidence)).not.toContain("must-not-be-recorded");
    await runner.dispose();
  });

  test("records a dispatch rejection once without content and preserves the original error", async () => {
    const evidence: unknown[] = [];
    const original = new Error("private transport detail");
    const runner = new HostContractRunner({
      host: {
        dispatch: async () => { throw original; },
        cancel: () => false,
        takeAttachment: () => null,
      },
      authority,
      fence,
      evidenceMode: "simulated",
      recordEvidence: (entry) => evidence.push(entry),
    });

    await expect(runner.execute(invocation("dispatch-rejected"))).rejects.toBe(original);
    expect(evidence).toEqual([expect.objectContaining({ outcome: "dispatch_rejected", requestCount: 1, resultCount: 0, settlement: null, resultPayloadBytes: 0, imageBytes: 0 })]);
    expect(JSON.stringify(evidence)).not.toContain("private transport detail");
    expect(JSON.stringify(evidence)).not.toContain("must-not-be-recorded");
    await runner.dispose();
  });

  test("settles accepted cancellation once and rejects the discarded late result without cancelling its sibling", async () => {
    const evidence: unknown[] = [];
    const runner = new HostContractRunner({
      host: host(async (args, context) => {
        if (args["name"] === "fast") return { settlement: "completed", result: { status: "ok" } };
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("cancelled");
      }),
      authority,
      fence,
      evidenceMode: "simulated",
      recordEvidence: (entry) => evidence.push(entry),
    });
    const slow = runner.start({ ...invocation("slow-request"), arguments: { name: "slow" } });
    const fast = runner.start({ ...invocation("fast-request"), arguments: { name: "fast" } });
    expect(slow.cancel()).toBe(true);
    expect(slow.cancel()).toBe(true);
    await expect(slow.result).rejects.toMatchObject({ code: "invalid_message" });
    expect((await fast.result).result.settlement).toBe("completed");
    expect(evidence.filter((entry) => (entry as { requestId?: string }).requestId === "slow-request"))
      .toEqual([expect.objectContaining({ outcome: "cancelled", requestCount: 1, resultCount: 0, settlement: null })]);
    expect(JSON.stringify(evidence)).not.toContain('"name"');
    await runner.dispose();
  });

  test("rejects and zeroizes a completed attachment returned after accepted cancellation", async () => {
    const release = Promise.withResolvers<void>();
    const real = host(async () => {
      await release.promise;
      return {
        settlement: "completed",
        result: { status: "captured" },
        attachment: { bytes: new Uint8Array([137, 80, 78, 71]), width: 1, height: 1, coordinateSpace: "window_snapshot_pixels" },
      };
    });
    let taken!: ReturnType<typeof real.takeAttachment>;
    const proxy = {
      cancel: real.cancel.bind(real),
      dispatch: real.dispatch.bind(real),
      takeAttachment(requestId: string) {
        taken = real.takeAttachment(requestId);
        return taken;
      },
    };
    const runner = new HostContractRunner({ host: proxy, authority, fence, evidenceMode: "simulated" });
    const call = runner.start(invocation("cancelled-capture"));
    expect(call.cancel()).toBe(true);
    release.resolve();
    await expect(call.result).rejects.toMatchObject({ code: "invalid_message" });
    expect([...taken!.bytes]).toEqual([0, 0, 0, 0]);
    await runner.dispose();
  });

  test("rejects a wrongly paired attachment and zeroizes its bytes", async () => {
    const evidence: unknown[] = [];
    const real = host(async () => ({
      settlement: "completed",
      result: { status: "captured" },
      attachment: { bytes: new Uint8Array([137, 80, 78, 71]), width: 1, height: 1, coordinateSpace: "window_snapshot_pixels" },
    }));
    let taken!: ReturnType<typeof real.takeAttachment>;
    const proxy = {
      cancel: real.cancel.bind(real),
      dispatch: real.dispatch.bind(real),
      takeAttachment(requestId: string) {
        taken = real.takeAttachment(requestId);
        if (taken !== null) (taken.metadata as { requestId: string }).requestId = "wrong-request";
        return taken;
      },
    };
    const runner = new HostContractRunner({
      host: proxy,
      authority,
      fence,
      evidenceMode: "simulated",
      recordEvidence: (entry) => {
        evidence.push(entry);
        throw new Error("measurement callback failure");
      },
    });
    await expect(runner.execute(invocation("capture-request"))).rejects.toMatchObject({ code: "invalid_message" });
    expect([...taken!.bytes]).toEqual([0, 0, 0, 0]);
    expect(evidence).toEqual([expect.objectContaining({ outcome: "invalid_attachment", requestCount: 1, resultCount: 0, settlement: null, resultPayloadBytes: 0, imageBytes: 4 })]);
    expect(JSON.stringify(evidence)).not.toContain("must-not-be-recorded");
    await runner.dispose();
  });

  test("disposes successfully paired attachments exactly and idempotently", async () => {
    const runner = new HostContractRunner({
      host: host(async () => ({
        settlement: "completed",
        result: { status: "captured" },
        attachment: { bytes: new Uint8Array([137, 80, 78, 71]), width: 1, height: 1, coordinateSpace: "window_snapshot_pixels" },
      })),
      authority,
      fence,
      evidenceMode: "simulated",
    });
    const outcome = await runner.execute(invocation("cleanup-request"));
    expect([...outcome.attachment!.bytes]).toEqual([137, 80, 78, 71]);
    await runner.dispose();
    outcome.attachment!.dispose();
    expect([...outcome.attachment!.bytes]).toEqual([0, 0, 0, 0]);
  });

  test("crosses createNativeCuaHost production handlers and distinguishes argument schema rejection", async () => {
    const port = {
      generation: `cua_${"a".repeat(32)}`,
      callContextTool: mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const })),
      launchApplication: mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const })),
      getWindowState: mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const })),
      captureWindowState: mock(async () => ({ ok: false as const, code: "context_fenced" as const })),
      captureDesktopState: mock(async () => ({ ok: false as const, code: "context_fenced" as const })),
      clickDesktop: mock(async () => ({ ok: false as const, code: "context_fenced" as const, stage: "session" as const })),
      endContextLease: mock(async () => undefined),
      awaitOutstandingOperations: mock(async () => undefined),
    } satisfies CuaCheckedContextPort;
    const lifecycle = {
      startup: mock(async () => ({ lifecycle: "healthy" as const })),
      checkedContextPort: mock(() => port),
      subscribeCheckedGenerationInvalidation: mock(() => () => undefined),
      shutdown: mock(async () => undefined),
    } as unknown as CuaMainLifecycle;
    const runtime = await createNativeCuaHost({
      driverPath: "/fixture/cua-driver",
      runtimeRoot: "/fixture/runtime",
      hostBundleId: "example.fixture",
      hostGeneration: fence.hostGeneration,
      createLifecycle: () => lifecycle,
    });
    const runner = new HostContractRunner({
      host: runtime.host,
      authority,
      fence: { ...fence, driverGeneration: runtime.driverGeneration },
      evidenceMode: "simulated",
    });
    const unknown = await runner.execute({
      requestId: "native-unknown-operation",
      contract: COMPUTER_USE_NATIVE_CONTRACTS.observe,
      arguments: { operation: "unknown_operation" },
    });
    expect(unknown.result).toMatchObject({ settlement: "failed", result: { status: "host_rejected", reason: "host_failure" } });
    expect(NATIVE_CONTRACT_SCHEMAS.observe.result.safeParse(unknown.result.result).success).toBe(false);

    const observed = await runner.execute({
      requestId: "native-safe-observation",
      contract: COMPUTER_USE_NATIVE_CONTRACTS.observe,
      arguments: { operation: "desktop_state" },
    });
    expect(observed.result).toMatchObject({ settlement: "not_completed", result: { operation: "desktop_state" } });
    expect(NATIVE_CONTRACT_SCHEMAS.observe.result.safeParse(observed.result.result).success).toBe(true);
    await runner.dispose();
    await runtime.shutdown();
  });
});
