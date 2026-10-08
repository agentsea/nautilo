import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";

const happyWindow = new Window({ url: "https://server.example" });
const priorGlobals: Record<string, unknown> = {};
let controllerChanged: (event: { sessionId: string; controller: "user" | "agent" }) => void = () => {};
let unconfirmedTransfers = 0;
const session = { id: "human-terminal", title: "shell", cwd: "/project", sandboxed: false,
  controller: "agent" as "user" | "agent", requested: false, agentControlConsented: true };
const api = {
  grantHumanControl: undefined as undefined | ((id: string, selection: { roomId: string; agentId: string }) => Promise<boolean>),
  list: async () => [session],
  attach: async () => ({ ok: true, info: session, scrollback: "" }),
  resize: async () => {},
  setController: async () => { unconfirmedTransfers++; return false; },
  onData: () => () => {}, onExit: () => () => {}, onRequest: () => () => {},
  onController: (listener: typeof controllerChanged) => { controllerChanged = listener; return () => {}; },
};
mock.module("../../src/lib/desktop", () => ({ desktopAPI: { terminal: api } }));
mock.module("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24;
  loadAddon() {} open() {} focus() {} write() {} dispose() {}
  onData() { return { dispose() {} }; }
} }));
mock.module("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

beforeAll(() => {
  for (const key of ["window", "document", "navigator", "HTMLElement", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"]) {
    priorGlobals[key] = (globalThis as Record<string, unknown>)[key];
  }
  Object.assign(globalThis, { window: happyWindow, document: happyWindow.document,
    navigator: happyWindow.navigator, HTMLElement: happyWindow.HTMLElement,
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true });
});
afterAll(() => {
  for (const [key, value] of Object.entries(priorGlobals)) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
  happyWindow.happyDOM.abort();
});

test("Human retake requires fresh visible consent even when the surface cached an earlier grant", async () => {
  const { TerminalSurface } = await import("../../src/apps/terminal-surface");
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<TerminalSurface sessionId={session.id} assistantName="Genie" onClose={() => {}} />);
    });
    expect(container.textContent).toContain("Take control");
    await act(async () => {
      session.controller = "user";
      session.agentControlConsented = false;
      controllerChanged({ sessionId: session.id, controller: "user" });
    });
    const handoff = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Let Genie drive");
    expect(handoff).toBeDefined();
    await act(async () => { handoff!.click(); });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(unconfirmedTransfers).toBe(0);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("scoped handoff needs a selected Genie and reports refusal without closing the dialog", async () => {
  const { TerminalSurface } = await import("../../src/apps/terminal-surface");
  const calls: unknown[] = [];
  api.grantHumanControl = async (id, selection) => { calls.push({ id, selection }); return false; };
  session.controller = "user";
  session.agentControlConsented = false;
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.append(container);
  const root = createRoot(container);
  const genies = [{ id: "agent-a", name: "Genie" }, { id: "agent-b", name: "Helper" }];
  try {
    await act(async () => { root.render(<TerminalSurface sessionId={session.id} assistantName="Genie"
      handoffRoomId="room-a" handoffGenies={genies} onClose={() => {}} />); });
    const button = () => Array.from(container.querySelectorAll("button")).find(value => value.textContent === "Let Genie drive")!;
    expect(button().disabled).toBeTrue();
    expect(container.querySelector('select[aria-label="Genie to control this terminal"]')).not.toBeNull();
    await act(async () => { root.render(<TerminalSurface sessionId={session.id} assistantName="Genie"
      handoffRoomId="room-a" handoffGenies={genies} selectedHandoffGenieId="agent-a" onClose={() => {}} />); });
    await act(async () => { button().click(); });
    const dialog = container.querySelector('[role="dialog"]')!;
    await act(async () => { Array.from(dialog.querySelectorAll("button")).find(value => value.textContent === "Let Genie drive")!.click(); });
    expect(calls).toEqual([{ id: session.id, selection: { roomId: "room-a", agentId: "agent-a" } }]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("chat or terminal changed");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => { root.render(<TerminalSurface sessionId={session.id} assistantName="Helper"
      handoffRoomId="room-a" handoffGenies={genies} selectedHandoffGenieId="agent-b" onClose={() => {}} />); });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove(); api.grantHumanControl = undefined;
  }
});

test("sandboxed Agent terminal transfers still work without a Human handoff target", async () => {
  const { TerminalSurface } = await import("../../src/apps/terminal-surface");
  let scopedCalls = 0;
  const priorTransfers = unconfirmedTransfers;
  api.grantHumanControl = async () => { scopedCalls++; return false; };
  session.controller = "user";
  session.agentControlConsented = false;
  session.sandboxed = true;
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<TerminalSurface sessionId={session.id} onClose={() => {}} />); });
    const handoff = Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent === "Let Agent drive")!;
    expect(handoff.disabled).toBeFalse();
    await act(async () => { handoff.click(); });
    expect(unconfirmedTransfers).toBe(priorTransfers + 1);
    expect(scopedCalls).toBe(0);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    session.sandboxed = false;
    api.grantHumanControl = undefined;
  }
});

