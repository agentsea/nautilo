import { describe, expect, test } from "bun:test";
import type {
  DelegatedLocalExecutionAdmission,
  DelegatedLocalExecutionPort,
  NautiloState,
  ToolRelayRegistry,
} from "@nautilo/agent";
import type {
  RelayDispatchResult,
  RelayLocalFileRequest,
} from "@nautilo/relay";
import type { LocalExecutionDelegation } from "@nautilo/types";

import { createProtectedTaskRepoDocsProjectFilePort } from "../../src/routes/protected-task-repo-docs-project-file";

const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const HUMAN = "40000000-0000-4000-8000-000000000004";
const ROOM = "50000000-0000-4000-8000-000000000005";
const RELAY = "relay-fixture";
const GENERATION = "generation-fixture";
const WORKSPACE = `/projects/root/nautilo-repo-docs/task-run-${RUN}`;

const readRequest: RelayLocalFileRequest = Object.freeze({
  operation: Object.freeze({
    kind: "file" as const,
    command: "read",
    zone: "current" as const,
    args: Object.freeze({ path: "README.md" }),
  }),
  allowedRoots: Object.freeze([WORKSPACE]),
});

const writeRequest: RelayLocalFileRequest = Object.freeze({
  operation: Object.freeze({
    kind: "file" as const,
    command: "write",
    zone: "current" as const,
    args: Object.freeze({ path: "openwiki/index.md", content: "Updated" }),
  }),
  allowedRoots: Object.freeze([WORKSPACE]),
});

function fixture(workspaceRoot = WORKSPACE) {
  const sourceAbort = new AbortController();
  const jobAbort = new AbortController();
  const delegation: LocalExecutionDelegation = {
    version: 1,
    humanUserId: HUMAN,
    agentId: AGENT,
    sourceRoomId: ROOM,
    sourceConversationId: "source-thread",
    rootTaskId: TASK,
    projectGrantId: "project-grant",
    ceiling: "basic",
    profile: null,
    target: {
      instanceId: "instance-fixture",
      relayId: RELAY,
      pairingGeneration: "pairing-fixture",
      serverOrigin: "https://server.example",
      serverFingerprint: "server-fingerprint",
    },
  };
  const source: DelegatedLocalExecutionAdmission = {
    taskId: TASK,
    taskRunId: RUN,
    signal: sourceAbort.signal,
    delegation,
  };
  let admittedSource = source;
  const admissions: string[] = [];
  const delegated: DelegatedLocalExecutionPort = {
    taskId: TASK,
    taskRunId: RUN,
    signal: sourceAbort.signal,
    retain: () => () => undefined,
    withAdmission: async (operation, work) => {
      admissions.push(operation);
      return await work(admittedSource);
    },
  };
  const state = {
    currentTaskId: TASK,
    currentTaskRunId: RUN,
    agentId: AGENT,
    roomId: ROOM,
    currentThreadId: "thread-fixture",
    langgraphThreadId: "thread-fixture",
    causalHumanUserId: HUMAN,
    trustedExecutionEntrypoint: "background.task",
  } satisfies Pick<NautiloState,
    | "currentTaskId"
    | "currentTaskRunId"
    | "agentId"
    | "roomId"
    | "currentThreadId"
    | "langgraphThreadId"
    | "causalHumanUserId"
    | "trustedExecutionEntrypoint"
  >;
  let current = true;
  let generation = GENERATION;
  let capabilitiesReads = 0;
  let driftGenerationAfterBinding = false;
  let dispatchResult: RelayDispatchResult = {
    status: "ok",
    result: { ok: true, result: { text: "private contents" } },
  };
  let duringDispatch: (() => void) | undefined;
  const dispatched: Parameters<ToolRelayRegistry["dispatch"]>[1][] = [];
  const registry = {
    findByCapabilityForUser: () => [RELAY],
    getCapabilities: () => {
      capabilitiesReads += 1;
      const selectedGeneration = driftGenerationAfterBinding && capabilitiesReads > 1
        ? "replacement-generation"
        : generation;
      return {
        profile: "desktop-agent" as const,
        canExecuteLocal: true,
        canDelegateLocalExecution: true,
        canUseTaskProjectFiles: true,
        localFileExecution: true,
        localExecution: {
          version: 1 as const,
          generation: selectedGeneration,
          pipe: true,
          pty: true,
          localNetworkPolicy: true,
          capacity: 1,
        },
      };
    },
    getProtocolVersion: () => 30,
    getUserId: () => HUMAN,
    getDesktopSessionId: () => "desktop-fixture",
    getPairingGeneration: () => "pairing-fixture",
    getLocalExecutionPairingGeneration: () => "opaque-pairing-fixture",
    getLocalExecutionBinding: () => null,
    dispatch: async (_relayId: string, request: Parameters<ToolRelayRegistry["dispatch"]>[1]) => {
      dispatched.push(request);
      duringDispatch?.();
      return dispatchResult;
    },
  } satisfies ToolRelayRegistry;
  const port = createProtectedTaskRepoDocsProjectFilePort({
    delegated,
    registry,
    state,
    modelId: "provider:fixture-model",
    selection: {
      target: "https://example.test/repository.git",
      mode: "auto",
      publish: "pr",
    },
    signal: jobAbort.signal,
    assertCurrent: () => current
      ? Promise.resolve()
      : Promise.reject(new Error("current authority revoked")),
    workspaceRoot,
    relayId: RELAY,
  });
  return {
    admissions,
    dispatched,
    jobAbort,
    port,
    sourceAbort,
    replaceAdmission(patch: Partial<DelegatedLocalExecutionAdmission>) {
      admittedSource = { ...source, ...patch };
    },
    setCurrent(value: boolean) { current = value; },
    setDispatchResult(value: RelayDispatchResult) { dispatchResult = value; },
    setDuringDispatch(value: (() => void) | undefined) { duringDispatch = value; },
    setGeneration(value: string) { generation = value; },
    setGenerationDrift(value: boolean) {
      driftGenerationAfterBinding = value;
      capabilitiesReads = 0;
    },
  };
}

