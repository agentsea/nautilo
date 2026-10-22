import { reapplyHappyDomGlobals } from "../../../../../tests/bun-dom-preload";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import type {
  TaskDetail,
  TaskOperationRunTranscriptReadV1,
} from "@nautilo/types";

const actualApi = await import("../../../../lib/api");
const actualAuth = await import("../../../../hooks/use-auth");
const { ConversationEncryptionPolicyModeContext } = await import("../../../../adapters/runtime-contexts");
const cryptoAdmission = await import("../../../../lib/crypto-admission-access");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

let viewerGeneration = 1;
let viewerId = "viewer-a";
let policyMode: "plaintext_only" | "shadow_encryption" = "plaintext_only";
let shadowContent: "ordinary" | "protected" = "protected";
const pending: Array<ReturnType<typeof deferred<TaskDetail>>> = [];
const getTask = mock(async (_taskId: string): Promise<TaskDetail> => {
  const read = deferred<TaskDetail>();
  pending.push(read);
  return read.promise;
});
const getTaskContentV1 = mock(async (taskId: string) => ({
  task: { id: taskId, status: "running",
    agentId: "30000000-0000-4000-8000-000000000003" },
  definition: shadowContent === "ordinary"
    ? { dtoVersion: 1 as const, status: "ordinary" as const,
        prompt: "ordinary", expectedOutput: null, lastError: null }
    : { dtoVersion: 1 as const, status: "protected" as const,
        objectId: "task-definition:1", contentRevision: 1,
        cryptoAccessRevision: 0 },
  runs: ["run-protected", "run-other"].map((id) => ({
    id, status: "running", modelId: "model",
    startedAt: null, completedAt: null,
    content: { dtoVersion: 1, status: "unavailable", reason: "unsupported_client" },
  })),
} as never));

mock.module("../../../../lib/api", () => ({
  ...actualApi,
  apiClient: { ...actualApi.apiClient, getTask, getTaskContentV1 },
}));
mock.module("../../../../hooks/use-auth", () => ({
  ...actualAuth,
  useAuth: () => ({
    viewerGeneration,
    viewer: { isVerified: true, sessionUserId: viewerId, sessionActorId: `${viewerId}-actor` },
  }),
}));

const actualProtectedController = await import(
  "../../../../lib/protected-human-task-controller"
);
const protectedPending: Array<ReturnType<
  typeof deferred<TaskOperationRunTranscriptReadV1>
>> = [];
const openTranscript = mock(async () => {
  const read = deferred<TaskOperationRunTranscriptReadV1>();
  protectedPending.push(read);
  return read.promise;
});
mock.module("../../../../lib/protected-human-task-controller", () => ({
  ...actualProtectedController,
  createWorkbenchProtectedHumanTaskController: () => ({
    open: async (task: never) => ({ task, content: { status: "protected",
      payload: { formatVersion: 1, prompt: "private", expectedOutput: null,
        protectedMetadata: {} } } }),
    openTranscript,
  }),
}));

const actionSession = await import("../../../../lib/client-action-session");

const { useSubagentTranscript } = await import("../use-subagent-transcript");

function wrapper({ children }: { children: ReactNode }) {
  // Production mounts this subtree only after the admission gate has opened
  // the exact policy snapshot. Keep the React presentation context and the
  // canonical operation owner on the same generation in this direct-hook
  // fixture too.
  cryptoAdmission.setCryptoAdmissionAccessState({
    status: "open",
    identity: `${viewerId}:device:test`,
    policy: {
      mode: policyMode,
      shadowBehavior: "fallback",
    },
  });
  return <ConversationEncryptionPolicyModeContext.Provider value={policyMode}>{children}</ConversationEncryptionPolicyModeContext.Provider>;
}

function detail(content: string, funding?: {
  source: "personal" | "server";
  failure?: "personal_credential_missing" | "personal_credential_stale";
}): TaskDetail {
  return {
    task: { status: "running", ...(funding?.failure ? { fundingFailure: funding.failure } : {}) },
    runs: [{ id: "run-1", transcript: [{
      role: "assistant", content, toolName: null, toolCalls: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    }], ...(funding ? {
      fundingSource: funding.source,
      ...(funding.failure ? { fundingFailure: funding.failure } : {}),
    } : {}) }],
  } as TaskDetail;
}

