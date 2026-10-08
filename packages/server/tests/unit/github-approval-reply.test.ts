import { expect, test } from "bun:test";
import { digestGitHubPreparation, type GitHubInvocationOwner, type GitHubPreparedOperation } from "@nautilo/types";
const owner: GitHubInvocationOwner = { instanceId: "", humanUserId: "human", agentId: "agent", roomId: "room", conversationId: "thread", runId: "turn", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "opaque-pair", serverOrigin: "https://server.example", serverFingerprint: "fingerprint", profileId: "profile", profileRevision: 1, grantRevision: 1, protectedPolicyVersion: 1 };
const { agentId: _agent, roomId: _room, conversationId: _thread, runId: _run, ...identity } = owner;
void _agent; void _room; void _thread; void _run;
const capability = { version: 1 as const, generation: "generation", identity };
async function preparation(): Promise<GitHubPreparedOperation> {
  const value = { version: 1 as const, preparationId: "preparation", generation: "generation", toolCallId: "call", request: { operation: "comment_create" as const, repository: "fixture/project", number: 12, body: "Full approved body\n<script>literal</script>" }, account: { id: 1, login: "fixture" }, repository: { id: 2, fullName: "fixture/project", htmlUrl: "https://github.com/fixture/project" }, resource: { id: 3, number: 12, kind: "issue" as const, htmlUrl: "https://github.com/fixture/project/issues/12", title: "Fixture", body: "Original", state: "open" as const } };
  return { ...value, digest: await digestGitHubPreparation(owner, value) };
}
import { parseGitHubApprovalEcho, githubApprovalId } from "@nautilo/types";
import { requirePendingApprovalAskInterrupt, requireGitHubApprovalEcho } from "../../../agent/src/graph/interrupt-mapping";
void capability;
test("HTTP echo validator refuses missing digest, broad verbs and foreign extra authority", () => {
  const reply = { approvalId: "github-publish:preparation:" + "a".repeat(64), digest: "a".repeat(64), laneKey: "thread", verb: "once" };
  expect(parseGitHubApprovalEcho(reply)).toEqual({ approvalId: reply.approvalId, digest: reply.digest, laneKey: "thread" });
  for (const invalid of [{ ...reply, digest: undefined }, { ...reply, verb: "always" }, { ...reply, laneKey: "" }, { ...reply, owner }]) expect(parseGitHubApprovalEcho(invalid)).toBeNull();
});
test("durable current pending interrupt owns exact ID, digest and lane after server restart", async () => {
  const prepared = await preparation(), approvalId = githubApprovalId(prepared);
  const value = { type: "approval_ask", approvalId, github: { version: 1, approvalId, digest: prepared.digest, prepared } };
  const saved = JSON.parse(JSON.stringify({ tasks: [{ interrupts: [{ id: "interrupt", value }] }] })) as { tasks: Array<Record<string, unknown>> };
  const pending = requirePendingApprovalAskInterrupt(saved, approvalId), echo = { approvalId, digest: prepared.digest, laneKey: "thread" };
  expect(() => requireGitHubApprovalEcho(pending, echo, "thread", "once")).not.toThrow();
  for (const change of [{ digest: "f".repeat(64) }, { approvalId: "github-publish:other" }, { laneKey: "other" }]) expect(() => requireGitHubApprovalEcho(pending, { ...echo, ...change }, "thread", "once")).toThrow();
  expect(() => requireGitHubApprovalEcho(pending, echo, "thread", "always")).toThrow();
  expect(() => requirePendingApprovalAskInterrupt({ tasks: [] }, approvalId)).toThrow();
});

test("authenticated HTTP handler rejects missing/broadened GitHub echo before any resume", async () => {
  const [{ default: Fastify }, { authRoutes }, { PinChallengeProvider }, { SessionStore }, { installLocalAuthPreHandlerStub }] = await Promise.all([
    import("fastify"), import("../../src/routes/auth"), import("@nautilo/trust"), import("../helpers/test-session-store"), import("./helpers/auth-preHandler-stub"),
  ]);
  const sessions = new SessionStore(undefined, { persistPath: null });
  const app = Fastify({ logger: false }); installLocalAuthPreHandlerStub(app, sessions);
  authRoutes(app, { pinProvider: new PinChallengeProvider({ persistPath: null }), ownerActorId: "human", ownerId: "human" });
  const token = sessions.createSession("human", "human", "human").token;
  try {
    for (const body of [
      { verb: "once", threadId: "thread", laneKey: "thread", approvalId: "github-publish:missing" },
      { verb: "always", threadId: "thread", laneKey: "thread", approvalId: "github-publish:fixture", githubDigest: "a".repeat(64) },
      { verb: "once", threadId: "thread", laneKey: "thread", approvalId: 42, githubDigest: "a".repeat(64) },
      { verb: "once", threadId: "thread", laneKey: "task:foreign", approvalId: "github-publish:fixture", githubDigest: "a".repeat(64) },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/auth/approval-reply", headers: { Authorization: `Bearer ${token}` }, payload: body });
      expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ code: "approval_stale" });
    }
  } finally { await app.close(); }
});