test("handoff rollback remains visible after main returns control before the grant reply", async () => {
  const { TerminalSurface } = await import("../../src/apps/terminal-surface");
  api.grantHumanControl = async () => {
    controllerChanged({ sessionId: session.id, controller: "agent" });
    controllerChanged({ sessionId: session.id, controller: "user" });
    return false;
  };
  session.controller = "user";
  session.agentControlConsented = false;
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<TerminalSurface sessionId={session.id}
      handoffRoomId="room-a" selectedHandoffGenieId="agent-a" onClose={() => {}} />); });
    await act(async () => { Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent === "Let Agent drive")!.click(); });
    await act(async () => { Array.from(container.querySelector('[role="dialog"]')!.querySelectorAll("button"))
      .find(button => button.textContent === "Let Agent drive")!.click(); });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("You have control");
    expect(container.textContent).toContain("Let Agent drive");
    expect(container.textContent).not.toContain("Take control");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    api.grantHumanControl = undefined;
  }
});

test("standing request leaves Genie selection available and scoped approval waits for a target", async () => {
  const { TerminalSurface } = await import("../../src/apps/terminal-surface");
  const calls: unknown[] = [];
  api.grantHumanControl = async (id, selection) => { calls.push({ id, selection }); return true; };
  session.controller = "user";
  session.agentControlConsented = false;
  session.requested = true;
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.append(container);
  const root = createRoot(container);
  const genies = [{ id: "agent-a", name: "Genie" }, { id: "agent-b", name: "Helper" }];
  const render = (selectedHandoffGenieId?: string) => root.render(<TerminalSurface
    sessionId={session.id} handoffRoomId="room-a" handoffGenies={genies}
    selectedHandoffGenieId={selectedHandoffGenieId} onClose={() => {}} />);
  try {
    await act(async () => { render(); });
    const selector = container.querySelector('select[aria-label="Genie to control this terminal"]');
    expect(selector).not.toBeNull();
    expect(container.textContent).toContain("Terminal control requested.");
    const bannerButton = () => Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent === "Let Agent drive")!;
    expect(bannerButton().disabled).toBeTrue();
    expect(container.textContent).toContain("Choose a Genie to continue.");

    await act(async () => { render("agent-a"); });
    expect(bannerButton().disabled).toBeFalse();
    await act(async () => { bannerButton().click(); });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(calls).toEqual([]);
    await act(async () => { Array.from(container.querySelector('[role="dialog"]')!.querySelectorAll("button"))
      .find(button => button.textContent === "Let Agent drive")!.click(); });
    expect(calls).toEqual([{ id: session.id, selection: { roomId: "room-a", agentId: "agent-a" } }]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    session.requested = false;
    api.grantHumanControl = undefined;
  }
});

test("late grant for an old Genie cannot close or update a newly opened consent dialog", async () => {
  const { TerminalSurface } = await import("../../src/apps/terminal-surface");
  const pending: Array<(granted: boolean) => void> = [];
  api.grantHumanControl = async () => new Promise<boolean>(resolve => pending.push(resolve));
  session.controller = "user";
  session.agentControlConsented = false;
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.append(container);
  const root = createRoot(container);
  const genies = [{ id: "agent-a", name: "Genie" }, { id: "agent-b", name: "Helper" }];
  const render = (selectedHandoffGenieId: string) => root.render(<TerminalSurface
    sessionId={session.id} handoffRoomId="room-a" handoffGenies={genies}
    selectedHandoffGenieId={selectedHandoffGenieId} onClose={() => {}} />);
  const confirm = () => Array.from(container.querySelector('[role="dialog"]')!.querySelectorAll("button"))
    .find(button => button.textContent === "Let Agent drive")!;
  try {
    await act(async () => { render("agent-a"); });
    await act(async () => { Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent === "Let Agent drive")!.click(); });
    await act(async () => { confirm().click(); });
    expect(pending).toHaveLength(1);

    await act(async () => { render("agent-b"); });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent === "Let Agent drive")!.click(); });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => { confirm().click(); });
    expect(pending).toHaveLength(2);

    await act(async () => { pending[0](true); await Promise.resolve(); });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { pending[1](false); await Promise.resolve(); });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("chat or terminal changed");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    api.grantHumanControl = undefined;
  }
});

test("late grant is ignored after the Desktop session becomes inactive", async () => {
  const { TerminalSurface } = await import("../../src/apps/terminal-surface");
  let resolveGrant: ((granted: boolean) => void) | undefined;
  api.grantHumanControl = async () => new Promise<boolean>(resolve => { resolveGrant = resolve; });
  session.controller = "user";
  session.agentControlConsented = false;
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.append(container);
  const root = createRoot(container);
  const render = (activeSession: boolean) => root.render(<TerminalSurface
    activeSession={activeSession} sessionId={session.id} handoffRoomId="room-a"
    handoffGenies={[{ id: "agent-a", name: "Genie" }]}
    selectedHandoffGenieId="agent-a" onClose={() => {}} />);
  try {
    await act(async () => { render(true); });
    await act(async () => { Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent === "Let Agent drive")!.click(); });
    await act(async () => { Array.from(container.querySelector('[role="dialog"]')!.querySelectorAll("button"))
      .find(button => button.textContent === "Let Agent drive")!.click(); });
    expect(resolveGrant).toBeDefined();
    await act(async () => { render(false); });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { resolveGrant!(true); await Promise.resolve(); });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    api.grantHumanControl = undefined;
  }
});
