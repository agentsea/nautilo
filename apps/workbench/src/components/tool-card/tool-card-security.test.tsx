import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { restoreSessionMessages } from "../../adapters/session-rehydrate";
import type { ToolActivityEvent } from "../../adapters/runtime-contexts";
import { ToolCard } from "./tool-card";

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};

beforeAll(() => {
  // Rendering-only fixture: no signed-in identity or resume authority.
  mock.module("../../hooks/use-auth", () => ({ useAuth: () => ({ viewer: { sessionUserId: null, sessionActorId: null } }) }));
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

afterAll(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  const globals = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(priorGlobals)) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("ToolCard credential display boundary", () => {
  test("only the explicit chevron collapses an expanded card", async () => {
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);

    root.render(
      <ToolCard
        toolCallId="interactive-editor"
        toolName="unknown_editor_tool"
        args={{}}
        status={{ type: "complete" }}
        defaultExpanded
        expandedContent={<label>Add images<input type="file" /></label>}
      />,
    );
    await flush();

    const card = host.querySelector("[data-tool-card-state]");
    const label = host.querySelector("label");
    expect(card?.getAttribute("aria-expanded")).toBe("true");
    label?.click();
    await flush();
    expect(card?.getAttribute("aria-expanded")).toBe("true");

    const input = host.querySelector("input");
    input?.dispatchEvent(new happyWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input?.dispatchEvent(new happyWindow.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    card?.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
    await flush();
    expect(card?.getAttribute("aria-expanded")).toBe("true");

    const collapse = host.querySelector("button[aria-label='Collapse unknown_editor_tool']") as HTMLButtonElement | null;
    collapse?.click();
    await flush();
    expect(card?.getAttribute("aria-expanded")).toBe("false");

    root.unmount();
    host.remove();
    await flush();
  });

  test("specialized shell renderer receives projected progress and result data", async () => {
    const progressSecret = "Ab3_Cd4-Ef5_Gh6-Ij7_Kl8-Mn9_Op0-Qr1_St2";
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    const event = {
      toolCallId: "shell-safe-render",
      toolName: "run_shell",
      args: { command: "printf status" },
      status: "running",
      startedAt: Date.now(),
      runShellProgress: {
        stdout: `Bearer ${progressSecret}`,
        stderr: "ordinary stderr",
        stdoutOffsetBytes: 0,
        stderrOffsetBytes: 0,
        droppedBytes: 0,
        phase: "running",
        elapsedMs: 1,
      },
    } as ToolActivityEvent;

    root.render(
      <ToolCard
        toolCallId="shell-safe-render"
        toolName="run_shell"
        args={{ command: "printf status" }}
        status={{ type: "running" }}
        activityOverride={event}
        defaultExpanded
      />,
    );
    await flush();

    expect(host.textContent).toContain("Bearer [redacted]");
    expect(host.innerHTML).not.toContain(progressSecret);
    root.unmount();
    host.remove();
    await flush();
  });

  test("a running connected website card opens and uses the canonical live event arguments", async () => {
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    const event = {
      toolCallId: "connected-nebius",
      toolName: "read_connected_web_account",
      args: { account: "console.nebius.com", request: "Inspect active instances", delivery: "text" },
      status: "running",
      startedAt: Date.now(),
    } as ToolActivityEvent;

    root.render(
      <ToolCard
        toolCallId="connected-nebius"
        toolName="read_connected_web_account"
        args={{}}
        status={{ type: "running" }}
        activityOverride={event}
      />,
    );
    await flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const card = host.querySelector("[data-tool-card-state]");
    expect(card?.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("Working on console.nebius.com");

    const collapse = host.querySelector("button[aria-label='Collapse Connected website']") as HTMLButtonElement | null;
    collapse?.click();
    await flush();
    expect(card?.getAttribute("aria-expanded")).toBe("false");

    root.unmount();
    host.remove();
    await flush();
  });

  test("a running connected website save uses canonical target args and respects manual expansion at completion", async () => {
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    const running = { toolCallId: "connected-save", toolName: "act_connected_web_account", args: { account: "Notion", action: "save_item", target: "Project plan" }, status: "running", startedAt: Date.now() } as ToolActivityEvent;
    root.render(<ToolCard toolCallId="connected-save" toolName="act_connected_web_account" args={{}} status={{ type: "running" }} activityOverride={running} />);
    await flush(); await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const card = host.querySelector("[data-tool-card-state]");
    expect(card?.getAttribute("data-tool-card-state")).toBe("running");
    expect(card?.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("Saving Project plan");
    const collapse = host.querySelector("button[aria-label='Collapse Connected website save']") as HTMLButtonElement | null;
    collapse?.click(); await flush();
    const expand = host.querySelector("button[aria-label='Expand Connected website save']") as HTMLButtonElement | null;
    expand?.click(); await flush();
    const completed = { ...running, status: "ok", endedAt: Date.now(), result: JSON.stringify({ ok: true, status: "completed", action: "save_item", target: "Project plan", account: { id: "11111111-1111-4111-8111-111111111111", label: "Notion", service: "Notion", origin: "https://www.notion.so" }, receipt: { executionRef: "execution", effectState: "observed", postcondition: "The named item is saved.", evidenceCode: "postcondition_observed", cost: { amountUsd: null, state: "unknown" } } }) } as ToolActivityEvent;
    root.render(<ToolCard toolCallId="connected-save" toolName="act_connected_web_account" args={{}} status={{ type: "complete" }} activityOverride={completed} />);
    await flush();
    expect(card?.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("Completed");
    root.unmount(); host.remove(); await flush();
  });

  test("a completed website save collapses quietly unless the Human changed expansion", async () => {
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    const running = { toolCallId: "connected-save-auto", toolName: "act_connected_web_account", args: { account: "Notion", action: "save_item", target: "Project plan" }, status: "running", startedAt: Date.now() } as ToolActivityEvent;
    root.render(<ToolCard toolCallId="connected-save-auto" toolName="act_connected_web_account" args={{}} status={{ type: "running" }} activityOverride={running} />);
    await flush(); await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const card = host.querySelector("[data-tool-card-state]");
    expect(card?.getAttribute("aria-expanded")).toBe("true");
    const completed = { ...running, status: "ok", endedAt: Date.now(), result: JSON.stringify({ ok: true, status: "completed", action: "save_item", target: "Project plan", account: { id: "11111111-1111-4111-8111-111111111111", label: "Notion", service: "Notion", origin: "https://www.notion.so" }, receipt: { executionRef: "execution", effectState: "observed", postcondition: "The named item is saved.", evidenceCode: "postcondition_observed", cost: { amountUsd: null, state: "unknown" } } }) } as ToolActivityEvent;
    root.render(<ToolCard toolCallId="connected-save-auto" toolName="act_connected_web_account" args={{}} status={{ type: "complete" }} activityOverride={completed} />);
    await flush(); await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(card?.getAttribute("aria-expanded")).toBe("false");
    root.unmount(); host.remove(); await flush();
  });

  test("a truncated connected website save is never displayed as success", async () => {
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    const event = { toolCallId: "connected-save-truncated", toolName: "act_connected_web_account", args: { account: "Notion", action: "save_item", target: "Project plan" }, status: "ok", startedAt: Date.now(), endedAt: Date.now(), resultTruncated: true, result: JSON.stringify({ ok: true, status: "completed", action: "save_item", target: "Project plan", account: { id: "11111111-1111-4111-8111-111111111111", label: "Notion", service: "Notion", origin: "https://www.notion.so" }, receipt: { executionRef: "execution", effectState: "observed", postcondition: "The named item is saved.", evidenceCode: "postcondition_observed", cost: { amountUsd: null, state: "unknown" } } }) } as ToolActivityEvent;
    root.render(<ToolCard toolCallId="connected-save-truncated" toolName="act_connected_web_account" args={{}} status={{ type: "complete" }} activityOverride={event} defaultExpanded />);
    await flush();
    expect(host.querySelector("[data-tool-card-state]")?.getAttribute("data-tool-card-state")).toBe("error");
    expect(host.textContent).toContain("truncated and cannot be confirmed");
    root.unmount(); host.remove(); await flush();
  });

  test("restart hydration keeps two paginated inspect cards safe when collapsed and expanded", async () => {
    const sessionSecret = "tool-card-restart-session-secret";
    const nestedSecret = "tool-card-restart-nested-secret";
    const opaqueCursorOne = "Qm7_Na2-Xp9_Lc4-Vr8_Kd1-Zs6_Hf3-Wt5_By0-Gj7_Pe2-Ru9_Cx4";
    const opaqueCursorTwo = "Rs8_Ob3-Yq0_Md5-Wa9_Ke2-Zt7_Ig4-Xu6_Cn1-Hj8_Pf3-Sv0_Dl5";
    const restored = restoreSessionMessages([
      {
        id: "assistant-inspects",
        role: "assistant",
        content: "",
        toolCalls: JSON.stringify([
          {
            id: "inspect-page-1",
            name: "inspect_open_design",
            args: {
              sessionToken: sessionSecret,
              cursor: opaqueCursorOne,
              pageSize: 25,
              nested: { access_token: nestedSecret, intent: "first page" },
            },
          },
          {
            id: "inspect-page-2",
            name: "inspect_open_design",
            args: {
              sessionToken: sessionSecret,
              cursor: opaqueCursorTwo,
              nested: { clientSecret: nestedSecret, intent: "next page" },
            },
          },
        ]),
      },
      {
        id: "result-1",
        role: "tool",
        toolName: "inspect_open_design",
        content: JSON.stringify({
          total: 4,
          returned: 2,
          omitted: 2,
          completeness: "partial",
          nextCursor: opaqueCursorOne,
          nodes: [{ name: "Ellipse" }, { name: "Diamond" }],
        }),
      },
      {
        id: "result-2",
        role: "tool",
        toolName: "inspect_open_design",
        content: JSON.stringify({
          total: 4,
          returned: 2,
          omitted: 0,
          completeness: "complete",
          nextCursor: opaqueCursorTwo,
          nested: { sessionToken: sessionSecret, cursor: opaqueCursorOne },
          nodes: [{ name: "Connector" }, { name: "Pen path" }],
        }),
      },
    ]);
    const calls = restored.map((message) => message.content[0] as {
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      result?: unknown;
    });
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);

    root.render(<>
      {calls.map((call, index) => (
        <ToolCard
          key={call.toolCallId}
          toolCallId={call.toolCallId}
          toolName={call.toolName}
          args={call.args}
          result={call.result}
          status={{ type: "complete" }}
          defaultExpanded={index === 1}
        />
      ))}
    </>);
    await flush();

    expect(host.querySelectorAll("[data-tool-card-state]")).toHaveLength(2);
    expect(host.textContent).toContain("next page");
    expect(host.textContent).toContain("Connector");
    expect(host.textContent).toContain("Pen path");
    expect(host.textContent).toContain("completeness");
    expect(host.textContent).toContain("returned");
    expect(host.innerHTML).not.toContain("[redacted]");
    expect(host.innerHTML).not.toContain("sessionToken");
    expect(host.innerHTML).not.toContain("nextCursor");
    expect(host.innerHTML).not.toContain('"cursor"');
    expect(host.innerHTML).not.toContain(sessionSecret);
    expect(host.innerHTML).not.toContain(nestedSecret);
    expect(host.innerHTML).not.toContain(opaqueCursorOne);
    expect(host.innerHTML).not.toContain(opaqueCursorTwo);
    for (const element of host.querySelectorAll("[aria-label], [title]")) {
      expect(element.getAttribute("aria-label") ?? "").not.toContain(sessionSecret);
      expect(element.getAttribute("aria-label") ?? "").not.toContain(nestedSecret);
      expect(element.getAttribute("title") ?? "").not.toContain(sessionSecret);
      expect(element.getAttribute("title") ?? "").not.toContain(nestedSecret);
      expect(element.getAttribute("aria-label") ?? "").not.toContain(opaqueCursorOne);
      expect(element.getAttribute("aria-label") ?? "").not.toContain(opaqueCursorTwo);
      expect(element.getAttribute("title") ?? "").not.toContain(opaqueCursorOne);
      expect(element.getAttribute("title") ?? "").not.toContain(opaqueCursorTwo);
    }

    root.unmount();
    host.remove();
    await flush();
  });
});
