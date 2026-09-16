import { expect, test } from "bun:test";

import { CuaComputerUseAdapter } from "../../src/native-runtime.ts";

const scope = {
  computerUseContextId: "context-1",
  installationEpoch: "epoch-1",
  grantGeneration: 1,
  provider: "cua" as const,
  providerGeneration: "generation-1",
  originHumanId: "human-1",
  originRunId: "run-1",
  originAgentId: "agent-1",
  lineageId: "lineage-1",
  serverBindingId: "binding-1",
  relayId: "relay-1",
  pairingGeneration: "pairing-1",
  desktopSessionId: "desktop-1",
};

test("Host owns the pre-provider semantic fences after the Electron provider path is removed", async () => {
  const port = {} as never;
  const host = new CuaComputerUseAdapter({ port });

  expect(await host.observe({ scope, operation: "desktop_state", maxWindows: 101 }))
    .toEqual({
      ok: false,
      code: "invalid_request",
      error: "desktop_state maxWindows must be between 1 and 100",
      outcome: {
        version: 1,
        phase: "observe",
        stateChangeCertainty: "not_applicable",
        retrySafety: "never",
        recovery: [],
      },
    });

  const hostAbort = new AbortController();
  hostAbort.abort();
  expect(await host.launchApp({ scope, signal: hostAbort.signal, operation: { kind: "launch_app", app: { name: "Spotify" } } }))
    .toMatchObject({
      ok: false,
      receipt: {
        action: "launch_app",
        completionCertainty: "not_completed",
        outcome: {
          phase: "pre_effect_dispatch",
          providerCondition: "cancelled",
          retrySafety: "safe",
          stateChangeCertainty: "not_changed",
        },
      },
    });
});
