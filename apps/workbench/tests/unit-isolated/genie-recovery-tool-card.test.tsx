import { expect, mock, test } from "bun:test";
import { createElement } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { reapplyHappyDomGlobals } from "../bun-dom-preload";

mock.module("../../src/hooks/use-auth", () => ({ useAuth: () => ({ session: { getAccessToken: async () => "token" } }) }));
mock.module("../../src/lib/desktop", () => ({ isDesktop: false, desktopAPI: null }));
mock.module("../../src/adapters/runtime-contexts", () => ({ useToolActivity: () => [] }));
const { GenieRecoveryAction, parseGenieRecoveryToolResult } = await import("../../src/components/tool-card/genie-recovery");
const { ToolCard } = await import("../../src/components/tool-card/tool-card");

const recovery = (target: string, requirement: string, domainTool: string) => JSON.stringify({ version: 1, text: "Recover safely.", recovery: { target, requirement, domainTool } });
function Location() { const location = useLocation(); return createElement("output", { "data-testid": "location" }, `${location.pathname}${location.hash}`); }
function action(toolName: string, raw: string) {
  const parsed = parseGenieRecoveryToolResult(toolName, raw);
  if (!parsed) throw new Error("test fixture must parse");
  return render(createElement(MemoryRouter, { initialEntries: ["/"] }, createElement(Location), createElement("div", { onClick: () => { throw new Error("parent click"); }, onKeyDown: () => { throw new Error("parent key"); } }, createElement(GenieRecoveryAction, { recovery: parsed, stopParent: (event) => event.stopPropagation() }))));
}

test("recovery action is inert until Human click, stops parent click/key, and reveals current Google target", () => {
  reapplyHappyDomGlobals();
  const view = action("google_workspace", recovery("connections.google", "login", "google_workspace"));
  const button = view.getByRole("button", { name: "Open Google Workspace" });
  expect(view.getByTestId("location").textContent).toBe("/");
  fireEvent.keyDown(button, { key: "Enter" });
  fireEvent.keyDown(button, { key: " " });
  fireEvent.click(button);
  expect(view.getByTestId("location").textContent).toBe("/connections#google");
});

test("browser customization uses the existing local route only after click", () => {
  reapplyHappyDomGlobals();
  const view = action("launch_customization", recovery("genie.customization", "human_enablement", "launch_customization"));
  fireEvent.click(view.getByRole("button", { name: "Open Customize Genie" }));
  expect(view.getByTestId("location").textContent).toBe("/customize-genie");
});

test("successful customization recovery ToolCards expand on rehydration and a live result without presenting", async () => {
  reapplyHappyDomGlobals();
  const raw = recovery("genie.customization", "human_enablement", "launch_customization");
  const card = (result: string | undefined, status: "running" | "complete", activityOverride?: object) => createElement(
    MemoryRouter,
    { initialEntries: ["/"] },
    createElement(Location),
    createElement(ToolCard, {
      toolName: "launch_customization",
      toolCallId: "customization-visible",
      args: { confirmed: true },
      result,
      status: { type: status },
      ...(activityOverride ? { activityOverride: activityOverride as never } : {}),
    }),
  );

  const rehydrated = render(card(raw, "complete"));
  await waitFor(() => expect(rehydrated.getByRole("group").getAttribute("aria-expanded")).toBe("true"));
  expect(rehydrated.getByRole("button", { name: "Open Customize Genie" })).toBeTruthy();
  expect(rehydrated.getByTestId("location").textContent).toBe("/");
  rehydrated.unmount();

  const live = render(card(undefined, "running", {
    toolCallId: "customization-visible",
    toolName: "launch_customization",
    args: { confirmed: true },
    status: "running",
  }));
  expect(live.getByRole("group").getAttribute("aria-expanded")).toBe("false");
  expect(live.queryByRole("button", { name: "Open Customize Genie" })).toBeNull();
  expect(live.getByTestId("location").textContent).toBe("/");
  live.rerender(card(undefined, "complete", {
    toolCallId: "customization-visible",
    toolName: "launch_customization",
    args: { confirmed: true },
    status: "ok",
    result: raw,
  }));
  await waitFor(() => expect(live.getByRole("group").getAttribute("aria-expanded")).toBe("true"));
  expect(live.getByRole("button", { name: "Open Customize Genie" })).toBeTruthy();
  expect(live.getByTestId("location").textContent).toBe("/");
});

test("malformed or mismatched successful recovery results do not expand a generic ToolCard", async () => {
  reapplyHappyDomGlobals();
  const view = render(createElement(MemoryRouter, { initialEntries: ["/"] }, createElement(Location), createElement(ToolCard, {
    toolName: "launch_customization",
    toolCallId: "customization-invalid",
    args: { confirmed: true },
    result: recovery("connections.codex", "human_enablement", "launch_customization"),
    status: { type: "complete" },
  })));
  await waitFor(() => expect(view.getByRole("group").getAttribute("aria-expanded")).toBe("false"));
  expect(view.queryByRole("button", { name: "Open Customize Genie" })).toBeNull();
  expect(view.getByTestId("location").textContent).toBe("/");
});

