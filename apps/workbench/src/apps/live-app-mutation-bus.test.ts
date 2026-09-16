import { describe, expect, mock, test } from "bun:test";
import {
  liveAppMutationFromToolEnd,
  publishLiveAppMutationCommitted,
  resetLiveAppMutationBusForTest,
  subscribeLiveAppMutationCommitted,
} from "./live-app-mutation-bus";

describe("live app mutation bus", () => {
  test.each([
    ["nautilo-design", "app_nautilo_design__edit_open_design", "app_nautilo_design__inspect_open_design"],
    ["nautilo-board", "app_nautilo_board__edit_open_board", "app_nautilo_board__inspect_open_board"],
  ])("recognizes successful direct edits for %s", (appId, editTool, inspectTool) => {
    expect(liveAppMutationFromToolEnd({
      type: "tool.end",
      toolCallId: "edit-1",
      toolName: editTool,
      duration: 10,
      status: "success",
    })).toEqual({ appId, toolCallId: "edit-1" });

    expect(liveAppMutationFromToolEnd({
      type: "tool.end",
      toolCallId: "edit-2",
      toolName: editTool,
      duration: 10,
      status: "error",
    })).toBeNull();
    expect(liveAppMutationFromToolEnd({
      type: "tool.end",
      toolCallId: "inspect-1",
      toolName: inspectTool,
      duration: 10,
      status: "success",
    })).toBeNull();
  });

  test("publishes a committed mutation to active subscribers", () => {
    resetLiveAppMutationBusForTest();
    const listener = mock(() => {});
    const unsubscribe = subscribeLiveAppMutationCommitted(listener);
    const event = { appId: "nautilo-design" as const, toolCallId: "edit-1" };

    publishLiveAppMutationCommitted(event);
    expect(listener).toHaveBeenCalledWith(event);

    unsubscribe();
    publishLiveAppMutationCommitted(event);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
