import "../bun-dom-preload.ts";
import { afterEach, expect, test } from "bun:test";
import {
  AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { HumanMessageContent } from "../../src/components/human-message-content";
import { UserText } from "../../src/components/conversation";
import { reconcileCanonicalHumanMessage, settleHumanMessageVerification } from "../../src/adapters/message-new-reconciliation";

function UserMessage() {
  return <HumanMessageContent><MessagePrimitive.Content components={{ Text: UserText }} /></HumanMessageContent>;
}

function Harness({ messages }: { messages: readonly ThreadMessageLike[] }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages, onNew: async () => {}, isRunning: false, convertMessage: (message) => message,
  });
  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Messages components={{ UserMessage }} />
  </AssistantRuntimeProvider>;
}

const pending = () => reconcileCanonicalHumanMessage([], {
  messageId: "42", sourceUserId: "peer", content: "ordinary content must stay hidden",
  verificationPending: true,
}, "viewer");

afterEach(cleanup);

test("pending → verified replaces an accessible reduced-motion-aware spinner with the message", async () => {
  const messages = pending();
  const view = render(<Harness messages={messages} />);
  const spinner = view.getByRole("status", { name: "Decrypting message" });
  expect(spinner.querySelector("svg")?.classList.contains("motion-reduce:animate-none")).toBe(true);
  expect(view.queryByText("Verified message body")).toBeNull();
  expect(view.container.textContent).not.toContain("waiting for verification");
  expect(view.container.textContent).not.toContain("ordinary content");
  view.rerender(<Harness messages={settleHumanMessageVerification(messages, "42", {
    status: "verified", content: "Verified message body",
  })} />);
  expect(view.queryByRole("status")).toBeNull();
  await waitFor(() => expect(view.getByText("Verified message body")).toBeTruthy());
});

test("pending → failed stops spinning, keeps content hidden, and explains retry", () => {
  const messages = pending();
  const view = render(<Harness messages={messages} />);
  view.rerender(<Harness messages={settleHumanMessageVerification(messages, "42", { status: "failed" })} />);
  expect(view.getByRole("status").textContent).toBe("Couldn’t verify message. Reload to retry.");
  expect(view.container.querySelector("svg")).toBeNull();
  expect(view.queryByText("Verified message body")).toBeNull();
});

test("ordinary messages retain their existing presentation", () => {
  const view = render(<Harness messages={[{ id: "42", role: "user", content: "ordinary" }]} />);
  expect(view.getByText("ordinary")).toBeTruthy();
  expect(view.queryByRole("status")).toBeNull();
});
