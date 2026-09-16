import "../bun-dom-preload.ts";
import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { ToolActivityContext, type ToolActivityEvent } from "../../src/adapters/runtime-contexts";
import { ToolCard } from "../../src/components/tool-card/tool-card";

afterEach(cleanup);

test("shows the physical button instruction while pairing, even with collapsed or partial arguments", () => {
  const activity: ToolActivityEvent = {
    toolCallId: "hue-setup", toolName: "hue_lights", args: { action: "setup" },
    status: "running", startedAt: Date.now(),
  };
  const card = (event: ToolActivityEvent) => (
    <ToolActivityContext.Provider value={[event]}>
      <ToolCard toolName="hue_lights" toolCallId="hue-setup" args={{}} status={{ type: "running" }} />
    </ToolActivityContext.Provider>
  );
  const view = render(card(activity));
  expect(view.getByRole("group").getAttribute("aria-expanded")).toBe("false");
  expect(view.getByRole("status").textContent).toContain("Press its physical button now");
  view.rerender(card({ ...activity, status: "error", endedAt: Date.now(), error: "Pairing timed out" }));
  expect(view.queryByRole("status")).toBeNull();
});

test("does not show a pairing instruction for ordinary Hue actions", () => {
  const view = render(<ToolCard toolName="hue_lights" args={{ action: "list_lights" }} status={{ type: "running" }} />);
  expect(view.queryByRole("status")).toBeNull();
});
