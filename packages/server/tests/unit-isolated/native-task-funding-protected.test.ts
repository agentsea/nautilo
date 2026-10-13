import { afterAll, describe, expect, mock, test } from "bun:test";
import type { Task, TaskRun } from "@nautilo/db";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";
const JOB = "66666666-6666-4666-8666-666666666666";
const NAMESPACE = "77777777-7777-4777-8777-777777777777";
const CREDENTIAL = "88888888-8888-4888-8888-888888888888";
const MODEL = "anthropic:claude-sonnet";
const binding = Object.freeze({
  kind: "personal" as const,
  providerRoute: "anthropic",
  credentialId: CREDENTIAL,
  credentialRevision: 4,
});

let currentTask: Task;
let currentRun: TaskRun;
let providerAttempts = 0;
let ordinaryTaskReads = 0;
let ordinaryRunReads = 0;
let protectedTaskProjectionKeys: readonly string[] = [];

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK,
    ownerId: HUMAN,
    requestorId: HUMAN,
    agentId: AGENT,
    prompt: "",
    expectedOutput: null,
    preset: "in_background",
    callingRoomId: ROOM,
    targetChat: "last_in_namespace",
    targetChatHandle: null,
    targetRoomId: ROOM,
    targetUserIds: [HUMAN],
    useScope: false,
    scopeId: null,
    toolsMode: "none",
    toolsWhitelist: [],
    awaitResponse: false,
    selectionProfile: "balanced",
    selectionSpec: null,
    requestedModelId: MODEL,
    parentTaskId: null,
    depth: 0,
    fundingMode: "caller",
    metadata: {},
    contentRepresentation: "protected",
    contentNamespaceId: NAMESPACE,
    contentRevision: 2,
    cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
    cryptoAccessRevision: 3,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(5),
    cryptoMappingState: "verified",
    ...overrides,
  } as Task;
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: RUN,
    taskId: TASK,
    jobId: JOB,
    graphThreadId: `subagent:${TASK}:${RUN}`,
    status: "running",
    modelId: MODEL,
    fundingBinding: binding,
    fundingPredecessorRunId: null,
    ...overrides,
  } as TaskRun;
}

currentTask = task();
currentRun = run();

const actualAgent = await import("@nautilo/agent");
const actualDb = await import("@nautilo/db");
const actualTrust = await import("@nautilo/trust");

mock.module("@nautilo/agent", () => ({
  ...actualAgent,
  getProfileByAgentId: async () => null,
  resolveRetainedModels: (ids: string[]) => ids.map(id => ({
    id,
    availability: "selectable" as const,
  })),
  resolveCatalogModel: () => ({ workload: "chat", output: ["text"] }),
  validateExactTaskModelSelection: () => null,
}));
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getTaskById: async () => {
    ordinaryTaskReads += 1;
    return currentTask;
  },
  getTaskRunForTask: async () => {
    ordinaryRunReads += 1;
    return currentRun;
  },
}));
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  assertCanInvokeAgent: async () => undefined,
}));

const directDb = {
  select: (projection: Readonly<Record<string, unknown>>) => {
    let source: unknown;
    const query = {
      from: (table: unknown) => {
        source = table;
        return query;
      },
      innerJoin: () => query,
      where: () => query,
      limit: async () => source === actualDb.tasks
        ? [Object.fromEntries(Object.keys(projection).map(key => [key,
            key === "metadataShapeSupported"
              ? true
              : currentTask[key as keyof Task],
          ]))]
        : source === actualDb.taskRuns
          ? [currentRun]
          : [{ id: ROOM }],
    };
    if (Object.hasOwn(projection, "contentRevision")) {
      protectedTaskProjectionKeys = Object.keys(projection);
    }
    return query;
  },
};
mock.module("../../src/lib/server-direct-db", () => ({
  getServerDirectDb: () => directDb,
}));
mock.module("../../src/lib/foreground-chat-funding", () => ({
  isOwnPrivateGenieRoom: async () => true,
  usageFundingFor: () => ({ kind: "personal", providerRoute: "anthropic" }),
}));
mock.module("../../src/lib/capability-funding", () => ({
  createCapabilityFundingSession: () => ({
    openModel: async () => ({}),
    openService: async () => ({}),
  }),
  prepareCapabilityFundingSession: async () => undefined,
}));
class TestModelFundingError extends Error {
  constructor(readonly code: string) { super(code); }
}
mock.module("../../src/lib/model-funding", () => ({
  ModelFundingError: TestModelFundingError,
  resolveModelFunding: async () => ({
    ...binding,
    humanUserId: HUMAN,
    payerHumanId: HUMAN,
    modelId: MODEL,
    workload: "native_text_task" as const,
  }),
  withAdmittedPersonalProviderKey: async (
    _decision: unknown,
    use: (apiKey: string) => Promise<unknown>,
  ) => {
    providerAttempts += 1;
    return use("request-local-secret");
  },
}));
mock.module("../../src/lib/caller-task-model-context", () => ({
  callerTaskModelEnvironment: async () => ({}),
  callerTaskModelIds: async () => [MODEL],
  personalOnlyTaskModelIds: async () => [MODEL],
}));

