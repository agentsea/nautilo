import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";

import {
  SYSTEM_OPENSSH_PATHS,
  runStructuredSshProcess,
  type StructuredSshChild,
} from "../../electron/structured-ssh/process-runner.ts";

function fakeChild() {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child: StructuredSshChild = {
    pid: 42,
    stdout,
    stderr,
    kill: () => true,
    once: events.once.bind(events) as StructuredSshChild["once"],
  };
  return {
    child,
    stdout,
    stderr,
    close: () => events.emit("close", 0, null),
  };
}

const input = {
  executable: SYSTEM_OPENSSH_PATHS.ssh,
  argv: ["-V"],
  env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
  timeoutMs: 1_000,
  maxStdoutBytes: 8,
  maxStderrBytes: 8,
} as const;

describe("structured SSH process runner observations", () => {
  test("drains raw stdout/stderr chunks without letting observer failures alter result or limits", async () => {
    const fake = fakeChild();
    const seen: string[] = [];
    const result = runStructuredSshProcess({
      ...input,
      onStdoutChunk: (chunk) => { seen.push(`out:${chunk.toString("utf8")}`); throw new Error("observer unavailable"); },
      onStderrChunk: (chunk) => { seen.push(`err:${chunk.toString("utf8")}`); },
    }, { spawn: () => fake.child, killProcessGroup: () => undefined });
    fake.stdout.write("123456789");
    fake.stderr.write("warn");
    fake.close();
    await expect(result).resolves.toMatchObject({
      processStarted: true,
      termination: "stdout_limit",
      stdout: "12345678",
      stderr: "warn",
    });
    expect(seen).toEqual(["out:123456789", "err:warn"]);
  });

  test("reports started only after successful child creation and isolates lifecycle observer failure", async () => {
    const fake = fakeChild();
    let starts = 0;
    const started = runStructuredSshProcess({
      ...input,
      onStarted: () => { starts += 1; throw new Error("observer unavailable"); },
    }, { spawn: () => fake.child });
    expect(starts).toBe(1);
    fake.close();
    await expect(started).resolves.toMatchObject({ processStarted: true, termination: "exited" });

    const failed = await runStructuredSshProcess({ ...input, onStarted: () => { starts += 1; } }, {
      spawn: () => { throw new Error("no child"); },
    });
    expect(failed).toMatchObject({ processStarted: false, termination: "spawn_failed" });
    expect(starts).toBe(1);
  });

  test("continues draining after the inline preview limit when continuation capture is enabled", async () => {
    const fake = fakeChild();
    const observed: Buffer[] = [];
    let kills = 0;
    fake.child.kill = () => { kills += 1; return true; };
    const result = runStructuredSshProcess({
      ...input,
      terminateOnOutputLimit: false,
      onStdoutChunk: (chunk) => observed.push(chunk),
    }, { spawn: () => fake.child, killProcessGroup: () => { kills += 1; } });
    fake.stdout.write("123456789-more-output");
    fake.close();
    await expect(result).resolves.toMatchObject({
      processStarted: true,
      termination: "exited",
      stdout: "12345678",
    });
    expect(Buffer.concat(observed).toString("utf8")).toBe("123456789-more-output");
    expect(kills).toBe(0);
  });
});
