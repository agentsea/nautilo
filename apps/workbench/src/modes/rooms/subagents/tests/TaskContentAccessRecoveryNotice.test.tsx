import { reapplyHappyDomGlobals } from "../../../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import {
  shouldShowTaskContentAccessRecovery,
  TaskContentAccessRecoveryNotice,
  type TaskContentAccessRecoveryClient,
} from "../TaskContentAccessRecoveryNotice";

const coordinate = {
  taskId: "task-1",
  taskRunId: "run-1",
  checkpointId: "checkpoint-1",
  toolCallId: "tool-1",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("TaskContentAccessRecoveryNotice", () => {
  beforeEach(() => {
    cleanup();
    reapplyHappyDomGlobals();
  });

  test("submits the exact coordinate and waits for refreshed truth before hiding", async () => {
    const refreshed = deferred<{ recovery: null }>();
    const discover = mock()
      .mockResolvedValueOnce({ recovery: coordinate })
      .mockImplementationOnce(() => refreshed.promise);
    const recover = mock(async () => ({ outcome: "completed" as const }));
    const client = {
      getTaskContentAccessRecovery: discover,
      recoverTaskContentAccess: recover,
    } as TaskContentAccessRecoveryClient;
    const view = render(<TaskContentAccessRecoveryNotice
      taskId="task-1"
      taskStatus="errored"
      scopeKey="server-a:viewer-a:task-1"
      discoveryGeneration={1}
      client={client}
    />);
    const button = await view.findByRole("button", { name: "Check and continue" });
    fireEvent.click(button);
    await waitFor(() => expect(recover).toHaveBeenCalledWith(
      "task-1",
      coordinate,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    expect(view.getByTestId("task-content-access-recovery")).toBeTruthy();
    refreshed.resolve({ recovery: null });
    await waitFor(() => expect(view.queryByTestId("task-content-access-recovery")).toBeNull());
  });

  test("retains unknown and busy outcomes for explicit same-coordinate retry", async () => {
    const discover = mock(async () => ({ recovery: coordinate }));
    const recover = mock()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce({ outcome: "busy" as const });
    const client = {
      getTaskContentAccessRecovery: discover,
      recoverTaskContentAccess: recover,
    } as TaskContentAccessRecoveryClient;
    const view = render(<TaskContentAccessRecoveryNotice
      taskId="task-1"
      taskStatus="errored"
      scopeKey="server-a:viewer-a:task-1"
      discoveryGeneration={1}
      client={client}
    />);
    let button = await view.findByRole("button", { name: "Check and continue" });
    fireEvent.click(button);
    await waitFor(() => expect(view.getByText(/still unknown/i)).toBeTruthy());
    button = view.getByRole("button", { name: "Check and continue" });
    fireEvent.click(button);
    await waitFor(() => expect(view.getByText(/still settling/i)).toBeTruthy());
    expect(recover).toHaveBeenNthCalledWith(1, "task-1", coordinate, expect.anything());
    expect(recover).toHaveBeenNthCalledWith(2, "task-1", coordinate, expect.anything());
  });

  test("lets an offered crash-gap recovery run despite stale running status and retains busy", async () => {
    const recover = mock(async () => ({ outcome: "busy" as const }));
    const client = {
      getTaskContentAccessRecovery: mock(async () => ({ recovery: coordinate })),
      recoverTaskContentAccess: recover,
    } as TaskContentAccessRecoveryClient;
    const view = render(<TaskContentAccessRecoveryNotice
      taskId="task-1"
      taskStatus="running"
      scopeKey="server-a:viewer-a:task-1"
      discoveryGeneration={1}
      client={client}
    />);
    const button = await view.findByRole("button", { name: "Check and continue" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(view.getByText(/still settling/i)).toBeTruthy());
    expect(recover).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(false);
  });

  test("aborts and hides stale Task recovery across scope changes", async () => {
    const first = deferred<{ recovery: typeof coordinate }>();
    const signals: AbortSignal[] = [];
    const discover = mock((taskId: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) signals.push(options.signal);
      return taskId === "task-1" ? first.promise : Promise.resolve({ recovery: null });
    });
    const client = {
      getTaskContentAccessRecovery: discover,
      recoverTaskContentAccess: mock(async () => ({ outcome: "completed" as const })),
    } as TaskContentAccessRecoveryClient;
    const view = render(<TaskContentAccessRecoveryNotice
      taskId="task-1"
      taskStatus="errored"
      scopeKey="server-a:viewer-a:task-1"
      discoveryGeneration={1}
      client={client}
    />);
    view.rerender(<TaskContentAccessRecoveryNotice
      taskId="task-2"
      taskStatus="errored"
      scopeKey="server-b:viewer-b:task-2"
      discoveryGeneration={1}
      client={client}
    />);
    expect(signals.some((signal) => signal.aborted)).toBe(true);
    first.resolve({ recovery: coordinate });
    await Promise.resolve();
    expect(view.queryByTestId("task-content-access-recovery")).toBeNull();
  });

  test("exposes recovery only for verified plaintext Task detail scope", () => {
    expect(shouldShowTaskContentAccessRecovery({
      mode: "plaintext_only", viewerVerified: true, taskId: "task-1", scopeKey: "scope",
    })).toBe(true);
    for (const mode of ["shadow_encryption", "full_encryption", null]) {
      expect(shouldShowTaskContentAccessRecovery({
        mode, viewerVerified: true, taskId: "task-1", scopeKey: "scope",
      })).toBe(false);
    }
    expect(shouldShowTaskContentAccessRecovery({
      mode: "plaintext_only", viewerVerified: false, taskId: "task-1", scopeKey: "scope",
    })).toBe(false);
  });

  test("keeps an in-flight POST disabled across Task lifecycle rediscovery", async () => {
    const pending = deferred<{ outcome: "busy" }>();
    const recover = mock(() => pending.promise);
    const client = {
      getTaskContentAccessRecovery: mock(async () => ({ recovery: coordinate })),
      recoverTaskContentAccess: recover,
    } as TaskContentAccessRecoveryClient;
    const view = render(<TaskContentAccessRecoveryNotice
      taskId="task-1"
      taskStatus="errored"
      scopeKey="server-a:viewer-a:task-1"
      discoveryGeneration={1}
      client={client}
    />);
    const button = await view.findByRole("button", { name: "Check and continue" });
    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<TaskContentAccessRecoveryNotice
      taskId="task-1"
      taskStatus="running"
      scopeKey="server-a:viewer-a:task-1"
      discoveryGeneration={2}
      client={client}
    />);
    await waitFor(() => expect(client.getTaskContentAccessRecovery).toHaveBeenCalledTimes(2));
    expect((view.getByRole("button", { name: "Check and continue" }) as HTMLButtonElement).disabled).toBe(true);
    expect(recover).toHaveBeenCalledTimes(1);
    pending.resolve({ outcome: "busy" });
    await waitFor(() => expect((view.getByRole("button", { name: "Check and continue" }) as HTMLButtonElement).disabled).toBe(false));
  });
});
