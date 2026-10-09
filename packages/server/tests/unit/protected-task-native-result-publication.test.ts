import { expect, test } from "bun:test";

import type { TaskContentAuthorityV1 } from "@nautilo/lattice-bridge";
import type { TaskRuntimeGrantClaimPlan } from "@nautilo/runtime";

import {
  createProtectedTaskNativeResultPublication,
} from "../../src/routes/protected-task-native-result-publication";

const HUMAN = "10000000-0000-4000-8000-000000000001";
const DEVICE = "20000000-0000-4000-8000-000000000002";
const REQUESTER = "30000000-0000-4000-8000-000000000003";
const AGENT = "40000000-0000-4000-8000-000000000004";
const TASK = "50000000-0000-4000-8000-000000000005";
const RUN = "60000000-0000-4000-8000-000000000006";
const NAMESPACE = "70000000-0000-4000-8000-000000000007";
const DOMAIN = "80000000-0000-4000-8000-000000000008";
const REQUEST = `task-run-authorization:${RUN}`;
const INPUT_OBJECT = `task-definition:v1:${"a".repeat(64)}`;
const RESULT_OBJECT = `task-run-result:v1:${"b".repeat(64)}`;
const CONTINUATION_FINGERPRINT = "A".repeat(43);

const reference: TaskRuntimeGrantClaimPlan["reference"] = Object.freeze({
  kind: "protected_task_run_v1",
  taskId: TASK,
  taskRunId: RUN,
  inputObjectId: INPUT_OBJECT,
  resultObjectId: RESULT_OBJECT,
  authorizationRequestId: REQUEST,
  policyRevision: 7,
  executionSegment: 1,
});

const authority: TaskContentAuthorityV1 = Object.freeze({
  authorityVersion: 1,
  kind: "requester_private_namespace",
  keyClass: "ai",
  requesterHumanId: HUMAN,
  namespaceId: NAMESPACE,
  domainId: DOMAIN,
  expectedAccessRevision: 5,
  expectedPolicyRevision: 7,
});

function publication(
  adjust: Readonly<Record<string, unknown>> = {},
): Parameters<TaskRuntimeGrantClaimPlan["publishResult"]>[0] {
  const value = {
    occurrence: {
      task: {
        id: TASK,
        requestorId: REQUESTER,
        agentId: AGENT,
        scheduleKind: "now",
        contentNamespaceId: NAMESPACE,
        cryptoObjectId: INPUT_OBJECT,
      },
      run: { id: RUN, taskId: TASK },
    },
    record: {
      snapshot: {
        state: "running",
        requestId: REQUEST,
        workId: RUN,
        acceptedResponse: {
          kind: "runtime",
          issuingHumanId: HUMAN,
          issuingDeviceId: DEVICE,
        },
      },
      expectedPolicyRevision: 7,
      descriptorBytes: new Uint8Array([1, 2, 3]),
    },
    payload: { lastError: null },
    domains: [{
      domainId: DOMAIN,
      keyClass: "ai",
      domainKeyGeneration: 4,
    }],
    evidence: {
      requestId: REQUEST,
      workId: RUN,
      policyRevision: 7,
      result: {
        taskId: TASK,
        taskRunId: RUN,
        contentRevision: 1,
        objectId: RESULT_OBJECT,
        signerAgentId: AGENT,
        namespace: {
          namespaceId: NAMESPACE,
          domainId: DOMAIN,
          operations: ["encrypt"],
          expectedAccessRevision: 5,
          expectedPolicyRevision: 7,
        },
      },
    },
    signal: new AbortController().signal,
    ...adjust,
  };
  return value as never;
}

type Overrides = NonNullable<
  Parameters<typeof createProtectedTaskNativeResultPublication>[1]
>;

