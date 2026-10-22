import { expect, mock, test } from "bun:test";
import Fastify from "fastify";
import type { PinChallengeProvider } from "@nautilo/trust";
import type { ProtectedTaskHumanResponseInput, ProtectedTaskHumanResponseResult } from "../../src/routes/protected-task-human-response";
const runtime = await import("@nautilo/runtime");
const ordinaryResume = mock(async () => { throw new Error("ordinary Task resume must not run"); });
mock.module("@nautilo/runtime", () => ({ ...runtime,
  authorizeTaskApprovalResume: ordinaryResume, runTaskApprovalResume: ordinaryResume,
}));
const { authRoutes } = await import("../../src/routes/auth");

async function fixture(validPin = true) {
  const accepted: ProtectedTaskHumanResponseInput[] = [];
  const events: string[] = [];
  let outcome: ProtectedTaskHumanResponseResult = { status: "accepted" };
  const app = Fastify();
  app.addHook("preHandler", async request => {
    request.sessionUserId = "user";
    request.sessionActorId = "human";
  });
  authRoutes(app, { ownerId: "user", ownerActorId: "human",
    pinProvider: { verifyProof: async () => { events.push("pin"); return validPin; } } as unknown as PinChallengeProvider,
    unlockVaultWithPin: async () => { events.push("unlock"); },
    acceptProtectedTaskResponse: async input => {
      events.push("accept"); accepted.push(input); return outcome;
    },
  });
  return { app, accepted, events, reject: () => { outcome = { status: "rejected", code: "approval_stale" }; } };
}

test("protected approval is durably accepted without ordinary checkpoint execution", async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({ method: "POST", url: "/api/auth/approval-reply",
      payload: { threadId: "graph", laneKey: "task:one", approvalId: "approval:1", verb: "deny" } });
    expect(response.statusCode).toBe(200);
    expect(f.accepted).toEqual([{ taskId: "one", graphThreadId: "graph", userId: "user",
      humanActorId: "human", requestId: "approval:1", response: { kind: "approval", verb: "deny" } }]);
    expect(ordinaryResume).not.toHaveBeenCalled();
    f.reject();
    const stale = await f.app.inject({ method: "POST", url: "/api/auth/approval-reply",
      payload: { threadId: "graph", laneKey: "task:one", approvalId: "approval:1", verb: "once" } });
    expect(stale.statusCode).toBe(409);
    expect(ordinaryResume).not.toHaveBeenCalled();
  } finally { await f.app.close(); }
});

test.each([true, false])("protected PIN response is accepted only after verification (%s)", async valid => {
  const f = await fixture(valid);
  try {
    const response = await f.app.inject({ method: "POST", url: "/api/auth/prove-and-resume",
      payload: { threadId: "graph", laneKey: "task:one", challengeId: "interrupt:1", pin: "826493" } });
    expect(response.statusCode).toBe(valid ? 200 : 401);
    expect(f.events).toEqual(valid ? ["pin", "unlock", "accept"] : ["pin"]);
    if (valid) expect(f.accepted[0]?.response).toEqual({ kind: "prove_it", approved: true });
    expect(JSON.stringify(f.accepted)).not.toContain("826493");
    expect(ordinaryResume).not.toHaveBeenCalled();
  } finally { await f.app.close(); }
});

test("protected denial needs no PIN and remains an exact categorical response", async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({ method: "POST", url: "/api/auth/prove-and-resume",
      payload: { threadId: "graph", laneKey: "task:one", challengeId: "interrupt:1", denied: true } });
    expect(response.statusCode).toBe(200);
    expect(f.events).toEqual(["accept"]);
    expect(f.accepted[0]?.response).toEqual({ kind: "prove_it", approved: false });
    expect(ordinaryResume).not.toHaveBeenCalled();
  } finally { await f.app.close(); }
});
