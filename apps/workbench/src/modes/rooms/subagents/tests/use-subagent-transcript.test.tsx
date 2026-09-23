import { reapplyHappyDomGlobals } from "../../../../../tests/bun-dom-preload";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import type { TaskDetail } from "@nautilo/types";

const actualApi = await import("../../../../lib/api");
const actualAuth = await import("../../../../hooks/use-auth");
const { ConversationEncryptionPolicyModeContext } = await import("../../../../adapters/runtime-contexts");

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
  task: { id: taskId, status: "running" },
  definition: shadowContent === "ordinary"
    ? { dtoVersion: 1 as const, status: "ordinary" as const,
        prompt: "ordinary", expectedOutput: null, lastError: null }
    : { dtoVersion: 1 as const, status: "protected" as const,
        objectId: "task-definition:1", contentRevision: 1,
        cryptoAccessRevision: 0 },
  runs: [],
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

const { useSubagentTranscript } = await import("../use-subagent-transcript");

function wrapper({ children }: { children: ReactNode }) {
  return <ConversationEncryptionPolicyModeContext.Provider value={policyMode}>{children}</ConversationEncryptionPolicyModeContext.Provider>;
}

function detail(content: string): TaskDetail {
  return {
    task: { status: "running" },
    runs: [{ id: "run-1", transcript: [{
      role: "assistant", content, toolName: null, toolCalls: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    }] }],
  } as TaskDetail;
}

beforeEach(() => {
  cleanup();
  reapplyHappyDomGlobals();
  viewerGeneration = 1;
  viewerId = "viewer-a";
  policyMode = "plaintext_only";
  shadowContent = "protected";
  pending.length = 0;
  getTask.mockClear();
  getTaskContentV1.mockClear();
});

afterAll(() => {
  cleanup();
  mock.module("../../../../lib/api", () => actualApi);
  mock.module("../../../../hooks/use-auth", () => actualAuth);
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
    expect(getTaskContentV1).toHaveBeenCalledWith("task-1");

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
});