beforeEach(() => {
  cleanup();
  reapplyHappyDomGlobals();
  cryptoAdmission.resetCryptoAdmissionAccess();
  viewerGeneration = 1;
  viewerId = "viewer-a";
  policyMode = "plaintext_only";
  shadowContent = "protected";
  pending.length = 0;
  getTask.mockClear();
  getTaskContentV1.mockClear();
  openTranscript.mockClear();
  protectedPending.length = 0;
  actionSession.clearClientActionSession();
});

afterAll(() => {
  cleanup();
  cryptoAdmission.resetCryptoAdmissionAccess();
  mock.module("../../../../lib/api", () => actualApi);
  mock.module("../../../../hooks/use-auth", () => actualAuth);
  mock.module("../../../../lib/protected-human-task-controller", () =>
    actualProtectedController);
  actionSession.clearClientActionSession();
});

describe("Task transcript viewer scope", () => {
  test("rejects a late prior-viewer transcript response", async () => {
    const view = renderHook(() => useSubagentTranscript("task-1"), { wrapper });
    await waitFor(() => expect(pending).toHaveLength(1));

    viewerId = "viewer-b";
    viewerGeneration += 1;
    view.rerender();
    expect(view.result.current.messages).toEqual([]);
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => { pending[0]!.resolve(detail("viewer A secret")); });
    expect(view.result.current.messages).toEqual([]);
    await act(async () => { pending[1]!.resolve(detail("viewer B content")); });
    expect(view.result.current.messages[0]?.content).toBe("viewer B content");
  });

  test("drops already opened content on viewer change", async () => {
    const view = renderHook(() => useSubagentTranscript("task-1"), { wrapper });
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => { pending[0]!.resolve(detail("viewer A secret")); });
    expect(view.result.current.messages[0]?.content).toBe("viewer A secret");

    viewerGeneration += 1;
    viewerId = "viewer-b";
    view.rerender();
    expect(view.result.current.messages).toEqual([]);
  });

  test("clears on policy change and never loads the Plain transcript in protected modes", async () => {
    const view = renderHook(() => useSubagentTranscript("task-1"), { wrapper });
    await waitFor(() => expect(pending).toHaveLength(1));
    policyMode = "shadow_encryption";
    view.rerender();
    expect(view.result.current.messages).toEqual([]);
    expect(pending).toHaveLength(1);
    await waitFor(() => expect(getTaskContentV1).toHaveBeenCalledWith("task-1"));

    await act(async () => { pending[0]!.resolve(detail("stale plaintext")); });
    expect(view.result.current.messages).toEqual([]);
  });

  test("keeps an ordinary Task transcript available in Shadow after exact classification", async () => {
    policyMode = "shadow_encryption";
    shadowContent = "ordinary";
    const view = renderHook(() => useSubagentTranscript("task-1"), { wrapper });
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => { pending[0]!.resolve(detail("ordinary in Shadow")); });
    expect(view.result.current.messages[0]?.content).toBe("ordinary in Shadow");
    expect(getTaskContentV1).toHaveBeenCalledWith("task-1");
    expect(getTask).toHaveBeenCalledWith("task-1");
  });

  test("projects only the server-classified funding recovery with the transcript", async () => {
    const view = renderHook(() => useSubagentTranscript("task-1"), { wrapper });
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]!.resolve(detail("saved result", {
        source: "personal",
        failure: "personal_credential_stale",
      }));
    });
    expect(view.result.current.fundingSource).toBe("personal");
    expect(view.result.current.fundingFailure).toBe("personal_credential_stale");
    expect(view.result.current.messages[0]?.content).toBe("saved result");
    expect(openTranscript).not.toHaveBeenCalled();
  });

  test("opens only the explicitly selected protected stored run", async () => {
    policyMode = "shadow_encryption";
    const view = renderHook(() => useSubagentTranscript("task-1", {
      taskRunId: "run-protected",
    }), { wrapper });
    await waitFor(() => expect(protectedPending).toHaveLength(1));
    expect(openTranscript).toHaveBeenCalledWith({
      taskId: "task-1",
      taskRunId: "run-protected",
      agentId: "30000000-0000-4000-8000-000000000003",
    });
    await act(async () => protectedPending[0]!.resolve({
      status: "ready",
      messages: [{ role: "assistant", content: "protected transcript",
        toolName: null, toolCalls: null,
        createdAt: "2026-10-09T12:00:00.000Z" }],
      nextCursor: null,
    }));
    expect(view.result.current.messages[0]?.content)
      .toBe("protected transcript");
    expect(getTask).not.toHaveBeenCalled();
  });

  test("does not infer a protected run when no stored run is selected", async () => {
    policyMode = "shadow_encryption";
    const view = renderHook(() => useSubagentTranscript("task-1"), { wrapper });
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.error)
      .toBe("Choose a stored run to open its protected transcript.");
    expect(openTranscript).not.toHaveBeenCalled();
    expect(getTask).not.toHaveBeenCalled();
  });

  test("loads a later protected page only from its opaque cursor", async () => {
    policyMode = "shadow_encryption";
    const view = renderHook(() => useSubagentTranscript("task-1", {
      taskRunId: "run-protected",
    }), { wrapper });
    await waitFor(() => expect(protectedPending).toHaveLength(1));
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      role: "assistant",
      content: `protected row ${index + 1}`,
      toolName: null,
      toolCalls: null,
      createdAt: `2026-10-09T12:00:${String(index).padStart(2, "0")}.000Z`,
    }));
    await act(async () => protectedPending[0]!.resolve({
      status: "ready",
      messages: firstPage,
      nextCursor: "opaque_page_two",
    }));
    expect(view.result.current.messages).toHaveLength(50);
    expect(view.result.current.hasMore).toBe(true);

    act(() => {
      view.result.current.loadMore();
      view.result.current.loadMore();
    });
    await waitFor(() => expect(protectedPending).toHaveLength(2));
    expect(openTranscript).toHaveBeenCalledTimes(2);
    expect(openTranscript).toHaveBeenLastCalledWith({
      taskId: "task-1",
      taskRunId: "run-protected",
      agentId: "30000000-0000-4000-8000-000000000003",
      cursor: "opaque_page_two",
    });
    await act(async () => protectedPending[1]!.resolve({
      status: "ready",
      messages: [{ role: "assistant", content: "protected row 51",
        toolName: null, toolCalls: null,
        createdAt: "2026-10-09T12:01:00.000Z" }],
      nextCursor: null,
    }));
    expect(view.result.current.messages).toHaveLength(51);
    expect(view.result.current.messages.at(-1)?.content).toBe("protected row 51");
    expect(view.result.current.hasMore).toBe(false);
  });

  test("clears decrypted rows when a later page reports revoked authority", async () => {
    policyMode = "shadow_encryption";
    const view = renderHook(() => useSubagentTranscript("task-1", {
      taskRunId: "run-protected",
    }), { wrapper });
    await waitFor(() => expect(protectedPending).toHaveLength(1));
    await act(async () => protectedPending[0]!.resolve({
      status: "ready",
      messages: [{ role: "assistant", content: "must be cleared",
        toolName: null, toolCalls: null,
        createdAt: "2026-10-09T12:00:00.000Z" }],
      nextCursor: "revoked_page",
    }));
    expect(view.result.current.messages).toHaveLength(1);
    act(() => view.result.current.loadMore());
    await waitFor(() => expect(protectedPending).toHaveLength(2));
    await act(async () => protectedPending[1]!.resolve({
      status: "unavailable",
      reason: "authority_changed",
    }));
    expect(view.result.current.messages).toEqual([]);
    expect(view.result.current.hasMore).toBe(false);
    expect(view.result.current.error)
      .toBe("Protected Task transcript is unavailable on this device.");
  });

  test("clears loaded pages and fences a late page after stored-run selection changes", async () => {
    policyMode = "shadow_encryption";
    const view = renderHook(({ runId }: { runId: string }) =>
      useSubagentTranscript("task-1", { taskRunId: runId }), {
      wrapper,
      initialProps: { runId: "run-protected" },
    });
    await waitFor(() => expect(protectedPending).toHaveLength(1));
    await act(async () => protectedPending[0]!.resolve({
      status: "ready",
      messages: [{ role: "assistant", content: "old run first page",
        toolName: null, toolCalls: null,
        createdAt: "2026-10-09T12:00:00.000Z" }],
      nextCursor: "old_run_page_two",
    }));
    act(() => view.result.current.loadMore());
    await waitFor(() => expect(protectedPending).toHaveLength(2));

    view.rerender({ runId: "run-other" });
    expect(view.result.current.messages).toEqual([]);
    await waitFor(() => expect(protectedPending).toHaveLength(3));
    await act(async () => protectedPending[1]!.resolve({
      status: "ready",
      messages: [{ role: "assistant", content: "stale old run page",
        toolName: null, toolCalls: null,
        createdAt: "2026-10-09T12:00:01.000Z" }],
      nextCursor: null,
    }));
    expect(view.result.current.messages).toEqual([]);
    await act(async () => protectedPending[2]!.resolve({
      status: "ready",
      messages: [{ role: "assistant", content: "selected new run page",
        toolName: null, toolCalls: null,
        createdAt: "2026-10-09T12:00:02.000Z" }],
      nextCursor: null,
    }));
    expect(view.result.current.messages[0]?.content).toBe("selected new run page");
    expect(openTranscript).toHaveBeenLastCalledWith({
      taskId: "task-1",
      taskRunId: "run-other",
      agentId: "30000000-0000-4000-8000-000000000003",
    });
  });

  test("fences a late appended page after the policy generation changes", async () => {
    policyMode = "shadow_encryption";
    const view = renderHook(() => useSubagentTranscript("task-1", {
      taskRunId: "run-protected",
    }), { wrapper });
    await waitFor(() => expect(protectedPending).toHaveLength(1));
    await act(async () => protectedPending[0]!.resolve({
      status: "ready",
      messages: [{ role: "assistant", content: "protected first page",
        toolName: null, toolCalls: null,
        createdAt: "2026-10-09T12:00:00.000Z" }],
      nextCursor: "protected_page_two",
    }));
    act(() => view.result.current.loadMore());
    await waitFor(() => expect(protectedPending).toHaveLength(2));

    policyMode = "plaintext_only";
    view.rerender();
    expect(view.result.current.messages).toEqual([]);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => protectedPending[1]!.resolve({
      status: "ready",
      messages: [{ role: "assistant", content: "stale protected second page",
        toolName: null, toolCalls: null,
        createdAt: "2026-10-09T12:00:01.000Z" }],
      nextCursor: null,
    }));
    expect(view.result.current.messages).toEqual([]);
    await act(async () => pending[0]!.resolve(detail("current Plain transcript")));
    expect(view.result.current.messages[0]?.content).toBe("current Plain transcript");
  });

  test("clears and fences a late protected page after action-session drift", async () => {
    policyMode = "shadow_encryption";
    actionSession.installClientActionSession({
      clientActionSessionId: "action:one",
    } as never);
    const view = renderHook(() => useSubagentTranscript("task-1", {
      taskRunId: "run-protected",
    }), { wrapper });
    await waitFor(() => expect(protectedPending).toHaveLength(1));
    actionSession.installClientActionSession({
      clientActionSessionId: "action:two",
    } as never);
    view.rerender();
    expect(view.result.current.messages).toEqual([]);
    await waitFor(() => expect(protectedPending).toHaveLength(2));
    await act(async () => protectedPending[0]!.resolve({
      status: "ready",
      messages: [{ role: "assistant", content: "stale protected transcript",
        toolName: null, toolCalls: null,
        createdAt: "2026-10-09T12:00:00.000Z" }],
      nextCursor: null,
    }));
    expect(view.result.current.messages).toEqual([]);
  });
});
