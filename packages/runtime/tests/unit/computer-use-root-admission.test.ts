import { describe, expect, test } from "bun:test";
import { admitFreshComputerUseRoot } from "../../src/executors/computer-use-root-admission";

const origin = {
  kind: "local_electron" as const,
  userId: "human-1",
  actorId: "human-actor-1",
  relayId: "relay-1",
  desktopSessionId: "desktop-session-1",
  pairingGeneration: "raw-token-row-id",
  requestId: "request-1",
};

const base = {
  userId: "human-1",
  actorId: "human-actor-1",
  causalHumanUserId: "human-1",
  agentId: "agent-1",
  trustedExecutionEntrypoint: "foreground.main" as const,
  verifiedOrdinaryOrigin: origin,
};

describe("D516 fresh computer-use root admission", () => {
  test("mints an opaque Cua Host route without compiled action capability facts", async () => {
    const admitted = await admitFreshComputerUseRoot(base, {
      resolveGrant: () => ({
        status: "admitted",
        originHumanId: "human-1",
        originAgentId: "agent-1",
        installationEpoch: "epoch-5",
        grantGeneration: 5,
        provider: "cua",
        providerGeneration: "cua-generation-5",
      }),
      createOpaqueId: (() => {
        const ids = ["v5-run", "v5-lineage"];
        return () => ids.shift()!;
      })(),
    });
    expect(admitted?.routeBinding).toEqual({
      version: 2,
      provider: "cua",
      providerGeneration: "cua-generation-5",
      grantGeneration: 5,
    });
  });

  test("mints fresh server ids only after the injected live-grant resolver admits", async () => {
    const requests: unknown[] = [];
    const ids = ["run-id", "lineage-id"];
    const provenance = await admitFreshComputerUseRoot(base, {
      resolveGrant: (request) => {
        requests.push(request);
        return {
          status: "admitted",
          originHumanId: "human-1",
          originAgentId: "agent-1",
          installationEpoch: "epoch-1",
          grantGeneration: 4,
          provider: "cua",
          providerGeneration: "provider-generation-1",
          supportedActions: ["focus", "click", "scroll"] as const,
          supportsWindowCreation: false,
          supportsElementTargeting: false,
          supportsTargetedObservation: false,
          supportsVerification: false,
        };
      },
      createOpaqueId: () => ids.shift()!,
    });
    expect(requests).toHaveLength(1);
    expect(provenance).toEqual({
      provenance: {
        originHumanId: "human-1",
        originRunId: "computer-run:run-id",
        originAgentId: "agent-1",
        lineageId: "computer-lineage:lineage-id",
        installationEpoch: "epoch-1",
        grantGeneration: 4,
      },
      routeBinding: {
        version: 2,
        provider: "cua",
        providerGeneration: "provider-generation-1",
        grantGeneration: 4,
      },
    });
  });

  test("background.task never consults the resolver and receives no provenance", async () => {
    let calls = 0;
    const provenance = await admitFreshComputerUseRoot({
      ...base,
      trustedExecutionEntrypoint: "background.task",
    }, {
      resolveGrant: () => {
        calls += 1;
        return {
          status: "admitted",
          originHumanId: "human-1",
          originAgentId: "agent-1",
          installationEpoch: "epoch-1",
          grantGeneration: 4,
          provider: "cua",
          providerGeneration: "provider-generation-1",
        };
      },
    });
    expect(calls).toBe(0);
    expect(provenance).toBeNull();
  });

  test("foreground.task_report_back cannot mint a fresh Computer Use root", async () => {
    let calls = 0;
    const provenance = await admitFreshComputerUseRoot({
      ...base,
      trustedExecutionEntrypoint: "foreground.task_report_back",
    }, {
      resolveGrant: () => {
        calls += 1;
        return { status: "denied", reason: "must not be consulted" } as const;
      },
    });
    expect(provenance).toBeNull();
    expect(calls).toBe(0);
  });

  test("another speaker, non-local origin, denial, and resolver failure all fail closed", async () => {
    const admitted = () => ({
      status: "admitted" as const,
      originHumanId: "human-1",
      originAgentId: "agent-1",
      installationEpoch: "epoch-1",
      grantGeneration: 1,
      provider: "cua" as const,
      providerGeneration: "provider-generation-1",
      supportedActions: ["focus", "click", "scroll"] as const,
      supportsWindowCreation: false,
      supportsElementTargeting: false,
      supportsTargetedObservation: false,
      supportsVerification: false,
    });
    expect(await admitFreshComputerUseRoot({ ...base, causalHumanUserId: "human-2" }, { resolveGrant: admitted })).toBeNull();
    expect(await admitFreshComputerUseRoot({ ...base, actorId: "human-actor-2" }, { resolveGrant: admitted })).toBeNull();
    expect(await admitFreshComputerUseRoot({ ...base, verifiedOrdinaryOrigin: null }, { resolveGrant: admitted })).toBeNull();
    expect(await admitFreshComputerUseRoot(base, { resolveGrant: () => ({ status: "denied", reason: "off" }) })).toBeNull();
    expect(await admitFreshComputerUseRoot(base, { resolveGrant: () => { throw new Error("registry down"); } })).toBeNull();
  });
});
