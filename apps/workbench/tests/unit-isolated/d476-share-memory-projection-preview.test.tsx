import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import type { ReactNode } from "react";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ApprovalReplyVerb, ProveItToolInfo } from "@nautilo/types";
import type { ApprovalAskState } from "../../src/adapters/runtime-contexts";

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};
let askState: ApprovalAskState;

const projectionTool: ProveItToolInfo = {
  name: "share_memory",
  args: { mode: "project", target_room_name: "The Nautilo Pub" },
  shareMemoryPreview: {
    memoryContentSnippet: "private source must not render",
    memoryType: "identity",
    targetHandle: "alex",
    targetDisplayName: "Alex",
    roomLabel: "The Nautilo Pub",
    wouldCreate: false,
    sensitivity: "normal",
    projection: {
      mode: "project",
      content: "Alex — 你好 👩🏽‍💻\nThis public-safe identity card is intentionally long enough to wrap in a narrow approval surface without being shortened.",
      roomLabel: "The Nautilo Pub",
      roomKind: "open",
      memberCount: 12,
      audienceWarning: "This is an open Room. Future members may see this Memory copy.",
    },
  },
};

function makeAskState(): ApprovalAskState {
  return {
    show: true,
    approvalId: "d476-ask",
    tools: [projectionTool],
    reason: "sharing a Memory copy needs approval",
    reasonCode: "destructive-tool",
    network: null,
    allowedVerbs: ["once", "deny"],
    scopeInfo: [],
    error: null,
    submitting: false,
  };
}

let ApprovalAskDock: (typeof import("../../src/components/approval-ask-dock"))["ApprovalAskDock"];
let ApprovalDialog: (typeof import("../../src/components/approval-dialog"))["ApprovalDialog"];

beforeAll(async () => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const) {
    priorGlobals[key] = (globalThis as Record<string, unknown>)[key];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  mock.module("../../src/adapters/runtime-contexts", () => ({
    useApprovalAsk: () => ({
      state: askState,
      submit: async (_verb: ApprovalReplyVerb) => undefined,
    }),
  }));
  ({ ApprovalAskDock } = await import("../../src/components/approval-ask-dock"));
  ({ ApprovalDialog } = await import("../../src/components/approval-dialog"));
});

beforeEach(() => {
  askState = makeAskState();
});

afterAll(() => {
  mock.restore();
  const globals = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) delete globals[key];
    else globals[key] = priorGlobals[key];
  }
});

async function render(node: ReactNode): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = happyWindow.document.createElement("div");
  // Narrow host asserts the detail itself owns wrapping/scroll instead of
  // depending on a desktop-width page.
  host.style.width = "220px";
  happyWindow.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root.render(node);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  return { host, root };
}

async function unmount(root: Root, host: HTMLDivElement): Promise<void> {
  await act(async () => {
    root.unmount();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  host.remove();
}

function expectProjection(host: HTMLDivElement): void {
  const preview = host.querySelector('[data-testid="share-memory-projection-preview"]');
  const content = host.querySelector('[data-testid="share-memory-projection-content"]');
  expect(preview?.textContent).toContain("NEW Memory copy will be created");
  expect(preview?.textContent).toContain("The Nautilo Pub");
  expect(preview?.textContent).toContain("open · 12 visible members");
  expect(preview?.textContent).toContain("Future members may see");
  expect(content?.textContent).toBe(projectionTool.shareMemoryPreview?.projection?.content);
  expect(content?.getAttribute("aria-label")).toBe("Exact projected Memory content");
  expect(preview?.textContent).not.toContain("private source must not render");
}

describe("D476 projection approval preview", () => {
  test("shows the complete safe copy, destination, warning, and accessibility label in the ask dock", async () => {
    const { host, root } = await render(<ApprovalAskDock />);
    expectProjection(host);
    await unmount(root, host);
  });

  test("shows the same new-copy disclosure in the PIN dialog", async () => {
    const { host, root } = await render(
      <ApprovalDialog tools={[projectionTool]} onSubmit={() => {}} onDeny={() => {}} />,
    );
    expectProjection(host);
    await unmount(root, host);
  });
});