describe("protected Task repo docs project file port", () => {
  test("reads only through the exact Task-owned V4 binding", async () => {
    const f = fixture();
    expect(await f.port.dispatch(readRequest, {
      mutating: false,
      approvalObtained: false,
    })).toEqual({ ok: true, result: { text: "private contents" } });
    expect(f.admissions).toEqual(["read"]);
    expect(f.dispatched).toHaveLength(1);
    expect(f.dispatched[0]).toMatchObject({
      toolName: "local-file",
      executionClass: "local-file",
      impact: "read-only",
      approvalObtained: false,
      localExecutionBinding: {
        version: 4,
        operation: "read",
        generation: GENERATION,
        authority: {
          kind: "delegated",
          taskId: TASK,
          taskRunId: RUN,
        },
      },
    });
    expect(f.dispatched[0]?.args).toEqual({ ...readRequest });
  });

  test("requires the exact managed child and explicit mutation approval", async () => {
    expect(() => fixture("/projects/root")).toThrow("identity is invalid");
    const f = fixture();
    const foreign = { ...readRequest, allowedRoots: ["/projects/root"] };
    expect(await f.port.dispatch(foreign, {
      mutating: false,
      approvalObtained: false,
    })).toMatchObject({ ok: false, code: "TASK_PROJECT_FILE_UNAVAILABLE" });
    expect(await f.port.dispatch(writeRequest, {
      mutating: true,
      approvalObtained: false,
    })).toMatchObject({ ok: false, code: "TASK_PROJECT_FILE_UNAVAILABLE" });
    expect(f.dispatched).toHaveLength(0);
    expect(await f.port.dispatch(writeRequest, {
      mutating: true,
      approvalObtained: true,
    })).toMatchObject({ ok: true });
    expect(f.admissions).toEqual(["input"]);
    expect(f.dispatched[0]).toMatchObject({
      impact: "destructive",
      approvalObtained: true,
      localExecutionBinding: { operation: "input" },
    });
  });

  test("rejects revoked product or grant custody before dispatch", async () => {
    const current = fixture();
    current.setCurrent(false);
    expect(await current.port.dispatch(readRequest, {
      mutating: false,
      approvalObtained: false,
    })).toMatchObject({ ok: false, code: "TASK_PROJECT_FILE_UNAVAILABLE" });
    expect(current.dispatched).toHaveLength(0);

    const expired = fixture();
    expired.sourceAbort.abort(new Error("grant expired"));
    expect(await expired.port.dispatch(readRequest, {
      mutating: false,
      approvalObtained: false,
    })).toMatchObject({ ok: false, code: "TASK_PROJECT_FILE_UNAVAILABLE" });
    expect(expired.dispatched).toHaveLength(0);
  });

  test("rejects generation, relay, and owner substitution before dispatch", async () => {
    const generation = fixture();
    generation.setGenerationDrift(true);
    expect(await generation.port.dispatch(readRequest, {
      mutating: false,
      approvalObtained: false,
    })).toMatchObject({ ok: false, code: "TASK_PROJECT_FILE_UNAVAILABLE" });
    expect(generation.dispatched).toHaveLength(0);

    for (const delegationPatch of [
      { target: { instanceId: "instance-fixture", relayId: "other-relay", pairingGeneration: "pairing-fixture",
        serverOrigin: "https://server.example", serverFingerprint: "server-fingerprint" } },
      { agentId: "other-agent" },
      { humanUserId: "other-human" },
    ]) {
      const changed = fixture();
      changed.replaceAdmission({ delegation: {
        version: 1,
        humanUserId: HUMAN,
        agentId: AGENT,
        sourceRoomId: ROOM,
        sourceConversationId: "source-thread",
        rootTaskId: TASK,
        projectGrantId: "project-grant",
        ceiling: "basic",
        profile: null,
        target: { instanceId: "instance-fixture", relayId: RELAY, pairingGeneration: "pairing-fixture",
          serverOrigin: "https://server.example", serverFingerprint: "server-fingerprint" },
        ...delegationPatch,
      } });
      expect(await changed.port.dispatch(readRequest, {
        mutating: false,
        approvalObtained: false,
      })).toMatchObject({ ok: false, code: "TASK_PROJECT_FILE_UNAVAILABLE" });
      expect(changed.dispatched).toHaveLength(0);
    }
  });

  test("returns outcome unknown when mutation authority closes after dispatch", async () => {
    const f = fixture();
    f.setDuringDispatch(() => f.setCurrent(false));
    expect(await f.port.dispatch(writeRequest, {
      mutating: true,
      approvalObtained: true,
    })).toMatchObject({ ok: false, code: "TASK_PROJECT_FILE_OUTCOME_UNKNOWN" });
    expect(f.dispatched).toHaveLength(1);
  });

  test("fails closed for malformed or unsuccessful relay responses", async () => {
    const unavailable = fixture();
    unavailable.setDispatchResult({ status: "error", error: "transport closed" });
    expect(await unavailable.port.dispatch(readRequest, {
      mutating: false,
      approvalObtained: false,
    })).toMatchObject({ ok: false, code: "TASK_PROJECT_FILE_UNAVAILABLE" });

    const denied = fixture();
    denied.setDispatchResult({
      status: "ok",
      result: { ok: false, code: "EACCES", message: "secret relay detail" },
    });
    expect(await denied.port.dispatch(readRequest, {
      mutating: false,
      approvalObtained: false,
    })).toEqual({
      ok: false,
      code: "EACCES",
      message: "The exact Task project file operation failed.",
    });
  });
});
