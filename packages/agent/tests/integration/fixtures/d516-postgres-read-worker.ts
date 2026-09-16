import { ToolMessage } from "@langchain/core/messages";
import type { RelayDispatchRequest } from "@nautilo/relay";
import {
  closeCheckpointSaver,
  createCheckpointSaver,
  setupCheckpointSaver,
} from "../../../src/checkpoints/checkpoint-saver";
import type { NautiloState } from "../../../src/agent/state";
import { COMPUTER_RESULT_DURABLE_SIDECAR_KEY } from "../../../src/tools/computer/model-result-projector";
import {
  d516BindingFor,
  d516GraphFor,
  d516HostResult,
  d516ReadCall,
  d516StateFor,
  setD516RelayDispatch,
  setupD516ProductionReadFixture,
  teardownD516ProductionReadFixture,
} from "../../support/d516-production-read-fixture";

type Phase = "crash-acknowledged" | "crash-unacknowledged" | "write-failure" | "resume";

type WorkerEvent =
  | Readonly<{ event: "ready" }>
  | Readonly<{ event: "assistant_protected" }>
  | Readonly<{ event: "dispatch"; call: "first" | "second" }>
  | Readonly<{ event: "result_protected"; call: "first" | "second" }>
  | Readonly<{
      event: "completed";
      toolCallIds: string[];
      pendingToolCallIds: string[];
      engagedSkillNames: string[];
      activatedToolNames: string[];
      activatedToolLeases: unknown[];
      resultDurableSidecarToolCallIds: string[];
    }>
  | Readonly<{ event: "failed"; reason: "persistence_failure" | "worker_error" }>;

function emit(event: WorkerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function phaseFromArg(value: string | undefined): Phase {
  if (value === "crash-acknowledged" || value === "crash-unacknowledged"
    || value === "write-failure" || value === "resume") {
    return value;
  }
  throw new Error("D516 worker phase rejected");
}

function assertOwnedDatabaseEnvironment(): void {
  if (process.env["NAUTILO_D516_DISPOSABLE_PG"] !== "1") {
    throw new Error("D516 worker requires its disposable Postgres marker");
  }
  const expectedPort = process.env["D516_PG_PORT"];
  if (expectedPort === undefined || !/^\d{1,5}$/u.test(expectedPort)) {
    throw new Error("D516 worker Postgres port rejected");
  }
  const expectedUsers = new Map([
    ["DB_DIRECT_CONNECTION", "postgres"],
    ["DB_AGENT_DIRECT_CONNECTION", "nautilo_agent"],
  ]);
  for (const [name, expectedUser] of expectedUsers) {
    const raw = process.env[name];
    if (raw === undefined) throw new Error(`D516 worker ${name} is required`);
    const url = new URL(raw);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new Error(`D516 worker ${name} protocol rejected`);
    }
    if (url.hostname !== "127.0.0.1" || url.port !== expectedPort
      || url.pathname !== "/d516_checkpoint" || decodeURIComponent(url.username) !== expectedUser) {
      throw new Error(`D516 worker ${name} target rejected`);
    }
  }
}

function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}

async function waitForParentGate(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
    process.stdin.resume();
  });
}

let activePhase: Phase | null = null;

async function main(): Promise<void> {
  const phase = phaseFromArg(process.argv[2]);
  activePhase = phase;
  const threadId = process.argv[3];
  if (threadId === undefined || !/^d516:[a-z0-9-]{8,96}$/u.test(threadId)) {
    throw new Error("D516 worker thread id rejected");
  }
  assertOwnedDatabaseEnvironment();

  // Keep stdout machine-readable for the parent lifecycle harness. Production
  // diagnostics remain visible on stderr without becoming durability signals.
  console.log = (...values: unknown[]) => { process.stderr.write(`${values.map(String).join(" ")}\n`); };
  console.warn = (...values: unknown[]) => { process.stderr.write(`${values.map(String).join(" ")}\n`); };
  console.error = (...values: unknown[]) => { process.stderr.write(`${values.map(String).join(" ")}\n`); };

  await setupCheckpointSaver();
  await setupD516ProductionReadFixture();
  emit({ event: "ready" });

  const first = d516ReadCall("call:first");
  const second = d516ReadCall("call:second");
  const mutation = d516ReadCall("call:mutation", "computer_do", {
    operation: { kind: "launch_app", app: { name: "TextEdit" } },
  });
  const callByInvocation = new Map([
    [d516BindingFor(first).computerUseInvocationId, "first" as const],
    [d516BindingFor(second).computerUseInvocationId, "second" as const],
  ]);

  setD516RelayDispatch(async (request: RelayDispatchRequest) => {
    const invocationId = request.desktopAutomationBinding?.computerUseInvocationId;
    const call = invocationId === undefined ? undefined : callByInvocation.get(invocationId);
    if (call === undefined) throw new Error("D516 worker received an unexpected relay request");
    emit({ event: "dispatch", call });
    if ((phase === "crash-acknowledged" || phase === "crash-unacknowledged")
      && call === "second") return await never();
    return { status: "ok", result: d516HostResult(request, call) };
  });

  const graph = d516GraphFor(createCheckpointSaver(), () => ({
    protectAssistantToolCall: async (message) => {
      emit({ event: "assistant_protected" });
      return await Promise.resolve(message);
    },
    protectToolResult: async (message) => {
      const call = message.tool_call_id === first.id
        ? "first"
        : message.tool_call_id === second.id
          ? "second"
          : undefined;
      if (call === undefined) throw new Error("D516 worker received an unexpected protected result");
      emit({ event: "result_protected", call });
      if (phase === "crash-unacknowledged" && call === "first") return await never();
      return message;
    },
  }));
  const config = { configurable: { thread_id: threadId } };
  if (phase === "write-failure") await waitForParentGate();
  const output = await graph.invoke(
    phase === "resume" ? null : d516StateFor([first, second, mutation]),
    config,
  ) as NautiloState;
  emit({
    event: "completed",
    toolCallIds: output.messages
      .filter((message) => ToolMessage.isInstance(message))
      .map((message) => message.tool_call_id),
    pendingToolCallIds: (output.approvedToolCalls ?? []).flatMap((call) => call.id === undefined ? [] : [call.id]),
    engagedSkillNames: [...(output.engagedSkillNames ?? [])],
    activatedToolNames: [...(output.activatedToolNames ?? [])],
    activatedToolLeases: [...(output.activatedToolLeases ?? [])],
    resultDurableSidecarToolCallIds: output.messages
      .filter((message) => ToolMessage.isInstance(message))
      .filter((message) => COMPUTER_RESULT_DURABLE_SIDECAR_KEY in (message.additional_kwargs ?? {}))
      .map((message) => message.tool_call_id),
  });
  await teardownD516ProductionReadFixture();
  await closeCheckpointSaver(5_000);
}

void main().catch(async () => {
  emit({
    event: "failed",
    reason: activePhase === "write-failure" ? "persistence_failure" : "worker_error",
  });
  process.exitCode = 1;
  await closeCheckpointSaver(5_000).catch(() => undefined);
});
