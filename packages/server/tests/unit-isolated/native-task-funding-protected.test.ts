import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { Task, TaskRun } from "@nautilo/db";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const PEER = "11111111-1111-4111-8111-111111111112";
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
let legacyTaskProjectionKeys: readonly string[] = [];
let returnPersonalForServer = false;
let failServerFundingAt = Number.POSITIVE_INFINITY;
let fundingRequests: Array<Record<string, unknown>> = [];
let fundingDecisions: Array<Record<string, unknown>> = [];
let serverProviderRoutes: readonly string[] = ["anthropic"];

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
const actualModelFunding = await import("../../src/lib/model-funding");

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
    } else if (Object.hasOwn(projection, "fundingMode")) {
      legacyTaskProjectionKeys = Object.keys(projection);
    }
    return query;
  },
};
mock.module("../../src/lib/server-direct-db", () => ({
  getServerDirectDb: () => directDb,
}));
mock.module("../../src/lib/foreground-chat-funding", () => ({
  isOwnPrivateGenieRoom: async () => true,
  usageFundingFor: (decision: { kind: "personal" | "server"; providerRoute: string }) => ({
    kind: decision.kind,
    providerRoute: decision.providerRoute,
  }),
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
  ...actualModelFunding,
  ModelFundingError: TestModelFundingError,
  resolveModelFunding: async (input: Record<string, unknown>) => {
    fundingRequests.push(input);
    if (input["fundingKind"] === "server"
      && fundingRequests.length >= failServerFundingAt) {
      throw new TestModelFundingError("server_credentials_forbidden");
    }
    const decision = input["fundingKind"] === "server" && !returnPersonalForServer
      ? { kind: "server" as const,
          providerRoute: serverProviderRoutes[Math.min(
            fundingDecisions.length,
            serverProviderRoutes.length - 1,
          )] ?? "anthropic",
          humanUserId: input["humanUserId"], modelId: input["modelId"],
          workload: input["workload"] }
      : { ...binding, humanUserId: HUMAN, payerHumanId: HUMAN,
          modelId: input["modelId"] ?? MODEL, workload: "native_text_task" as const };
    fundingDecisions.push(decision);
    return decision;
  },
  withAdmittedPersonalCredential: async (
    _decision: unknown,
    use: (credential: { apiKey: string }) => Promise<unknown>,
  ) => {
    providerAttempts += 1;
    return use({ apiKey: "request-local-secret" });
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
afterEach(() => { serverProviderRoutes = ["anthropic"]; });

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

  test("opens a direct server-pinned legacy wake without caller-only shape or custody", async () => {
    currentTask = task({
      ownerId: PEER,
      fundingMode: "legacy_server",
      useScope: true,
      scopeId: NAMESPACE,
      targetChat: "orphan",
      targetRoomId: null,
      targetUserIds: [HUMAN, PEER],
      toolsMode: "auto",
    });
    currentRun = run({
      status: "completed",
      fundingBinding: null,
    });
    fundingRequests = [];
    fundingDecisions = [];
    serverProviderRoutes = ["surplus", "anthropic"];
    legacyTaskProjectionKeys = [];
    providerAttempts = 0;
    let authorityChecks = 0;
    let current = true;
    const session = await openProtectedTaskWakeFundingSession({
      taskSource: currentTask,
      runSource: currentRun,
      modelId: MODEL,
      assertCurrent: async () => {
        authorityChecks += 1;
        if (!current) throw new Error("protected_authority_revoked");
      },
    });
    expect(session).not.toBeNull();
    expect(session!.kind).toBe("server");
    expect(session!.admission).toBeUndefined();
    expect(session!.admittedTransport).toBe("direct");
    expect(session!.capabilityFunding).toBeUndefined();
    expect(await session!.runAttempt(MODEL, async attempt => attempt.usageFunding))
      .toEqual({ kind: "server", providerRoute: "anthropic" });
    expect(providerAttempts).toBe(0);
    expect(fundingRequests).toHaveLength(3);
    expect(fundingRequests.every(request => request["fundingKind"] === "server"
      && request["workload"] === "native_text_task"
      && request["humanUserId"] === HUMAN)).toBeTrue();
    expect(fundingRequests[0]?.["priorDecision"]).toBeUndefined();
    expect(fundingRequests[1]?.["priorDecision"]).toBe(fundingDecisions[0]);
    expect(fundingRequests[2]?.["priorDecision"]).toBe(fundingDecisions[0]);
    await session!.recheckAttempt("anthropic:alternate", "direct");
    expect(fundingRequests[3]).toMatchObject({
      modelId: "anthropic:alternate",
      transport: "direct",
      fundingKind: "server",
      priorDecision: fundingDecisions[0],
    });
    expect(legacyTaskProjectionKeys).toEqual([
      "id", "ownerId", "requestorId", "agentId", "fundingMode",
      "requestedModelId", "selectionProfile", "selectionSpec", "toolsMode",
      "toolsWhitelist",
    ]);
    expect(legacyTaskProjectionKeys).not.toContain("metadata");
    expect(legacyTaskProjectionKeys).not.toContain("prompt");
    expect(authorityChecks).toBeGreaterThanOrEqual(7);

    current = false;
    expect(await session!.runAttempt(MODEL, async () => "unreachable").then(
      () => null,
      (error: unknown) => (error as Error).message,
    )).toBe("protected_authority_revoked");
    expect(fundingRequests).toHaveLength(4);
  });

  test("opens a Surplus server-pinned legacy wake with the same live server policy", async () => {
    currentTask = task({ fundingMode: "legacy_server" });
    currentRun = run({ status: "completed", fundingBinding: null });
    fundingRequests = [];
    fundingDecisions = [];
    serverProviderRoutes = ["anthropic", "surplus"];
    let authorityChecks = 0;
    let current = true;
    const session = await openProtectedTaskWakeFundingSession({
      taskSource: currentTask,
      runSource: currentRun,
      modelId: MODEL,
      assertCurrent: async () => {
        authorityChecks += 1;
        if (!current) throw new Error("protected_authority_revoked");
      },
    });

    expect(session).not.toBeNull();
    expect(session!.admission).toBeUndefined();
    expect(session!.admittedTransport).toBe("surplus");
    expect(fundingRequests).toHaveLength(2);
    expect(fundingRequests.every(request => request["fundingKind"] === "server"
      && request["workload"] === "native_text_task"
      && request["humanUserId"] === HUMAN)).toBeTrue();
    expect(fundingRequests[0]?.["priorDecision"]).toBeUndefined();
    expect(fundingRequests[1]?.["priorDecision"]).toBe(fundingDecisions[0]);
    expect(authorityChecks).toBeGreaterThanOrEqual(4);

    current = false;
    expect(await session!.recheckAttempt(MODEL).then(
      () => null,
      (error: unknown) => (error as Error).message,
    )).toBe("protected_authority_revoked");
    expect(fundingRequests).toHaveLength(2);
  });

  test("fences legacy funding coordinates and rejects a non-server resolution", async () => {
    const acceptedTask = task({ fundingMode: "legacy_server" });
    const acceptedRun = run({ status: "errored", fundingBinding: null });
    currentTask = acceptedTask;
    currentRun = acceptedRun;
    fundingRequests = [];
    fundingDecisions = [];
    const session = await openProtectedTaskWakeFundingSession({
      taskSource: acceptedTask,
      runSource: acceptedRun,
      modelId: MODEL,
      assertCurrent: async () => {},
    });
    expect(session).not.toBeNull();
    for (const [changedTask, changedRun] of [
      [task({ fundingMode: "legacy_server", selectionProfile: "smartest" }), acceptedRun],
      [task({ fundingMode: "legacy_server", toolsWhitelist: ["file"] }), acceptedRun],
      [task({ fundingMode: "legacy_server", requestorId: PEER }), acceptedRun],
      [task({ fundingMode: "caller" }), acceptedRun],
      [acceptedTask, run({ status: "errored", fundingBinding: null, graphThreadId: "changed" })],
      [acceptedTask, run({ status: "errored", fundingBinding: null,
        fundingPredecessorRunId: "99999999-9999-4999-8999-999999999999" })],
      [acceptedTask, run({ status: "completed", fundingBinding: null })],
      [acceptedTask, run({ status: "errored", fundingBinding: null,
        modelId: "anthropic:alternate" })],
      [acceptedTask, run({ status: "errored", fundingBinding: binding })],
    ] as const) {
      currentTask = changedTask;
      currentRun = changedRun;
      expect(await session!.recheckAttempt(MODEL).then(
        () => null,
        (error: unknown) => (error as { code?: unknown }).code,
      )).toBe("funding_source_changed");
    }

    currentTask = acceptedTask;
    currentRun = acceptedRun;
    returnPersonalForServer = true;
    try {
      expect(await openProtectedTaskWakeFundingSession({
        taskSource: acceptedTask,
        runSource: acceptedRun,
        modelId: MODEL,
        assertCurrent: async () => {},
      }).then(
        () => null,
        (error: unknown) => (error as { code?: unknown }).code,
      )).toBe("funding_source_changed");
    } finally {
      returnPersonalForServer = false;
    }

    currentTask = acceptedTask;
    currentRun = acceptedRun;
    fundingRequests = [];
    fundingDecisions = [];
    const policySession = await openProtectedTaskWakeFundingSession({
      taskSource: acceptedTask,
      runSource: acceptedRun,
      modelId: MODEL,
      assertCurrent: async () => {},
    });
    failServerFundingAt = 3;
    let callbackCalled = false;
    try {
      expect(await policySession!.runAttempt(MODEL, async () => {
        callbackCalled = true;
        return "unreachable";
      }).then(
        () => null,
        (error: unknown) => (error as { code?: unknown }).code,
      )).toBe("server_credentials_forbidden");
      expect(callbackCalled).toBeFalse();
    } finally {
      failServerFundingAt = Number.POSITIVE_INFINITY;
    }
  });

  test("selects server funding only for a fully null synthetic legacy cancellation", async () => {
    currentTask = task({ fundingMode: "legacy_server" });
    currentRun = run({
      status: "cancelled",
      jobId: null,
      modelId: null,
      fundingBinding: null,
      fundingPredecessorRunId: null,
    });
    fundingRequests = [];
    fundingDecisions = [];
    const session = await openProtectedTaskWakeFundingSession({
      taskSource: currentTask,
      runSource: currentRun,
      modelId: null,
      assertCurrent: async () => {},
    });
    expect(session).not.toBeNull();
    expect(fundingRequests[0]?.["modelId"]).toBe(MODEL);
    expect(await session!.runAttempt(MODEL, async () => "accepted"))
      .toBe("accepted");

    const partial = run({ status: "cancelled", jobId: JOB, modelId: null,
      fundingBinding: null, fundingPredecessorRunId: null });
    for (const invalid of [
      partial,
      run({ status: "completed", modelId: null, fundingBinding: null }),
      run({ status: "errored", modelId: null, fundingBinding: null }),
    ]) {
      expect(await openProtectedTaskWakeFundingSession({
        taskSource: currentTask,
        runSource: invalid,
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
