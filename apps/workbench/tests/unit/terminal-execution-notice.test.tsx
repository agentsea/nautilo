import "../bun-dom-preload.ts";
import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import {
  TerminalExecutionNotices,
  terminalExecutionsFromMessageMetadata,
} from "../../src/components/terminal-execution-notice";

afterEach(cleanup);

test("renders durable cancellation and restart outcomes without payload content", () => {
  const summaries = terminalExecutionsFromMessageMetadata({
    custom: {
      terminalExecutions: [
        { messageId: 27, executionId: "execution:cancelled", classification: "cancelled" },
        { messageId: 27, executionId: "execution:lost", classification: "process_lost" },
      ],
    },
  });
  const view = render(<TerminalExecutionNotices summaries={summaries} />);

  expect(view.getByText("Response stopped.")).toBeTruthy();
  expect(view.getByText("Response interrupted when Nautilo restarted.")).toBeTruthy();
  expect(view.container.textContent).not.toContain("execution:cancelled");
  expect(view.container.textContent).not.toContain("execution:lost");
});

test("rejects open-ended or malformed classifications", () => {
  expect(terminalExecutionsFromMessageMetadata({
    custom: {
      terminalExecutions: [
        { messageId: 27, executionId: "execution:deadline", classification: "deadline_expired" },
      ],
    },
  })).toEqual([]);
});
