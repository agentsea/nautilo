import { describe, expect, test } from "bun:test";
import type {
  ProtectedCheckpointNamespaceMaterial,
  ProtectedCheckpointNamespaceSessionContentExecutor,
} from "@nautilo/lattice-bridge";

import {
  createForegroundConversationAgentContentAuthority,
} from "../../src/conversation/protected-conversation-agent-content-authority";
import type {
  ForegroundAuthorizationSessionRegistry,
  ForegroundAuthorizationView,
} from "../../src/protected-execution/foreground-authorization-session";

const view = Object.freeze({
  sessionId: "foreground-session",
  viewId: "foreground-view",
}) as ForegroundAuthorizationView;
const contentPort =
  Object.freeze({}) as ProtectedCheckpointNamespaceSessionContentExecutor;
const material: ProtectedCheckpointNamespaceMaterial = Object.freeze({
  namespaceId: "namespace-authority",
  domainId: "domain-authority",
  accessRevision: 4,
  agentAuthorizationRevision: 7,
  currentGeneration: 2,
  generations: Object.freeze([
    Object.freeze({
      generation: 2,
      key: new Uint8Array(32).fill(2),
    }),
  ]),
});

type Registry = Pick<
  ForegroundAuthorizationSessionRegistry,
  "leaseOperation" | "executeCheckpointNamespace"
>;

function request(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    authorizationSession: view,
    entrypointId: "foreground.main" as const,
    namespaceId: "namespace-authority",
    domainId: "domain-authority",
    expectedAccessRevision: 4,
    expectedPolicyRevision: 7,
    execute: () => "opened",
    ...overrides,
  };
}

describe("foreground conversation Agent content authority", () => {
  test("leases one exact decrypt operation and keeps callback execution inside it", async () => {
    const calls: unknown[] = [];
    const registry = {
      leaseOperation: (input: unknown) => {
        calls.push(input);
        return {
          status: "leased" as const,
          lease: Object.freeze({
            sessionId: "foreground-session",
            leaseId: "lease-1",
          }),
        };
      },
      executeCheckpointNamespace: async (
        lease: unknown,
        input: {
          contentPort: unknown;
          expectedAccessRevision: number;
          expectedPolicyRevision: number;
          execute: (
            value: ProtectedCheckpointNamespaceMaterial,
            context: {
              signal: AbortSignal;
              assertActive(): void;
            },
          ) => Promise<unknown>;
        },
      ) => {
        calls.push({ lease, input });
        const signal = new AbortController().signal;
        return {
          status: "executed" as const,
          value: await input.execute(material, {
            signal,
            assertActive: () => undefined,
          }),
        };
      },
    } as unknown as Registry;
    const authority = createForegroundConversationAgentContentAuthority({
      registry,
      authorization: view,
      namespaceContentPort: contentPort,
    });

    const result = await authority.execute(request());

    expect(result).toEqual({ status: "executed", value: "opened" });
    expect(calls[0]).toEqual({
      view,
      entrypointId: "foreground.main",
      operation: "decrypt",
      namespaceId: "namespace-authority",
      domainId: "domain-authority",
    });
    const execution = calls[1] as {
      input: {
        contentPort: unknown;
        expectedAccessRevision: number;
        expectedPolicyRevision: number;
      };
    };
    expect(execution.input.contentPort).toBe(contentPort);
    expect(execution.input.expectedAccessRevision).toBe(4);
    expect(execution.input.expectedPolicyRevision).toBe(7);
  });

  test("rejects a substituted view before leasing", async () => {
    let leases = 0;
    const registry = {
      leaseOperation: () => {
        leases += 1;
        throw new Error("must not lease");
      },
      executeCheckpointNamespace: () => {
        throw new Error("must not execute");
      },
    } as unknown as Registry;
    const authority = createForegroundConversationAgentContentAuthority({
      registry,
      authorization: view,
      namespaceContentPort: contentPort,
    });

    const result = await authority.execute(request({
      authorizationSession: { ...view },
    }));

    expect(result).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(leases).toBe(0);
  });

  test("preserves caller failures and classifies lease/content failures", async () => {
    const callbackRegistry = {
      leaseOperation: () => ({
        status: "leased" as const,
        lease: Object.freeze({
          sessionId: "foreground-session",
          leaseId: "lease-callback",
        }),
      }),
      executeCheckpointNamespace: async (
        _lease: unknown,
        input: {
          execute: (
            value: ProtectedCheckpointNamespaceMaterial,
            context: {
              signal: AbortSignal;
              assertActive(): void;
            },
          ) => Promise<unknown>;
        },
      ) => ({
        status: "executed" as const,
        value: await input.execute(material, {
          signal: new AbortController().signal,
          assertActive: () => undefined,
        }),
      }),
    } as unknown as Registry;
    const callbackAuthority =
      createForegroundConversationAgentContentAuthority({
        registry: callbackRegistry,
        authorization: view,
        namespaceContentPort: contentPort,
    });
    const callbackFailure = new Error("model execution failed");
    const rejected = callbackAuthority.execute(request({
      execute: () => {
        throw callbackFailure;
      },
    }));
    expect(await rejected.catch((error: unknown) => error)).toBe(
      callbackFailure,
    );

    const deniedAuthority = createForegroundConversationAgentContentAuthority({
      registry: {
        leaseOperation: () => ({
          status: "unavailable",
          reason: "session_expired",
        }),
        executeCheckpointNamespace: () => {
          throw new Error("must not execute");
        },
      } as unknown as Registry,
      authorization: view,
      namespaceContentPort: contentPort,
    });
    expect(await deniedAuthority.execute(request())).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });

    const unavailableAuthority =
      createForegroundConversationAgentContentAuthority({
        registry: {
          leaseOperation: callbackRegistry.leaseOperation,
          executeCheckpointNamespace: async () => ({
            status: "unavailable",
            reason: "content_unavailable",
          }),
        } as unknown as Registry,
        authorization: view,
        namespaceContentPort: contentPort,
      });
    expect(await unavailableAuthority.execute(request())).toEqual({
      status: "unavailable",
      reason: "content_unavailable",
    });
  });
});
