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
import { parseGitHubCapability, parseGitHubInvocationBinding, parseGitHubPublishApproval, githubApprovalId } from "../../src/github-invocation";
test("closed bindings separate source identity, preparation, read and exact one-time publication", async () => {
  expect(parseGitHubCapability(capability)).toEqual(capability);
  expect(parseGitHubCapability({ ...capability, identity: owner })).toBeNull();
  const prepared = await preparation(), approvalId = githubApprovalId(prepared);
  const binding = { version: 1 as const, generation: capability.generation, toolCallId: "call", owner, stage: "publish" as const, prepared, approval: { verb: "once" as const, approvalId, digest: prepared.digest } };
  expect(parseGitHubInvocationBinding(binding, prepared.request)).toEqual(binding);
  for (const changed of [{ ...binding, generation: "new" }, { ...binding, toolCallId: "other" }, { ...binding, stage: "read" }, { ...binding, approval: { ...binding.approval, verb: "always" } }, { ...binding, token: "synthetic" }]) expect(parseGitHubInvocationBinding(changed, prepared.request)).toBeNull();
  expect(parseGitHubInvocationBinding(binding, { ...prepared.request, body: "changed" })).toBeNull();
  const review = { version: 1 as const, approvalId, digest: prepared.digest, prepared };
  expect(parseGitHubPublishApproval(review)).toEqual(review);
  expect(parseGitHubPublishApproval({ ...review, owner })).toBeNull();

});
