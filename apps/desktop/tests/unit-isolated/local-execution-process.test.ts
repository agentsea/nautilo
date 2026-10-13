import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";

class Child extends EventEmitter {
  pid = 12345;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}
let child: Child;
let ptyExit: (event: { exitCode: number; signal: number }) => void;
mock.module("node:child_process", () => ({ spawn: () => child }));
mock.module("../../electron/terminal-host", () => ({
  spawnTerminalPty: () => ({
    pid: 12345,
    onData: () => ({ dispose() {} }),
    onExit: (listener: typeof ptyExit) => { ptyExit = listener; return { dispose() {} }; },
    write() {},
  }),
}));
const { spawnLocalExecutionProcess } = await import("../../electron/local-execution-process");

const prepared = { program: "/bin/sh", args: [], cwd: "/tmp", env: {}, dispose() {} };
const errno = (code: string) => Object.assign(new Error(code), { code });
afterEach(() => mock.restore());

function fixture(
  responses: readonly (true | string)[],
  tty = false,
  command = prepared,
) {
  child = new Child();
  let index = 0;
  const kill = spyOn(process, "kill").mockImplementation(() => {
    const result = responses[index++];
    if (result === undefined) throw new Error("Unexpected process signal");
    if (result !== true) throw errno(result);
    return true;
  });
  const owned = spawnLocalExecutionProcess(command, tty, () => {});
  return { owned, kill };
}

describe("owned process-group cleanup certainty", () => {
  test("accepts credentials admitted by prepared environment policy", async () => {
    const { owned } = fixture(["ESRCH"], false, {
      ...prepared,
      env: { GH_TOKEN: "synthetic-user-export" },
    });
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    expect(await owned.exited).toEqual({ exitCode: 0, signal: null });
  });

  test("successful kill and direct absence need no probe", async () => {
    const { owned, kill } = fixture([true, "ESRCH"]);
    owned.terminate();
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    expect(await owned.exited).toEqual({ exitCode: null, signal: "SIGKILL" });
    expect(kill.mock.calls).toEqual([[-12345, "SIGKILL"], [-12345, "SIGKILL"]]);
  });

  for (const error of ["EPERM", "EIO"]) {
    test(`${error} followed by conclusive absence resolves cleanup`, async () => {
      const { owned, kill } = fixture([error, "ESRCH"]);
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      expect(await owned.exited).toEqual({ exitCode: 0, signal: null });
      expect(kill.mock.calls).toEqual([[-12345, "SIGKILL"], [-12345, 0]]);
    });
  }

  test("a disappearing killed group is checked again only at drained close", async () => {
    const { owned, kill } = fixture([true, "EPERM", "EPERM", "ESRCH"]);
    owned.terminate();
    child.emit("exit", null, "SIGKILL");
    expect(kill.mock.calls).toEqual([[-12345, "SIGKILL"], [-12345, "SIGKILL"], [-12345, 0]]);
    child.emit("close", null, "SIGKILL");
    expect(await owned.exited).toEqual({ exitCode: null, signal: "SIGKILL" });
    expect(kill.mock.calls.at(-1)).toEqual([-12345, 0]);
    expect(kill).toHaveBeenCalledTimes(4);
  });

  for (const probe of [true, "EPERM", "EIO"] as const) {
    test(`a live or uncertain group (${String(probe)}) remains unconfirmed`, async () => {
      const { owned, kill } = fixture(["EPERM", probe, probe]);
      child.emit("exit", null, "SIGKILL");
      child.emit("close", null, "SIGKILL");
      expect(await owned.exited).toEqual({
        exitCode: null, signal: "SIGKILL", failureCode: "LOCAL_EXECUTION_GROUP_CLEANUP_FAILED",
      });
      expect(kill.mock.calls).toEqual([[-12345, "SIGKILL"], [-12345, 0], [-12345, 0]]);
    });
  }

  test("group absence cannot erase an output-drain failure", async () => {
    const { owned } = fixture(["EPERM", "EPERM", "ESRCH"]);
    child.emit("exit", 0, null);
    child.stderr.emit("error", new Error("fixture drain failure"));
    child.emit("close", 0, null);
    expect((await owned.exited).failureCode).toBe("LOCAL_EXECUTION_OUTPUT_DRAIN_FAILED");
  });

  test("Stop still throws its original failure when absence is not established", () => {
    const { owned } = fixture(["EPERM", true]);
    expect(() => owned.terminate()).toThrow("EPERM");
  });

  test("PTY drained exit can establish immediate absence", async () => {
    const { owned, kill } = fixture(["EPERM", "ESRCH"], true);
    ptyExit({ exitCode: 0, signal: 9 });
    expect(await owned.exited).toEqual({ exitCode: 0, signal: "9" });
    expect(kill.mock.calls).toEqual([[-12345, "SIGKILL"], [-12345, 0]]);
  });

  test("PTY drained exit preserves uncertain cleanup without a later boundary", async () => {
    const { owned, kill } = fixture(["EPERM", "EPERM"], true);
    ptyExit({ exitCode: 0, signal: 9 });
    expect((await owned.exited).failureCode).toBe("LOCAL_EXECUTION_GROUP_CLEANUP_FAILED");
    expect(kill).toHaveBeenCalledTimes(2);
  });
});
