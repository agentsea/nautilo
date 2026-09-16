import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { ApprovalDialog } from "./approval-dialog";

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

afterAll(() => {
  const globals = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(priorGlobals)) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("ApprovalDialog tool preview", () => {
  const projectedTool = (expiresAt?: number) => ({
    name: "share_memory",
    args: {},
    shareMemoryPreview: {
      memoryContentSnippet: "snippet",
      memoryType: null,
      targetHandle: "alice",
      targetDisplayName: "Alice",
      roomLabel: "Shared room",
      wouldCreate: false,
      sensitivity: "sensitive" as const,
      projection: {
        mode: "project" as const,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        content: "exact projected content",
        roomLabel: "Shared room",
        roomKind: "private" as const,
        memberCount: 2,
        audienceWarning: "Alice can read this.",
      },
    },
  });

  test("shows an already-expired projection while keeping denial available", async () => {
    let denied = 0;
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalDialog tools={[projectedTool(Date.now() - 1)]} onSubmit={() => {}} onDeny={() => { denied += 1; }} />);
    await flush();
    expect(host.textContent).toContain("This sharing preview has expired. Deny it and ask for a fresh preview.");
    host.querySelector<HTMLButtonElement>('button[aria-label="Deny"]')?.click();
    expect(denied).toBe(1);
    root.unmount();
    host.remove();
  });

  test("expires a projection while the dialog remains open", async () => {
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalDialog tools={[projectedTool(Date.now() + 20)]} onSubmit={() => {}} onDeny={() => {}} />);
    await flush();
    expect(host.textContent).not.toContain("This sharing preview has expired");
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    expect(host.textContent).toContain("This sharing preview has expired. Deny it and ask for a fresh preview.");
    root.unmount();
    host.remove();
  });

  test("keeps legacy projections without expiresAt reviewable", async () => {
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(<ApprovalDialog tools={[projectedTool()]} onSubmit={() => {}} onDeny={() => {}} />);
    await flush();
    expect(host.textContent).toContain("exact projected content");
    expect(host.textContent).not.toContain("This sharing preview has expired");
    root.unmount();
    host.remove();
  });
  test("keeps denial available beside a rejected duplicate-response error", async () => {
    let denied = 0;
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(
      <ApprovalDialog
        tools={[{ name: "share_memory", args: {} }]}
        onSubmit={() => {}}
        onDeny={() => { denied += 1; }}
        error="This response was already submitted. No new action was started."
      />,
    );
    await flush();

    expect(host.textContent).toContain("No new action was started");
    const deny = [...host.querySelectorAll("button")].find((button) =>
      button.textContent === "Deny"
    );
    expect(deny).toBeDefined();
    deny?.click();
    expect(denied).toBe(1);

    root.unmount();
    host.remove();
    await flush();
  });

  test("shows useful intent without exposing nested or variant secrets", async () => {
    const args = {
      operation: "path",
      session_token: "dialog-session-secret",
      request: {
        credentials: { password: "dialog-password" },
        nodeId: "node:one",
      },
    };
    const original = structuredClone(args);
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(
      <ApprovalDialog
        tools={[{ name: "edit-open-design", args }]}
        onSubmit={() => {}}
        onDeny={() => {}}
      />,
    );
    await flush();

    expect(host.textContent).toContain("operation: path");
    expect(host.innerHTML).toContain("[redacted]");
    expect(host.innerHTML).not.toContain("dialog-session-secret");
    expect(host.innerHTML).not.toContain("dialog-password");
    expect(args).toEqual(original);

    root.unmount();
    host.remove();
    await flush();
  });

  test("accepts only the first rapid approve-or-deny decision", async () => {
    let approved = 0;
    let denied = 0;
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    root.render(
      <ApprovalDialog
        tools={[{ name: "share_memory", args: {} }]}
        onSubmit={() => { approved += 1; }}
        onDeny={() => { denied += 1; }}
      />,
    );
    await flush();

    const buttons = [...host.querySelectorAll("button")];
    const deny = buttons.find((button) => button.textContent === "Deny");
    deny?.click();
    deny?.click();

    expect(approved + denied).toBe(1);
    root.unmount();
    host.remove();
    await flush();
  });

  test("unlocks the decision after a failed HTTP response is shown", async () => {
    let denied = 0;
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    const renderDialog = (error?: string) => root.render(
      <ApprovalDialog
        tools={[{ name: "share_memory", args: {} }]}
        onSubmit={() => {}}
        onDeny={() => { denied += 1; }}
        error={error}
      />,
    );
    renderDialog();
    await flush();
    host.querySelector<HTMLButtonElement>('button[aria-label="Deny"]')?.click();
    expect(denied).toBe(1);

    renderDialog("Network error: retry safely");
    await flush();
    host.querySelector<HTMLButtonElement>('button[aria-label="Deny"]')?.click();
    expect(denied).toBe(2);

    root.unmount();
    host.remove();
    await flush();
  });
});
