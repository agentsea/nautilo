import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { BolterNativeProcessOwner } from "../../electron/bolter-bridge/native-process";
import { createBolterIdentityInvocation, createBolterReceiveInvocation, createBolterSendInvocation, type BolterCliInvocation } from "../../electron/bolter-bridge/cli-contract";

const runtime = { executable: "/opt/nautilo/bolter-agent", home: "/var/lib/nautilo/synthetic-home", platform: "linux" as const, version: "synthetic-v1" };
// Bounds exercise synthetic fixtures only, not a qualified provider ceiling.
const qualification = { version: runtime.version, maxOutputBytes: 1000, maxBatchBytes: 1000 };
const selection = { origin: "https://bolter.chat", agentId: "synthetic-agent" };
function fake() {
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as string | null, kills: 0,
    kill() { this.kills++; return true; } });
  return { process: process as unknown as ChildProcessWithoutNullStreams, value: process,
    finish(code = 0) { process.exitCode = code; process.emit("close", code); } };
}
function plan(): BolterCliInvocation {
  const result = createBolterIdentityInvocation(runtime, selection);
  if (!result.ok) throw new Error("Synthetic fixture invalid");
  return result.value;
}

test("native runner requires qualified bounds and exact fixed plans before spawning", async () => {
  let calls = 0;
  const options = { runtime, attest: () => Promise.resolve(true), isCurrent: () => true,
    spawn: () => { calls++; return fake().process; } };
  await Promise.resolve(expect(new BolterNativeProcessOwner(options).execute(plan())).rejects.toThrow("unavailable"));
  const native = new BolterNativeProcessOwner({ ...options, qualification });
  for (const invalid of [{ ...plan(), args: ["unpair"] }, { ...plan(), env: { ...plan().env, TOKEN: "synthetic-secret" } },
    { ...plan(), shell: true }, { ...plan(), stdin: "unexpected" }]) {
    await Promise.resolve(expect(native.execute(invalid as BolterCliInvocation)).rejects.toThrow("unavailable"));
  }
  expect(calls).toBe(0);
});

test("native runner checks current destination after attestation and snapshots caller plans", async () => {
  let current = true;
  let calls = 0;
  const native = new BolterNativeProcessOwner({ runtime, qualification, isCurrent: () => true,
    attest: () => { current = false; return Promise.resolve(true); }, spawn: () => { calls++; return fake().process; } });
  await Promise.resolve(expect(native.execute(plan(), () => current)).rejects.toThrow("unavailable"));
  expect(calls).toBe(0);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const child = fake();
  let observed: BolterCliInvocation | undefined;
  const mutable = { ...plan(), args: [...plan().args], env: { ...plan().env } };
  const snapshot = new BolterNativeProcessOwner({ runtime, qualification, isCurrent: () => true,
    attest: async () => { await gate; return true; }, spawn: p => { observed = p; return child.process; } });
  const starting = snapshot.start(mutable);
  mutable.args[0] = "unpair";
  mutable.env["HOME"] = "/different";
  release();
  const running = await starting;
  expect(observed?.args[0]).toBe("me");
  expect(observed?.env["HOME"]).toBe(runtime.home);
  child.finish();
  await running.result;
});

test("cancellation waits actual close and never returns captured provider diagnostics", async () => {
  const child = fake();
  const native = new BolterNativeProcessOwner({ runtime, qualification, attest: () => Promise.resolve(true),
    isCurrent: () => true, spawn: () => child.process });
  const running = await native.start(plan());
  child.value.stderr.write("synthetic private diagnostic");
  child.value.stdout.write("synthetic identity");
  let retired = false;
  const retirement = native.retire().then(() => { retired = true; });
  await Promise.resolve();
  expect(retired).toBe(false);
  expect(child.value.kills).toBe(1);
  child.finish();
  await retirement;
  expect(await running.result).toEqual({ exitCode: null, stdout: "", stderr: "" });
  await Promise.resolve(expect(native.execute(plan())).rejects.toThrow("unavailable"));
});

test("output overflow fails closed after child exit and never retries a send", async () => {
  const child = fake();
  let calls = 0;
  const native = new BolterNativeProcessOwner({ runtime, qualification, attest: () => Promise.resolve(true),
    isCurrent: () => true, spawn: () => { calls++; return child.process; } });
  const send = createBolterSendInvocation(runtime, selection, { chatId: "synthetic-chat", threadRootId: null }, "Synthetic reply");
  if (!send.ok) throw new Error("Synthetic fixture invalid");
  const running = await native.start(send.value);
  child.value.stdout.write("x".repeat(qualification.maxOutputBytes + 1));
  expect(child.value.kills).toBe(1);
  child.finish();
  expect(await running.result).toEqual({ exitCode: null, stdout: "", stderr: "" });
  expect(calls).toBe(1);
});

test("helper attestation uses the same pinned executable and descriptor that will be launched", async () => {
  const receive = { helper: "/opt/nautilo/synthetic-helper", descriptor: "synthetic-descriptor" };
  const plan = createBolterReceiveInvocation(runtime, selection, receive.helper);
  if (!plan.ok) throw new Error("Synthetic fixture invalid");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let helper: string | undefined;
  let invocation: BolterCliInvocation | undefined;
  const child = fake();
  const native = new BolterNativeProcessOwner({ runtime, qualification, isCurrent: () => true,
    attest: async () => { await gate; return true; }, attestHelper: path => { helper = path; return Promise.resolve(true); },
    spawn: plan => { invocation = plan; return child.process; } });
  const starting = native.start(plan.value, receive);
  receive.helper = "/other/helper";
  receive.descriptor = "other-descriptor";
  release();
  const running = await starting;
  expect(helper).toBe("/opt/nautilo/synthetic-helper");
  expect(invocation?.args).toContain("'/opt/nautilo/synthetic-helper'");
  expect(invocation?.env["NAUTILO_BOLTER_HANDOVER"]).toBe("synthetic-descriptor");
  child.finish();
  await running.result;
});