const {
  nativeTaskFundingPort,
  openProtectedTaskWakeFundingSession,
  withProtectedTaskFundingAuthority,
} = await import("../../src/lib/native-task-funding");

afterAll(() => { mock.restore(); });

describe("protected native Task funding", () => {
  test("requires live protected authority and retains it around credential custody", async () => {
    currentTask = task();
    currentRun = run();
    providerAttempts = 0;
    ordinaryTaskReads = 0;
    ordinaryRunReads = 0;
    let authorityChecks = 0;
    let current = true;
    const assertCurrent = async () => {
      authorityChecks += 1;
      if (!current) throw new Error("protected_authority_revoked");
    };

    expect(await nativeTaskFundingPort.admit(currentTask).then(
      () => null,
      (error: unknown) => (error as { code?: unknown }).code,
    )).toBe("unsupported_workload");

    const admission = await withProtectedTaskFundingAuthority(
      assertCurrent,
      () => nativeTaskFundingPort.admit(currentTask),
    );
    expect(admission).toEqual({ modelId: MODEL, binding });
    const session = await withProtectedTaskFundingAuthority(
      assertCurrent,
      () => nativeTaskFundingPort.openSession(
        currentTask,
        currentRun,
        MODEL,
        false,
      ),
    );
    const secret = await session.runAttempt(
      MODEL,
      async attempt => attempt.personalCredential?.apiKey,
    );
    expect(secret).toBe("request-local-secret");
    expect(providerAttempts).toBe(1);
    expect({ ordinaryTaskReads, ordinaryRunReads }).toEqual({
      ordinaryTaskReads: 0,
      ordinaryRunReads: 0,
    });
    expect(protectedTaskProjectionKeys).toContain("metadataShapeSupported");
    expect(protectedTaskProjectionKeys).not.toContain("metadata");
    expect(authorityChecks).toBeGreaterThanOrEqual(10);
    expect(JSON.stringify({ currentTask, currentRun, admission }))
      .not.toContain("request-local-secret");

    current = false;
    expect(await session.runAttempt(MODEL, async () => "unreachable").then(
      () => null,
      (error: unknown) => (error as Error).message,
    )).toBe("protected_authority_revoked");
    expect(providerAttempts).toBe(1);
  });

  test("rechecks admitted Deep Research funding from the accepted metadata without selecting the DB body", async () => {
    const lanes = ["supervisor", "research", "summarization", "compression", "finalReport"] as const;
    const modelPlan = {
      version: 1 as const,
      supervisorModel: MODEL,
      researchModel: MODEL,
      summarizationModel: MODEL,
      compressionModel: MODEL,
      finalReportModel: MODEL,
    };
    const metadata = {
      deepResearch: {
        version: 2 as const,
        reportLanguage: "English",
        modelPlan,
        invokingModelId: MODEL,
        preferenceRevisions: Object.fromEntries(lanes.map(lane => [lane, 1])),
        modelFunding: Object.fromEntries(lanes.map(lane => [lane,
          { kind: "server", providerRoute: "anthropic" }])),
        tavilyFunding: { kind: "server" as const, providerRoute: "tavily" },
      },
    };
    const accepted = task({ metadata });
    currentTask = accepted;
    currentRun = run();
    protectedTaskProjectionKeys = [];
    const session = await withProtectedTaskFundingAuthority(
      async () => {},
      () => nativeTaskFundingPort.openSession(accepted, currentRun, MODEL, false),
    );
    const currentWithoutBody = { ...accepted };
    Object.defineProperty(currentWithoutBody, "metadata", {
      configurable: true,
      get(): never { throw new Error("protected metadata body was selected"); },
    });
    currentTask = currentWithoutBody;
    expect(await session.runAttempt(MODEL, async () => "accepted")).toBe("accepted");
    expect(protectedTaskProjectionKeys).toContain("metadataShapeSupported");
    expect(protectedTaskProjectionKeys).not.toContain("metadata");
  });

  test("protected repo docs keeps exact file-only funding and never rereads its encrypted definition body", async () => {
    const accepted = task({ preset: "repo_docs", toolsMode: "whitelist", toolsWhitelist: ["file"],
      metadata: { target: "/private/project", mode: "auto", publish: "branch", instructions: "Private guidance" } });
    currentTask = accepted;
    currentRun = run();
    const session = await withProtectedTaskFundingAuthority(async () => {},
      () => nativeTaskFundingPort.openSession(accepted, currentRun, MODEL, false));
    const withoutBody = { ...accepted };
    Object.defineProperty(withoutBody, "metadata", {
      get(): never { throw new Error("protected repo docs metadata body was selected"); },
    });
    currentTask = withoutBody;
    expect(await session.runAttempt(MODEL, async () => "accepted")).toBe("accepted");
    expect(protectedTaskProjectionKeys).not.toContain("metadata");
    for (const change of [
      { toolsWhitelist: ["file", "exec_command"] },
      { toolsMode: "auto" as const },
      { useScope: true, scopeId: NAMESPACE },
      { metadata: { target: "/private/project", mode: "auto", publish: "branch", unknownBody: "unclassified" } },
      { metadata: { mode: "auto", publish: "branch" } },
      { contentRepresentation: "ordinary" as const },
    ]) {
      const candidate = { ...accepted, ...change };
      expect(await withProtectedTaskFundingAuthority(async () => {},
        () => nativeTaskFundingPort.admit(candidate)).then(() => null,
          (error: unknown) => (error as { code?: string }).code)).toBe("unsupported_workload");
    }
  });

  test("opens fresh caller funding for a synthetic cancelled protected Run", async () => {
    currentTask = task();
    currentRun = run({
      status: "cancelled",
      jobId: null,
      modelId: null,
      fundingBinding: null,
      fundingPredecessorRunId: null,
    });
    providerAttempts = 0;
    ordinaryTaskReads = 0;
    ordinaryRunReads = 0;
    let current = true;
    const session = await openProtectedTaskWakeFundingSession({
      taskSource: currentTask,
      runSource: currentRun,
      modelId: null,
      assertCurrent: async () => {
        if (!current) throw new Error("protected_authority_revoked");
      },
    });
    expect(session).not.toBeNull();
    expect(await session!.runAttempt(
      MODEL,
      async attempt => attempt.personalCredential?.apiKey,
    )).toBe("request-local-secret");
    expect(providerAttempts).toBe(1);
    expect({ ordinaryTaskReads, ordinaryRunReads }).toEqual({
      ordinaryTaskReads: 0,
      ordinaryRunReads: 0,
    });

    current = false;
    expect(await session!.runAttempt(MODEL, async () => "unreachable").then(
      () => null,
      (error: unknown) => (error as Error).message,
    )).toBe("protected_authority_revoked");
    expect(providerAttempts).toBe(1);
  });

  test("rejects partial synthetic cancellation coordinates", async () => {
    currentTask = task();
    for (const current of [
      run({ status: "cancelled", jobId: null, modelId: null,
        fundingBinding: binding, fundingPredecessorRunId: null }),
      run({ status: "cancelled", jobId: JOB, modelId: null,
        fundingBinding: null, fundingPredecessorRunId: null }),
    ]) {
      currentRun = current;
      expect(await openProtectedTaskWakeFundingSession({
        taskSource: currentTask,
        runSource: current,
        modelId: null,
        assertCurrent: async () => {},
      }).then(
        () => null,
        (error: unknown) => (error as { code?: unknown }).code,
      )).toBe("funding_source_changed");
    }
  });

  test("admits a protected Scope only under its live authority and fences Scope changes", async () => {
    currentTask = task({ useScope: true, scopeId: NAMESPACE });
    currentRun = run();
    providerAttempts = 0;
    const accepted = currentTask;
    expect(await withProtectedTaskFundingAuthority(
      async () => {},
      () => nativeTaskFundingPort.admit(accepted),
    )).toEqual({ modelId: MODEL, binding });
    const session = await withProtectedTaskFundingAuthority(
      async () => {},
      () => nativeTaskFundingPort.openSession(accepted, currentRun, MODEL, false),
    );
    expect(await session.runAttempt(MODEL, async () => "accepted")).toBe("accepted");
    expect(providerAttempts).toBe(1);
    for (const changed of [
      task({ useScope: true, scopeId: ROOM }),
      task({ useScope: false, scopeId: null }),
    ]) {
      currentTask = changed;
      expect(await session.runAttempt(MODEL, async () => "unreachable").then(
        () => null,
        (error: unknown) => (error as { code?: unknown }).code,
      )).toBe("funding_source_changed");
    }
    expect(providerAttempts).toBe(1);
  });

  for (const shape of [
    { useScope: true, scopeId: null },
    { useScope: true, scopeId: "untrusted" },
    { useScope: false, scopeId: NAMESPACE },
  ]) test(`refuses inconsistent protected Scope ${JSON.stringify(shape)}`, async () => {
    currentTask = task(shape);
    expect(await withProtectedTaskFundingAuthority(
      async () => {},
      () => nativeTaskFundingPort.admit(currentTask),
    ).then(
      () => null,
      (error: unknown) => (error as { code?: unknown }).code,
    )).toBe("unsupported_workload");
  });
});
