import { describe, expect, test } from "bun:test";
import { createColdBootTerminalRuntime } from "../../electron/cold-boot-terminal-runtime";

const authority = {
  scope: "https://b.example", revision: "revision-b", connectionAttemptId: "attempt-b", serverFingerprint: "fingerprint-b",
} as const;
const recovery = {
  disposition: "committed-handoff", action: "resume-handoff", attemptId: "attempt-b", generation: 4,
  context: "cold-boot", candidateOrigin: "https://b.example", routingServerUrl: "https://b.example/base",
  priorRecoveryGuard: { scope: null, revision: null }, priorRegistryScope: null,
  nextPostCommitCheckpoint: "metadata", validActions: ["resume-handoff"],
  requiresEphemeralFactReconstructionAndRevalidation: true,
  identityTransition: { kind: "ordinary" },
} as const;

describe("D514 cold-boot terminal runtime facade", () => {
  test("binds committed recovery to the exact authority, target scope, and registry transaction", async () => {
    const calls: unknown[] = [];
    const handle = { id: "prepared-b" } as never;
    const runtime = createColdBootTerminalRuntime({
      configureRegistry: () => calls.push("configure"),
      loadPending: () => ({ disposition: "committed-handoff", pending: {} } as never),
      projectCommitted: (loaded) => { calls.push(loaded); return recovery; },
      currentAuthority: () => authority,
      registry: {
        beginCommittedHandoffRecovery: (input: unknown) => { calls.push(input); return { ok: true, handle }; },
        completeCommittedHandoffRevalidation: () => ({ ok: true }),
        promotePrepared: async (received: unknown, hooks: unknown) => {
          calls.push([received, hooks]);
          return { ok: true, receipt: {} } as never;
        },
      } as never,
      fetch: fetch,
      fingerprintFromHealthBody: () => "fingerprint-b",
      navigateCandidate: async () => ({}) as never,
      savePending: () => {}, clearPending: () => {}, persistMetadata: async () => {},
      stopOldCodex: async () => {}, stopOldRelay: async () => {}, deactivateOldProfile: async () => {},
      startTargetRelay: async () => {}, createTokenStore: () => ({ load: () => null, save: () => {}, clear: () => {} }),
      observeRelayContract: () => {}, candidateUi: {} as never, forceOnboarding: false,
      installActiveAuthDescriptor: () => {},
    });
    const ports = runtime.committedPorts({
      targetRegistryScope: "scope-b", initiateLocalShell: () => calls.push("shell"),
      releaseCandidate: () => {}, finishReleased: async () => {}, onState: () => {},
    });
    ports.configureRegistry();
    expect(calls[0]).toBe("configure");
    expect(ports.beginCommitted(recovery)).toEqual({ handle, activeAuthorityGuard: authority });
    expect(calls[1]).toMatchObject({
      attemptId: "attempt-b", generation: 4, canonicalOrigin: "https://b.example",
      routingServerUrl: "https://b.example/base", targetRegistryScope: "scope-b",
      identityTransition: { kind: "ordinary" },
      currentActiveAuthority: authority,
    });
    const hooks = {} as never;
    await ports.promote(handle, hooks);
    expect(calls[2]).toEqual([handle, hooks]);
  });

  test("accepted ports force the exact receipt-bound detached candidate and forward recovery controls", async () => {
    let prepared: Record<string, unknown> | null = null;
    let navigation: Record<string, unknown> | null = null;
    const runtime = createColdBootTerminalRuntime({
      configureRegistry: () => {}, loadPending: () => ({ disposition: "none" }), projectCommitted: () => recovery,
      currentAuthority: () => authority, currentRegistryScope: () => "scope-b",
      registry: {
        beginCommittedHandoffRecovery: () => ({ ok: false }),
        completeCommittedHandoffRevalidation: () => ({ ok: false }),
        promotePrepared: async () => ({ ok: false, reason: "stale-handle" }),
        prepareSwitch: async (input: Record<string, unknown>) => {
          prepared = input;
          await (input["awaitNavigationReceipt"] as (value: Record<string, unknown>) => Promise<unknown>)({
            attemptId: "attempt-b", generation: 4, view: "view-b", newlyCreatedView: true, expectedOrigin: "https://b.example",
          });
          return { ok: false, reason: "invalid-receipt" } as never;
        },
        cancelPreparedSwitch: (attemptId: string, generation: number) => attemptId === "attempt-b" && generation === 4,
        resolveUnknownCommitOutcome: () => ({ outcome: "unresolved" }),
      } as never,
      fetch, fingerprintFromHealthBody: () => "fingerprint-b",
      navigateCandidate: async (input: Record<string, unknown>) => { navigation = input; return {} as never; },
      savePending: () => {}, clearPending: () => {}, persistMetadata: async () => {},
      stopOldCodex: async () => {}, stopOldRelay: async () => {}, deactivateOldProfile: async () => {},
      startTargetRelay: async () => {}, createTokenStore: () => ({ load: () => null, save: () => {}, clear: () => {} }),
      observeRelayContract: () => {}, candidateUi: {} as never, forceOnboarding: false, installActiveAuthDescriptor: () => {},
    });
    const commit = () => true;
    const accepted = runtime.acceptedPorts({ commitAcceptedConfig: commit });
    const receipt = { attemptId: "attempt-b", generation: 4, origin: "https://b.example", observedAtMs: 9 } as never;
    await accepted.prepare({
      attemptId: "attempt-b", generation: 4, canonicalOrigin: "https://b.example", navigationUrl: "https://b.example/base/",
      priorRegistryScope: "scope-b", priorAuthorityGuard: authority, candidateServerFingerprint: "fingerprint-b",
      acceptedIdentityReplacementReceipt: receipt, signal: new AbortController().signal,
      identityTransition: { kind: "accepted-identity-replacement", priorConnectionAttemptId: "attempt-a",
        priorServerFingerprint: "fingerprint-a", priorRoutingServerUrl: "https://b.example/old" },
    });
    expect(prepared).toMatchObject({ forceDetachedReplacement: true, routingServerUrl: "https://b.example/base/",
      acceptedIdentityReplacementReceipt: receipt, identityTransition: { kind: "accepted-identity-replacement" } });
    expect(navigation).toMatchObject({ attemptId: "attempt-b", generation: 4, navigationUrl: "https://b.example/base/" });
    expect(accepted.cancelPrepared("attempt-b", 4)).toBe(true);
    expect(accepted.resolveUnknownCommitOutcome({} as never, authority)).toEqual({ outcome: "unresolved" });
    expect(accepted.commitAcceptedConfig).toBe(commit);
  });
});
