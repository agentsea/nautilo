import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const contexts = await import("../../src/adapters/runtime-contexts");
const taskContext = await import("../../src/contexts/task-state/task-state-context");
const api = await import("../../src/lib/api");
const { ApiError } = await import("@nautilo/api-client/browser");
let research: { unitsCompleted: number; unitsTotal: number } | undefined;
let canonicalStatus: string | undefined;
let overlayStatus: string | undefined;
let durableStatus = "paused";
let durableFundingSource: "personal" | "server" | null = null;
let durableFundingFailure: string | null = null;
const stopTask = mock(async (_taskId: string) => {});
const refresh = mock(async () => {});
const pauseTaskApi = mock(async (_taskId: string) => ({
  taskId: "task", status: "paused", message: "Task paused",
}));
const unpauseTaskApi = mock(async (_taskId: string) => ({
  taskId: "task", status: "running", message: "Task resumed",
}));
const stopTaskApi = mock(async (_taskId: string) => {
  durableStatus = "cancelled";
  canonicalStatus = "cancelled";
  return { taskId: "task", status: "cancelled", message: "Task stopped" };
});
mock.module("../../src/adapters/runtime-contexts", () => ({ ...contexts,
  useConversationEncryptionPolicyMode: () => "shadow_encryption",
  useToolActivity: () => [{ toolCallId: "dispatch", toolName: "in_background", args: {}, status: "ok", startedAt: 10 }],
  useRunningSubagents: () => ({ list: overlayStatus ? [{ taskId: "task", status: overlayStatus,
    researchProgress: research, harnessActivity: [], startedAtMs: 10, line3: "The model is responding" }] : [] }),
}));
mock.module("../../src/hooks/use-auth", () => ({
  useAuth: () => ({
    viewerGeneration: 1,
    viewer: { isVerified: true, sessionUserId: "task-owner" },
  }),
}));
mock.module("../../src/contexts/task-state/task-state-context", () => ({ ...taskContext,
  useTaskState: () => ({
    taskMap: canonicalStatus ? { task: {
      status: canonicalStatus,
      preparation: { research },
      fundingFailure: durableFundingFailure,
    } } : {},
    busyIds: new Set(),
    refresh,
    stopTask,
  }),
}));
mock.module("../../src/lib/api", () => ({ ...api,
  apiClient: {
    getTaskContentV1: async () => ({ task: { id: "task" }, definition: { status: "ordinary" } }),
    getTask: async () => ({
      task: { status: durableStatus, fundingFailure: durableFundingFailure },
      runs: durableFundingSource || durableFundingFailure ? [{
        fundingSource: durableFundingSource,
        fundingFailure: durableFundingFailure,
      }] : [],
    }),
    pauseTask: pauseTaskApi,
    unpauseTask: unpauseTaskApi,
    stopTask: stopTaskApi,
  },
}));
mock.module("../../src/modes/rooms/subagents/use-subagent-transcript", () => ({
  useSubagentTranscript: () => ({ error: null, messages: [{ key: "read", role: "tool", toolName: "file",
    toolCallId: "read", toolStatus: "success", resultText: "Saved source bytes", content: "", createdAt: "2026-01-01" }] }),
}));
mock.module("../../src/modes/rooms/subagents/VirtualTranscriptRows", () => ({
  ScrollableTaskTranscript: ({ isRunning }: { isRunning: boolean }) => <div data-testid="preserved-transcript" data-running={String(isRunning)}>Saved source bytes</div>,
}));
const { harnessTaskToolRenderers } = await import("../../src/modes/rooms/subagents/HarnessTaskToolCard");
const Card = harnessTaskToolRenderers.in_background;
function card() { return <Card toolName="in_background" toolCallId="dispatch" args={{}} status={{ type: "complete" }}
  result={{ taskId: "task", execution: "native", status: "pending", message: "The task is running in the background." }} />; }
beforeEach(() => {
  reapplyHappyDomGlobals();
  research = undefined;
  canonicalStatus = "paused";
  overlayStatus = "running";
  durableStatus = "paused";
  durableFundingSource = null;
  durableFundingFailure = null;
  stopTask.mockClear();
  refresh.mockClear();
  pauseTaskApi.mockClear();
  unpauseTaskApi.mockClear();
  stopTaskApi.mockClear();
  stopTaskApi.mockImplementation(async (_taskId: string) => {
    durableStatus = "cancelled";
    canonicalStatus = "cancelled";
    return { taskId: "task", status: "cancelled", message: "Task stopped" };
  });
  unpauseTaskApi.mockImplementation(async (_taskId: string) => ({
    taskId: "task", status: "running", message: "Task resumed",
  }));
});
afterEach(cleanup);

