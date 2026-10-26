import { expect, test } from "bun:test";
import type { AcceptProtectedTaskHumanContinuationInput } from "@nautilo/db";
import { bindEncryptionDataOperationOwner, ClassifiedDataOperationError } from "@nautilo/lattice-bridge";
import { createProtectedTaskHumanResponse, type ProtectedTaskHumanResponseInput } from "../../src/routes/protected-task-human-response";

const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const JOB = "30000000-0000-4000-8000-000000000003";
const USER = "40000000-0000-4000-8000-000000000004";
const HUMAN = "50000000-0000-4000-8000-000000000005";
function fixture(mode: "plaintext_only" | "shadow_encryption" | "encrypted_only", shadowBehavior: "fallback" | "strict" = "fallback") {
  const events: string[] = [];
  const accepted: AcceptProtectedTaskHumanContinuationInput[] = [];
  let failure = false;
  let allowedVerbs: readonly ("once" | "room" | "always" | "deny")[] | undefined = ["once", "deny"];
  let representation: "ordinary" | "dual" | "protected" = mode === "shadow_encryption" ? "dual" : "protected";
  const owner = bindEncryptionDataOperationOwner({ policy: {
    resolve: async () => ({ policy: { mode, shadowBehavior }, revalidationToken: 1 }),
    revalidate: async () => {},
  } });
  const respond = createProtectedTaskHumanResponse({ db: {} as never, owner,
    wake: () => { events.push("wake"); }, now: () => new Date(1000),
  }, {
    task: async () => { events.push("representation"); return { representation, agentId: "agent", targetRoomId: null }; },
    admit: async () => {},
    resolve: async (_db, request) => {
      events.push("resolve");
      expect(request.acceptedBy).toEqual({ userId: USER, humanActorId: HUMAN });
      if (failure) throw new ClassifiedDataOperationError("key_waiting", "unavailable");
      return { status: "resolved", input: { taskId: TASK, taskRunId: RUN,
        priorJobId: JOB, executionSegment: 2 } as Omit<AcceptProtectedTaskHumanContinuationInput, "acceptance">,
        interrupt: { id: "interrupt:1", kind: request.interrupt.kind,
          ...(request.interrupt.requestId === undefined ? {} : { requestId: request.interrupt.requestId }),
          ...(request.interrupt.kind !== "approval" || allowedVerbs === undefined
            ? {} : { allowedVerbs }) } };
    },
    accept: async (_db, input) => { events.push("accept"); accepted.push(input);
      return { status: "accepted", acceptance: input.acceptance }; },
  });
  const request: ProtectedTaskHumanResponseInput = {
    taskId: TASK, graphThreadId: "thread:1", userId: USER, humanActorId: HUMAN,
    requestId: "approval:1", response: { kind: "approval", verb: "once" },
  };
  return { events, accepted, respond, request,
    setRepresentation: (value: typeof representation) => { representation = value; },
    setAllowedVerbs: (value: typeof allowedVerbs) => { allowedVerbs = value; },
    fail: () => { failure = true; }, ordinary: () => { representation = "ordinary"; } };
}

test("Plain response never reads protected metadata or changes continuation", async () => {
  const f = fixture("plaintext_only");
  expect(await f.respond(f.request)).toEqual({ status: "not_applicable" });
  expect(f.events).toEqual([]);
});

test.each(["shadow_encryption", "encrypted_only"] as const)(
  "%s saves the categorical response before waking and derives stable retry identity", async mode => {
    const f = fixture(mode);
    expect(await f.respond(f.request)).toEqual({ status: "accepted" });
    expect(f.events).toEqual(["representation", "resolve", "accept", "wake"]);
    await f.respond(f.request);
    expect(f.accepted[0]?.acceptance.acceptanceId).toBe(f.accepted[1]?.acceptance.acceptanceId);
    expect(f.accepted[0]?.acceptance.response).toEqual({ kind: "approval", verb: "once" });
    expect(JSON.stringify(f.accepted)).not.toContain("pin");
  });

test("Fallback never sends a failed protected acceptance to ordinary graph resume", async () => {
  const f = fixture("shadow_encryption"); f.fail();
  expect(f.respond(f.request)).rejects.toThrow("unavailable");
  expect(f.events).toEqual(["representation", "resolve"]);
});

test("requires a real actor and exact approval request but preserves ordinary Tasks", async () => {
  const f = fixture("shadow_encryption");
  expect(await f.respond({ ...f.request, humanActorId: null })).toEqual({
    status: "rejected", code: "task_approval_not_found",
  });
  const { requestId: _requestId, ...missing } = f.request;
  expect(await f.respond(missing)).toEqual({ status: "rejected", code: "approval_stale" });
  expect(f.accepted).toEqual([]);
  f.ordinary();
  expect(await f.respond(f.request)).toEqual({ status: "not_applicable" });
});

test("rejects a disallowed approval before immutable acceptance and keeps legacy deny available", async () => {
  const f = fixture("encrypted_only");
  f.setAllowedVerbs(["deny"]);
  expect(await f.respond(f.request)).toEqual({ status: "rejected", code: "approval_stale" });
  expect(f.accepted).toEqual([]);
  expect(await f.respond({ ...f.request,
    response: { kind: "approval", verb: "deny" } })).toEqual({ status: "accepted" });
  const legacy = fixture("encrypted_only");
  legacy.setAllowedVerbs(undefined);
  expect(await legacy.respond(legacy.request)).toEqual({ status: "rejected", code: "approval_stale" });
  expect(await legacy.respond({ ...legacy.request,
    response: { kind: "approval", verb: "deny" } })).toEqual({ status: "accepted" });
});


test.each([
  ["shadow_encryption", "strict"],
  ["encrypted_only", "fallback"],
] as const)("%s/%s never sends an ordinary-only Task to ordinary resume", async (mode, behavior) => {
  const f = fixture(mode, behavior); f.ordinary();
  expect(f.respond(f.request)).rejects.toThrow("Task has no protected continuation");
  expect(f.accepted).toEqual([]);
  expect(f.events).toEqual(["representation"]);
});


test("Shadow refuses protected-only continuation before recording a response", async () => {
  const f = fixture("shadow_encryption"); f.setRepresentation("protected");
  expect(await f.respond(f.request)).toEqual({ status: "rejected", code: "approval_stale" });
  expect(f.accepted).toEqual([]);
  expect(f.events).toEqual(["representation"]);
});

test("Full accepts an encrypted retained-dual definition through the protected continuation", async () => {
  const f = fixture("encrypted_only"); f.setRepresentation("dual");
  expect(await f.respond(f.request)).toEqual({ status: "accepted" });
  expect(f.events).toEqual(["representation", "resolve", "accept", "wake"]);
  expect(f.accepted[0]?.acceptance.response).toEqual({ kind: "approval", verb: "once" });
});
