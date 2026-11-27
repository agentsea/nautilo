import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  CapabilitySlug,
  MemoryRecoveryPreview,
  MemoryRecoveryRequest,
  MemoryRecoveryResult,
} from "@nautilo/types";

let capabilities = new Set<CapabilitySlug>();
const preview = mock(async (_roomId: string): Promise<MemoryRecoveryPreview> => fixture());
const run = mock(async (_request: MemoryRecoveryRequest): Promise<MemoryRecoveryResult> => ({ status: "queued" }));
mock.module("../../../hooks/use-can", () => ({ useCan: () => (capability: CapabilitySlug) => capabilities.has(capability) }));
mock.module("../../../lib/api", () => ({ apiClient: { admin: { memoryRecovery: { preview, run } } } }));

const { MemoryRecoveryCard, memoryRecoveryStatusText } = await import("./memory-recovery-card");

function fixture(): MemoryRecoveryPreview {
  return {
    roomId: "room-1",
    generatedAt: "2026-11-27T10:00:00.000Z",
    journal: { generation: 3, cursor: 8, lastCompletedAt: null, target: 12, rebuild: "available" },
    reflection: { pending: 2, completed: 6 },
    memory: { pending: 1, covered: 7, latestOutcome: "no_change" },
    jobs: [{
      id: "job-1", lane: "stenographer", version: "v4", stage: "model_call",
      reason: "provider_failed", modelId: null, action: "retry_with_model",
    }],
    hasMoreJobs: false,
    models: [{ id: "anthropic:haiku", label: "Haiku", lanes: ["stenographer"] }],
  };
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  capabilities = new Set(["read_server_settings", "manage_server_operations"]);
  preview.mockClear();
  run.mockClear();
  preview.mockImplementation(async () => fixture());
  run.mockImplementation(async () => ({ status: "queued" }));
});
afterEach(cleanup);

describe("MemoryRecoveryCard", () => {
  test("previews without executing, runs an explicit current job, verifies it, and invalidates edited input", async () => {
    const view = render(<MemoryRecoveryCard />);
    const user = userEvent.setup();
    const room = view.getByLabelText("Room ID");
    await user.type(room, "room-1");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Preview" })); });

    await waitFor(() => expect(view.getByTestId("memory-recovery-preview")).toBeTruthy());
    expect(preview).toHaveBeenCalledWith("room-1");
    expect(run).not.toHaveBeenCalled();
    expect(view.getByText("8 / 12")).toBeTruthy();
    expect(view.getByText("Last step: model call")).toBeTruthy();
    expect(view.getByText("Failure: provider failed")).toBeTruthy();

    await user.selectOptions(view.getByLabelText("Connected model for this job"), "anthropic:haiku");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Run with selected model" })); });
    await waitFor(() => expect(run).toHaveBeenCalledWith({
      roomId: "room-1", action: "retry_with_model", lane: "stenographer",
      jobId: "job-1", version: "v4", modelId: "anthropic:haiku",
    }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    expect(view.getByRole("status").textContent).toContain("Queued");

    await user.clear(room);
    await user.type(room, "room-2");
    expect(view.queryByTestId("memory-recovery-preview")).toBeNull();
    expect(view.queryByRole("status")).toBeNull();
  });

  test("labels every manual outcome and a clear Room without jobs", async () => {
    expect(memoryRecoveryStatusText("queued")).toContain("refresh this Room later");
    expect(memoryRecoveryStatusText("already_queued")).toContain("Conflict");
    expect(memoryRecoveryStatusText("already_queued")).toContain("already queued");
    expect(memoryRecoveryStatusText("blocked")).toContain("Blocked");
    expect(memoryRecoveryStatusText("stale")).toContain("stale");
    preview.mockImplementation(async () => ({ ...fixture(), jobs: [], journal: { ...fixture().journal, rebuild: "unavailable" } }));
    const view = render(<MemoryRecoveryCard />);
    const user = userEvent.setup();
    await user.type(view.getByLabelText("Room ID"), "room-1");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Preview" })); });
    await waitFor(() => expect(view.getByText("No recovery job is currently available for this Room.")).toBeTruthy());
    expect(run).not.toHaveBeenCalled();
  });

  test("locks Room identity during requests and invalidates an unverifiable recovery", async () => {
    let finishPreview!: (value: MemoryRecoveryPreview) => void;
    preview.mockImplementationOnce(() => new Promise((resolve) => { finishPreview = resolve; }));
    const view = render(<MemoryRecoveryCard />);
    const user = userEvent.setup();
    const room = view.getByLabelText("Room ID") as HTMLInputElement;
    await user.type(room, "room-1");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Preview" })); });
    expect(room.disabled).toBe(true);
    finishPreview(fixture());
    await waitFor(() => expect(view.getByTestId("memory-recovery-preview")).toBeTruthy());

    run.mockRejectedValueOnce(new Error("unknown outcome"));
    await user.selectOptions(view.getByLabelText("Connected model for this job"), "anthropic:haiku");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Run with selected model" })); });
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("could not be confirmed"));
    expect(view.queryByTestId("memory-recovery-preview")).toBeNull();
    expect(room.disabled).toBe(false);

    preview.mockImplementationOnce(async () => fixture());
    preview.mockImplementationOnce(async () => { throw new Error("verification unavailable"); });
    run.mockResolvedValueOnce({ status: "queued" });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Preview" })); });
    await waitFor(() => expect(view.getByTestId("memory-recovery-preview")).toBeTruthy());
    await user.selectOptions(view.getByLabelText("Connected model for this job"), "anthropic:haiku");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Run with selected model" })); });
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("verification refresh failed"));
    expect(view.queryByTestId("memory-recovery-preview")).toBeNull();
  });

  test("excludes the prior model and explains when no alternative is eligible", async () => {
    preview.mockImplementation(async () => ({
      ...fixture(),
      jobs: [{ ...fixture().jobs[0]!, modelId: "anthropic:haiku" }],
    }));
    const view = render(<MemoryRecoveryCard />);
    const user = userEvent.setup();
    await user.type(view.getByLabelText("Room ID"), "room-1");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Preview" })); });
    await waitFor(() => expect(view.getByText("No other connected model is eligible for this job.")).toBeTruthy());
    expect(view.queryByLabelText("Connected model for this job")).toBeNull();
    expect(view.getByRole("button", { name: "Run with selected model" }).hasAttribute("disabled")).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});
