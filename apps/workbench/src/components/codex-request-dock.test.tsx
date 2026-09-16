import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import userEvent from "@testing-library/user-event";
import type { CodexRequestState } from "../adapters/runtime-contexts";

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};
let state: CodexRequestState;
const dismissed: string[] = [];
const responses: Array<{ readonly requestId: string; readonly response: unknown }> = [];
let CodexRequestDock: (typeof import("./codex-request-dock"))["CodexRequestDock"];

function userInputView(availability: "actionable" | "unavailable"): CodexRequestState["requests"][number] {
  return {
    availability,
    event: {
      type: "codex.request",
      ownerId: "owner-a",
      requestId: `${availability}-request`,
      taskId: "task-a",
      jobId: "job-a",
      roomId: "room-a",
      expiresAt: "2026-08-01T12:00:00.000Z",
      request: {
        kind: "user_input_required",
        questions: [{
          id: "answer",
          header: "Which path?",
          prompt: "Choose a path to continue.",
          secret: false,
          allowOther: false,
          options: [{ id: "continue", label: "Continue", description: null }],
        }],
        autoResolutionMs: null,
      },
    },
  };
}

function permissionSelectionView(toolTitle: string | null): CodexRequestState["requests"][number] {
  return {
    availability: "actionable",
    event: {
      type: "codex.request",
      ownerId: "owner-a",
      requestId: "permission-request",
      taskId: "task-a",
      jobId: "job-a",
      roomId: "room-a",
      expiresAt: null,
      request: {
        kind: "permission_selection_required",
        detail: { state: "shown", text: "Read\n/workspace/example.txt" },
        options: [
          { id: "opaque-allow", label: "Allow once", semanticHint: null },
          { id: "opaque-deny", label: "Deny", semanticHint: null },
        ],
        tool: { title: toolTitle, kind: "host-private" },
      },
    },
  };
}

beforeAll(async () => {
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
  mock.module("../adapters/runtime-contexts", () => ({
    useCodexRequests: () => ({
      state,
      respond: async (requestId: string, response: unknown) => { responses.push({ requestId, response }); },
      dismiss: (requestId: string) => dismissed.push(requestId),
    }),
  }));
  ({ CodexRequestDock } = await import("./codex-request-dock"));
});

beforeEach(() => {
  state = { requests: [], submittingRequestId: null, errors: {} };
  dismissed.length = 0;
  responses.length = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  mock.restore();
  const globals = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) delete globals[key];
    else globals[key] = priorGlobals[key];
  }
});

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function setText(input: HTMLInputElement, value: string): Promise<void> {
  const user = userEvent.setup({ document: happyWindow.document });
  await user.clear(input);
  await user.type(input, value);
}

