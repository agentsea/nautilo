import { describe, expect, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ComposeDriverProfile } from "@nautilo/compose-driver";
import {
  buildComposeOperatorTransport,
  buildReleaseActiveWorkReadiness,
} from "../../src/lib/compose-driver-factory.ts";
import { buildLocalContainerFetch } from "../../src/lib/remote-operator-transport.ts";

type SpawnCall = {
  readonly cmd: string;
  readonly args: string[];
  stdin?: string;
  killedWith?: string;
};

type ProcessResult = {
  readonly stdout: string;
  readonly stderr?: string;
  readonly code: number;
  readonly hang?: boolean;
};

function fakeSpawn(results: readonly ProcessResult[]): {
  readonly calls: SpawnCall[];
  readonly spawnFn: (cmd: string, args: string[], options: SpawnOptions) => ChildProcess;
} {
  const calls: SpawnCall[] = [];
  const spawnFn = (cmd: string, args: string[], _options: SpawnOptions): ChildProcess => {
    const result = results[calls.length];
    if (!result) throw new Error(`unexpected spawn: ${cmd} ${args.join(" ")}`);
    const call: SpawnCall = { cmd, args };
    calls.push(call);
    const child = new EventEmitter() as ChildProcess;
    child.stdin = new PassThrough() as ChildProcess["stdin"];
    child.stdout = new PassThrough() as ChildProcess["stdout"];
    child.stderr = new PassThrough() as ChildProcess["stderr"];
    child.kill = ((signal?: NodeJS.Signals | number) => {
      call.killedWith = String(signal ?? "SIGTERM");
      return true;
    }) as ChildProcess["kill"];
    let stdin = "";
    (child.stdin as PassThrough).on("data", (chunk: Buffer) => {
      stdin += chunk.toString("utf8");
    });
    (child.stdin as PassThrough).on("end", () => {
      call.stdin = stdin;
      if (result.hang === true) return;
      (child.stdout as PassThrough).end(result.stdout);
      (child.stderr as PassThrough).end(result.stderr ?? "");
      queueMicrotask(() => child.emit("close", result.code));
    });
    return child;
  };
  return { calls, spawnFn };
}

const project = "nautilo-qa-local-1";
const containerId = "a1b2c3d4e5f6";
const statusUrl = "http://127.0.0.1:3001/api/operator/maintenance/status";

