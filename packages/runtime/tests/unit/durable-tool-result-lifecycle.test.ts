import { describe, expect, test } from "bun:test";
import {
  _resetDurableToolResultLifecycleObserverForTests,
  installDurableToolResultLifecycleObserver,
  notifyDurableToolResultLifecycle,
} from "../../src/durable-tool-result-lifecycle";

const event = {
  kind: "tool_result_persisted" as const,
  toolName: "guide_user",
  content: "{}",
  fingerprint: "tool-fingerprint",
  trustedExecutionEntrypoint: "foreground.main" as const,
  turnId: "turn-1",
};

describe("durable tool result lifecycle", () => {
  test("replaces observers safely and an old cleanup cannot remove the replacement", () => {
    const seen: string[] = [];
    const disposeFirst = installDurableToolResultLifecycleObserver(() => seen.push("first"));
    const disposeSecond = installDurableToolResultLifecycleObserver(() => seen.push("second"));
    disposeFirst();

    notifyDurableToolResultLifecycle(event);
    expect(seen).toEqual(["second"]);

    disposeSecond();
    notifyDurableToolResultLifecycle(event);
    expect(seen).toEqual(["second"]);
    _resetDurableToolResultLifecycleObserverForTests();
  });

  test("contains observer exceptions so a durable append can remain successful", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => warnings.push(message);
    try {
      installDurableToolResultLifecycleObserver(() => { throw new Error("must not escape"); });
      expect(() => notifyDurableToolResultLifecycle(event)).not.toThrow();
      expect(warnings).toEqual([
        "[durable-tool-result-lifecycle] observer failed; automatic presentation dropped",
      ]);
    } finally {
      console.warn = originalWarn;
      _resetDurableToolResultLifecycleObserverForTests();
    }
  });
});
