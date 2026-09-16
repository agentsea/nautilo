/**
 * SubagentDock complete list / available height / collapse behavior.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Window } from "happy-dom";
import type { RunningSubagent } from "../running-subagents-model";
import { DrawerProvider } from "../../thread-drawer/drawer-state.tsx";

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};
const setActiveRoom = mock((_roomId: string) => undefined);
const pauseTask = mock(async (_taskId: string) => undefined);
const unpauseTask = mock(async (_taskId: string) => undefined);
const stopTask = mock(async (_taskId: string) => undefined);

let snapshot: { list: RunningSubagent[]; heartbeat: { count: number; line: string } };
let roomNavRooms: { id: string }[] = [];
let busyIds: ReadonlySet<string> = new Set();

function makeSubagent(index: number, overrides: Partial<RunningSubagent> = {}): RunningSubagent {
  return {
    taskId: `task-${index}`,
    parentTaskId: null,
    depth: 0,
    taskRunId: `run-${index}`,
    agentName: `Agent ${index}`,
    modelId: "gpt-test",
    kind: "task",
    harnessId: null,
    prompt: `Prompt ${index}`,
    status: "running",
    line3: `working on ${index}`,
    recentActivity: [],
    harnessActivity: [],
    awaitingRoomId: null,
    startedAtMs: index * 1000,
    terminalAtMs: null,
    ...overrides,
  };
}

let SubagentDock: (typeof import("../SubagentDock"))["SubagentDock"];

const actualRuntimeContexts = await import("../../../../adapters/runtime-contexts");
const actualRoomNav = await import("../../../../contexts/room-navigation-context");
const actualTaskState = await import("../../../../contexts/task-state/task-state-context");

function renderDock(): ReturnType<typeof render> {
  return render(
    <DrawerProvider>
      <SubagentDock />
    </DrawerProvider>,
  );
}

beforeAll(async () => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  for (const k of ["window", "document", "navigator", "HTMLElement"] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
  });

  mock.module("../../../../adapters/runtime-contexts", () => ({
    ...actualRuntimeContexts,
    useRunningSubagents: () => snapshot,
  }));

  mock.module("../../../../contexts/room-navigation-context", () => ({
    ...actualRoomNav,
    useRoomNavigation: () => ({
      setActiveRoom,
      activeRoomId: null,
      activeRoom: null,
      rooms: roomNavRooms,
    }),
  }));

  mock.module("../../../../contexts/task-state/task-state-context", () => ({
    ...actualTaskState,
    useTaskState: () => ({
      busyIds,
      pauseTask,
      unpauseTask,
      stopTask,
    }),
  }));

  ({ SubagentDock } = await import("../SubagentDock"));
});

beforeEach(() => {
  setActiveRoom.mockClear();
  pauseTask.mockClear();
  unpauseTask.mockClear();
  stopTask.mockClear();
  snapshot = { list: [], heartbeat: { count: 0, line: "" } };
  roomNavRooms = [];
  busyIds = new Set();
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  cleanup();
  await new Promise<void>((r) => setTimeout(r, 50));
  mock.module("../../../../adapters/runtime-contexts", () => actualRuntimeContexts);
  mock.module("../../../../contexts/room-navigation-context", () => actualRoomNav);
  mock.module("../../../../contexts/task-state/task-state-context", () => actualTaskState);
  mock.restore();
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) delete g[key];
    else g[key] = priorGlobals[key];
  }
});

describe("SubagentDock", () => {
  test("renders null when the live set is empty", () => {
    const { container } = render(<SubagentDock />);
    expect(container.firstChild).toBeNull();
  });

  test("keeps the complete list in a keyboard-accessible flexible scroll region", () => {
    snapshot = {
      list: Array.from({ length: 12 }, (_, i) => makeSubagent(i)),
      heartbeat: { count: 12, line: "Agent 0 › working on 0" },
    };
    const view = renderDock();
    const list = view.getByRole("region", { name: "Task activity" });
    expect(list.children).toHaveLength(12);
    expect(list.textContent).toContain("Prompt 11");
    expect(list.tabIndex).toBe(0);
    expect(list.classList.contains("flex-1")).toBe(true);
    expect(list.classList.contains("min-h-0")).toBe(true);
    expect(list.classList.contains("overflow-y-auto")).toBe(true);
    expect(list.className).not.toContain("max-h-");
    expect(view.getByTestId("subagent-dock").classList.contains("flex-1")).toBe(true);
    expect([...list.children].every((card) => card.classList.contains("shrink-0"))).toBe(true);
    expect(view.queryByTestId("subagent-dock-overflow")).toBeNull();
    fireEvent.click(view.getAllByTestId("subagent-pause")[11]!);
    expect(pauseTask).toHaveBeenCalledWith("task-11");
  });

  test("collapses to heartbeat bar and expands again", () => {
    snapshot = {
      list: [makeSubagent(1)],
      heartbeat: { count: 1, line: "Agent 1 › working on 1" },
    };
    const view = renderDock();
    expect(view.getByTestId("subagent-dock").getAttribute("data-collapsed")).toBe("false");

    fireEvent.click(view.getByLabelText("Collapse subagent activity dock"));
    expect(view.getByTestId("subagent-dock").getAttribute("data-collapsed")).toBe("true");
    expect(view.getByTestId("subagent-dock").classList.contains("flex-1")).toBe(false);
    expect(view.getByText(/1 task · Agent 1 › working on 1/)).toBeTruthy();

    fireEvent.click(view.getByLabelText("Expand subagent activity dock"));
    expect(view.getByTestId("subagent-dock").getAttribute("data-collapsed")).toBe("false");
    expect(view.getByTestId("subagent-dock-list")).toBeTruthy();
  });

  test("labels an external harness and expands its live semantic activity", async () => {
    snapshot = {
      list: [
        makeSubagent(1, {
          harnessId: "codex",
          recentActivity: ["Codex thinking", "rg -n TODO"],
          harnessActivity: [{
            id: "command-1",
            kind: "command",
            name: "run_command",
            status: "running",
            args: { command: "rg -n TODO" },
            result: "Command output\nmatch",
            startedAt: 1,
          }],
        }),
      ],
      heartbeat: { count: 1, line: "Agent 1 › rg -n TODO" },
    };
    const view = renderDock();
    expect(view.getByText("→ Codex")).toBeTruthy();
    expect(view.getByLabelText("Collapse subagent steps")).toBeTruthy();
    expect(view.getByLabelText("Harness execution activity").textContent).toContain("run_command");
    expect(view.getByLabelText("Harness execution activity").textContent).toContain("Command output");
    expect(view.getByTestId("subagent-elapsed")).toBeTruthy();
  });

  test("renders Hermes command summaries with canonical Task Stop only", () => {
    snapshot = {
      list: [
        makeSubagent(1, {
          harnessId: "hermes-acp",
          harnessActivity: [{
            id: "hermes-command-1",
            kind: "command",
            name: "external_command",
            status: "running",
            args: { detail: "Read ACCEPTANCE.txt" },
            startedAt: 1,
          }],
        }),
      ],
      heartbeat: { count: 1, line: "Agent 1 › Read ACCEPTANCE.txt" },
    };

    const view = renderDock();
    expect(view.getByText("→ Hermes via ACP")).toBeTruthy();
    const activity = view.getByLabelText("Harness execution activity");
    expect(activity.textContent).toContain("Read ACCEPTANCE.txt");
    expect(activity.querySelector('[aria-expanded="true"]')).toBeTruthy();
    expect(view.queryByTestId("subagent-pause")).toBeNull();
    expect(view.queryByTestId("subagent-resume")).toBeNull();
    fireEvent.click(view.getByTestId("subagent-stop"));
    expect(stopTask).toHaveBeenCalledWith("task-1");
  });

  test("shows jump when awaiting room is in roomNav.rooms", () => {
    roomNavRooms = [{ id: "room-await" }];
    snapshot = {
      list: [
        makeSubagent(1, {
          status: "awaiting",
          awaitingRoomId: "room-await",
          line3: "waiting on reply",
        }),
      ],
      heartbeat: { count: 1, line: "Agent 1 › waiting on reply" },
    };
    const view = renderDock();
    expect(view.getByTestId("subagent-jump")).toBeTruthy();
  });

  test("hides jump when awaiting room is not in roomNav.rooms", () => {
    roomNavRooms = [{ id: "room-other" }];
    snapshot = {
      list: [
        makeSubagent(1, {
          status: "awaiting",
          awaitingRoomId: "room-private",
          line3: "waiting on reply",
        }),
      ],
      heartbeat: { count: 1, line: "Agent 1 › waiting on reply" },
    };
    const view = renderDock();
    expect(view.queryByTestId("subagent-jump")).toBeNull();
  });

  test("delegates lifecycle actions and busy state to shared task state", () => {
    snapshot = {
      list: [makeSubagent(1)],
      heartbeat: { count: 1, line: "Agent 1 › working on 1" },
    };
    const view = renderDock();

    fireEvent.click(view.getByTestId("subagent-pause"));
    fireEvent.click(view.getByTestId("subagent-stop"));

    expect(pauseTask).toHaveBeenCalledWith("task-1");
    expect(stopTask).toHaveBeenCalledWith("task-1");
  });

  test("uses the shared task busy id to disable lifecycle controls", () => {
    busyIds = new Set(["task-1"]);
    snapshot = {
      list: [makeSubagent(1)],
      heartbeat: { count: 1, line: "Agent 1 › working on 1" },
    };
    const view = renderDock();

    expect(view.getByTestId("subagent-pause").hasAttribute("disabled")).toBe(true);
    expect(view.getByTestId("subagent-stop").hasAttribute("disabled")).toBe(true);
  });
});


test("verified errored research uses ordinary Resume without terminal Stop", () => {
  snapshot = { list: [makeSubagent(1, { status: "errored", canResumeResearch: true })],
    heartbeat: { count: 1, line: "Research interrupted" } };
  const view = renderDock();
  fireEvent.click(view.getByTestId("subagent-resume"));
  expect(unpauseTask).toHaveBeenCalledWith("task-1");
  expect(view.queryByTestId("subagent-stop")).toBeNull();
  expect(view.queryByTestId("subagent-pause")).toBeNull();
});

test("ordinary terminal cards have no recovery control", () => {
  snapshot = { list: [makeSubagent(1, { status: "errored" }), makeSubagent(2, { status: "done", canResumeResearch: true })],
    heartbeat: { count: 2, line: "Finished" } };
  const view = renderDock();
  expect(view.queryByTestId("subagent-resume")).toBeNull();
});
