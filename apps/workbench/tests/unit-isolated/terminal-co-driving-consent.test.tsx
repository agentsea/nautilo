import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

let happyWindow: Window;
let TerminalControlConsentDialog: (typeof import("../../src/components/terminal-control-consent-dialog"))["TerminalControlConsentDialog"];
const priorGlobals: Record<string, unknown> = {};

beforeAll(async () => {
  happyWindow = new Window({ url: "http://localhost/" });
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
  ({ TerminalControlConsentDialog } = await import("../../src/components/terminal-control-consent-dialog"));
});

afterAll(() => {
  const globals = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) delete globals[key];
    else globals[key] = priorGlobals[key];
  }
});

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("terminal co-driving consent", () => {
  test("dialog has calm copy, accessible semantics, initial cancel focus, Escape, and confirm actions", async () => {
    let cancelled = 0;
    let confirmed = 0;
    const host = happyWindow.document.createElement("div");
    happyWindow.document.body.append(host);
    const root: Root = createRoot(host);
    await act(async () => {
      root.render(
        <TerminalControlConsentDialog
          assistantName="Jeannie"
          onCancel={() => {
            cancelled += 1;
          }}
          onConfirm={() => {
            confirmed += 1;
          }}
        />,
      );
      await flush();
    });

    const dialog = host.querySelector('[data-testid="terminal-control-consent-dialog"]');
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(host.textContent).toContain(
      "Jeannie can type and run commands in this terminal using your macOS account.",
    );
    expect(host.textContent).toContain("You can take control at any time.");
    expect(happyWindow.document.activeElement?.textContent).toBe("Cancel");

    await act(async () => {
      happyWindow.document.dispatchEvent(
        new happyWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await flush();
    });
    expect(cancelled).toBe(1);

    const confirm = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Let Jeannie drive"),
    ) as HTMLButtonElement;
    await act(async () => {
      confirm.click();
      await flush();
    });
    expect(confirmed).toBe(1);

    await act(async () => {
      root.unmount();
      await flush();
    });
    host.remove();
  });

  test("surface routes first handoff to grant and repeat handoff to setController without optimistic state", async () => {
    const source = await Bun.file(
      new URL("../../src/apps/terminal-surface.tsx", import.meta.url).pathname,
    ).text();

    expect(source).toContain("if (sandboxed || agentControlConsented)");
    expect(source).toContain('await api.setController(activeSessionId, "agent");');
    expect(source).toContain("setConsentDialogOpen(true);");
    expect(source).toContain("await api.grantAgentControl(activeSessionId);");
    expect(source).toContain("setAgentControlConsented(true);");
    expect(source).toMatch(
      /setAgentControlConsented\(true\);\s+setConsentDialogOpen\(false\);\s+setConsentForRequest\(false\);/,
    );
    expect(source).not.toContain('applyController("agent")');
    expect(source).not.toContain('applyController("user")');
  });

  test("hidden requests inspect metadata, retain the request through confirmation, and clear only on deny or cancel", async () => {
    const source = await Bun.file(
      new URL("../../src/layouts/workbench-shell.tsx", import.meta.url).pathname,
    ).text();

    expect(source).toContain("const session = (await api.list()).find");
    expect(source).toContain("session.sandboxed || session.agentControlConsented");
    expect(source).toContain('await api.setController(sid, "agent");');
    expect(source).toContain("setTerminalControlConsentSessionId(sid);");
    expect(source).toContain("await api.grantAgentControl(sid);");
    expect(source).toContain("if (granted) setTerminalControlConsentSessionId(null);");
    expect(source).toContain("await api.clearRequest(sid);");
    expect(source).not.toContain("setTerminalControlRequestSessionId(null);\n    void api.setController");
  });

  test("visible request cancellation clears only after the user cancels the consent dialog", async () => {
    const source = await Bun.file(
      new URL("../../src/apps/terminal-surface.tsx", import.meta.url).pathname,
    ).text();

    expect(source).toContain("const clearsRequest = consentForRequest;");
    expect(source).toContain("if (clearsRequest && api && sid) {");
    expect(source).toContain("await api.clearRequest(sid);");
    expect(source).toContain("onClick={() => void handleLetAgentDrive(true)}");
  });
});
