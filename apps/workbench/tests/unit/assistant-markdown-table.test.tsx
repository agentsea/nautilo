import "../bun-dom-preload";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { act, useState, type FC } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";

import { AssistantMarkdownTextPrimitive } from "../../src/components/assistant-markdown-text";
import {
  ASSISTANT_RESPONSE_GFM_TABLE_FIXTURE as fixture,
  ASSISTANT_RESPONSE_GFM_TABLE_PARTIAL as partialFixture,
} from "../../../../dev/fixtures/assistant-response-gfm-table";

type HarnessMessage = { id: string; text: string };

const convertMessage = (message: HarnessMessage): ThreadMessageLike => ({
  id: message.id,
  role: "assistant",
  content: [{ type: "text", text: message.text }],
});

const AssistantText: FC = () => (
  <AssistantMarkdownTextPrimitive smooth={false} />
);

let assistantMessageMounts = 0;

function AssistantMessage() {
  const [mountId] = useState(() => {
    assistantMessageMounts += 1;
    return assistantMessageMounts;
  });
  return (
    <article data-assistant-message data-mount-id={mountId}>
      <MessagePrimitive.Content components={{ Text: AssistantText }} />
    </article>
  );
}

function Harness({ messages }: { messages: HarnessMessage[] }) {
  const runtime = useExternalStoreRuntime<HarnessMessage>({
    messages,
    setMessages: () => {},
    onNew: async () => {},
    isRunning: false,
    convertMessage,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Messages components={{ AssistantMessage }} />
    </AssistantRuntimeProvider>
  );
}

afterEach(() => {
  cleanup();
  assistantMessageMounts = 0;
});

describe("assistant GFM table Markdown", () => {
  test("renders the shared AI-response fixture as semantic table HTML", async () => {
    const view = render(
      <Harness messages={[{ id: "assistant-1", text: fixture }]} />,
    );

    const table = await waitFor(() => view.container.querySelector("table"));
    expect(table).not.toBeNull();
    expect(table?.querySelector("thead")).not.toBeNull();
    expect(table?.querySelector("tbody")).not.toBeNull();
    expect(table?.querySelectorAll("th")).toHaveLength(5);
    expect(table?.querySelectorAll("td")).toHaveLength(10);
    expect(table?.querySelectorAll("th")[1]?.style.textAlign).toBe("center");
    expect(table?.querySelectorAll("th")[2]?.style.textAlign).toBe("right");
    expect(table?.querySelector("a")?.getAttribute("href")).toBe("https://nautilo.ai");
    expect(table?.querySelector("code")?.textContent).toBe("ready");
    expect(view.getByText("The prose after the table remains ordinary Markdown.")).toBeTruthy();
    expect(view.container.querySelector("li")?.textContent).toBe(
      "Closing list item with emphasis.",
    );
  });

  test("contains a wide assistant table in a keyboard-reachable horizontal viewport", async () => {
    const view = render(<Harness messages={[{ id: "assistant-wide", text: fixture }]} />);

    const table = await waitFor(() => view.container.querySelector("table"));
    const viewport = table?.parentElement;
    expect(viewport?.tagName).toBe("DIV");
    expect(viewport?.hasAttribute("data-assistant-markdown-table-viewport")).toBe(true);
    expect(viewport?.className).toContain("max-w-full");
    expect(viewport?.className).toContain("overflow-x-auto");
    expect(viewport?.getAttribute("tabindex")).toBe("0");
    expect(table?.className).toContain("min-w-full");
  });

  test("converges from partial streamed syntax without remounting or duplicating the table", async () => {
    const view = render(
      <Harness messages={[{ id: "assistant-stream", text: partialFixture }]} />,
    );
    const initialMessage = await waitFor(() =>
      view.container.querySelector<HTMLElement>("[data-assistant-message]"),
    );
    expect(initialMessage).not.toBeNull();
    expect(view.container.querySelector("table")).toBeNull();
    const initialMountId = initialMessage?.dataset.mountId;

    await act(async () => {
      view.rerender(<Harness messages={[{ id: "assistant-stream", text: fixture }]} />);
      await Promise.resolve();
    });

    await waitFor(() => expect(view.container.querySelectorAll("table")).toHaveLength(1));
    expect(
      view.container.querySelector<HTMLElement>("[data-assistant-message]")?.dataset.mountId,
    ).toBe(initialMountId);
  });
});
