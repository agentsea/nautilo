import { createHash } from "node:crypto";
import { rejects } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createProtectedRepoDocsCheckpoint,
  createProtectedRepoDocsRequest,
  ProtectedRepoDocsOutcomeUnknownError,
  type DelegatedLocalExecutionAdmission,
  type DelegatedLocalExecutionPort,
  type NautiloState,
  type ProtectedRepoDocsExecutionRequest,
  type ToolRelayRegistry,
} from "@nautilo/agent";
import type { RelayDispatchResult } from "@nautilo/relay";
import type { LocalExecutionDelegation } from "@nautilo/types";
import { createProtectedTaskRepoDocsLocalExecutionPort } from "../../src/routes/protected-task-repo-docs-local-execution";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  agent: "30000000-0000-4000-8000-000000000003",
  human: "40000000-0000-4000-8000-000000000004",
  room: "50000000-0000-4000-8000-000000000005",
};
const generation = "generation-fixture";

function digest(request: ProtectedRepoDocsExecutionRequest): string {
  return createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function prepareReceipt(request: ProtectedRepoDocsExecutionRequest): string {
  return ["NAUTILO_REPO_DOCS_V1", digest(request), "prepare",
    b64(`/projects/root/${request.relativeWorkspacePath}`), b64(request.relativeWorkspacePath), b64(request.branch),
    b64("a".repeat(40)), b64("init"), b64(""), b64(""), b64("a".repeat(40)), b64(""), b64("max20"),
    b64("a000000 Initial source\tREADME.md")].join("\t");
}

function snapshot(binding: NonNullable<Parameters<ToolRelayRegistry["dispatch"]>[1]["localExecutionBinding"]>, output: string,
  overrides: Readonly<Record<string, unknown>> = {}): RelayDispatchResult {
  const bytes = Buffer.byteLength(output, "utf8");
  return { status: "ok", result: {
    executionId: binding.executionId, generation: binding.generation, session_id: binding.executionId,
    state: "completed", exitCode: 0,
    output: { data: output, cursor: 0, nextCursor: bytes, availableFrom: 0, produced: bytes, gap: false, hasMore: false },
    ...overrides,
  } };
}

function fixture(
  target = "https://example.test/repository.git",
  modelId = "model-fixture",
) {
  const selection = Object.freeze({ target, mode: "auto" as const, publish: "pr" as const,
    instructions: "Prioritize operator workflows." });
  const checkpoint = createProtectedRepoDocsCheckpoint({ taskRunId: ids.run, selection,
    modelId });
  const request = createProtectedRepoDocsRequest(checkpoint, "prepare");
  const sourceAbort = new AbortController();
  const jobAbort = new AbortController();
  const delegation: LocalExecutionDelegation = { version: 1, humanUserId: ids.human, agentId: ids.agent,
    sourceRoomId: ids.room, sourceConversationId: "source-thread", rootTaskId: ids.task,
    projectGrantId: "project-grant", ceiling: "basic", profile: null,
    target: { instanceId: "instance-fixture", relayId: "relay-fixture", pairingGeneration: "pairing-fixture",
      serverOrigin: "https://server.example", serverFingerprint: "server-fingerprint" } };
  const source: DelegatedLocalExecutionAdmission = { taskId: ids.task, taskRunId: ids.run,
    signal: sourceAbort.signal, delegation };
  const admissions: string[] = [];
  const delegated: DelegatedLocalExecutionPort = { taskId: ids.task, taskRunId: ids.run, signal: sourceAbort.signal,
    retain: () => () => undefined,
    withAdmission: async (operation, work) => { admissions.push(operation); return await work(source); } };
  const state = { currentTaskId: ids.task, currentTaskRunId: ids.run, agentId: ids.agent, roomId: ids.room,
    currentThreadId: "thread-fixture", langgraphThreadId: "thread-fixture", causalHumanUserId: ids.human,
    trustedExecutionEntrypoint: "background.task" } as Pick<NautiloState,
      "currentTaskId" | "currentTaskRunId" | "agentId" | "roomId" | "currentThreadId" |
      "langgraphThreadId" | "causalHumanUserId" | "trustedExecutionEntrypoint">;
  let currentGeneration = generation;
  let current = true;
  let dispatchResult: ((request: Parameters<ToolRelayRegistry["dispatch"]>[1]) => RelayDispatchResult) | undefined;
  const dispatched: Parameters<ToolRelayRegistry["dispatch"]>[1][] = [];
  const registry = {
    findByCapabilityForUser: () => ["relay-fixture"],
    getCapabilities: () => ({ profile: "desktop-agent", canExecuteLocal: true, canDelegateLocalExecution: true,
      localExecution: { version: 1, generation: currentGeneration, pipe: true, pty: true, localNetworkPolicy: true, capacity: 1 } }),
    getProtocolVersion: () => 99,
    getUserId: () => ids.human,
    getDesktopSessionId: () => "desktop-fixture",
    getPairingGeneration: () => "pairing-fixture",
    getLocalExecutionPairingGeneration: () => "opaque-pairing-fixture",
    getLocalExecutionBinding: () => null,
    dispatch: async (_relayId: string, sent: Parameters<ToolRelayRegistry["dispatch"]>[1]) => {
      dispatched.push(sent);
      return dispatchResult?.(sent) ?? { status: "error", error: "fixture unavailable" };
    },
  } as ToolRelayRegistry;
  const port = createProtectedTaskRepoDocsLocalExecutionPort({ delegated, registry, state, selection,
    modelId,
    signal: jobAbort.signal, assertCurrent: () => current ? Promise.resolve() : Promise.reject(new Error("revoked")) });
  return { admissions, checkpoint, delegated, dispatched, jobAbort, port, request, selection, sourceAbort,
    setDispatch(value: typeof dispatchResult) { dispatchResult = value; },
    setCurrent(value: boolean) { current = value; },
    setGeneration(value: string) { currentGeneration = value; } };
}

function runGit(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// Windows Desktops offer no local execution, so these POSIX shell flows only
// ever run on macOS and Linux hosts.
describe.skipIf(process.platform === "win32")("protected Task RepoDocs delegated local execution", () => {
  test("pins one immutable V4 project generation and returns a genuine contained prepare result", async () => {
    const f = fixture();
    const plan = await f.port.plan(f.request);
    expect(plan?.relayBinding).toMatchObject({ version: 4, operation: "start", generation,
      authority: { kind: "delegated", taskId: ids.task, taskRunId: ids.run, roomId: ids.room } });
    expect(Object.isFrozen(plan?.relayBinding)).toBe(true);
    expect(Object.isFrozen(plan?.relayBinding.owner)).toBe(true);
    f.setDispatch(sent => snapshot(sent.localExecutionBinding!, prepareReceipt(f.request)));
    const result = await f.port.execute({ request: f.request, plan: plan!, signal: new AbortController().signal });
    expect(result).toMatchObject({ kind: "prepared", relativeWorkspacePath: f.request.relativeWorkspacePath,
      workDir: `/projects/root/${f.request.relativeWorkspacePath}`, branch: f.request.branch,
      sourceHead: "a".repeat(40), resolvedMode: "init" });
    expect(result.kind === "prepared" ? result.brief : "").toContain("Prioritize operator workflows.");
    expect(f.dispatched).toHaveLength(1);
    expect(f.dispatched[0]).toMatchObject({ toolName: "exec_command", impact: "high", approvalObtained: true,
      args: { workdir: ".", tty: false } });
    expect(String(f.dispatched[0]?.args["cmd"])).toContain(`nautilo-repo-docs/task-run-${ids.run}`);
    expect(String(f.dispatched[0]?.args["cmd"])).not.toContain(f.selection.instructions);
  });

  test("quotes target data and never promotes it into a second shell command", async () => {
    const target = "https://example.test/repo'$(touch${IFS}/tmp/escaped).git";
    const f = fixture(target);
    const plan = await f.port.plan(f.request);
    f.setDispatch(sent => snapshot(sent.localExecutionBinding!, prepareReceipt(f.request)));
    await f.port.execute({ request: f.request, plan: plan!, signal: new AbortController().signal });
    const command = String(f.dispatched[0]?.args["cmd"]);
    expect(spawnSync("/bin/sh", ["-n"], { input: command }).status).toBe(0);
    expect(command).toContain("'https://example.test/repo'\"'\"'$(touch${IFS}/tmp/escaped).git'");
    expect(command).not.toContain("eval ");
    expect(command).toContain("GIT_TERMINAL_PROMPT=0");
    expect(command).toContain("core.hooksPath=/dev/null");
    expect(command).not.toContain("config core.hooksPath");
    expect(command).not.toContain("config commit.gpgSign");
  });

  test("rejects foreign requests, changed relay generations, and revoked authority before dispatch", async () => {
    const f = fixture();
    const plan = await f.port.plan(f.request);
    const foreign = { ...f.request, taskRunId: "90000000-0000-4000-8000-000000000009" };
    await rejects(f.port.execute({ request: foreign, plan: plan!, signal: new AbortController().signal }), /request is invalid/u);
    const changedModel = { ...f.request, modelId: "replacement-model" };
    await rejects(f.port.execute({ request: changedModel, plan: plan!, signal: new AbortController().signal }), /request is invalid/u);
    f.setGeneration("replacement-generation");
    await rejects(f.port.execute({ request: f.request, plan: plan!, signal: new AbortController().signal }), /binding changed/u);
    f.setGeneration(generation);
    f.setCurrent(false);
    await rejects(f.port.execute({ request: f.request, plan: plan!, signal: new AbortController().signal }), /revoked/u);
    expect(f.dispatched).toHaveLength(0);
  });

  test("inspects only the original managed execution and never starts or rebinds work", async () => {
    const f = fixture();
    const plan = await f.port.plan(f.request);
    f.setDispatch(sent => snapshot(sent.localExecutionBinding!, prepareReceipt(f.request)));
    const result = await f.port.inspect({ request: f.request, plan: plan!, signal: new AbortController().signal });
    expect(result.status).toBe("confirmed");
    expect(f.dispatched).toHaveLength(1);
    expect(f.dispatched[0]).toMatchObject({ toolName: "write_stdin", impact: "read-only",
      args: { session_id: plan?.relayBinding.executionId, cursor: 0 } });
    expect(f.dispatched[0]?.args).not.toHaveProperty("cmd");
    expect(f.dispatched[0]?.localExecutionBinding).toMatchObject({ generation, executionId: plan?.relayBinding.executionId,
      operation: "read" });
  });

  test("treats retained-output gaps and aborted work as unknown without replay", async () => {
    const f = fixture();
    const plan = await f.port.plan(f.request);
    f.setDispatch(sent => snapshot(sent.localExecutionBinding!, prepareReceipt(f.request), {
      output: { data: "partial", cursor: 10, nextCursor: 17, availableFrom: 10, produced: 17, gap: true, hasMore: false },
    }));
    expect(await f.port.inspect({ request: f.request, plan: plan!, signal: new AbortController().signal }))
      .toEqual({ status: "ambiguous" });
    await rejects(f.port.execute({ request: f.request, plan: plan!, signal: new AbortController().signal }),
      ProtectedRepoDocsOutcomeUnknownError);
    const aborted = new AbortController(); aborted.abort(new Error("stopped"));
    await rejects(f.port.execute({ request: f.request, plan: plan!, signal: aborted.signal }), /stopped/u);
    expect(f.dispatched.every(sent => sent.toolName !== "exec_command" || sent.localExecutionBinding?.executionId === plan?.relayBinding.executionId)).toBe(true);
  });

  test("commit commands stage only the wiki and enforce the immutable source HEAD", async () => {
    const f = fixture();
    const preparePlan = await f.port.plan(f.request);
    f.setDispatch(sent => snapshot(sent.localExecutionBinding!, prepareReceipt(f.request)));
    const prepared = await f.port.execute({ request: f.request, plan: preparePlan!, signal: new AbortController().signal });
    if (prepared.kind !== "prepared") throw new Error("missing prepare fixture");
    const checkpoint = { ...f.checkpoint, receipts: [{ version: 1 as const, status: "confirmed" as const,
      request: f.request, plan: preparePlan!, result: prepared }] };
    const request = createProtectedRepoDocsRequest(checkpoint, "commit");
    const plan = await f.port.plan(request);
    const receipt = ["NAUTILO_REPO_DOCS_V1", digest(request), "commit", "committed", prepared.sourceHead,
      "b".repeat(40), "3"].join("\t");
    f.dispatched.length = 0;
    f.setDispatch(sent => snapshot(sent.localExecutionBinding!, receipt));
    expect(await f.port.execute({ request, plan: plan!, signal: new AbortController().signal })).toEqual({
      kind: "committed", sourceHead: prepared.sourceHead, commitOid: "b".repeat(40), changedFileCount: 3,
    });
    const command = String(f.dispatched[0]?.args["cmd"]);
    expect(spawnSync("/bin/sh", ["-n"], { input: command }).status).toBe(0);
    expect(command).toContain("git add -- 'openwiki'");
    expect(command).toContain(`[ "$(git rev-parse HEAD 2>/dev/null)" = '${prepared.sourceHead}' ]`);
    expect(command).toContain("date -u '+%Y-%m-%dT%H:%M:%SZ'");
    expect(command).toContain(`"command": "${prepared.resolvedMode}"`);
    expect(command).toContain(`"gitHead": "${prepared.sourceHead}"`);
    expect(command).toContain('"workhorseModel": "model-fixture"');
    expect(command).toContain('"finalizeModel": "model-fixture"');
    expect(command).toContain("-c user.name=Nautilo -c user.email=repo-docs@localhost commit -m");
    expect(command).not.toContain("--no-verify");
    expect(command).not.toContain("--no-gpg-sign");
    expect(command).not.toContain("core.hooksPath=/dev/null -c user.name");
    expect(command).not.toContain(f.selection.instructions);
  });

  test.each(["unchanged", "changed origin before commit", "installed hook", "symlinked wiki", "symlinked metadata", "changed origin before publish"] as const)(
    "executes only the pinned local Git flow: %s", async tamper => {
    const root = await mkdtemp(path.join(tmpdir(), "nautilo-repo-docs-"));
    try {
      const sourceWork = path.join(root, "source-work");
      await mkdir(sourceWork);
      runGit(sourceWork, ["init", "--initial-branch=main"]);
      await writeFile(path.join(sourceWork, "README.md"), "# Fixture repository\n", "utf8");
      runGit(sourceWork, ["add", "README.md"]);
      runGit(sourceWork, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
        "commit", "-m", "Initial source"]);
      const sourceHead = runGit(sourceWork, ["rev-parse", "HEAD"]);
      runGit(root, ["clone", "--bare", sourceWork, "source.git"]);

      const modelId = "model-__NAUTILO_REPO_DOCS_UPDATED_AT__-fixture";
      const f = fixture("source.git", modelId);
      const retained = new Map<string, Readonly<{ output: string; exitCode: number }>>();
      let starts = 0;
      f.setDispatch(sent => {
        const binding = sent.localExecutionBinding!;
        if (sent.toolName === "exec_command") {
          starts += 1;
          const workdir = String(sent.args["workdir"]);
          const execution = spawnSync("/bin/sh", ["-c", String(sent.args["cmd"])], {
            cwd: path.resolve(root, workdir),
            encoding: "utf8",
          });
          const receipt = { output: execution.stdout, exitCode: execution.status ?? 1 };
          retained.set(binding.executionId, receipt);
          return snapshot(binding, receipt.output, { exitCode: receipt.exitCode });
        }
        const receipt = retained.get(binding.executionId);
        return receipt === undefined
          ? { status: "error", error: "missing retained execution" }
          : snapshot(binding, receipt.output, { exitCode: receipt.exitCode });
      });

      const preparePlan = (await f.port.plan(f.request))!;
      const prepared = await f.port.execute({ request: f.request, plan: preparePlan,
        signal: new AbortController().signal });
      if (prepared.kind !== "prepared") throw new Error("prepare result was unavailable");
      expect(prepared).toMatchObject({ sourceHead, resolvedMode: "init" });
      expect((await stat(path.join(prepared.workDir, "openwiki"))).isDirectory()).toBe(true);
      await writeFile(path.join(prepared.workDir, "openwiki", "quickstart.md"), "# Generated docs\n", "utf8");

      const preparedCheckpoint = { ...f.checkpoint, receipts: [{ version: 1 as const,
        status: "confirmed" as const, request: f.request, plan: preparePlan, result: prepared }] };
      const commitRequest = createProtectedRepoDocsRequest(preparedCheckpoint, "commit");
      const commitPlan = (await f.port.plan(commitRequest))!;
      const wiki = path.join(prepared.workDir, "openwiki");
      if (tamper === "changed origin before commit") {
        runGit(prepared.workDir, ["remote", "set-url", "origin", sourceWork]);
      } else if (tamper === "installed hook") {
        await writeFile(path.join(prepared.workDir, ".git", "hooks", "pre-commit"),
          `#!/bin/sh\nprintf '%s' escaped > '${path.join(root, "hook-effect")}'\n`, { mode: 0o700 });
      } else if (tamper === "symlinked wiki") {
        await rm(wiki, { recursive: true });
        await symlink(sourceWork, wiki);
      } else if (tamper === "symlinked metadata") {
        await symlink(path.join(sourceWork, "README.md"), path.join(wiki, ".openwiki-metadata.json"));
      }
      if (tamper !== "unchanged" && tamper !== "changed origin before publish") {
        await rejects(f.port.execute({ request: commitRequest, plan: commitPlan,
          signal: new AbortController().signal }), ProtectedRepoDocsOutcomeUnknownError);
        expect(runGit(prepared.workDir, ["rev-parse", "HEAD"])).toBe(sourceHead);
        expect(await readFile(path.join(sourceWork, "README.md"), "utf8")).toBe("# Fixture repository\n");
        expect(await readFile(path.join(root, "hook-effect"), "utf8").catch(() => null)).toBeNull();
        expect(await f.port.inspect({ request: commitRequest, plan: commitPlan,
          signal: new AbortController().signal })).toEqual({ status: "ambiguous" });
        return;
      }
      const committed = await f.port.execute({ request: commitRequest, plan: commitPlan,
        signal: new AbortController().signal });
      expect(committed).toMatchObject({ kind: "committed", sourceHead });
      const metadata = JSON.parse(await readFile(
        path.join(prepared.workDir, "openwiki", ".openwiki-metadata.json"), "utf8",
      )) as Record<string, unknown>;
      expect(metadata).toEqual({
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u),
        command: "init",
        gitHead: sourceHead,
        workhorseModel: modelId,
        finalizeModel: modelId,
      });
      expect(runGit(sourceWork, ["rev-parse", "HEAD"])).toBe(sourceHead);
      expect(runGit(sourceWork, ["status", "--short"])).toBe("");

      const startsBeforeInspection = starts;
      expect(await f.port.inspect({ request: commitRequest, plan: commitPlan,
        signal: new AbortController().signal })).toMatchObject({
        status: "confirmed",
        result: { kind: "committed", sourceHead },
      });
      expect(starts).toBe(startsBeforeInspection);

      if (committed.kind !== "committed" || committed.commitOid === null) throw new Error("commit result was unavailable");
      const publishCheckpoint = { ...preparedCheckpoint, receipts: [
        ...preparedCheckpoint.receipts,
        { version: 1 as const, status: "confirmed" as const, request: commitRequest,
          plan: commitPlan, result: committed },
      ] };
      const publishRequest = createProtectedRepoDocsRequest(publishCheckpoint, "publish");
      const publishPlan = (await f.port.plan(publishRequest))!;
      if (tamper === "changed origin before publish") {
        runGit(prepared.workDir, ["remote", "set-url", "origin", sourceWork]);
        await rejects(f.port.execute({ request: publishRequest, plan: publishPlan,
          signal: new AbortController().signal }), ProtectedRepoDocsOutcomeUnknownError);
        expect(spawnSync("git", ["--git-dir=source.git", "rev-parse", "--verify", `refs/heads/${f.request.branch}`],
          { cwd: root, encoding: "utf8" }).status).not.toBe(0);
        expect(runGit(sourceWork, ["rev-parse", "HEAD"])).toBe(sourceHead);
        return;
      }
      expect(await f.port.execute({ request: publishRequest, plan: publishPlan,
        signal: new AbortController().signal })).toMatchObject({
        kind: "published",
        commitOid: committed.commitOid,
        remoteRefOid: committed.commitOid,
      });
      expect(runGit(root, ["--git-dir=source.git", "rev-parse", `refs/heads/${f.request.branch}`]))
        .toBe(committed.commitOid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publishes only the exact new branch with a normal push and a manual PR instruction", async () => {
    const f = fixture();
    const prepared = Object.freeze({ kind: "prepared" as const, relativeWorkspacePath: f.request.relativeWorkspacePath,
      workDir: `/projects/root/${f.request.relativeWorkspacePath}`, branch: f.request.branch,
      sourceHead: "a".repeat(40), resolvedMode: "init" as const, brief: "brief" });
    const committed = Object.freeze({ kind: "committed" as const, sourceHead: prepared.sourceHead,
      commitOid: "b".repeat(40), changedFileCount: 2 });
    const preparePlan = (await f.port.plan(f.request))!;
    const commitCheckpoint = { ...f.checkpoint, receipts: [{ version: 1 as const, status: "confirmed" as const,
      request: f.request, plan: preparePlan, result: prepared }] };
    const commitRequest = createProtectedRepoDocsRequest(commitCheckpoint, "commit");
    const commitPlan = (await f.port.plan(commitRequest))!;
    const publishCheckpoint = { ...commitCheckpoint, receipts: [...commitCheckpoint.receipts,
      { version: 1 as const, status: "confirmed" as const, request: commitRequest, plan: commitPlan, result: committed }] };
    const request = createProtectedRepoDocsRequest(publishCheckpoint, "publish");
    const plan = await f.port.plan(request);
    const instruction = `Open a pull request from ${request.branch}.`;
    const receipt = ["NAUTILO_REPO_DOCS_V1", digest(request), "publish", committed.commitOid,
      committed.commitOid, b64(instruction)].join("\t");
    f.setDispatch(sent => snapshot(sent.localExecutionBinding!, receipt));
    expect(await f.port.execute({ request, plan: plan!, signal: new AbortController().signal })).toEqual({
      kind: "published", commitOid: committed.commitOid, remoteRefOid: committed.commitOid, instruction,
    });
    const command = String(f.dispatched[0]?.args["cmd"]);
    expect(spawnSync("/bin/sh", ["-n"], { input: command }).status).toBe(0);
    expect(command).toContain(`git push --set-upstream origin "HEAD:refs/heads/${request.branch}"`);
    expect(command).not.toContain("--force");
    expect(command).not.toContain("gh ");
  });
});
