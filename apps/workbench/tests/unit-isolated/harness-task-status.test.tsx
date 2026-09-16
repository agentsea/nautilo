import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const contexts = await import("../../src/adapters/runtime-contexts");
const taskContext = await import("../../src/contexts/task-state/task-state-context");
const api = await import("../../src/lib/api");
let research: { unitsCompleted: number; unitsTotal: number } | undefined;
let canonicalStatus: string | undefined;
let overlayStatus: string | undefined;
let durableStatus = "paused";
const stopTask = mock(async (_taskId: string) => {});
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
  useTaskState: () => ({ taskMap: canonicalStatus ? { task: { status: canonicalStatus, preparation: { research } } } : {}, busyIds: new Set(), stopTask }),
}));
mock.module("../../src/lib/api", () => ({ ...api,
  apiClient: { ...api.apiClient, getTask: async () => ({ task: { status: durableStatus }, runs: [] }) },
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
beforeEach(() => { reapplyHappyDomGlobals(); research = undefined; canonicalStatus = "paused"; overlayStatus = "running"; durableStatus = "paused"; stopTask.mockClear(); });
afterEach(cleanup);

test("canonical pause and awaiting reply override stale working overlays while preserving Stop and history", async () => {
  for (const status of ["paused", "awaiting"]) {
    canonicalStatus = status;
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
  expect(stopTask).toHaveBeenCalledTimes(2);
});

test("canonical resume and completion override stale paused or running overlays", async () => {
  canonicalStatus = "running"; overlayStatus = "paused";
  const view = render(card());
  await waitFor(() => expect(view.container.querySelector('[data-tool-card-state="running"]')).toBeTruthy());
  expect(view.container.querySelector('[data-testid="tool-card-spinner"]')).toBeTruthy();
  expect(view.getByTestId("preserved-transcript").getAttribute("data-running")).toBe("true");
  canonicalStatus = "completed"; overlayStatus = "running";
  view.rerender(card());
  await waitFor(() => expect(view.container.querySelector('[data-tool-card-state="success"]')).toBeTruthy());
  expect(view.container.querySelector('[data-testid="tool-card-spinner"]')).toBeNull();
  expect(view.queryByRole("button", { name: "Stop task" })).toBeNull();
  expect(view.getByTestId("preserved-transcript").getAttribute("data-running")).toBe("false");
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
