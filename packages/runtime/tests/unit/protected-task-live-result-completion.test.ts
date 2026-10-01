import { describe, expect, test } from "bun:test";

import {
  completeProtectedTaskRunResultWithLiveAuthority,
  type CompleteProtectedTaskRunResultWithLiveAuthorityInput,
} from "../../src/tasks/protected-task-live-result-completion";

const NAMESPACE_ID = "30000000-0000-4000-8000-000000000003";
const DOMAIN_ID = "40000000-0000-4000-8000-000000000004";

function fixture() {
  const authority = Object.freeze({
    authorityVersion: 1 as const,
    kind: "requester_private_namespace" as const,
    keyClass: "ai" as const,
    requesterHumanId: "50000000-0000-4000-8000-000000000005",
    namespaceId: NAMESPACE_ID,
    domainId: DOMAIN_ID,
    expectedAccessRevision: 4,
    expectedPolicyRevision: 7,
  });
  const current = { content: authority, agentAuthorizationRevision: 6 };
  const input = {
    signal: new AbortController().signal,
    evidence: {
      policyRevision: 7,
      result: {
        namespace: {
          namespaceId: NAMESPACE_ID,
          domainId: DOMAIN_ID,
          expectedAccessRevision: 4,
        },
      },
    },
    domains: [{ domainId: DOMAIN_ID }],
    loadCurrentAuthority: async () => current,
  } as unknown as CompleteProtectedTaskRunResultWithLiveAuthorityInput;
  const calls: string[] = [];
  const receipt = {
    status: "mapped" as const,
    taskId: "10000000-0000-4000-8000-000000000001",
    taskRunId: "20000000-0000-4000-8000-000000000002",
    resultObjectId: "task-run-result:v1:example",
    resultRevision: 1 as const,
  };
  const dependencies: NonNullable<Parameters<
    typeof completeProtectedTaskRunResultWithLiveAuthority
  >[1]> = {
    withNamespaceSource: (async (value: {
      assertCurrentTaskAuthority(): Promise<void>;
      execute(namespace: unknown): Promise<unknown>;
    }) => {
      calls.push("source");
      await value.assertCurrentTaskAuthority();
      return value.execute({ trustedHead: "verified" });
    }) as NonNullable<Parameters<
      typeof completeProtectedTaskRunResultWithLiveAuthority
    >[1]>["withNamespaceSource"],
    withSigner: (async (value: {
      expectedAgentAuthorizationRevision: number;
      execute(signer: unknown): Promise<unknown>;
    }) => {
      calls.push(`signer:${value.expectedAgentAuthorizationRevision}`);
      return {
        status: "executed",
        value: await value.execute({
          agentAuthorizationRevision: 6,
          runtime: { key: new Uint8Array(32) },
          signerPublication: {},
        }),
      };
    }) as NonNullable<Parameters<
      typeof completeProtectedTaskRunResultWithLiveAuthority
    >[1]>["withSigner"],
    complete: (async (value: { agentAuthorizationRevision: number }) => {
      calls.push(`complete:${value.agentAuthorizationRevision}`);
      return receipt;
    }) as NonNullable<Parameters<
      typeof completeProtectedTaskRunResultWithLiveAuthority
    >[1]>["complete"],
  };
  return { input, current, dependencies, calls, receipt };
}

describe("live protected Task result completion", () => {
  test("borrows the Namespace and signer only while authority remains current", async () => {
    const scenario = fixture();
    expect(await completeProtectedTaskRunResultWithLiveAuthority(
      scenario.input,
      scenario.dependencies,
    )).toEqual(scenario.receipt);
    expect(scenario.calls).toEqual(["source", "signer:6", "complete:6"]);
  });

  test("a revision change prevents signer use and result publication", async () => {
    const scenario = fixture();
    let reads = 0;
    const input = {
      ...scenario.input,
      loadCurrentAuthority: async () => {
        reads += 1;
        return {
          ...scenario.current,
          agentAuthorizationRevision: reads === 1 ? 6 : 7,
        };
      },
    };
    expect(completeProtectedTaskRunResultWithLiveAuthority(
      input,
      scenario.dependencies,
    )).rejects.toMatchObject({ failureClass: "stale" });
    expect(scenario.calls).toEqual(["source"]);
  });

  test("missing signer cannot publish a result", async () => {
    const scenario = fixture();
    const dependencies = {
      ...scenario.dependencies,
      withSigner: (async () => ({
        status: "unavailable",
        reason: "signer_unavailable",
      })) as typeof scenario.dependencies.withSigner,
    };
    expect(completeProtectedTaskRunResultWithLiveAuthority(
      scenario.input,
      dependencies,
    )).rejects.toMatchObject({ failureClass: "authority" });
    expect(scenario.calls).toEqual(["source"]);
  });
});
