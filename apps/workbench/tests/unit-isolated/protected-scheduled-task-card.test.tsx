import "../bun-dom-preload";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { bindEncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import type { TaskRunSummaryV1 } from "@nautilo/types";

import type {
  ProtectedScheduledTaskHistory,
  ProtectedScheduledTaskRow,
} from "../../src/pages/scheduled-tasks/use-scheduled-tasks";

const renderProtectedResult = mock((props: Readonly<{ taskRunId: string }>) => (
  <div data-testid="selected-protected-result">
    {props.taskRunId === "failed-run" ? "Run failed before producing a result." : "Opened result"}
  </div>
));

mock.module("../../src/modes/rooms/subagents/ProtectedTaskRunResult", () => ({
  ProtectedTaskRunResult: renderProtectedResult,
}));

const { ProtectedScheduledTaskCard } = await import("../../src/pages/scheduled-tasks/ProtectedScheduledTaskCard");

function openedRow(): ProtectedScheduledTaskRow {
  return {
    availability: "opened",
    task: {
      id: "protected-schedule",
      agentId: "agent-one",
      agentName: "Genie",
      scheduleKind: "cron",
      cron: "0 9 * * 1",
      nextFireAt: "2026-10-12T09:00:00.000Z",
      status: "pending",
    } as ProtectedScheduledTaskRow["task"],
    prompt: "Prepare a private weekly digest",
    expectedOutput: null,
    retainedHistoricalError: null,
  };
}

function run(id: string, status: string, startedAt: string | null): TaskRunSummaryV1 {
  return {
    id,
    status,
    modelId: null,
    startedAt,
    completedAt: null,
    content: {
      dtoVersion: 1,
      status: "unavailable",
      reason: "waiting_for_authorization",
    },
  };
}

const actions = {
  owner: bindEncryptionDataOperationOwner({ policy: {
    resolve: async () => ({
      policy: { mode: "encrypted_only", shadowBehavior: "fallback" },
      revalidationToken: 1,
    }),
    revalidate: async () => {},
  } }),
  onEnable: mock(() => {}),
  onDisable: mock(() => {}),
  onRemove: mock(() => {}),
  onOpenHistory: mock(() => {}),
  onCloseHistory: mock(() => {}),
};

function readyHistory(): ProtectedScheduledTaskHistory {
  return {
    taskId: "protected-schedule",
    state: "ready",
    runs: [
      run("pending-run", "pending", null),
      run("failed-run", "errored", "2026-10-08T10:00:00.000Z"),
      run("completed-run", "completed", "2026-10-09T10:00:00.000Z"),
    ],
  };
}

describe("ProtectedScheduledTaskCard run history", () => {
  afterEach(() => {
    cleanup();
    renderProtectedResult.mockClear();
    actions.onEnable.mockClear();
    actions.onDisable.mockClear();
    actions.onRemove.mockClear();
    actions.onOpenHistory.mockClear();
    actions.onCloseHistory.mockClear();
  });

  test.each(["completed", "cancelled", "errored"])(
    "%s history cannot advertise or re-enable a future occurrence", (status) => {
      const row = openedRow();
      const view = render(
        <ProtectedScheduledTaskCard row={{ ...row, task: { ...row.task, status } }}
          {...actions} controller={undefined} scopeKey="scope-a" history={null} />,
      );
      const toggle = view.getByRole("checkbox", { name: "Finished protected schedule" }) as HTMLInputElement;
      expect(toggle.checked).toBe(false);
      expect(toggle.disabled).toBe(true);
      expect((view.getByRole("button", { name: "Remove protected schedule" }) as HTMLButtonElement).disabled)
        .toBe(true);
      expect(view.getByText("No future runs")).toBeTruthy();
      expect(view.queryByText(/^next /)).toBeNull();
      fireEvent.click(view.getByRole("button", { name: "Run history" }));
      expect(actions.onOpenHistory).toHaveBeenCalledWith("protected-schedule");
      expect(actions.onEnable).not.toHaveBeenCalled();
      expect(actions.onDisable).not.toHaveBeenCalled();
      expect(actions.onRemove).not.toHaveBeenCalled();
    },
  );

  test("a terminal refresh disables an open Stop confirmation and preserves result history", () => {
    const row = openedRow();
    const view = render(
      <ProtectedScheduledTaskCard row={row} {...actions}
        controller={undefined} scopeKey="scope-a" history={readyHistory()} />,
    );
    fireEvent.click(view.getByRole("button", { name: "Remove protected schedule" }));
    view.rerender(
      <ProtectedScheduledTaskCard row={{ ...row, task: { ...row.task, status: "cancelled" } }}
        {...actions} controller={undefined} scopeKey="scope-a" history={readyHistory()} />,
    );
    expect((view.getByRole("button", { name: "confirm" }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.click(view.getByRole("button", { name: /completed/i }));
    expect(view.getByTestId("selected-protected-result").textContent).toBe("Opened result");
    expect(actions.onRemove).not.toHaveBeenCalled();
  });

  test("opens history on demand and reports loading and failures truthfully", () => {
    const view = render(
      <ProtectedScheduledTaskCard row={openedRow()} {...actions}
        controller={undefined} scopeKey="scope-a"
        history={null} />,
    );

    fireEvent.click(view.getByRole("button", { name: "Run history" }));
    expect(actions.onOpenHistory).toHaveBeenCalledWith("protected-schedule");

    view.rerender(
      <ProtectedScheduledTaskCard row={openedRow()} {...actions}
        controller={undefined} scopeKey="scope-a"
        history={{ taskId: "protected-schedule", state: "loading" }} />,
    );
    expect(view.getByRole("status").textContent).toBe("Loading run history…");

    view.rerender(
      <ProtectedScheduledTaskCard row={openedRow()} {...actions}
        controller={undefined} scopeKey="scope-a"
        history={{
          taskId: "protected-schedule",
          state: "error",
          message: "Device access is unavailable",
        }} />,
    );
    expect(view.getByRole("alert").textContent).toContain("Device access is unavailable");
    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    expect(actions.onOpenHistory).toHaveBeenCalledTimes(2);
  });

  test("shows an authenticated historical error only while protected custody is open", () => {
    const opened = { ...openedRow(), retainedHistoricalError: "Provider unavailable before repair" };
    const view = render(
      <ProtectedScheduledTaskCard row={opened} {...actions}
        controller={undefined} scopeKey="scope-a"
        history={null} />,
    );
    expect(view.getByTestId("task-retained-historical-error").textContent)
      .toBe("Earlier error: Provider unavailable before repair");

    view.rerender(
      <ProtectedScheduledTaskCard row={{
        availability: "unavailable",
        task: opened.task,
        reason: "waiting_for_authorization",
      }} {...actions} controller={undefined}
        scopeKey="scope-a" history={null} />,
    );
    expect(view.queryByTestId("task-retained-historical-error")).toBeNull();
    expect(view.container.textContent).not.toContain("Provider unavailable before repair");
    expect(view.container.textContent).not.toContain("Earlier error:");
  });

  test("requires an exact stored run selection and never displays run ids", () => {
    const history = readyHistory();
    const view = render(
      <ProtectedScheduledTaskCard row={openedRow()} {...actions}
        controller={undefined} scopeKey="scope-a"
        history={history} />,
    );

    expect(view.getByText("Choose a run to open its protected result.")).toBeTruthy();
    expect(view.getByText("pending")).toBeTruthy();
    expect(view.getByText("errored")).toBeTruthy();
    expect(view.getByText("completed")).toBeTruthy();
    expect(renderProtectedResult).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain("pending-run");
    expect(view.container.textContent).not.toContain("failed-run");
    expect(view.container.textContent).not.toContain("completed-run");

    fireEvent.click(view.getByRole("button", { name: /errored/i }));
    expect(renderProtectedResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentId: "agent-one",
        owner: actions.owner,
        scopeKey: "scope-a",
        taskId: "protected-schedule",
        taskRunId: "failed-run",
      }),
      undefined,
    );
    expect(view.getByText("Run failed before producing a result.")).toBeTruthy();
    expect(view.container.textContent).not.toContain("failed-run");
  });

  test("clears the selected result immediately when viewer scope changes", () => {
    const history = readyHistory();
    const view = render(
      <ProtectedScheduledTaskCard row={openedRow()} {...actions}
        controller={undefined} scopeKey="scope-a"
        history={history} />,
    );
    fireEvent.click(view.getByRole("button", { name: /completed/i }));
    expect(view.getByTestId("selected-protected-result")).toBeTruthy();

    view.rerender(
      <ProtectedScheduledTaskCard row={openedRow()} {...actions}
        controller={undefined} scopeKey="scope-b"
        history={history} />,
    );
    expect(view.queryByTestId("selected-protected-result")).toBeNull();
    expect(view.getByText("Choose a run to open its protected result.")).toBeTruthy();
  });
});