test("strict correspondence accepts four matching SSH rows and keeps mixed/sentinel/raw inputs inert", () => {
  const row = (name: string) => ({ name, recovery: JSON.parse(recovery("connections.ssh", "pin", name)) });
  expect(parseGenieRecoveryToolResult("discover_tools", JSON.stringify([row("structured_ssh_auth"), row("structured_ssh_exec"), row("structured_ssh_copy_upload"), row("structured_ssh_copy_download")]))?.recovery.target).toBe("connections.ssh");
  expect(parseGenieRecoveryToolResult("discover_tools", JSON.stringify([row("structured_ssh_auth"), { name: "structured_ssh_output", recovery: {} }]))).toBeNull();
  expect(parseGenieRecoveryToolResult("google_workspace", "NAUTILO_ACTION:google_auth_required")).toBeNull();
  expect(parseGenieRecoveryToolResult("task", "[Open Codex](/connections#codex)")).toBeNull();
  expect(parseGenieRecoveryToolResult("task", recovery("connections.codex", "pin", "task"))).toBeNull();
  expect(parseGenieRecoveryToolResult("in_background", recovery("connections.codex", "login", "task"))).toBeNull();
  expect(parseGenieRecoveryToolResult("google_workspace", recovery("connections.google", "desktop", "google_workspace"))).toBeNull();
  expect(parseGenieRecoveryToolResult("launch_customization", recovery("connections.codex", "human_enablement", "launch_customization"))).toBeNull();
  expect(parseGenieRecoveryToolResult("task", recovery("connections.google", "login", "task"))).toBeNull();
});

test("actual ToolCard reads a live error over a synthetic result and remains Human-clicked", () => {
  reapplyHappyDomGlobals();
  const error = recovery("connections.google", "login", "google_workspace");
  const view = render(createElement(MemoryRouter, { initialEntries: ["/"] }, createElement(Location), createElement(ToolCard, {
    toolName: "google_workspace", toolCallId: "google-live", args: {}, result: "Done", status: { type: "complete" }, defaultExpanded: true,
    activityOverride: { toolCallId: "google-live", toolName: "google_workspace", args: {}, status: "error", error } as never,
  })));
  const button = view.getByRole("button", { name: "Open Google Workspace" });
  expect(view.getByTestId("location").textContent).toBe("/");
  fireEvent.click(button);
  expect(view.getByTestId("location").textContent).toBe("/connections#google");
});

test("actual ToolCard reads a live result and renders its readable fallback text", () => {
  reapplyHappyDomGlobals();
  const result = JSON.stringify({ version: 1, text: "Sign in on the authorized Desktop, then retry.", recovery: { target: "connections.google", requirement: "login", domainTool: "google_workspace" } });
  const view = render(createElement(MemoryRouter, { initialEntries: ["/"] }, createElement(ToolCard, {
    toolName: "google_workspace", toolCallId: "google-result", args: {}, result: "Done", status: { type: "complete" }, defaultExpanded: true,
    activityOverride: { toolCallId: "google-result", toolName: "google_workspace", args: {}, status: "ok", result } as never,
  })));
  expect(view.getByText("Sign in on the authorized Desktop, then retry.")).toBeTruthy();
  expect(view.getByRole("button", { name: "Open Google Workspace" })).toBeTruthy();
});

test("actual ToolCards are independently repeat-clickable and malformed or old payloads stay inert", () => {
  reapplyHappyDomGlobals();
  const raw = recovery("connections.google", "login", "google_workspace");
  const card = (id: string, result = raw) => createElement(ToolCard, { toolName: "google_workspace", toolCallId: id, args: {}, result, status: { type: "complete" }, defaultExpanded: true });
  const view = render(createElement(MemoryRouter, { initialEntries: ["/"] }, createElement(Location), card("one"), card("two"), card("bad", "{no"), card("truncated", raw.slice(0, -8)), card("old", JSON.stringify({ version: 2, text: "old", recovery: { target: "connections.google", requirement: "login", domainTool: "google_workspace" } }))));
  const buttons = view.getAllByRole("button", { name: "Open Google Workspace" });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[0]); fireEvent.click(buttons[0]); fireEvent.click(buttons[1]);
  expect(view.queryAllByTestId("genie-recovery-action")).toHaveLength(2);
});

test("a correspondence mismatch stays inert while its old-client fallback remains readable", () => {
  reapplyHappyDomGlobals();
  const mismatched = JSON.stringify({ version: 1, text: "Ask the authorized Human to finish setup.", recovery: { target: "connections.codex", requirement: "login", domainTool: "google_workspace" } });
  const view = render(createElement(MemoryRouter, { initialEntries: ["/"] }, createElement(ToolCard, {
    toolName: "google_workspace", toolCallId: "mismatch", args: {}, result: mismatched, status: { type: "complete" }, defaultExpanded: true,
  })));
  expect(view.queryByTestId("genie-recovery-action")).toBeNull();
  expect(view.container.textContent).toContain("Ask the authorized Human to finish setup.");
});