test("canonical pause and awaiting reply override stale working overlays while preserving Stop and history", async () => {
  for (const status of ["paused", "awaiting"]) {
    canonicalStatus = status;
    durableStatus = status;
    const view = render(card());
    await waitFor(() => expect(view.container.querySelector(`[data-tool-card-state="${status}"]`)).toBeTruthy());
    expect(view.container.querySelector('[data-testid="tool-card-spinner"]')).toBeNull();
    expect(view.container.querySelector('[role="group"]')?.getAttribute("aria-label")).toContain(status === "paused" ? "paused" : "awaiting reply");
    expect(view.container.textContent).not.toContain("The model is responding");
    expect(view.container.textContent).not.toContain("The task is running in the background");
    expect(view.getByTestId("preserved-transcript").getAttribute("data-running")).toBe("false");
    expect(view.container.textContent).toContain("Saved source bytes");
    fireEvent.click(view.getByRole("button", { name: "Stop task" }));
    await waitFor(() => expect(view.container.querySelector('[data-tool-card-state="cancelled"]')).toBeTruthy());
    view.unmount();
  }
  expect(stopTaskApi).toHaveBeenCalledTimes(2);
});

test("canonical resume and completion override stale paused or running overlays", async () => {
  canonicalStatus = "running"; overlayStatus = "paused"; durableStatus = "running";
  const view = render(card());
  await waitFor(() => expect(view.container.querySelector('[data-tool-card-state="running"]')).toBeTruthy());
  expect(view.container.querySelector('[data-testid="tool-card-spinner"]')).toBeTruthy();
  expect(view.getByTestId("preserved-transcript").getAttribute("data-running")).toBe("true");
  canonicalStatus = "completed"; overlayStatus = "running"; durableStatus = "completed";
  view.rerender(card());
  await waitFor(() => expect(view.container.querySelector('[data-tool-card-state="success"]')).toBeTruthy());
  expect(view.container.querySelector('[data-testid="tool-card-spinner"]')).toBeNull();
  expect(view.queryByRole("button", { name: "Stop task" })).toBeNull();
  expect(view.getByTestId("preserved-transcript").getAttribute("data-running")).toBe("false");
});

test("stale personal credentials disable Resume and show fresh-task recovery", async () => {
  canonicalStatus = undefined;
  overlayStatus = undefined;
  durableStatus = "paused";
  durableFundingSource = "personal";
  durableFundingFailure = "personal_provider_unavailable";
  unpauseTaskApi.mockImplementation(async () => {
    throw new ApiError(409, "personal_credential_stale");
  });
  const view = render(card());

  const resume = await view.findByRole("button", { name: "Resume" });
  expect(resume.hasAttribute("disabled")).toBe(false);
  fireEvent.click(resume);

  await waitFor(() => expect(view.container.textContent).toContain(
    "The Personal API key saved for this run changed. Start a fresh task",
  ));
  expect(view.getByRole("button", { name: "Resume" }).hasAttribute("disabled")).toBe(true);
  expect(view.getByRole("link", { name: "Personal API keys" }).getAttribute("href"))
    .toBe("/settings#personal-provider-keys");
});

test("a completed Stop response never invents a cancelled presentation", async () => {
  canonicalStatus = undefined;
  overlayStatus = undefined;
  durableStatus = "paused";
  stopTaskApi.mockImplementation(async () => {
    durableStatus = "completed";
    canonicalStatus = "completed";
    return { taskId: "task", status: "completed", message: "Task already completed" };
  });
  const view = render(card());

  fireEvent.click(await view.findByRole("button", { name: "Stop task" }));
  await waitFor(() => expect(stopTaskApi).toHaveBeenCalledTimes(1));
  view.rerender(card());

  await waitFor(() => expect(view.container.querySelector('[data-tool-card-state="success"]')).toBeTruthy());
  expect(view.container.textContent).not.toContain("Stopped by you");
  expect(view.container.querySelector('[data-tool-card-state="cancelled"]')).toBeNull();
});

test("a cancelled quota-failed Task keeps its funding source without obsolete Resume guidance", async () => {
  canonicalStatus = undefined;
  overlayStatus = undefined;
  durableStatus = "cancelled";
  durableFundingSource = "personal";
  durableFundingFailure = "personal_provider_unavailable";
  const view = render(card());

  await waitFor(() => expect(
    view.container.querySelector('[data-tool-card-state="cancelled"]'),
  ).toBeTruthy());
  expect(view.getByTestId("task-funding-source").textContent).toBe("Personal API key");
  expect(view.queryByTestId("task-funding-recovery")).toBeNull();
  expect(view.container.textContent).not.toContain("then resume with the same key");
  expect(view.container.textContent).toContain("Saved source bytes");
});

test("reconnected cards use durable paused Task truth without a live overlay", async () => {
  canonicalStatus = undefined; overlayStatus = undefined;
  const view = render(card());
  await waitFor(() => expect(view.container.querySelector('[data-tool-card-state="paused"]')).toBeTruthy());
  expect(view.container.querySelector('[data-testid="tool-card-spinner"]')).toBeNull();
  expect(view.getByRole("button", { name: "Stop task" })).toBeTruthy();
  expect(view.getByTestId("preserved-transcript").getAttribute("data-running")).toBe("false");
});


test("background audit card updates its visible percentage from canonical progress while paused or running", async () => {
  research = { unitsCompleted: 4, unitsTotal: 15 };
  const view = render(card());
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("27");
  canonicalStatus = "running";
  research = { unitsCompleted: 5, unitsTotal: 15 };
  view.rerender(card());
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("33");
  await waitFor(() => expect(view.container.textContent).toContain("5/15 review units complete"));
});
