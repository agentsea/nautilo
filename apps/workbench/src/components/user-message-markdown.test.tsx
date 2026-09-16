import "../../tests/bun-dom-preload.ts";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { FC } from "react";

import { UserText } from "./conversation";

const adapter: ChatModelAdapter = {
  async *run() {},
};

const UserMessage: FC = () => (
  <MessagePrimitive.Content components={{ Text: UserText }} />
);

function renderUserMessage(text: string) {
  const messages: ThreadMessageLike[] = [{ role: "user", content: text }];

  function Runtime() {
    const runtime = useLocalRuntime(adapter, { initialMessages: messages });
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Messages components={{ UserMessage }} />
      </AssistantRuntimeProvider>
    );
  }

  return render(<Runtime />);
}

afterEach(cleanup);

describe("UserText", () => {
  test("renders a bare HTTPS URL as a link opened outside the current window", async () => {
    const url = "https://example.com/project/specs/plan.md";
    const view = renderUserMessage(`New spec: ${url}`);
    const link = await waitFor(() => view.getByRole("link", { name: url }));

    expect(link.getAttribute("href")).toBe(url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("does not turn a plain document filename into a web link", async () => {
    const view = renderUserMessage("Open @mini-cloud-master-plan.md");

    await waitFor(() => {
      expect(view.getByText("Open @mini-cloud-master-plan.md")).toBeTruthy();
    });
    expect(view.queryByRole("link")).toBeNull();
  });
});
