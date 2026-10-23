import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createProtectedRepoDocsCheckpoint,
  createProtectedRepoDocsRequest,
  ProtectedRepoDocsOutcomeUnknownError,
  runProtectedRepoDocsOperation,
  type ProtectedRepoDocsCheckpointV1,
  type ProtectedRepoDocsExecutionPort,
} from "../../src/runtime/protected-repo-docs";

const RUN = "10000000-0000-4000-8000-000000000001";
const TASK = "20000000-0000-4000-8000-000000000002";

function planFor(request: ReturnType<typeof createProtectedRepoDocsRequest>) {
  const delegation = {
    version: 1 as const,
    humanUserId: "human",
    agentId: "agent",
    sourceRoomId: "room",
    sourceConversationId: "conversation",
    rootTaskId: TASK,
    target: {
      instanceId: "",
      relayId: "relay",
      pairingGeneration: "pairing",
      serverOrigin: "https://server.example.test",
      serverFingerprint: "fingerprint",
    },
    projectGrantId: "project-grant",
    ceiling: "basic" as const,
    profile: null,
  };
  return {
    requestDigest: createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex"),
    relayBinding: {
      version: 4 as const,
      generation: "generation",
      invocationId: request.operationId,
      executionId: "execution",
      operation: "start" as const,
      owner: {
        instanceId: "",
        humanUserId: delegation.humanUserId,
        agentId: delegation.agentId,
        runId: RUN,
        conversationId: "conversation",
        relayId: delegation.target.relayId,
        desktopSessionId: "desktop",
        pairingGeneration: delegation.target.pairingGeneration,
        serverBindingId: "server-binding",
        profileId: null,
        profileRevision: null,
        grantIds: [delegation.projectGrantId],
        grantRevision: 1,
        protectedPolicyVersion: 1,
      },
      authority: {
        kind: "delegated" as const,
        taskId: TASK,
        taskRunId: RUN,
        roomId: delegation.sourceRoomId,
        delegation,
      },
    },
  };
}

function fixture() {
  let saved: ProtectedRepoDocsCheckpointV1 | null = null;
  const calls: string[] = [];
  const result = Object.freeze({
    kind: "prepared" as const,
    relativeWorkspacePath: `nautilo-repo-docs/task-run-${RUN}`,
    workDir: `/captured/project/nautilo-repo-docs/task-run-${RUN}`,
    branch: `nautilo/repo-docs/${RUN}`,
    sourceHead: "a".repeat(40),
    resolvedMode: "init" as const,
    brief: "Generate the repository documentation.",
  });
  const port: ProtectedRepoDocsExecutionPort = {
    plan: async request => {
      calls.push("plan");
      return planFor(request);
    },
    execute: async () => {
      calls.push(`execute:${saved?.receipts.at(-1)?.status ?? "missing"}`);
      return result;
    },
    inspect: async () => {
      calls.push("inspect");
      return { status: "confirmed", result };
    },
  };
  const checkpoint = createProtectedRepoDocsCheckpoint({
    taskRunId: RUN,
    selection: { target: "https://example.test/repository.git", mode: "auto", publish: "pr" },
    modelId: "model-fixture",
  });
  return {
    checkpoint,
    request: createProtectedRepoDocsRequest(checkpoint, "prepare"),
    port,
    calls,
    result,
    store: {
      read: async () => saved,
      write: async (value: ProtectedRepoDocsCheckpointV1) => { saved = value; },
    },
    saved: () => saved,
  };
}

