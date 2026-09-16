import "../../../../tests/bun-dom-preload.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { TaskHarnessActivity } from "@nautilo/types";

import { HarnessActivityFeed } from "./HarnessActivityFeed";

afterEach(cleanup);

function response(result: string): TaskHarnessActivity {
  return {
    id: "assistant-response-1",
    kind: "status",
    name: "assistant_response",
    status: "running",
    args: {},
    result,
    appendResult: true,
    appendResultSeparator: "",
    startedAt: 1,
  };
}

describe("HarnessActivityFeed", () => {
  test("updates one continuously growing assistant response card in place", () => {
    const view = render(<HarnessActivityFeed activity={[response("Hello ")]} />);
    const original = view.getByTestId("assistant-streaming-response");
    expect(original.textContent).toBe("Hello");

    view.rerender(<HarnessActivityFeed activity={[response("Hello world")]} />);

    const updated = view.getByTestId("assistant-streaming-response");
    expect(updated).toBe(original);
    expect(updated.textContent).toBe("Hello world");
    expect(view.getAllByTestId("assistant-streaming-response")).toHaveLength(1);
    expect(view.getByText("Assistant response")).toBeTruthy();
  });
});
