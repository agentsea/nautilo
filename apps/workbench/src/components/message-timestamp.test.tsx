import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
let sentAt: unknown = "2026-09-06T14:42:08.000Z";
mock.module("@assistant-ui/react", () => ({ useMessage: (selector: (message: unknown) => unknown) => selector({ metadata: { custom: { sentAt, editedAt: "2026-09-07T15:00:00Z" } } }) }));
const { MessageTimestamp, messageDayKey, messageDayStarts, validMessageSentAt } = await import("./message-timestamp");
let screen: ReturnType<typeof within>;
beforeEach(() => { reapplyHappyDomGlobals(); screen = within(document.body); sentAt = "2026-09-06T14:42:08.000Z"; });
afterEach(cleanup);
test("shows original sent time, with keyboard/tap-accessible full date and timezone", () => {
  render(<MessageTimestamp />);
  const button = screen.getByRole("button");
  expect(button.querySelector("time")?.dateTime).toBe("2026-09-06T14:42:08.000Z");
  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText(/^Sent /).textContent).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  fireEvent.click(button); expect(button.getAttribute("aria-expanded")).toBe("false");
});
test("missing or invalid historical timestamps never become the current time", () => {
  sentAt = undefined;
  const view = render(<MessageTimestamp />); expect(view.container.textContent).toBe("");
  expect(validMessageSentAt("invalid")).toBeNull(); expect(validMessageSentAt(undefined)).toBeNull();
});
test("date boundary compares local calendar days", () => {
  const early = new Date(2026, 8, 6, 0, 1).toISOString();
  const late = new Date(2026, 8, 6, 23, 59).toISOString();
  const next = new Date(2026, 8, 7, 0, 1).toISOString();
  expect(messageDayKey(early)).toBe(messageDayKey(late)); expect(messageDayKey(next)).not.toBe(messageDayKey(late));
});

test("undated system notices do not repeat the same day separator", () => {
  expect([...messageDayStarts(["2026-09-06T12:00:00Z", undefined, "2026-09-06T12:30:00Z", "2026-09-07T12:00:00Z"])]).toEqual([0, 3]);
});
