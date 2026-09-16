import { useState } from "react";
import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReadyToWorkAggregateStatus, ReadyToWorkComponentId } from "../../../desktop/electron/ready-to-work-contract";
import type { DesktopReadyToWorkAPI } from "../lib/desktop";
import { AutoApproveBarView } from "./auto-approve-bar";
import {
  computeReadyToWorkPopoverPosition,
  ReadyToWorkSegment,
} from "./footer/ready-to-work-segment";
import { writeReadyToWorkPresentationMode } from "../lib/ready-to-work-presentation";

const componentIds: ReadyToWorkComponentId[] = ["voice", "auto_approve", "workstation", "computer_use", "coding_connection"];
let listener: ((next: ReadyToWorkAggregateStatus) => void) | null = null;
let nextStatus: ReadyToWorkAggregateStatus;
const get = mock(async () => nextStatus);
const restore = mock(async () => nextStatus);
const unsubscribe = mock(() => undefined);
const autoApproveToggle = mock((_enabled: boolean) => undefined);

const readyToWork = {
  get,
  enroll: async () => nextStatus,
  restore,
  disable: async () => nextStatus,
  onRestoreRendererOwners: () => () => undefined,
  acknowledgeRendererOwners: async () => undefined,
  reportRendererOwners: async () => nextStatus,
  onStatusChanged: (next: (status: ReadyToWorkAggregateStatus) => void) => {
    listener = next;
    return unsubscribe;
  },
} satisfies DesktopReadyToWorkAPI;