function fixture(choice: "protected" | "dual" = "protected") {
  const calls: string[] = [];
  const request = { requestId: REQUEST, workId: RUN };
  const runtimeBytes = new Uint8Array([7, 8, 9]);
  let published: Record<string, unknown> | null = null;
  const input = {
    reference,
    db: {} as never,
    restricted: {} as never,
    crypto: {} as never,
    owner: { choice } as never,
    serverScope: "https://server.example.test",
    product: { handle: {} as never, canonicalRunner: {} as never },
    now: () => 2_000_000_000_000,
  };
  const overrides: Overrides = {
    decodeRequest: () => {
      calls.push("decode");
      return request as never;
    },
    destroyRequest: (value) => {
      expect(value).toBe(request as never);
      calls.push("destroy");
    },
    verifyCryptoHandle: (async () => {
      calls.push("crypto");
      return {};
    }) as never,
    createStorage: () => ({
      getAgentRuntimeAtomicState: async () => {
        calls.push("runtime");
        return {
          runtime: {
            agentId: AGENT,
            authorizationRevision: 9,
            runtimeGeneration: 3,
            detached: runtimeBytes,
          },
        } as never;
      },
      getAgentRuntimeSignerPublication: async () => null,
    }),
    createPhaseAuthority: (() => {
      calls.push("authority:create");
      return async () => {
        calls.push("authority:resolve");
        return authority;
      };
    }) as never,
    withSignerHistory: (async (value: Record<string, unknown>) => {
      calls.push("history:start");
      const result = await (value["use"] as (history: unknown) => Promise<unknown>)({
        resolveHistoricalRuntimeCommitter: () => null,
        resolveHistoricalSignerPublicationManager: () => null,
      });
      calls.push("history:postcheck");
      return result;
    }) as never,
    withSigner: (async (value: Record<string, unknown>) => {
      calls.push("signer");
      return {
        status: "executed",
        value: await (value["execute"] as (signer: unknown) => Promise<unknown>)({
          agentAuthorizationRevision: 9,
          runtime: {},
          signerPublication: {},
        }),
      };
    }) as never,
    prepare: (async (value: Record<string, unknown>) => {
      await (value["assertCurrentTaskAuthority"] as () => Promise<void>)();
      calls.push("prepare");
      return {
        coordinate: {
          kind: "run_result",
          taskId: TASK,
          taskRunId: RUN,
          contentRevision: 1,
        },
        objectId: RESULT_OBJECT,
        bytes: new Uint8Array([10]),
      };
    }) as never,
    createRepository: (() => {
      calls.push("repository");
      return {};
    }) as never,
    createHumanSignerHistory: () => ({
      resolveAgentRuntimeSignerManager: async () => null,
    }),
    createTerminalPorts: (() => {
      calls.push("terminal");
      return { terminal: {}, dualTerminal: {} };
    }) as never,
    publish: (async (value: Record<string, unknown>) => {
      calls.push(`publish:${(value["owner"] as { choice: string }).choice}`);
      published = value;
      return {
        status: "mapped",
        taskId: TASK,
        taskRunId: RUN,
        resultObjectId: RESULT_OBJECT,
        resultRevision: 1,
      };
    }) as never,
    recordAttached: (async () => {
      calls.push("attached");
      return { status: "recorded" };
    }) as never,
  };
  return { calls, input, overrides, runtimeBytes, published: () => published };
}

test("prepares under signer history and publishes only after its postcheck", async () => {
  const state = fixture();
  const publishResult = createProtectedTaskNativeResultPublication(
    state.input,
    state.overrides,
  );

  await publishResult(publication());

  expect(state.calls).toEqual([
    "decode",
    "crypto",
    "authority:create",
    "authority:resolve",
    "runtime",
    "history:start",
    "signer",
    "authority:resolve",
    "prepare",
    "history:postcheck",
    "repository",
    "terminal",
    "publish:protected",
    "attached",
    "destroy",
  ]);
  expect([...state.runtimeBytes]).toEqual([0, 0, 0]);
  expect(state.published()).toMatchObject({
    reference,
    authority,
    scheduleKind: "now",
  });
});

test.each(["protected", "dual"] as const)(
  "forwards the current owner for %s result publication without a Plain path",
  async (choice) => {
    const state = fixture(choice);
    const publishResult = createProtectedTaskNativeResultPublication(
      state.input,
      state.overrides,
    );

    await publishResult(publication());

    expect(state.calls).toContain(`publish:${choice}`);
    const sent = state.published();
    expect(sent).not.toBeNull();
    expect(Object.keys(sent ?? {})).not.toContain("plainTerminal");
  },
);

test("rejects a mismatched exact grant before decoding or publishing", async () => {
  const state = fixture();
  const publishResult = createProtectedTaskNativeResultPublication(
    state.input,
    state.overrides,
  );
  const mismatched = publication({
    occurrence: {
      ...publication().occurrence,
      task: {
        ...publication().occurrence.task,
        cryptoObjectId: `task-definition:v1:${"c".repeat(64)}`,
      },
    },
  });

  await Promise.resolve(
    expect(publishResult(mismatched)).rejects.toThrow(
      "publication coordinates disagree",
    ),
  );
  expect(state.calls).toEqual([]);
});