describe("CodexRequestDock recovery rendering", () => {
  test("renders an actionable durable question with answer controls", async () => {
    state = { requests: [userInputView("actionable")], submittingRequestId: null, errors: {} };
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root: Root = createRoot(host as unknown as HTMLElement);
    root.render(<CodexRequestDock />);
    await flush();

    expect(host.textContent).toContain("Which path?");
    expect(host.querySelector("button[type=submit]")?.textContent).toBe("Send answers");
    root.unmount();
    host.remove();
  });

  test("retains unavailable recovery copy with only a local dismiss control", async () => {
    state = { requests: [userInputView("unavailable")], submittingRequestId: null, errors: {} };
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root: Root = createRoot(host as unknown as HTMLElement);
    root.render(<CodexRequestDock />);
    await flush();

    expect(host.textContent).toContain("This question can’t continue because the connection or Nautilo restarted. Start a new task.");
    expect(host.querySelector("form")).toBeNull();
    const dismiss = host.querySelector("button") as HTMLButtonElement | null;
    expect(dismiss?.textContent).toBe("Dismiss");
    dismiss?.click();
    expect(dismissed).toEqual(["unavailable-request"]);
    root.unmount();
    host.remove();
  });

  test("withheld details disable approval while preserving cancellation", async () => {
    const view = permissionSelectionView("Bash");
    if (view.event.request.kind !== "permission_selection_required") throw new Error("wrong fixture");
    view.event.request.detail = { state: "withheld", reason: "sensitive" };
    state = { requests: [view], submittingRequestId: null, errors: {} };
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root: Root = createRoot(host as unknown as HTMLElement);
    root.render(<CodexRequestDock />);
    await flush();
    expect(host.textContent).toContain("Action details are unavailable (sensitive)");
    const allow = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Allow once") as HTMLButtonElement;
    expect(allow.disabled).toBeTrue();
    allow.click();
    expect(responses).toHaveLength(0);
    (Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Cancel") as HTMLButtonElement).click();
    expect(responses).toHaveLength(1);
    root.unmount();
    host.remove();
  });

  test("posts opaque permission selections or cancellation with neutral context", async () => {
    state = { requests: [permissionSelectionView("Read project files")], submittingRequestId: null, errors: {} };
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root: Root = createRoot(host as unknown as HTMLElement);
    root.render(<CodexRequestDock />);
    await flush();

    expect(host.textContent).toContain("Permission requested for Read project files.");
    expect(host.querySelector("pre")?.textContent).toBe("Read\n/workspace/example.txt");
    expect(host.textContent).not.toContain("Codex");
    expect(host.querySelector("[aria-label='Task request status']")).not.toBeNull();
    (Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Allow once") as HTMLButtonElement).click();
    (Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Deny") as HTMLButtonElement).click();
    (Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Cancel") as HTMLButtonElement).click();
    await flush();
    expect(responses).toEqual([
      { requestId: "permission-request", response: { kind: "permission_selection_required", outcome: { kind: "selected", optionId: "opaque-allow" } } },
      { requestId: "permission-request", response: { kind: "permission_selection_required", outcome: { kind: "selected", optionId: "opaque-deny" } } },
      { requestId: "permission-request", response: { kind: "permission_selection_required", outcome: { kind: "cancelled" } } },
    ]);
    root.unmount();
    host.remove();

    state = { requests: [permissionSelectionView(null)], submittingRequestId: null, errors: {} };
    const fallbackHost = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(fallbackHost);
    const fallbackRoot: Root = createRoot(fallbackHost as unknown as HTMLElement);
    fallbackRoot.render(<CodexRequestDock />);
    await flush();
    expect(fallbackHost.textContent).toContain("Permission requested for a local tool.");
    fallbackRoot.unmount();
    fallbackHost.remove();
  });

  test("keeps omitted multiSelect as radio and clears Other on a new single selection", async () => {
    const view = userInputView("actionable");
    if (view.event.request.kind !== "user_input_required") throw new Error("expected input request");
    state = {
      requests: [{
        ...view,
        event: {
          ...view.event,
          request: {
            ...view.event.request,
            questions: [{
              ...view.event.request.questions[0]!,
              allowOther: true,
              options: [
                { id: "first", label: "First", description: null },
                { id: "second", label: "Second", description: null },
              ],
            }],
          },
        },
      }],
      submittingRequestId: null,
      errors: {},
    };
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root: Root = createRoot(host as unknown as HTMLElement);
    root.render(<CodexRequestDock />);
    await flush();

    expect(host.querySelectorAll("input[type=radio]")).toHaveLength(2);
    const other = host.querySelector("input[type=text]") as HTMLInputElement;
    await setText(other, "Other answer");
    await flush();
    (host.querySelectorAll("input[type=radio]")[1] as HTMLInputElement).click();
    await flush();
    expect(other.value).toBe("");
    (host.querySelector("button[type=submit]") as HTMLButtonElement).click();
    await flush();
    expect(responses).toEqual([{
      requestId: "actionable-request",
      response: { kind: "user_input_required", answers: { answer: ["second"] } },
    }]);
    root.unmount();
    host.remove();
  });

  test("preserves multi-select options plus one Other answer and keeps incomplete four-question forms disabled", async () => {
    const view = userInputView("actionable");
    if (view.event.request.kind !== "user_input_required") throw new Error("expected input request");
    const questions = Array.from({ length: 4 }, (_, question) => ({
      id: `question-${question}`,
      header: `Question ${question + 1}`,
      prompt: "Choose one or more options.",
      secret: false,
      allowOther: question === 0,
      multiSelect: true,
      options: Array.from({ length: 4 }, (_, option) => ({
        id: `q${question}-option-${option}`,
        label: `Option ${option + 1}`,
        description: null,
      })),
    }));
    state = {
      requests: [{ ...view, event: { ...view.event, request: { ...view.event.request, questions } } }],
      submittingRequestId: null,
      errors: {},
    };
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root: Root = createRoot(host as unknown as HTMLElement);
    root.render(<CodexRequestDock />);
    await flush();

    expect(host.querySelectorAll("input[type=checkbox]")).toHaveLength(16);
    expect((host.querySelector("button[type=submit]") as HTMLButtonElement).disabled).toBe(true);
    const choices = host.querySelectorAll("input[type=checkbox]");
    (choices[0] as HTMLInputElement).click();
    (choices[1] as HTMLInputElement).click();
    (choices[0] as HTMLInputElement).click();
    const other = host.querySelector("input[type=text]") as HTMLInputElement;
    await setText(other, "Other answer");
    await flush();
    (host.querySelector("button[type=submit]") as HTMLButtonElement).click();
    await flush();
    expect(responses).toEqual([]);

    root.unmount();
    host.remove();
    const multiView = userInputView("actionable");
    state = {
      requests: [{
        ...multiView,
        event: {
          ...multiView.event,
          request: {
            ...multiView.event.request,
            questions: [questions[0]!],
          },
          requestId: "multi-request",
        },
      }],
      submittingRequestId: null,
      errors: {},
    };
    const multiHost = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(multiHost);
    const multiRoot: Root = createRoot(multiHost as unknown as HTMLElement);
    multiRoot.render(<CodexRequestDock />);
    await flush();
    const multiChoices = multiHost.querySelectorAll("input[type=checkbox]");
    (multiChoices[0] as HTMLInputElement).click();
    await flush();
    (multiChoices[1] as HTMLInputElement).click();
    await flush();
    (multiChoices[0] as HTMLInputElement).click();
    await flush();
    const multiOther = multiHost.querySelector("input[type=text]") as HTMLInputElement;
    await setText(multiOther, "Other answer");
    await flush();
    (multiHost.querySelector("button[type=submit]") as HTMLButtonElement).click();
    await flush();
    expect(responses).toEqual([{
      requestId: "multi-request",
      response: {
        kind: "user_input_required",
        answers: { "question-0": ["q0-option-1", "Other answer"] },
      },
    }]);
    multiRoot.unmount();
    multiHost.remove();
  });
});