describe("buildLocalContainerFetch", () => {
  test("the local Compose transport drives readiness and maintenance through container loopback", async () => {
    const profile: ComposeDriverProfile = {
      name: "qa-local-1",
      transport: "local",
      lifecycle: "compose",
      instance_id: "qa-local-1",
    };
    const body = JSON.stringify({ softMs: 300_000, hardMs: 1_800_000 });
    const fake = fakeSpawn([
      { stdout: `${containerId}\n`, code: 0 },
      { stdout: '{"runningJobs":0,"queuedTurns":0,"bufferedLanes":0}\n200', code: 0 },
      { stdout: `${containerId}\n`, code: 0 },
      { stdout: '{"state":"draining"}\n200', code: 0 },
    ]);
    const transport = buildComposeOperatorTransport(profile, fake.spawnFn);

    expect(transport.resolveServerUrl?.(profile)).toBe("http://127.0.0.1:3001");
    expect(transport.readBootstrapTokenFn?.(profile.name, "/unused")).toBeNull();
    await buildReleaseActiveWorkReadiness(transport)(profile);

    const fetchFn = transport.fetchFn;
    if (!fetchFn) throw new Error("local Compose operator transport omitted fetchFn");
    const maintenance = await fetchFn(
      "http://127.0.0.1:3001/api/operator/maintenance/enter",
      {
        method: "POST",
        headers: {
          authorization: "Bearer retired-bootstrap-must-not-be-forwarded",
          "content-type": "application/json",
        },
        body,
      },
    );

    expect(maintenance.status).toBe(200);
    expect(await maintenance.json()).toEqual({ state: "draining" });
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls[0]?.args).toContain("label=com.docker.compose.project=nautilo-qa-local-1");
    expect(fake.calls[1]?.args.join(" ")).toContain(
      "http://127.0.0.1:3001/api/operator/release/readiness",
    );
    expect(fake.calls[3]?.args.join(" ")).toContain(
      "http://127.0.0.1:3001/api/operator/maintenance/enter",
    );
    expect(fake.calls[3]?.args.join(" ")).not.toContain("retired-bootstrap-must-not-be-forwarded");
    expect(fake.calls[3]?.args.join(" ").toLowerCase()).not.toContain("authorization");
    expect(fake.calls[3]?.stdin).toBe(body);
  });

  test("discovers the exact Compose server and executes the canonical Bun probe with JSON stdin", async () => {
    const body = JSON.stringify({ hardMs: 1_800_000 });
    const { calls, spawnFn } = fakeSpawn([
      { stdout: `${containerId}\n`, code: 0 },
      { stdout: '{"state":"draining"}\n200', code: 0 },
    ]);
    const fetchFn = buildLocalContainerFetch({ composeProjectName: project, spawnFn });

    const response = await fetchFn(
      "http://127.0.0.1:3001/api/operator/maintenance/enter",
      {
        method: "POST",
        headers: {
          authorization: "Bearer must-not-leave-the-operator",
          "content-type": "application/json",
        },
        body,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "draining" });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      cmd: "docker",
      args: [
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--filter",
        "label=com.docker.compose.service=nautilo-server",
      ],
      stdin: "",
    });
    expect(calls[1]?.cmd).toBe("docker");
    expect(calls[1]?.args.slice(0, 3)).toEqual(["exec", "-i", containerId]);
    expect(calls[1]?.args.join(" ")).toContain("bun -e");
    expect(calls[1]?.args.join(" ")).toContain("http://127.0.0.1:3001/api/operator/maintenance/enter");
    expect(calls[1]?.args.join(" ")).not.toContain("must-not-leave-the-operator");
    expect(calls[1]?.args.join(" ").toLowerCase()).not.toContain("authorization");
    expect(calls[1]?.stdin).toBe(body);
  });

  test("preserves an operator endpoint's non-success HTTP response", async () => {
    const { spawnFn } = fakeSpawn([
      { stdout: `${containerId}\n`, code: 0 },
      { stdout: '{"error":"Operator authorization required"}\n403', code: 0 },
    ]);
    const response = await buildLocalContainerFetch({ composeProjectName: project, spawnFn })(statusUrl);
    expect(response.status).toBe(403);
    expect(response.ok).toBe(false);
    expect(await response.json()).toEqual({ error: "Operator authorization required" });
  });

  test.each([
    ["missing", ""],
    ["ambiguous", `${containerId}\ndeadbeef\n`],
    ["invalid", "not-a-container-id\n"],
  ] as const)("rejects a %s server-container discovery result", async (_case, stdout) => {
    const { calls, spawnFn } = fakeSpawn([{ stdout, code: 0 }]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      buildLocalContainerFetch({ composeProjectName: project, spawnFn })(statusUrl),
    ).rejects.toThrow(/exactly one running nautilo-server container/);
    expect(calls).toHaveLength(1);
  });

  test("rejects a failed Docker discovery command", async () => {
    const { calls, spawnFn } = fakeSpawn([
      { stdout: "", stderr: "Cannot connect to the Docker daemon", code: 1 },
    ]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      buildLocalContainerFetch({ composeProjectName: project, spawnFn })(statusUrl),
    ).rejects.toThrow(/exactly one running nautilo-server container/);
    expect(calls).toHaveLength(1);
  });

  test.each([
    ["probe exit", { stdout: "", stderr: "container stopped", code: 1 }],
    ["missing status trailer", { stdout: '{"state":"normal"}', code: 0 }],
    ["invalid status", { stdout: '{"state":"normal"}\nnot-a-status', code: 0 }],
  ] as const)("rejects %s", async (_case, probeResult) => {
    const { spawnFn } = fakeSpawn([
      { stdout: `${containerId}\n`, code: 0 },
      probeResult,
    ]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      buildLocalContainerFetch({ composeProjectName: project, spawnFn })(statusUrl),
    ).rejects.toThrow(/probe failed|invalid HTTP status/);
  });

  test.each([
    "https://127.0.0.1:3001/api/operator/maintenance/status",
    "http://localhost:3001/api/operator/maintenance/status",
    "http://127.0.0.1:3001/api/rooms",
    "http://127.0.0.1:3001/api/operator/maintenance/status?detail=true",
    "http://127.0.0.1:3001/api/operator/maintenance/status#fragment",
    "http://user@127.0.0.1:3001/api/operator/maintenance/status",
  ])("rejects a non-canonical target before spawning Docker: %s", async (url) => {
    const { calls, spawnFn } = fakeSpawn([]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      buildLocalContainerFetch({ composeProjectName: project, spawnFn })(url),
    ).rejects.toThrow(/container-loopback operator URL/);
    expect(calls).toEqual([]);
  });

  test("honors the caller deadline and kills a hanging container discovery", async () => {
    const { calls, spawnFn } = fakeSpawn([
      { stdout: "", code: 0, hang: true },
    ]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      buildLocalContainerFetch({ composeProjectName: project, spawnFn })(statusUrl, { signal: AbortSignal.timeout(10) }),
    ).rejects.toThrow(/aborted or timed out/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.killedWith).toBe("SIGKILL");
  });

  test("an active probe consumes the caller abort and kills its Docker child", async () => {
    const controller = new AbortController();
    const fake = fakeSpawn([
      { stdout: `${containerId}\n`, code: 0 },
      { stdout: "", code: 0, hang: true },
    ]);
    const spawnFn = ((cmd: string, args: string[], options: SpawnOptions) => {
      const child = fake.spawnFn(cmd, args, options);
      if (args[0] === "exec") queueMicrotask(() => controller.abort());
      return child;
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      buildLocalContainerFetch({ composeProjectName: project, spawnFn })(statusUrl, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted or timed out/);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.killedWith).toBe("SIGKILL");
  });

  test("preserves complete operator replies without a transport-specific output cutoff", async () => {
    const body = JSON.stringify({ detail: "x".repeat(1024 * 1024 + 1) });
    const fake = fakeSpawn([
      { stdout: `${containerId}\n`, code: 0 },
      { stdout: `${body}\n200`, code: 0 },
    ]);
    const response = await buildLocalContainerFetch({ composeProjectName: project, spawnFn: fake.spawnFn })(statusUrl);
    expect(await response.text()).toBe(body);
    expect(fake.calls[1]?.killedWith).toBeUndefined();
  });

  test("a pre-aborted request rejects before spawning Docker", async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, spawnFn } = fakeSpawn([]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      buildLocalContainerFetch({ composeProjectName: project, spawnFn })(statusUrl, {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
