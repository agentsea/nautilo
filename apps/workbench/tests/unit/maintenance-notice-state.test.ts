import { afterEach, describe, expect, test } from "bun:test";
import {
  applyMaintenanceStatus,
  getMaintenanceNoticeSnapshot,
  hasMaintenanceNormalCompletion,
  resetMaintenanceNoticeForTest,
  resolveWorkbenchMessageBar,
  subscribeMaintenanceNotice,
} from "../../src/components/maintenance-notice-state";

afterEach(() => {
  resetMaintenanceNoticeForTest();
});

describe("maintenance message-bar state (D420 R12)", () => {
  test("consumes draining and applying transitions", () => {
    applyMaintenanceStatus({ state: "draining" });
    expect(getMaintenanceNoticeSnapshot()).toEqual({
      kind: "draining",
      applyingLatched: false,
    });

    applyMaintenanceStatus({ state: "applying" });
    expect(getMaintenanceNoticeSnapshot()).toEqual({
      kind: "applying",
      applyingLatched: true,
    });
  });

  test("keeps applying through a planned reconnect and ignores delayed draining", () => {
    applyMaintenanceStatus({ state: "applying" });

    // Transport close/reopen does not mutate this origin-scoped store.
    expect(
      resolveWorkbenchMessageBar({
        maintenance: getMaintenanceNoticeSnapshot(),
        refreshPending: false,
        reconnecting: true,
      }),
    ).toBe("applying");

    applyMaintenanceStatus({ state: "draining" });
    expect(getMaintenanceNoticeSnapshot().kind).toBe("applying");
  });

  test("holds applying until an observed normal maintenance frame", () => {
    applyMaintenanceStatus({ state: "applying" });
    expect(getMaintenanceNoticeSnapshot()).toEqual({
      kind: "applying",
      applyingLatched: true,
    });
    expect(hasMaintenanceNormalCompletion()).toBe(false);

    applyMaintenanceStatus({ state: "normal" });
    expect(getMaintenanceNoticeSnapshot()).toEqual({
      kind: "applying",
      applyingLatched: true,
    });
    expect(hasMaintenanceNormalCompletion()).toBe(true);
  });

  test("emits normal completion only once while applying remains latched", () => {
    applyMaintenanceStatus({ state: "applying" });
    let emissions = 0;
    const unsubscribe = subscribeMaintenanceNotice(() => {
      emissions += 1;
    });

    applyMaintenanceStatus({ state: "normal" });
    applyMaintenanceStatus({ state: "normal" });

    expect(emissions).toBe(1);
    expect(hasMaintenanceNormalCompletion()).toBe(true);
    expect(getMaintenanceNoticeSnapshot()).toEqual({
      kind: "applying",
      applyingLatched: true,
    });
    unsubscribe();
  });

  test("enforces applying, draining, Refresh, reconnect precedence", () => {
    const normal = { kind: "normal", applyingLatched: false } as const;
    const draining = { kind: "draining", applyingLatched: false } as const;
    const applying = { kind: "applying", applyingLatched: true } as const;

    expect(
      resolveWorkbenchMessageBar({
        maintenance: applying,
        refreshPending: true,
        reconnecting: true,
      }),
    ).toBe("applying");
    expect(
      resolveWorkbenchMessageBar({
        maintenance: draining,
        refreshPending: true,
        reconnecting: true,
      }),
    ).toBe("draining");
    expect(
      resolveWorkbenchMessageBar({
        maintenance: normal,
        refreshPending: true,
        reconnecting: true,
      }),
    ).toBe("refresh");
    expect(
      resolveWorkbenchMessageBar({
        maintenance: normal,
        refreshPending: false,
        reconnecting: true,
      }),
    ).toBe("reconnect");
  });
});
