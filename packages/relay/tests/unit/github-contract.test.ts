import { expect, test } from "bun:test";
import { digestGitHubPreparation, type GitHubInvocationOwner, type GitHubPreparedOperation } from "@nautilo/types";
const owner: GitHubInvocationOwner = { instanceId: "", humanUserId: "human", agentId: "agent", roomId: "room", conversationId: "thread", runId: "turn", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "opaque-pair", serverOrigin: "https://server.example", serverFingerprint: "fingerprint", profileId: "profile", profileRevision: 1, grantRevision: 1, protectedPolicyVersion: 1 };
const { agentId: _agent, roomId: _room, conversationId: _thread, runId: _run, ...identity } = owner;
void _agent; void _room; void _thread; void _run;
const capability = { version: 1 as const, generation: "generation", identity, authenticatedGit: { version: 1 as const } };
async function preparation(): Promise<GitHubPreparedOperation> {
  const value = { version: 1 as const, preparationId: "preparation", generation: "generation", toolCallId: "call", request: { operation: "comment_create" as const, repository: "fixture/project", number: 12, body: "Full approved body\n<script>literal</script>" }, account: { id: 1, login: "fixture" }, repository: { id: 2, fullName: "fixture/project", htmlUrl: "https://github.com/fixture/project" }, resource: { id: 3, number: 12, kind: "issue" as const, htmlUrl: "https://github.com/fixture/project/issues/12", title: "Fixture", body: "Original", state: "open" as const } };
  return { ...value, digest: await digestGitHubPreparation(owner, value) };
}
import { isRelayGitHubDispatch, matchesGitHubWorkstationBinding, projectRelayCapabilitiesForProtocol,
  RELAY_PROTOCOL_VERSION, type RelayWorkstationShellBinding } from "../../src/protocol";
test("GitHub dispatch stays unavailable to every older negotiated peer and mismatched owner", async () => {
  void preparation;
  const caps = { profile: "desktop-agent" as const, canUseGitHub: true, github: capability };
  const args = { operation: "issue_read", repository: "fixture/project", number: 12 };
  const binding = { version: 1, generation: "generation", toolCallId: "call", owner, stage: "read", localNetworkPolicy: { mode: "host" } };
  expect(RELAY_PROTOCOL_VERSION).toBe(29);
  expect(isRelayGitHubDispatch("local_github", args, binding, caps, 29)).toBeTrue();
  for (const version of [1, 20, 24, 25, 26, 27, 28]) {
    expect(isRelayGitHubDispatch("local_github", args, binding, caps, version)).toBeFalse();
    expect(projectRelayCapabilitiesForProtocol(caps, version).canUseGitHub).toBeUndefined();
  }
  for (const change of [{ generation: "other" }, { owner: { ...owner, profileRevision: 2 } }, { owner: { ...owner, humanUserId: "other" } }]) expect(isRelayGitHubDispatch("local_github", args, { ...binding, ...change }, caps, 29)).toBeFalse();
  expect(isRelayGitHubDispatch("run_shell", args, binding, caps, 29)).toBeFalse();
  const git = { operation: "fetch", repository: "fixture/project", branch: "main" };
  expect(isRelayGitHubDispatch("local_git", git, binding, caps, 29)).toBeTrue();
  expect(isRelayGitHubDispatch("local_git", git, binding, { ...caps, github: { version: 1, generation: "generation", identity } }, 29)).toBeFalse();
  expect(isRelayGitHubDispatch("local_git", git, { ...binding, localNetworkPolicy: { mode: "unknown" } }, caps, 29)).toBeFalse();
});

test("authenticated Git requires one exact account and workstation binding", () => {
  const account = { version: 1, generation: "generation", toolCallId: "call", owner,
    stage: "read", localNetworkPolicy: { mode: "host" } } as const;
  const shell: RelayWorkstationShellBinding = {
    version: 2, toolCallId: account.toolCallId, relayId: owner.relayId,
    desktopSessionId: owner.desktopSessionId, serverBindingId: "server-binding",
    pairingGeneration: "raw-pairing", profileId: owner.profileId,
    profileRevision: owner.profileRevision, grantIds: ["grant"], capabilityRevision: 4,
    currentFolder: "/project", grantRevision: owner.grantRevision,
    protectedPolicyVersion: owner.protectedPolicyVersion,
    subject: { userId: owner.humanUserId, instanceId: owner.instanceId,
      relayId: owner.relayId, agentScope: "all_owned_agents" },
    operation: "execute", executionClass: "profile_bound_sandbox",
  };
  expect(matchesGitHubWorkstationBinding(account, shell)).toBeTrue();
  for (const mismatch of [
    { ...shell, toolCallId: "other" },
    { ...shell, relayId: "other" },
    { ...shell, desktopSessionId: "other" },
    { ...shell, profileId: "other" },
    { ...shell, profileRevision: 2 },
    { ...shell, grantRevision: 2 },
    { ...shell, protectedPolicyVersion: 2 },
    { ...shell, subject: { ...shell.subject, userId: "other" } },
    { ...shell, subject: { ...shell.subject, instanceId: "other" } },
    { ...shell, subject: { ...shell.subject, relayId: "other" } },
  ]) expect(matchesGitHubWorkstationBinding(account, mismatch)).toBeFalse();
  // Raw shell pairing is intentionally checked against the server registry's
  // raw token generation, never the account binding's opaque pairing digest.
  expect(matchesGitHubWorkstationBinding(account, { ...shell, pairingGeneration: "another-raw-pairing" })).toBeTrue();
});
