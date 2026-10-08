/**
 * Opt-in native acceptance: Node is required by the installed node-pty addon.
 * From the repository root, bundle this file with Bun --target=node --format=cjs
 * --external node-pty into a disposable directory, then run the bundle with Node
 * and NODE_PATH pointing to this checkout's node_modules. No live account or
 * application state is used. All commands, listeners and files belong to fixtures.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Sandbox } from "@nautilo/sandbox";
import { RELAY_WORKSTATION_SHELL_BINDING_VERSION, type RelayDispatchRequest } from "@nautilo/relay";
import { LocalExecutionHost } from "../../electron/local-execution-host";
import { LocalExecutionDispatch, type LocalExecutionView } from "../../electron/relay-dispatch/local-execution";
import type { PreparedLocalExecution } from "../../electron/local-execution-process";

const TEST_DEADLINE_MS = 10_000;
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "local-execution-native-")));
  let releases = 0;
  const host = new LocalExecutionHost({ retention: { maxOutputBytes: 65_536, maxTotalOutputBytes: 262_144,
    maxExecutions: 16, maxActiveExecutions: 8, completedTtlMs: 60_000, maxInputRequestsPerExecution: 16 } });
  const dispatch = new LocalExecutionDispatch(host);
  function request(id: string, cmd: string, tty = false): RelayDispatchRequest {
    return { correlationId: id, toolName: "exec_command", args: { cmd, tty, yield_time_ms: 0 }, impact: "destructive", approvalObtained: true,
      runShellOwnerBinding: { instanceId: "fixture", userId: "human", relayId: "relay", desktopSessionId: "desktop" },
      workstationShellBinding: { version: RELAY_WORKSTATION_SHELL_BINDING_VERSION, toolCallId: id,
        relayId: "relay", desktopSessionId: "desktop", serverBindingId: "server", pairingGeneration: "pairing",
        profileId: "profile", profileRevision: 1, grantIds: ["grant"], capabilityRevision: 1, currentFolder: root,
        grantRevision: 1, protectedPolicyVersion: 1, subject: { userId: "human", instanceId: "fixture", relayId: "relay", agentScope: "all_owned_agents" },
        operation: "execute", executionClass: "profile_bound_sandbox" },
      localExecutionBinding: { version: 1, generation: host.hostGeneration, invocationId: id, executionId: id, operation: "start",
        owner: { instanceId: "fixture", humanUserId: "human", agentId: "agent", runId: "run", conversationId: "conversation",
          relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "pairing", serverBindingId: "server",
          profileId: "profile", profileRevision: 1, grantIds: ["grant"], grantRevision: 1, protectedPolicyVersion: 1 } },
    };
  }
  const invoke = async (req: RelayDispatchRequest, prepare?: () => Promise<PreparedLocalExecution>) => {
    const result = await dispatch.dispatch({ request: req, revalidate: () => Promise.resolve(), prepare: prepare ?? (() => Promise.resolve({
      program: "/bin/sh", args: ["-c", req.args["cmd"] as string], cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root },
      dispose() { releases += 1; },
    })) });
    assert.equal(result.status, "ok", JSON.stringify(result));
    if (result.status !== "ok") throw new Error("unreachable");
    return result.result as LocalExecutionView;
  };
  const follow = (original: RelayDispatchRequest, args: Record<string, unknown> = {}, inputId = "read") => invoke({ ...original,
    toolName: "write_stdin", args: { session_id: original.localExecutionBinding!.executionId, yield_time_ms: 0, ...args },
    localExecutionBinding: { ...original.localExecutionBinding!, invocationId: inputId,
      operation: args["cancel"] === true ? "cancel" : args["chars"] ? "input" : "read" },
  });
  async function until(original: RelayDispatchRequest, predicate: (view: LocalExecutionView) => boolean) {
    const deadline = Date.now() + TEST_DEADLINE_MS;
    let view = await follow(original);
    while (!predicate(view)) {
      assert(Date.now() < deadline, `fixture did not reach expected state: ${JSON.stringify(view)}`);
      await delay(10);
      view = await follow(original);
    }
    return view;
  }
  return { root, host, request, invoke, follow, until, releases: () => releases,
    async close() { await host.finishDisposal(); rmSync(root, { recursive: true, force: true }); },
  };
}

function childAlive(child: ChildProcess): boolean { return child.exitCode === null && child.signalCode === null; }
function killFixtureGroup(pid: number) {
  try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function waitForFixtureProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + TEST_DEADLINE_MS;
  for (;;) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    // The OS can retain a just-killed orphan until init reaps it. This is a
    // fixture observation deadline, not a production cleanup timeout or retry.
    assert(Date.now() < deadline, "owned fixture child did not disappear");
    await delay(10);
  }
}
async function stopFixtureChild(child: ChildProcess) {
  if (!childAlive(child)) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}
async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

for (const tty of [false, true]) {
  void test(`${tty ? "PTY" : "pipe"}: quiet multiline command, lost start response and final diagnostics`, async () => {
    const f = fixture();
    try {
      const req = f.request("build", "printf 'once\\n' >> mutations\nwhile [ ! -f proceed ]; do sleep 0.02; done\nprintf 'compiler diagnostic\\n' >&2\nexit 7", tty);
      await f.invoke(req); // Deliberately discard the first response.
      await f.until(req, (view) => view.state === "running");
      const yielded = await f.follow(req, { yield_time_ms: 25 });
      assert.equal(yielded.state, "running"); assert.equal(yielded.output.data, "");
      const replay = await f.invoke(req);
      assert.equal(replay.executionId, yielded.executionId);
      writeFileSync(join(f.root, "proceed"), "");
      const done = await f.until(req, (view) => view.resources === "released");
      assert.equal(done.state, "completed"); assert.equal(done.exitCode, 7);
      assert.match(done.output.data, /compiler diagnostic/);
      assert.equal(readFileSync(join(f.root, "mutations"), "utf8"), "once\n");
      const reads = await Promise.all([f.follow(req), f.follow(req)]);
      assert.deepEqual(reads[0], reads[1]); assert.deepEqual(reads[0], done);
      assert.equal(f.releases(), 1);
    } finally { await f.close(); }
  });

  void test(`${tty ? "PTY" : "pipe"}: yielded sandbox proxy remains usable until actual exit`, async () => {
    const f = fixture();
    const server = createServer((_request, response) => response.end("proxy-alive\n"));
    let sandbox: Sandbox | undefined;
    let closes = 0;
    try {
      const port = await listen(server);
      sandbox = await Sandbox.create({ workspace: f.root, dataDir: join(f.root, "secrets"), toolsBin: "/usr/bin", failIfNoBackend: true,
        config: { mode: "enabled", writablePaths: [], projectPaths: [], passthroughEnv: [], networkPolicy: { mode: "proxy-allowlist",
          allow: [{ type: "cidr", cidr: "127.0.0.1/32", ports: [port] }] } } });
      assert(sandbox.containmentActive());
      const curl = `/usr/bin/curl --silent --show-error --fail --noproxy '' --proxy "$HTTP_PROXY" http://127.0.0.1:${port}`;
      const req = f.request("proxy", `${curl}\nprintf 'ready\\n'\nwhile [ ! -f proceed ]; do sleep 0.02; done\n${curl}\nexit 7`, tty);
      const resource = sandbox;
      await f.invoke(req, () => {
        const wrapped = resource.wrap("/bin/sh", ["-c", req.args["cmd"] as string], f.root, {});
        assert(wrapped.env);
        return Promise.resolve({ ...wrapped, env: wrapped.env, dispose: async () => { closes += 1; await resource.close(); } });
      });
      const yielded = await f.until(req, (view) => view.output.data.includes("ready"));
      assert.equal(yielded.state, "running"); assert.match(yielded.output.data, /proxy-alive/); assert.equal(closes, 0);
      writeFileSync(join(f.root, "proceed"), "");
      const done = await f.until(req, (view) => view.resources === "released");
      assert.equal(done.exitCode, 7); assert.equal(done.output.data.match(/proxy-alive/g)?.length, 2); assert.equal(closes, 1);
    } finally { await f.close(); if (closes === 0) await sandbox?.close(); await closeServer(server); }
  });
}

void test("large output has repeatable independent cursor pages and explicit tail loss", async () => {
  const f = fixture();
  try {
    const script = join(f.root, "output.cjs");
    writeFileSync(script, "process.stdout.write('x'.repeat(70000)+'FINAL\\n')");
    const req = f.request("output", `${quote(process.execPath)} ${quote(script)}`);
    await f.invoke(req);
    const done = await f.until(req, (view) => view.resources === "released");
    assert.equal(done.exitCode, 0); assert.equal(done.output.gap, true);
    assert.equal(done.output.availableFrom, 70006 - 65536);
    const pages = await Promise.all([f.follow(req, { cursor: 0, max_output_bytes: 37 }), f.follow(req, { cursor: 0, max_output_bytes: 37 })]);
    assert.deepEqual(pages[0], pages[1]); assert.equal(pages[0].output.data.length, 37);
    let cursor = pages[0].output.nextCursor;
    let output = pages[0].output.data;
    while (cursor < done.output.produced) {
      const page = await f.follow(req, { cursor, max_output_bytes: 4096 });
      output += page.output.data; cursor = page.output.nextCursor;
    }
    assert.equal(output.length, 65536); assert(output.endsWith("FINAL\n"));
    assert.deepEqual(await f.follow(req, { cursor: 0, max_output_bytes: 37 }), pages[0]);
  } finally { await f.close(); }
});

void test("PTY input response loss does not replay a mutating line", async () => {
  const f = fixture();
  try {
    const req = f.request("input", "printf 'ready\\n'; while IFS= read -r line; do printf '%s\\n' \"$line\" >> mutations; printf 'accepted\\n'; done", true);
    await f.invoke(req);
    await f.until(req, (view) => view.output.data.includes("ready"));
    await f.follow(req, { chars: "once\n" }, "write-once");
    await f.follow(req, { chars: "once\n" }, "write-once");
    await f.until(req, (view) => view.output.data.includes("accepted"));
    assert.equal(readFileSync(join(f.root, "mutations"), "utf8"), "once\n");
    await f.follow(req, { cancel: true }, "stop");
    const stopped = await f.until(req, (view) => view.resources === "released");
    assert.equal(stopped.state, "cancelled"); assert.equal(stopped.terminationScope, "owned_process_group");
  } finally { await f.close(); }
});

void test("owned server Stop, collision and port reuse never kill an unrelated listener", async () => {
  const f = fixture();
  const unrelated = createServer((_request, response) => response.end("unrelated"));
  let replacement: Server | undefined;
  try {
    const otherPort = await listen(unrelated);
    const script = join(f.root, "server.cjs");
    writeFileSync(script, "const http=require('node:http');const s=http.createServer((q,r)=>r.end('owned'));s.on('error',e=>{console.error(e.code);process.exit(8)});s.listen(Number(process.argv[2]),'127.0.0.1',()=>console.log('http://127.0.0.1:'+s.address().port));");
    const collision = f.request("collision", `${quote(process.execPath)} ${quote(script)} ${otherPort}`);
    await f.invoke(collision);
    const failed = await f.until(collision, (view) => view.resources === "released");
    assert.equal(failed.exitCode, 8); assert.match(failed.output.data, /EADDRINUSE/);
    assert.equal(await (await fetch(`http://127.0.0.1:${otherPort}`)).text(), "unrelated");
    const req = f.request("server", `${quote(process.execPath)} ${quote(script)} 0`);
    await f.invoke(req);
    const running = await f.until(req, (view) => /http:\/\/127\.0\.0\.1:\d+/.test(view.output.data));
    const url = running.output.data.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    assert.equal(await (await fetch(url)).text(), "owned");
    await f.follow(req, { cancel: true }, "stop");
    const stopped = await f.until(req, (view) => view.resources === "released");
    assert.equal(stopped.state, "cancelled");
    replacement = createServer((_request, response) => response.end("replacement"));
    await new Promise<void>((resolve) => replacement!.listen(Number(new URL(url).port), "127.0.0.1", resolve));
    await f.follow(req, { cancel: true }, "stop-again");
    assert.equal(await (await fetch(url)).text(), "replacement");
    assert.equal(await (await fetch(`http://127.0.0.1:${otherPort}`)).text(), "unrelated");
  } finally { await f.close(); await closeServer(unrelated); if (replacement) await closeServer(replacement); }
});

void test("background exit reports cleanup certainty; explicit Stop spares unrelated work", async () => {
  const f = fixture();
  const unrelated = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    for (const tty of [false, true]) {
      const marker = tty ? "pty-child" : "pipe-child";
      const req = f.request(marker, `sleep 30 &\nprintf '%s' "$!" > ${marker}\nprintf 'parent-finished\\n'\nexit 0`, tty);
      await f.invoke(req);
      const done = await f.until(req, (view) => view.resources === "released");
      assert.equal(done.exitCode, 0, JSON.stringify({ tty, receipt: done }));
      if (done.state === "completed") assert.equal(done.failureCode, null);
      else {
        // macOS can return EPERM while a PTY group disappears after shell exit.
        // Preserve the production uncertainty instead of claiming Stop succeeded.
        assert.equal(done.state, "unknown", JSON.stringify({ tty, receipt: done }));
        assert.equal(done.failureCode, "LOCAL_EXECUTION_GROUP_CLEANUP_FAILED");
      }
      assert.equal(done.terminationScope, "owned_process_group");
      const pid = Number(readFileSync(join(f.root, marker), "utf8"));
      await waitForFixtureProcessExit(pid);
      assert(childAlive(unrelated));
      const active = f.request(`${marker}-stop`, `sleep 30 &\nprintf '%s' "$!" > ${marker}-stop\nprintf 'ready\\n'\nwait`, tty);
      await f.invoke(active);
      await f.until(active, (view) => view.output.data.includes("ready"));
      const activeChildPid = Number(readFileSync(join(f.root, `${marker}-stop`), "utf8"));
      process.kill(activeChildPid, 0);
      await f.follow(active, { cancel: true }, "stop");
      const stopped = await f.until(active, (view) => view.resources === "released");
      assert.equal(stopped.state, "cancelled", JSON.stringify({ tty, receipt: stopped }));
      await waitForFixtureProcessExit(activeChildPid);
      assert(childAlive(unrelated));
    }
  } finally { await f.close(); await stopFixtureChild(unrelated); }
});

void test("detached framework handoff is outside the receipt's explicit process-group scope", async () => {
  const f = fixture();
  let detachedPid: number | undefined;
  try {
    const script = join(f.root, "detach.cjs");
    writeFileSync(script, "const c=require('node:child_process').spawn('/bin/sleep',['30'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync('detached-pid',String(c.pid));c.unref();");
    const req = f.request("handoff", `${quote(process.execPath)} ${quote(script)}`);
    await f.invoke(req);
    const done = await f.until(req, (view) => view.resources === "released");
    detachedPid = Number(readFileSync(join(f.root, "detached-pid"), "utf8"));
    process.kill(detachedPid, 0);
    assert.equal(done.state, "completed"); assert.equal(done.terminationScope, "owned_process_group");
    await f.follow(req, { cancel: true }, "stop-finished");
    process.kill(detachedPid, 0); // Never claim this unrelated group was stopped.
  } finally {
    if (detachedPid !== undefined) killFixtureGroup(detachedPid);
    await f.close();
  }
});
