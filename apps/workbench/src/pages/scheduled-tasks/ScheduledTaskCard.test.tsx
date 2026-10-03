import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { Window } from "happy-dom";
import type { TaskSummary } from "@nautilo/types";
import { ScheduledTaskCard } from "./ScheduledTaskCard";

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};

beforeAll(() => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) {
    priorGlobals[key] = (globalThis as Record<string, unknown>)[key];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
  });
});

afterEach(cleanup);

afterAll(() => {
  cleanup();
  mock.restore();
  const globals = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(priorGlobals)) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

function task(fundingFailure: TaskSummary["fundingFailure"]): TaskSummary {
  return {
    id: "task-1", parentTaskId: null, depth: 0, status: "paused", preset: "schedule",
    prompt: "Write a summary", scheduleKind: "cron", cron: "0 9 * * 1-5",
    nextFireAt: null, callingRoomId: null, lastError: fundingFailure ?? null,
    fundingFailure,
  };
}

describe("ScheduledTaskCard funding recovery", () => {
  test("keeps repairable schedules resumable and removable", () => {
    const view = render(<ScheduledTaskCard task={task("personal_credential_missing")}
      onEnable={() => undefined} onDisable={() => undefined} onRemove={() => undefined} />);
    expect(view.getByLabelText("Enable schedule").hasAttribute("disabled")).toBe(false);
    expect(view.getByLabelText("Remove schedule")).toBeTruthy();
    expect(view.getByRole("link", { name: "Personal API keys" })).toBeTruthy();
  });

  test("keeps removal available but prevents resuming a stale admitted run", () => {
    const view = render(<ScheduledTaskCard task={task("personal_credential_stale")}
      onEnable={() => undefined} onDisable={() => undefined} onRemove={() => undefined} />);
    expect(view.getByLabelText("Enable schedule").hasAttribute("disabled")).toBe(true);
    expect(view.getByLabelText("Remove schedule")).toBeTruthy();
    expect(view.getByRole("status").textContent).toContain("fresh task");
  });
});