test.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid execution segment %s before decoding or publishing",
  (executionSegment) => {
    const state = fixture();
    expect(() => createProtectedTaskNativeResultPublication(
      {
        ...state.input,
        reference: { ...reference, executionSegment } as never,
      },
      state.overrides,
    )).toThrow("Protected Task result reference is invalid");
    expect(state.calls).toEqual([]);
  },
);

test("requires one exact resume binding on resumed result references", () => {
  const state = fixture();
  expect(() => createProtectedTaskNativeResultPublication({
    ...state.input,
    reference: {
      ...reference,
      executionSegment: 2,
      resumeAcceptanceId: "await-reply-acceptance:1",
    },
  }, state.overrides)).not.toThrow();
  expect(() => createProtectedTaskNativeResultPublication({
    ...state.input,
    reference: {
      ...reference,
      executionSegment: 2,
      resumeContinuationFingerprint: CONTINUATION_FINGERPRINT,
    },
  }, state.overrides)).not.toThrow();
  for (const invalid of [
    { ...reference, executionSegment: 2 },
    { ...reference, resumeAcceptanceId: "await-reply-acceptance:1" },
    { ...reference, resumeContinuationFingerprint: CONTINUATION_FINGERPRINT },
    { ...reference, executionSegment: 2, resumeAcceptanceId: "contains spaces" },
    {
      ...reference,
      executionSegment: 2,
      resumeAcceptanceId: "await-reply-acceptance:1",
      resumeContinuationFingerprint: CONTINUATION_FINGERPRINT,
    },
    { ...reference, executionSegment: 2, resumeAcceptanceId: undefined },
    { ...reference, executionSegment: 2, resumeContinuationFingerprint: undefined },
    { ...reference, executionSegment: 2, resumeContinuationFingerprint: "A".repeat(42) },
    {
      ...reference,
      executionSegment: 2,
      resumeContinuationFingerprint: `${"A".repeat(42)}B`,
    },
  ]) {
    expect(() => createProtectedTaskNativeResultPublication({
      ...state.input,
      reference: invalid as never,
    }, state.overrides)).toThrow("Protected Task result reference is invalid");
  }
  expect(state.calls).toEqual([]);
});

test("destroys the decoded request when current authority is unavailable", async () => {
  const state = fixture();
  const overrides: Overrides = {
    ...state.overrides,
    createPhaseAuthority: (() => async () => null) as never,
  };
  const publishResult = createProtectedTaskNativeResultPublication(
    state.input,
    overrides,
  );

  await Promise.resolve(
    expect(publishResult(publication())).rejects.toThrow(
      "authority is unavailable",
    ),
  );
  expect(state.calls).toEqual(["decode", "crypto", "destroy"]);
});

test("does not publish when authority changes during native preparation", async () => {
  const state = fixture();
  let resolution = 0;
  const overrides: Overrides = {
    ...state.overrides,
    createPhaseAuthority: (() => async () => {
      resolution += 1;
      return resolution === 1
        ? authority
        : { ...authority, expectedAccessRevision: 6 };
    }) as never,
  };
  const publishResult = createProtectedTaskNativeResultPublication(
    state.input,
    overrides,
  );

  await Promise.resolve(
    expect(publishResult(publication())).rejects.toThrow("authority changed"),
  );
  expect(state.calls).not.toContain("history:postcheck");
  expect(state.calls.some((call) => call.startsWith("publish:"))).toBe(false);
  expect(state.calls.at(-1)).toBe("destroy");
});

test("does not attach a substituted result publication receipt", async () => {
  const state = fixture();
  let attached = false;
  const publishResult = createProtectedTaskNativeResultPublication(
    state.input,
    {
      ...state.overrides,
      publish: (async () => ({
        status: "mapped",
        taskId: TASK,
        taskRunId: TASK,
        resultObjectId: RESULT_OBJECT,
        resultRevision: 1,
      })) as never,
      recordAttached: (async () => {
        attached = true;
        return { status: "recorded" };
      }) as never,
    },
  );
  await Promise.resolve(expect(publishResult(publication())).rejects.toThrow(
    "result receipt is not exact",
  ));
  expect(attached).toBe(false);
});
