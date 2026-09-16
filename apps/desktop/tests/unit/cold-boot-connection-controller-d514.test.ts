import { describe, expect, test } from "bun:test";
import { ColdBootConnectionController } from "../../electron/cold-boot-connection-controller";
import type { PendingConnectionRecovery } from "../../electron/pending-connection";

const precommit: PendingConnectionRecovery = {
  disposition: "precommit", action: "fresh-attempt", context: "cold-boot",
  enteredTarget: "https://alpha.example.test", priorActiveScope: "https://alpha.example.test",
  priorRecoveryGuard: { scope: "https://alpha.example.test", revision: "rev-a" },
  restartPhase: "normalizing", requiresFreshAttemptAndGeneration: true,
};
const committed: PendingConnectionRecovery = {
  disposition: "committed-handoff", action: "resume-handoff", attemptId: "attempt-b",
  generation: 7, context: "cold-boot", candidateOrigin: "https://alpha.example.test",
  routingServerUrl: "https://alpha.example.test/base", priorRecoveryGuard: { scope: "https://old.example", revision: "rev-a" },
  priorRegistryScope: null, nextPostCommitCheckpoint: "metadata", validActions: ["resume-handoff"],
  requiresEphemeralFactReconstructionAndRevalidation: true,
};

describe("D514 cold boot controller", () => {
  test("initiates local shell before journal load and precommit restarts with fresh facts", async () => {
    const calls: string[] = [];
    let passedSignal: AbortSignal | null = null;
    const controller = new ColdBootConnectionController({
      initiateLocalShell: () => calls.push("shell"), configureRegistry: () => calls.push("registry"),
      loadPending: () => { calls.push("load"); return precommit; }, freshColdBoot: async () => false,
      restartPrecommit: async (recovery, signal) => {
        calls.push(`fresh:${recovery.restartPhase}`); passedSignal = signal; return true;
      },
      beginCommitted: () => null, reconstructCommitted: async () => null,
      completeCommitted: () => false, promoteCommitted: async () => ({ ok: false }),
      runCandidateGates: async () => false, resumePresentation: async () => ({ ok: false }),
    });
    await controller.launch();
    expect(calls).toEqual(["shell", "registry", "load", "fresh:normalizing"]);
    expect(passedSignal?.aborted).toBe(false);
    expect(controller.snapshot()).toEqual({ phase: "released", canRetry: false });
  });

  test("a delayed healthy recovery has no elapsed-time terminal failure", async () => {
    const calls: string[] = [];
    let release!: () => void;
    let now = 0;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const controller = new ColdBootConnectionController({
      initiateLocalShell: () => calls.push("shell"), configureRegistry: () => calls.push("registry"),
      loadPending: () => precommit, freshColdBoot: async () => false,
      restartPrecommit: async () => { await delayed; calls.push(`fresh:${now}`); return true; },
      beginCommitted: () => null, reconstructCommitted: async () => null,
      completeCommitted: () => false, promoteCommitted: async () => ({ ok: false }),
      runCandidateGates: async () => false, resumePresentation: async () => ({ ok: false }),
    });
    const launch = controller.launch();
    expect(controller.snapshot()).toEqual({ phase: "connecting", canRetry: false });
    now = 5_002;
    release();
    await launch;
    expect(calls).toContain("fresh:5002");
    expect(controller.snapshot().phase).toBe("released");
  });

  test("committed recovery fences before reconstruction, pauses through scoped gates, then resumes without recommit", async () => {
    const calls: string[] = [];
    const handle = { id: "candidate" };
    const controller = new ColdBootConnectionController({
      initiateLocalShell: () => calls.push("shell"), configureRegistry: () => calls.push("registry"),
      loadPending: () => committed, freshColdBoot: async () => false,
      restartPrecommit: async () => false,
      beginCommitted: (record) => { calls.push(`fence:${record.routingServerUrl}`); return handle; },
      reconstructCommitted: async (_record, input) => {
        expect(input).toBe(handle); calls.push("fresh-ready-health-setup-auth-navigation");
        return { proof: { receipt: "fresh" }, facts: { candidateScoped: true } };
      },
      completeCommitted: (_handle, proof) => { calls.push(`complete:${proof.receipt}`); return true; },
      promoteCommitted: async (_handle, options) => {
        calls.push(`promote:${options.pauseBeforeRendererAuthority}`);
        return { ok: true, paused: true, handle };
      },
      runCandidateGates: async (_handle, facts) => {
        expect(facts).toEqual({ candidateScoped: true }); calls.push("candidate-auth-onboarding"); return true;
      },
      resumePresentation: async (input) => {
        expect(input).toBe(handle); calls.push("resume:false"); return { ok: true, paused: false, handle };
      },
    });
    await controller.launch();
    expect(calls).toEqual([
      "shell", "registry", "fence:https://alpha.example.test/base",
      "fresh-ready-health-setup-auth-navigation", "complete:fresh", "promote:true",
      "candidate-auth-onboarding", "resume:false",
    ]);
    expect(controller.snapshot()).toEqual({ phase: "released", canRetry: false });
  });

  test("failed fenced recovery stays locally recoverable and retry aborts late work", async () => {
    let first = true;
    let firstSignal: AbortSignal | null = null;
    let unblock!: () => void;
    const block = new Promise<void>((resolve) => { unblock = resolve; });
    const states: string[] = [];
    const controller = new ColdBootConnectionController({
      initiateLocalShell: () => {}, configureRegistry: () => {}, loadPending: () => precommit, freshColdBoot: async () => false,
      restartPrecommit: async (_record, signal) => {
        if (first) { first = false; firstSignal = signal; await block; return true; }
        return false;
      },
      beginCommitted: () => null, reconstructCommitted: async () => null,
      completeCommitted: () => false, promoteCommitted: async () => ({ ok: false }),
      runCandidateGates: async () => false, resumePresentation: async () => ({ ok: false }),
      onState: (state) => states.push(state.phase),
    });
    const initial = controller.launch();
    await Promise.resolve();
    await Promise.resolve();
    const retry = controller.retry();
    unblock();
    await Promise.all([initial, retry]);
    expect(firstSignal?.aborted).toBe(true);
    expect(controller.snapshot()).toEqual({ phase: "recoverable", canRetry: true });
    expect(states.at(-1)).toBe("recoverable");
  });

  test("ordinary no-pending launch uses fresh cold observation rather than recovery failure", async () => {
    const calls: string[] = [];
    const controller = new ColdBootConnectionController({
      initiateLocalShell: () => calls.push("shell"), configureRegistry: () => calls.push("registry"),
      loadPending: () => { calls.push("load"); return null; },
      freshColdBoot: async () => { calls.push("fresh"); return true; }, restartPrecommit: async () => false,
      beginCommitted: () => null, reconstructCommitted: async () => null, completeCommitted: () => false,
      promoteCommitted: async () => ({ ok: false }), runCandidateGates: async () => false,
      resumePresentation: async () => ({ ok: false }),
    });
    await controller.launch();
    expect(calls).toEqual(["shell", "registry", "load", "fresh"]);
    expect(controller.snapshot().phase).toBe("released");
  });

  test("a committed failure retries the exact fenced handle without a second begin or commit", async () => {
    const handle = { id: "fenced" };
    let reconstructs = 0;
    let begins = 0;
    const controller = new ColdBootConnectionController({
      initiateLocalShell: () => {}, configureRegistry: () => {}, loadPending: () => committed,
      freshColdBoot: async () => false, restartPrecommit: async () => false,
      beginCommitted: () => { begins += 1; return handle; },
      reconstructCommitted: async (_record, input) => { reconstructs += 1; expect(input).toBe(handle); return reconstructs === 1 ? null : { proof: 1, facts: 1 }; },
      completeCommitted: () => true,
      promoteCommitted: async (input, options) => { expect(input).toBe(handle); expect(options.pauseBeforeRendererAuthority).toBe(true); return { ok: true, paused: true, handle }; },
      runCandidateGates: async () => true,
      resumePresentation: async (input) => { expect(input).toBe(handle); return { ok: true, paused: false, handle }; },
    });
    await controller.launch();
    expect(controller.snapshot().phase).toBe("recoverable");
    await controller.retry();
    expect(begins).toBe(1);
    expect(reconstructs).toBe(2);
    expect(controller.snapshot().phase).toBe("released");
  });

  test("dependency throws are contained as local recoverable state", async () => {
    const controller = new ColdBootConnectionController({
      initiateLocalShell: () => {}, configureRegistry: () => { throw new Error("disk"); }, loadPending: () => null,
      freshColdBoot: async () => true, restartPrecommit: async () => false, beginCommitted: () => null,
      reconstructCommitted: async () => null, completeCommitted: () => false, promoteCommitted: async () => ({ ok: false }),
      runCandidateGates: async () => false, resumePresentation: async () => ({ ok: false }),
    });
    await controller.launch();
    expect(controller.snapshot()).toEqual({ phase: "recoverable", canRetry: true });
  });

  test("committed retry resumes the failed gates and presentation stages without revalidation or recommit", async () => {
    const handle = { id: "B" };
    let complete = 0;
    let promote = 0;
    let gates = 0;
    let resume = 0;
    const controller = new ColdBootConnectionController({
      initiateLocalShell: () => {}, configureRegistry: () => {}, loadPending: () => committed,
      freshColdBoot: async () => false, restartPrecommit: async () => false, beginCommitted: () => handle,
      reconstructCommitted: async () => ({ proof: "fresh", facts: "candidate-only" }),
      completeCommitted: () => { complete += 1; return true; },
      promoteCommitted: async () => { promote += 1; return { ok: true, paused: true, handle }; },
      runCandidateGates: async () => { gates += 1; return gates > 1; },
      resumePresentation: async () => { resume += 1; return resume > 1 ? { ok: true, paused: false, handle } : { ok: false }; },
    });
    await controller.launch(); // gates fail
    await controller.retry(); // gates pass; presentation fails
    await controller.retry(); // presentation only
    expect({ complete, promote, gates, resume }).toEqual({ complete: 1, promote: 1, gates: 2, resume: 2 });
    expect(controller.snapshot().phase).toBe("released");
  });

  test("Use-anyway delegates only the exact displayed B to a fresh isolated candidate adapter", async () => {
    const displayedB = "fingerprint-B";
    const accepted: string[] = [];
    const controller = new ColdBootConnectionController<never, never, never, string>({
      initiateLocalShell: () => {}, configureRegistry: () => {}, loadPending: () => null,
      freshColdBoot: async () => false, restartPrecommit: async () => false, beginCommitted: () => null,
      reconstructCommitted: async () => null, completeCommitted: () => false, promoteCommitted: async () => ({ ok: false }),
      runCandidateGates: async () => false, resumePresentation: async () => ({ ok: false }),
      acceptDisplayedWrongServer: async (displayed) => { accepted.push(displayed); return displayed === displayedB; },
    });
    await controller.useDisplayedWrongServer(displayedB);
    expect(accepted).toEqual([displayedB]);
    expect(controller.snapshot().phase).toBe("released");
    await controller.useDisplayedWrongServer("fingerprint-C");
    expect(accepted).toEqual([displayedB, "fingerprint-C"]);
    expect(controller.snapshot()).toEqual({ phase: "recoverable", canRetry: true });
  });

  test("promotion's exact paused handle becomes the only handle allowed through gates and release", async () => {
    const begun = { id: "begun" };
    const paused = { id: "paused" };
    const controller = new ColdBootConnectionController({
      initiateLocalShell: () => {}, configureRegistry: () => {}, loadPending: () => committed,
      freshColdBoot: async () => false, restartPrecommit: async () => false, beginCommitted: () => begun,
      reconstructCommitted: async () => ({ proof: 1, facts: 1 }), completeCommitted: () => true,
      promoteCommitted: async (handle) => { expect(handle).toBe(begun); return { ok: true, paused: true, handle: paused }; },
      runCandidateGates: async (handle) => { expect(handle).toBe(paused); return true; },
      resumePresentation: async (handle) => { expect(handle).toBe(paused); return { ok: true, paused: false, handle }; },
    });
    await controller.launch();
    expect(controller.snapshot()).toEqual({ phase: "released", canRetry: false });
  });
});
