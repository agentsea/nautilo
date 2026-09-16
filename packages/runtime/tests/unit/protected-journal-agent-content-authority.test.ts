import { describe, expect, test } from "bun:test";
import type {
  ProtectedJournalAgentContentAuthorityPort,
} from "@nautilo/lattice-bridge/server";

import type {
  ForegroundAuthorizationSessionRegistry,
} from "../../src/protected-execution/foreground-authorization-session";
import {
  createForegroundJournalAgentContentAuthority,
} from "../../src/stenographer/protected-journal-agent-content-authority";

type Registry = Pick<
  ForegroundAuthorizationSessionRegistry,
  "leaseOperation" | "executeCheckpointNamespace"
>;

function request(
  authorizationSession: unknown,
): Parameters<ProtectedJournalAgentContentAuthorityPort["execute"]>[0] {
  return {
    authorizationSession,
    entrypointId: "foreground.main",
    namespaceId: "namespace-journal",
    domainId: "domain-journal",
    expectedAccessRevision: 5,
    expectedPolicyRevision: 9,
    execute: ({ material, assertActive }) => {
      assertActive();
      return {
        namespaceId: material.namespaceId,
        generations: material.generations.length,
      };
    },
  };
}

describe("foreground journal Agent content authority", () => {
  test("binds one exact view to one decrypt lease and current Namespace execution", async () => {
    const authorization = Object.freeze({
      sessionId: "foreground-session",
      viewId: "foreground-view",
    }) as never;
    const lease = Object.freeze({
      sessionId: "foreground-session",
      leaseId: "journal-lease",
    }) as never;
    const calls: string[] = [];
    const registry: Registry = {
      leaseOperation: (input) => {
        calls.push(
          `lease:${input.entrypointId}:${input.operation}:${
            input.namespaceId
          }:${input.domainId}`,
        );
        return { status: "leased", lease };
      },
      executeCheckpointNamespace: async (_lease, input) => {
        calls.push(
          `execute:${input.expectedAccessRevision}:${
            input.expectedPolicyRevision
          }`,
        );
        return {
          status: "executed",
          value: await input.execute(
            {
              namespaceId: "namespace-journal",
              domainId: "domain-journal",
              accessRevision: 5,
              agentAuthorizationRevision: 9,
              currentGeneration: 3,
              generations: [{
                generation: 3,
                key: new Uint8Array(32),
              }],
            },
            {
              signal: new AbortController().signal,
              assertActive: () => {},
              assertCommitAllowed: () => Promise.resolve(),
              remainingMs: () => 30_000,
            },
          ),
        };
      },
    };
    const authority = createForegroundJournalAgentContentAuthority({
      registry,
      authorization,
      namespaceContentPort: Object.freeze({}) as never,
    });

    const result = await authority.execute(request(authorization));

    expect(result).toEqual({
      status: "executed",
      value: { namespaceId: "namespace-journal", generations: 1 },
    });
    expect(calls).toEqual([
      "lease:foreground.main:decrypt:namespace-journal:domain-journal",
      "execute:5:9",
    ]);
  });

  test("rejects a rebound handle or stale session before opening content", async () => {
    const authorization = Object.freeze({
      sessionId: "foreground-session",
      viewId: "foreground-view",
    }) as never;
    let leaseCalls = 0;
    const registry: Registry = {
      leaseOperation: () => {
        leaseCalls += 1;
        return {
          status: "unavailable",
          reason: "session_expired",
        };
      },
      executeCheckpointNamespace: async () => {
        throw new Error("must not execute");
      },
    };
    const authority = createForegroundJournalAgentContentAuthority({
      registry,
      authorization,
      namespaceContentPort: Object.freeze({}) as never,
    });

    expect(
      await authority.execute(request(Object.freeze({
        sessionId: "other",
        viewId: "other",
      }))),
    ).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(leaseCalls).toBe(0);

    expect(await authority.execute(request(authorization))).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(leaseCalls).toBe(1);
  });
});
