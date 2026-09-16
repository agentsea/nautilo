import "../bun-dom-preload";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { runShellRenderer } from "../../src/components/tool-card/renderers/run-shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderResult(state: "success" | "error", exitCode: number): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <runShellRenderer.ExpandedBody
        toolName="run_shell"
        args={{ command: "bun test" }}
        result={undefined}
        state={state}
        event={undefined}
        resultText={JSON.stringify({
          stderr: "Resolved, downloaded and extracted [1]\n(pass) example",
          stdout: "",
          exitCode,
        })}
        resultTruncated={false}
      />,
    );
  });
  return container.querySelector<HTMLElement>('[data-testid="run-shell-stderr"]')!;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("run_shell stderr outcome treatment", () => {
  test("keeps Bun progress neutral when the command exits successfully", async () => {
    const stderr = await renderResult("success", 0);
    expect(stderr.classList.contains("text-tool-error")).toBe(false);
    expect(stderr.classList.contains("text-foreground")).toBe(true);
  });

  test("retains error treatment for a failed command", async () => {
    const stderr = await renderResult("error", 1);
    expect(stderr.classList.contains("text-tool-error")).toBe(true);
  });
});
