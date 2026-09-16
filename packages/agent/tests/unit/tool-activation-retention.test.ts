import { describe, expect, test } from "bun:test";
import {
  advanceActivatedToolLeases,
  createActivatedToolsHandle,
  MAX_ACTIVATED_TOOL_NAMES,
} from "../../src/tools/meta/activated-tools-handle";

describe("D447 — pure activated-tool lease transitions", () => {
  test("keeps an activation through three unused owner turns then expires before the fourth", () => {
    const handle = createActivatedToolsHandle();
    handle.add("file");
    let state = {
      names: handle.snapshotNames(),
      leases: handle.snapshotLeases(),
      agedForTurnId: "turn-n",
      initialized: true,
    };

    for (const [turnId, expectedAge] of [["turn-n+1", 1], ["turn-n+2", 2], ["turn-n+3", 3]] as const) {
      state = advanceActivatedToolLeases({ ...state, turnId, retentionTurns: 3 });
      expect(state).toEqual({
        names: ["file"],
        leases: [{ name: "file", idleTurns: expectedAge }],
        agedForTurnId: turnId,
        initialized: true,
      });
    }

    state = advanceActivatedToolLeases({ ...state, turnId: "turn-n+4", retentionTurns: 3 });
    expect(state).toEqual({
      names: [], leases: [], agedForTurnId: "turn-n+4", initialized: true,
    });
  });

  test("does not age twice within one owner turn and renewal resets only its concrete tool", () => {
    const once = advanceActivatedToolLeases({
      names: ["file", "run_shell"],
      leases: [{ name: "file", idleTurns: 2 }, { name: "run_shell", idleTurns: 2 }],
      agedForTurnId: "turn-1",
      turnId: "turn-2",
      retentionTurns: 3,
      initialized: true,
    });
    const twice = advanceActivatedToolLeases({ ...once, turnId: "turn-2", retentionTurns: 3 });
    expect(twice).toEqual(once);

    const handle = createActivatedToolsHandle(twice.names, MAX_ACTIVATED_TOOL_NAMES, twice.leases, 3);
    handle.renew("file");
    expect(handle.snapshotLeases()).toEqual([
      { name: "file", idleTurns: 0 },
      { name: "run_shell", idleTurns: 3 },
    ]);
  });

  test("migrates only missing legacy metadata at age zero and never remigrates explicit emptiness", () => {
    const migrated = advanceActivatedToolLeases({
      names: [" file ", "file", "run_shell"],
      leases: [],
      turnId: "turn-legacy",
      retentionTurns: 3,
    });
    expect(migrated).toEqual({
      names: ["file", "run_shell"],
      leases: [{ name: "file", idleTurns: 0 }, { name: "run_shell", idleTurns: 0 }],
      agedForTurnId: "turn-legacy",
      initialized: true,
    });

    expect(advanceActivatedToolLeases({
      names: ["file"],
      leases: [],
      initialized: true,
      agedForTurnId: "turn-legacy",
      turnId: "turn-next",
      retentionTurns: 3,
    })).toEqual({ names: [], leases: [], agedForTurnId: "turn-next", initialized: true });
  });

  test("normalizes malformed leases, caps deterministically, and implements retention zero", () => {
    const tooMany = Array.from({ length: MAX_ACTIVATED_TOOL_NAMES + 2 }, (_, index) => ({
      name: index === 1 ? " tool-0 " : `tool-${index}`,
      idleTurns: index === 0 ? -2 : 99,
    }));
    const migrated = advanceActivatedToolLeases({
      names: [],
      leases: tooMany,
      initialized: true,
      agedForTurnId: "turn-1",
      turnId: "turn-1",
      retentionTurns: 20,
    });
    expect(migrated.leases).toHaveLength(MAX_ACTIVATED_TOOL_NAMES);
    expect(migrated.leases[0]).toEqual({ name: "tool-0", idleTurns: 0 });
    expect(migrated.leases.at(-1)?.name).toBe(`tool-${MAX_ACTIVATED_TOOL_NAMES}`);

    expect(advanceActivatedToolLeases({
      names: ["file"],
      leases: [{ name: "file", idleTurns: 0 }],
      initialized: true,
      agedForTurnId: "turn-n",
      turnId: "turn-n+1",
      retentionTurns: 0,
    })).toEqual({ names: [], leases: [], agedForTurnId: "turn-n+1", initialized: true });
  });

  test("never resurrects an over-age lease when a same turn or lower retention is processed", () => {
    expect(advanceActivatedToolLeases({
      names: ["file"],
      leases: [{ name: "file", idleTurns: 4 }],
      initialized: true,
      agedForTurnId: "turn-4",
      turnId: "turn-4",
      retentionTurns: 3,
    })).toEqual({ names: [], leases: [], agedForTurnId: "turn-4", initialized: true });

    const retainedAtTwenty = advanceActivatedToolLeases({
      names: ["file"],
      leases: [{ name: "file", idleTurns: 20 }],
      initialized: true,
      agedForTurnId: "turn-20",
      turnId: "turn-20",
      retentionTurns: 20,
    });
    expect(retainedAtTwenty.leases).toEqual([{ name: "file", idleTurns: 20 }]);

    expect(advanceActivatedToolLeases({
      ...retainedAtTwenty,
      retentionTurns: 3,
      turnId: "turn-20",
    })).toEqual({ names: [], leases: [], agedForTurnId: "turn-20", initialized: true });
  });
});
