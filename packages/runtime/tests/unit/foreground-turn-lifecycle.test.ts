import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetForegroundTurnLifecycleObserverForTests,
  installForegroundTurnLifecycleObserver,
  notifyForegroundTurnLifecycle,
} from "../../src/foreground-turn-lifecycle";

afterEach(() => _resetForegroundTurnLifecycleObserverForTests());

describe("D513 foreground turn lifecycle observer", () => {
  test("replacement cleanup cannot uninstall the newer app observer", () => {
    const seen: string[] = [];
    const cleanFirst = installForegroundTurnLifecycleObserver(() => seen.push("first"));
    const cleanSecond = installForegroundTurnLifecycleObserver(() => seen.push("second"));
    cleanFirst();
    notifyForegroundTurnLifecycle({ kind: "human_persisted", turnId: "turn" });
    expect(seen).toEqual(["second"]);
    cleanSecond();
    notifyForegroundTurnLifecycle({ kind: "human_persisted", turnId: "turn" });
    expect(seen).toEqual(["second"]);
  });

  test("an observer failure cannot escape a completed append boundary", () => {
    installForegroundTurnLifecycleObserver(() => { throw new Error("test observer"); });
    expect(() => notifyForegroundTurnLifecycle({
      kind: "human_persist_failed",
      turnId: "turn",
    })).not.toThrow();
  });
});