describe("protected repo docs checkpointed operations", () => {
  test("uses one visible stable child and persists the relay plan before dispatch", async () => {
    const f = fixture();
    const outcome = await runProtectedRepoDocsOperation({ ...f,
      signal: new AbortController().signal });
    expect(f.checkpoint.relativeWorkspacePath).toBe(`nautilo-repo-docs/task-run-${RUN}`);
    expect(f.request.modelId).toBe("model-fixture");
    expect(f.calls).toEqual(["plan", "execute:pending"]);
    expect(outcome.result).toEqual(f.result);
    expect(f.saved()?.receipts).toHaveLength(1);
    expect(f.saved()?.receipts[0]?.status).toBe("confirmed");
  });

  test("binds commit metadata to the confirmed source, mode, and selected model", async () => {
    const f = fixture();
    const prepared = await runProtectedRepoDocsOperation({ ...f,
      signal: new AbortController().signal });
    const commit = createProtectedRepoDocsRequest(prepared.checkpoint, "commit");
    expect(commit).toMatchObject({
      kind: "commit",
      sourceHead: f.result.sourceHead,
      resolvedMode: f.result.resolvedMode,
      modelId: "model-fixture",
    });
    expect(() => createProtectedRepoDocsCheckpoint({
      taskRunId: RUN,
      selection: { target: "repository", mode: "auto", publish: "branch" },
      modelId: " ",
    })).toThrow("model identity is invalid");
  });

  test("adopts an exact read-only inspection after a pending response loss", async () => {
    const f = fixture();
    const plan = await f.port.plan(f.request);
    const pending = { version: 1 as const, status: "pending" as const,
      request: f.request, plan: plan! };
    await f.store.write({ ...f.checkpoint, receipts: [pending] });
    f.calls.length = 0;
    const outcome = await runProtectedRepoDocsOperation({ ...f,
      signal: new AbortController().signal });
    expect(outcome.result).toEqual(f.result);
    expect(f.calls).toEqual(["inspect"]);
  });

  test("does not replay a pending effect when inspection proves absent", async () => {
    const f = fixture();
    const plan = await f.port.plan(f.request);
    await f.store.write({ ...f.checkpoint, receipts: [{ version: 1, status: "pending",
      request: f.request, plan: plan! }] });
    f.calls.length = 0;
    f.port.inspect = async () => ({ status: "absent" });
    await Promise.resolve(expect(runProtectedRepoDocsOperation({ ...f,
      signal: new AbortController().signal })).rejects.toBeInstanceOf(
      ProtectedRepoDocsOutcomeUnknownError,
    ));
    expect(f.calls).toEqual([]);
  });

  test("returns an immutable confirmed replay without relay custody", async () => {
    const f = fixture();
    const first = await runProtectedRepoDocsOperation({ ...f,
      signal: new AbortController().signal });
    expect(createProtectedRepoDocsRequest(first.checkpoint, "prepare")).toEqual(
      f.request,
    );
    f.calls.length = 0;
    const replay = await runProtectedRepoDocsOperation({
      ...f, checkpoint: first.checkpoint,
      signal: new AbortController().signal,
    });
    expect(replay.result).toBe(first.result);
    expect(f.calls).toEqual([]);
  });

  test("rejects a substituted plan before persisting or dispatching", async () => {
    const f = fixture();
    f.port.plan = async request => ({
      ...planFor(request),
      requestDigest: "0".repeat(64),
    });
    await Promise.resolve(expect(runProtectedRepoDocsOperation({
      ...f,
      signal: new AbortController().signal,
    })).rejects.toThrow("relay authority is unavailable"));
    expect(f.saved()).toBeNull();
    expect(f.calls).toEqual([]);
  });

  test("rejects a request substituted after checkpoint creation", async () => {
    const f = fixture();
    await Promise.resolve(expect(runProtectedRepoDocsOperation({
      ...f,
      request: Object.freeze({ ...f.request, target: "https://attacker.example.test/repository.git" }),
      signal: new AbortController().signal,
    })).rejects.toThrow("request does not match its checkpoint"));
    expect(f.saved()).toBeNull();
    expect(f.calls).toEqual([]);
  });

  test("rejects adapter mutation and leaves only the pending receipt", async () => {
    const f = fixture();
    f.port.execute = async ({ plan }) => {
      expect(() => {
        (plan.relayBinding.owner.grantIds as string[])[0] = "replacement";
      }).toThrow();
      throw new Error("execution refused");
    };
    await Promise.resolve(expect(runProtectedRepoDocsOperation({
      ...f,
      signal: new AbortController().signal,
    })).rejects.toThrow("execution refused"));
    expect(f.saved()?.receipts[0]?.status).toBe("pending");
    expect(f.saved()?.receipts[0]?.plan.relayBinding.owner.grantIds).toEqual([
      "project-grant",
    ]);
  });
});
