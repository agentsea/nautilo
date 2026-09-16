import { beforeAll, describe, expect, mock, test } from "bun:test";
import {
  createWorkspaceGuard,
  RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION,
  type DesktopAutomationInvocationBinding,
  type RelayDispatchRequest,
} from "@nautilo/relay";
import type { ComputerUseHostInvocation } from "../../electron/computer-use/host-dispatch.ts";

mock.module("electron", () => ({ app: { getPath: () => "/tmp/nautilo-computer-use-relay-test" } }));

let makeDispatchHandler: typeof import("../../electron/relay.ts").makeDispatchHandler;

beforeAll(async () => {
  ({ makeDispatchHandler } = await import("../../electron/relay.ts"));
});

const binding: DesktopAutomationInvocationBinding = {
  version: RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION,
  computerUseContextId: "computer-use-context-1",
  originHumanId: "human-1",
  originRunId: "run-1",
  originAgentId: "agent-1",
  lineageId: "lineage-1",
  installationEpoch: "epoch-1",
  grantGeneration: 1,
  relayId: "relay-1",
  pairingGeneration: "pairing-1",
  desktopSessionId: "desktop-session-1",
  computerUseInvocationId: "computer-invocation:fixture-1",
  provider: "cua",
  providerGeneration: "provider-generation-1",
};

const selection = {
  version: 1 as const,
  provider: "cua" as const,
  providerGeneration: binding.providerGeneration,
};

const futureHostRequest = {
  contract: {
    contractNamespace: "nautilo.computer_use",
    contractId: "future.arbitrary_compatible_contract",
    contractVersion: 1,
    schemaDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    effectClass: "read" as const,
    replayClass: "safe" as const,
    authorityClass: "standing_computer_use" as const,
    attachmentClass: "none" as const,
    disclosureClass: "semantic" as const,
  },
  arguments: { opaque: "future-value" },
} as const;

function request(overrides: Partial<RelayDispatchRequest> = {}): RelayDispatchRequest {
  return {
    correlationId: "computer-1",
    toolName: "computer_observe",
    args: { operation: "desktop_state" },
    impact: "read-only",
    approvalObtained: false,
    executionClass: "computer_use",
    desktopAutomationBinding: binding,
    ...overrides,
  };
}

describe("Cua-only semantic Computer use relay splice", () => {
  test("routes an exact bound unknown future catalogue key to the generic dispatcher", async () => {
    const received: ComputerUseHostInvocation[] = [];
    const structured = {
      ok: true as const,
      provider: selection,
      result: {
        kind: "observation" as const,
        observation: { version: 1 as const, operation: "desktop_state" as const, context: "ctx", targets: [] },
      },
    };
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
      computerUseDispatch: async (invocation) => {
        received.push(invocation);
        return structured as never;
      },
    });

    await expect(handler(request({ toolName: "future_catalogue_operation", computerUseRequest: futureHostRequest }))).resolves.toEqual({ status: "ok", result: structured });
    expect(received).toEqual([{ binding, toolName: "future_catalogue_operation", args: { operation: "desktop_state" }, computerUseRequest: futureHostRequest }]);
  });

  test("moves a screenshot through the established multimodal relay envelope", async () => {
    const semantic = {
      ok: true as const,
      provider: selection,
      result: {
        kind: "observation" as const,
        observation: { version: 1 as const, operation: "desktop_state" as const, context: "opaque-context", targets: [] },
        visionImage: { mime: "image/png" as const, base64: "iVBORw==" },
      },
    };
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
      computerUseDispatch: async () => semantic as never,
    });

    const dispatched = await handler(request());
    expect(dispatched).toEqual({ status: "ok", result: semantic });
  });

  test("carries the measured Spotify window image beyond the retired 1 MiB control ceiling", async () => {
    const base64 = "A".repeat(1_606_228);
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
      computerUseDispatch: async () => ({
        ok: true,
        provider: selection,
        result: {
          kind: "observation",
          observation: { version: 1, operation: "desktop_state", context: "opaque-context", targets: [] },
          visionImage: { mime: "image/png", base64 },
        },
      }) as never,
    });

    const dispatched = await handler(request());
    expect(dispatched.status).toBe("ok");
    const result = dispatched.result as { result?: { visionImage?: { base64?: string } } };
    expect(result.result?.visionImage?.base64).toHaveLength(1_606_228);
  });

  test("fails before Cua when the computer_use class lacks its exact binding", async () => {
    let calls = 0;
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
      computerUseDispatch: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });

    await expect(handler(request({ desktopAutomationBinding: undefined }))).resolves.toMatchObject({
      status: "error", errorCode: "desktop_automation_unavailable",
    });
    await expect(handler(request({ executionClass: "browser" }))).resolves.toMatchObject({
      status: "error",
    });
    expect(calls).toBe(0);
  });

  test("carries cancellation to Cua and preserves its truthful outcome", async () => {
    const correlation = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const structured = {
      ok: false as const,
      code: "desktop_operation_cancelled" as const,
      error: "The desktop request was cancelled.",
      retry: "never" as const,
      outcome: {
        version: 1 as const,
        phase: "pre_effect_dispatch" as const,
        retrySafety: "never" as const,
        stateChangeCertainty: "unknown" as const,
        targetCondition: "unknown" as const,
        recovery: ["observe_again", "do_not_replay"] as const,
      },
    };
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
      computerUseDispatch: async (invocation) => {
        receivedSignal = invocation.signal;
        return await new Promise((resolve) => {
          invocation.signal?.addEventListener("abort", () => resolve(structured as never), { once: true });
        });
      },
    });

    const pending = handler(request({ toolName: "computer_do", impact: "low" }), correlation.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(receivedSignal).toBe(correlation.signal);
    correlation.abort();
    await expect(pending).resolves.toEqual({ status: "ok", result: structured });
  });

  test("preserves a Cua controller failure as a truthful semantic outcome", async () => {
    const structured = {
      ok: false as const,
      code: "desktop_automation_revoked" as const,
      error: "Computer use authority changed before the action could be dispatched.",
      retry: "never" as const,
      outcome: {
        version: 1 as const,
        phase: "pre_effect_dispatch" as const,
        retrySafety: "never" as const,
        stateChangeCertainty: "unchanged" as const,
        targetCondition: "unknown" as const,
        recovery: ["observe_again", "do_not_replay"] as const,
      },
    };
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
      computerUseDispatch: async () => structured as never,
    });

    await expect(handler(request({ toolName: "computer_do", impact: "low" }))).resolves.toEqual({
      status: "ok",
      result: structured,
    });
  });
});