function aggregate(
  mode: "standard" | "ready",
  changes: Partial<Record<ReadyToWorkComponentId, Partial<ReadyToWorkAggregateStatus["components"][number]>>> = {},
): ReadyToWorkAggregateStatus {
  return {
    mode,
    components: componentIds.map((id) => ({
      id,
      state: mode === "ready" ? "ready" as const : "off_by_choice" as const,
      reason: mode === "ready" ? null : "not_selected" as const,
      repairTarget: null,
      ...changes[id],
    })),
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.hash}`}</output>;
}

function renderBar() {
  function TestBar() {
    const [enabled, setEnabled] = useState(false);
    return <AutoApproveBarView
      enabled={enabled}
      setEnabled={(next) => {
        autoApproveToggle(next);
        setEnabled(next);
      }}
      canToggle
      isDesktopShell
      statusSegment={<ReadyToWorkSegment
        isDesktopShell
        readyToWork={readyToWork}
        standardSegment={<span data-testid="workstation-segment">Workstation original</span>}
      />}
    />;
  }
  return render(<MemoryRouter initialEntries={["/"]}><TestBar /><LocationProbe /></MemoryRouter>);
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  window.localStorage.clear();
  listener = null;
  nextStatus = aggregate("standard");
  get.mockClear();
  restore.mockClear();
  unsubscribe.mockClear();
  autoApproveToggle.mockClear();
});

afterEach(() => cleanup());
describe("AutoApproveBar Ready to work slot", () => {
  test("replaces Workstation with Ready to work setup by default", async () => {
    const view = renderBar();
    const ready = await view.findByRole("button", { name: "Ready to work: Set up" });

    const strip = view.container.querySelector("div.flex.w-full.items-center.justify-end.gap-1.px-4.py-1");
    expect(strip?.textContent).toBe("Ready: Set up·Approve: off");
    expect(view.queryByTestId("workstation-segment")).toBeNull();
    fireEvent.click(ready);
    expect(view.getByTestId("location").textContent).toBe("/settings#startup");
  });

  test("returns the original Workstation control only for Individual controls", async () => {
    writeReadyToWorkPresentationMode("individual");
    const view = renderBar();
    await view.findByTestId("workstation-segment");
    expect(view.queryByText(/Ready to work:/)).toBeNull();
  });

  test("shows On only when every selected component is ready", async () => {
    nextStatus = aggregate("ready");
    const view = renderBar();

    await view.findByRole("button", { name: "Ready to work: On" });
    expect(view.queryByTestId("workstation-segment")).toBeNull();
  });

  test("shows the exact partial count and bounded failure copy", async () => {
    nextStatus = aggregate("ready", {
      voice: { state: "ready", repairTarget: "voice_settings" },
      computer_use: {
        state: "needs_attention",
        reason: "computer_use_provider_unavailable",
        repairTarget: "computer_use_settings",
      },
    });
    const view = renderBar();

    const trigger = await view.findByRole("button", { name: "Ready to work: 4/5 · Computer Use unavailable" });
    fireEvent.click(trigger);
    expect(await view.findAllByText("Computer Use unavailable.")).toHaveLength(2);
    expect(view.getByRole("button", { name: "Review Computer Use" }).textContent)
      .toBe("Needs attention: Computer Use unavailable.Review →");
    expect(view.queryByRole("button", { name: "Open Desktop permissions" })).toBeNull();
    expect(view.queryByRole("button", { name: "Open voice controls" })).toBeNull();
  });

  test("omits off-by-choice components from the exact denominator", async () => {
    nextStatus = aggregate("ready", {
      coding_connection: { state: "off_by_choice", reason: "not_selected" },
      computer_use: { state: "needs_attention", reason: "computer_use_setup_required", repairTarget: "computer_use_settings" },
    });
    const view = renderBar();

    await view.findByRole("button", { name: "Ready to work: 3/4 · Computer Use setup needed" });
  });

  test("counts every enabled coding harness separately and routes its repair", async () => {
    nextStatus = {
      ...aggregate("ready"),
      codingHarnesses: [
        { id: "codex", state: "ready", reason: null, repairTarget: "coding_connection_settings" },
        { id: "hermes-acp", state: "needs_attention", reason: "coding_harness_unavailable", repairTarget: "coding_connection_settings" },
      ],
    };
    const view = renderBar();
    const trigger = await view.findByRole("button", { name: "Ready to work: 5/6 · Hermes unavailable" });
    fireEvent.click(trigger);
    fireEvent.click(view.getByRole("button", { name: "Review Hermes" }));
    await waitFor(() => expect(view.getByTestId("location").textContent).toBe("/connections#hermes-acp"));
  });

  test("keeps Auto-approve independently clickable and confirmed", async () => {
    nextStatus = aggregate("ready");
    const view = renderBar();
    await view.findByRole("button", { name: "Ready to work: On" });

    fireEvent.click(view.getByTestId("auto-approve-toggle"));
    expect(view.getByRole("heading", { name: "Turn on Auto-Approve for this session?" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(autoApproveToggle).toHaveBeenCalledWith(true));
  });

  test("updates from the Desktop subscription", async () => {
    nextStatus = aggregate("ready");
    const view = renderBar();
    await view.findByRole("button", { name: "Ready to work: On" });

    await act(async () => {
      listener?.(aggregate("ready", {
        voice: { state: "needs_attention", reason: "owner_unavailable", repairTarget: "voice_settings" },
      }));
    });
    await view.findByRole("button", { name: "Ready to work: 4/5 · Voice unavailable" });
  });

  test("restores partial Ready and routes direct repair plus Startup settings actions", async () => {
    nextStatus = aggregate("ready", {
      computer_use: { state: "needs_attention", reason: "computer_use_setup_required", repairTarget: "computer_use_settings" },
    });
    restore.mockImplementationOnce(async () => aggregate("ready"));
    const view = renderBar();
    fireEvent.click(await view.findByRole("button", { name: "Ready to work: 4/5 · Computer Use setup needed" }));

    fireEvent.click(view.getByRole("button", { name: "Review Computer Use" }));
    await waitFor(() => expect(view.getByTestId("location").textContent).toBe("/connections#computer-use"));

    fireEvent.click(view.getByRole("button", { name: "Ready to work: 4/5 · Computer Use setup needed" }));
    fireEvent.click(view.getByRole("button", { name: "Restore Ready" }));
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    await view.findByRole("button", { name: "Ready to work: On" });

    fireEvent.click(view.getByRole("link", { name: "Startup settings" }));
    await waitFor(() => expect(view.getByTestId("location").textContent).toBe("/settings#startup"));
  });

  test("uses compact truthful loading and error states without claiming On", async () => {
    let rejectGet: ((cause: Error) => void) | null = null;
    get.mockImplementationOnce(() => new Promise<ReadyToWorkAggregateStatus>((_resolve, reject) => {
      rejectGet = reject;
    }));
    const view = renderBar();
    expect(view.getByText("Ready: Checking…")).toBeTruthy();

    await act(async () => { rejectGet?.(new Error("raw desktop error")); });
    await view.findByText("Ready: Unavailable");
    expect(view.queryByText("Ready: On")).toBeNull();
  });

  test("closes on Escape and outside pointer input while restoring trigger focus", async () => {
    nextStatus = aggregate("ready");
    const view = renderBar();
    const trigger = await view.findByRole("button", { name: "Ready to work: On" });
    fireEvent.click(trigger);
    const portaledDialog = await view.findByRole("dialog", { name: "Ready to work details" });
    expect(portaledDialog.parentElement).toBe(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.queryByRole("dialog", { name: "Ready to work details" })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    await view.findByRole("dialog", { name: "Ready to work details" });
    fireEvent.pointerDown(document.body);
    expect(view.queryByRole("dialog", { name: "Ready to work details" })).toBeNull();
  });

  test("shows the compact real-world Auto-approve-off state without wrapping controls", async () => {
    nextStatus = aggregate("ready", {
      auto_approve: {
        state: "needs_attention",
        reason: "owner_rejected",
        repairTarget: "auto_approve_settings",
      },
    });
    const view = renderBar();

    const ready = await view.findByRole("button", { name: "Ready to work: 4/5 · Auto-approve off" });
    expect(ready.textContent).toBe("Ready: 4/5 · Auto-approve off");
    expect(ready.className).toContain("whitespace-nowrap");
    fireEvent.click(ready);
    expect(view.queryByText(/feature owner/i)).toBeNull();
    expect(view.getByText("Off.")).toBeTruthy();

    const approve = view.getByRole("button", { name: "Auto-approve: off" });
    expect(approve.textContent).toBe("Approve: off");
    expect(approve.className).toContain("whitespace-nowrap");
    expect(approve.className).toContain("shrink-0");
  });

  test("clamps the portaled menu to a narrow right-hand viewport", () => {
    const trigger = {
      left: 650,
      right: 690,
      top: 700,
      bottom: 724,
    } as DOMRect;

    expect(computeReadyToWorkPopoverPosition(trigger, { innerWidth: 700, innerHeight: 800 }))
      .toEqual({ left: 370, width: 320, maxHeight: 688, bottom: 104 });

    expect(computeReadyToWorkPopoverPosition(trigger, { innerWidth: 240, innerHeight: 800 }))
      .toEqual({ left: 8, width: 224, maxHeight: 688, bottom: 104 });
  });
});
