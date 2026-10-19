import { reapplyHappyDomGlobals } from "../../../../../tests/bun-dom-preload";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { bindEncryptionDataOperationOwner } from "@nautilo/lattice-bridge";

import type { WorkbenchProtectedHumanTaskController } from
  "../../../../lib/protected-human-task-controller";
import {
  ProtectedTaskRunResult,
  protectedTaskRunResultRequestKey,
} from "../ProtectedTaskRunResult";

function controller(
  openResult: WorkbenchProtectedHumanTaskController["openResult"],
): WorkbenchProtectedHumanTaskController {
  return { openResult } as WorkbenchProtectedHumanTaskController;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function operationOwner(
  mode: "plaintext_only" | "shadow_encryption" | "encrypted_only",
  shadowBehavior: "fallback" | "strict" = "fallback",
) {
  return bindEncryptionDataOperationOwner({ policy: {
    resolve: async () => ({
      policy: { mode, shadowBehavior },
      revalidationToken: 1,
    }),
    revalidate: async () => {},
  } });
}

const base = {
  agentId: "agent-1",
  owner: operationOwner("encrypted_only"),
  refreshToken: "completed:1",
  scopeKey: "server-a:viewer-a:1",
  taskId: "task-1",
  taskRunId: "run-1",
};

describe("ProtectedTaskRunResult", () => {
  beforeEach(() => {
    cleanup();
    reapplyHappyDomGlobals();
  });

  test("renders ready, waiting, and unavailable outcomes truthfully", async () => {
    const cases = [
      {
        result: { status: "ready" as const, payload: {
          formatVersion: 1 as const, resultText: "private outcome", lastError: null,
        } },
        text: "private outcome",
      },
      {
        result: { status: "waiting" as const, reason: "result_not_mapped" as const },
        text: "still being prepared",
      },
      {
        result: { status: "unavailable" as const, reason: "integrity_failure" as const },
        text: "could not be verified",
      },
    ];
    for (const item of cases) {
      const view = render(<ProtectedTaskRunResult {...base}
        controller={controller(mock(async () => item.result))} />);
      await waitFor(() => expect(view.getByText(new RegExp(item.text, "i"))).toBeTruthy());
      cleanup();
    }
  });

  test("preserves precise unavailable status when Fallback has no ordinary sibling", async () => {
    const openResult = mock(async () => ({
      status: "unavailable" as const,
      reason: "result_not_protected" as const,
    }));
    const view = render(<ProtectedTaskRunResult {...base}
      owner={operationOwner("shadow_encryption", "fallback")}
      controller={controller(openResult)} />);
    await waitFor(() => expect(view.getByText(
      "This Task run does not have a protected result.",
    )).toBeTruthy());
    expect(view.queryByText("Opening protected result…")).toBeNull();
    expect(openResult).toHaveBeenCalledTimes(1);
  });

  test("submits exact identity and exposes retriable read errors", async () => {
    const openResult = mock()
      .mockRejectedValueOnce(new Error("device locked"))
      .mockResolvedValueOnce({ status: "ready" as const, payload: {
        formatVersion: 1 as const, resultText: null, lastError: "provider stopped",
      } });
    const view = render(<ProtectedTaskRunResult {...base}
      controller={controller(openResult)} />);
    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    expect(openResult).toHaveBeenNthCalledWith(1, {
      taskId: "task-1", taskRunId: "run-1", agentId: "agent-1",
    });
    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(view.getByText("provider stopped")).toBeTruthy());
    expect(openResult).toHaveBeenCalledTimes(2);
  });

  test("clears and fences decrypted state when the viewer scope changes", async () => {
    const first = deferred<Awaited<ReturnType<WorkbenchProtectedHumanTaskController["openResult"]>>>();
    const openResult = mock()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ status: "ready" as const, payload: {
        formatVersion: 1 as const, resultText: "viewer B result", lastError: null,
      } });
    const resultController = controller(openResult);
    const view = render(<ProtectedTaskRunResult {...base} controller={resultController} />);
    expect(await view.findByText("Opening protected result…")).toBeTruthy();
    view.rerender(<ProtectedTaskRunResult {...base}
      scopeKey="server-a:viewer-b:2" controller={resultController} />);
    await waitFor(() => expect(view.getByText("viewer B result")).toBeTruthy());
    first.resolve({ status: "ready", payload: {
      formatVersion: 1, resultText: "viewer A secret", lastError: null,
    } });
    await Promise.resolve();
    expect(view.queryByText("viewer A secret")).toBeNull();
    expect(protectedTaskRunResultRequestKey({
      scopeKey: base.scopeKey,
      taskId: base.taskId,
      taskRunId: base.taskRunId,
      agentId: base.agentId,
    })).not.toBe(protectedTaskRunResultRequestKey({
      scopeKey: "server-a:viewer-b:2",
      taskId: base.taskId,
      taskRunId: base.taskRunId,
      agentId: base.agentId,
    }));
  });

  test("does not invent a result read when exact run or Agent identity is absent", async () => {
    const openResult = mock(async () => ({ status: "waiting" as const,
      reason: "result_not_mapped" as const }));
    const missingRun = render(<ProtectedTaskRunResult {...base}
      taskRunId={null} controller={controller(openResult)} />);
    expect(missingRun.queryByTestId("protected-task-run-result")).toBeNull();
    cleanup();
    const missingAgent = render(<ProtectedTaskRunResult {...base}
      agentId={null} controller={controller(openResult)} />);
    expect(missingAgent.getByText(/identity is unavailable/i)).toBeTruthy();
    expect(openResult).not.toHaveBeenCalled();
  });
});
