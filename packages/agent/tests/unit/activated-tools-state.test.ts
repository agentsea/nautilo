import { describe, expect, test } from "bun:test";
import {
  NautiloStateAnnotation,
  replaceActivatedToolLeases,
  replaceActivatedToolNames,
} from "../../src/agent/state";
import {
  createActivatedToolsHandle,
  MAX_ACTIVATED_TOOL_NAMES,
} from "../../src/tools/meta/activated-tools-handle";

describe("D419 — activated tool checkpoint state", () => {
  test("defaults legacy checkpoints to an empty activation list", () => {
    const channel = NautiloStateAnnotation.spec.activatedToolNames;

    expect(channel.fromCheckpoint(undefined).get()).toEqual([]);
  });

  test("replaces the complete activation list without changing the whitelist", () => {
    const state = {
      activatedToolNames: ["file"],
      toolWhitelist: ["discover_tools"],
    };

    const next = {
      ...state,
      activatedToolNames: replaceActivatedToolNames(
        state.activatedToolNames,
        ["run_shell"],
      ),
    };

    expect(next.activatedToolNames).toEqual(["run_shell"]);
    expect(next.toolWhitelist).toEqual(["discover_tools"]);
  });

  test("bounds direct checkpoint state updates as well as tool mutations", () => {
    const update = Array.from(
      { length: MAX_ACTIVATED_TOOL_NAMES + 2 },
      (_, index) => ` tool-${index} `,
    );

    const next = replaceActivatedToolNames([], update);

    expect(next).toHaveLength(MAX_ACTIVATED_TOOL_NAMES);
    expect(next[0]).toBe("tool-0");
    expect(next).not.toContain(`tool-${MAX_ACTIVATED_TOOL_NAMES + 1}`);
  });

  test("defaults lease metadata and its aging marker independently from names", () => {
    expect(NautiloStateAnnotation.spec.activatedToolLeases.fromCheckpoint(undefined).get()).toEqual([]);
    expect(NautiloStateAnnotation.spec.activationLeasesAgedForTurnId.fromCheckpoint(undefined).get()).toBe("");
    expect(NautiloStateAnnotation.spec.activationLeasesInitialized.fromCheckpoint(undefined).get()).toBe(false);
    expect(NautiloStateAnnotation.spec.activationIntentAppliedForTurnId.fromCheckpoint(undefined).get()).toBe("");
  });

  test("normalizes direct lease checkpoint updates", () => {
    expect(replaceActivatedToolLeases([], [
      { name: " file ", idleTurns: -1 },
      { name: "file", idleTurns: 3 },
      { name: "run_shell", idleTurns: Number.POSITIVE_INFINITY },
      { name: "", idleTurns: 1 },
    ])).toEqual([
      { name: "file", idleTurns: 0 },
      { name: "run_shell", idleTurns: 0 },
    ]);
  });
});

describe("D419 — activated tools handle", () => {
  test("keeps names and leases together through add, renewal, removal, and clearing", () => {
    const handle = createActivatedToolsHandle([" file ", "file", "run_shell"]);

    handle.add(" run_shell ");
    handle.add("read_webpage");
    handle.renew("run_shell");
    handle.remove(" file ");

    expect(handle.snapshotNames()).toEqual(["run_shell", "read_webpage"]);
    expect(handle.snapshotLeases()).toEqual([
      { name: "run_shell", idleTurns: 0 },
      { name: "read_webpage", idleTurns: 0 },
    ]);
    handle.clear();
    expect(handle.snapshot()).toEqual([]);
    expect(handle.snapshotLeases()).toEqual([]);
  });

  test("caps initial and subsequently added names", () => {
    const handle = createActivatedToolsHandle(
      Array.from({ length: MAX_ACTIVATED_TOOL_NAMES + 1 }, (_, index) => `tool-${index}`),
    );

    handle.add("overflow");

    expect(handle.snapshot()).toHaveLength(MAX_ACTIVATED_TOOL_NAMES);
    expect(handle.snapshot()).not.toContain("overflow");
  });

  test("keeps selected names independent from leases and reports atomic capacity rejection", () => {
    const retainedButNotSelected = createActivatedToolsHandle(
      ["intent_only"],
      MAX_ACTIVATED_TOOL_NAMES,
      [{ name: "file", idleTurns: 2 }],
    );

    expect(retainedButNotSelected.snapshotNames()).toEqual(["intent_only"]);
    expect(retainedButNotSelected.snapshotLeases()).toEqual([{ name: "file", idleTurns: 2 }]);
    expect(retainedButNotSelected.add("file")).toBe(true);
    expect(retainedButNotSelected.snapshotNames()).toEqual(["intent_only", "file"]);

    const handle = createActivatedToolsHandle(
      Array.from({ length: MAX_ACTIVATED_TOOL_NAMES - 1 }, (_, index) => `intent-${index}`),
      MAX_ACTIVATED_TOOL_NAMES,
      Array.from({ length: MAX_ACTIVATED_TOOL_NAMES }, (_, index) => ({
        name: `lease-${index}`,
        idleTurns: 0,
      })),
    );
    expect(handle.add("candidate")).toBe(false);
    expect(handle.snapshotNames()).not.toContain("candidate");
    expect(handle.snapshotLeases()).not.toContainEqual({ name: "candidate", idleTurns: 0 });
  });

  test("returns an immutable snapshot copy", () => {
    const handle = createActivatedToolsHandle(["file"]);
    const snapshot = handle.snapshot();

    snapshot.push("mutated");

    expect(handle.snapshot()).toEqual(["file"]);
  });

  test("returns immutable lease snapshot copies", () => {
    const handle = createActivatedToolsHandle();
    handle.add("file");
    const snapshot = handle.snapshotLeases();

    snapshot[0]!.idleTurns = 9;

    expect(handle.snapshotLeases()).toEqual([{ name: "file", idleTurns: 0 }]);
  });
});
