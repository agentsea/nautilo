/**
 * M037 — ApprovalAskDock verb + grain rendering tests.
 *
 * Asserts the dock renders all four verbs (incl. "Always", which D142-P1
 * previously hid), shows the generalization grain from `scopeInfo`, and
 * that clicking a verb button calls `submit(verb)`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { ApprovalReplyVerb } from "@nautilo/types";
import type { ApprovalAskState } from "../../src/adapters/runtime-contexts";

const actualRuntimeContexts = await import("../../src/adapters/runtime-contexts");

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};

const submitted: ApprovalReplyVerb[] = [];
let askState: ApprovalAskState;

function makeState(overrides: Partial<ApprovalAskState> = {}): ApprovalAskState {
  return {
    show: true,
    approvalId: "ap-1",
    tools: [{ name: "run_shell", args: { command: "ls /proj/a/src" } }],
    reason: "needs approval",
    reasonCode: "destructive-tool",
    network: null,
    allowedVerbs: ["once", "room", "always", "deny"],
    scopeInfo: [
      { onceDisplay: "run_shell ls /proj/a/src", generalizedDisplay: "run_shell ls <directory:/proj/a>", sameAsOnce: false },
    ],
    error: null,
    submitting: false,
    ...overrides,
  };
}

let ApprovalAskDock: (typeof import("../../src/components/approval-ask-dock"))["ApprovalAskDock"];

beforeAll(async () => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  for (const k of ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  mock.module("../../src/adapters/runtime-contexts", () => ({
    ...actualRuntimeContexts,
    useApprovalAsk: () => ({
      state: askState,
      submit: async (verb: ApprovalReplyVerb) => {
        submitted.push(verb);
      },
    }),
  }));

  ({ ApprovalAskDock } = await import("../../src/components/approval-ask-dock"));
});

beforeEach(() => {
  submitted.length = 0;
  askState = makeState();
});

afterAll(async () => {
  await new Promise<void>((r) => setTimeout(r, 50));
  mock.module("../../src/adapters/runtime-contexts", () => actualRuntimeContexts);
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) delete g[key];
    else g[key] = priorGlobals[key];
  }
});

async function flush(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe("ApprovalAskDock (M037)", () => {
  test("renders all four verbs incl. Always (not hidden) + the grain line", async () => {
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root: Root = createRoot(host as unknown as HTMLElement);
    await act(async () => {
      root.render(<MemoryRouter initialEntries={["/rooms/test"]}><ApprovalAskDock /></MemoryRouter>);
      await flush();
    });

    const verbs = [...host.querySelectorAll("[data-verb]")].map((b) => b.getAttribute("data-verb"));
    expect(verbs).toEqual(["once", "room", "always", "deny"]);

    const grain = host.querySelector('[data-testid="approval-grain"]');
    expect(grain?.textContent).toContain("run_shell ls <directory:/proj/a>");

    await act(async () => {
      root.unmount();
      await flush();
    });
    host.remove();
    await flush();
  });

  test("clicking a verb calls submit(verb)", async () => {
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    await act(async () => {
      root.render(<MemoryRouter initialEntries={["/rooms/test"]}><ApprovalAskDock /></MemoryRouter>);
      await flush();
    });

    const always = host.querySelector('[data-verb="always"]') as HTMLButtonElement | null;
    expect(always).not.toBeNull();
    await act(async () => {
      always!.click();
      await flush();
    });
    expect(submitted).toContain("always");

    await act(async () => {
      root.unmount();
      await flush();
    });
    host.remove();
    await flush();
  });

  test("sameAsOnce grain renders the 'exactly this command' copy", async () => {
    askState = makeState({
      tools: [{ name: "transcribe_audio", args: { path: "/x.wav" } }],
      scopeInfo: [
        { onceDisplay: "transcribe_audio(path: /x.wav)", generalizedDisplay: "transcribe_audio path=/x.wav", sameAsOnce: true },
      ],
    });
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    await act(async () => {
      root.render(<MemoryRouter initialEntries={["/rooms/test"]}><ApprovalAskDock /></MemoryRouter>);
      await flush();
    });

    const grain = host.querySelector('[data-testid="approval-grain"]');
    expect(grain?.textContent).toContain("exactly this command");

    await act(async () => {
      root.unmount();
      await flush();
    });
    host.remove();
    await flush();
  });
});
