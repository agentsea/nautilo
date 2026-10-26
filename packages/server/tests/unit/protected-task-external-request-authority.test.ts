import { expect, test } from "bun:test";
import { bindEncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import { LatticeCrypto, authorizationRevision } from "@nautilo/lattice-crypto";
import { createProtectedTaskExternalRequestAuthority } from "../../src/routes/protected-task-external-request-authority";
import type { DomainForegroundReadSnapshot } from "../../src/routes/foreground-domain-read-authority";

const binding = { userId: "user", humanActorId: "human", clientDeviceId: "device", clientActionSessionId: "session" };
const identity = { taskId: "task", taskRunId: "run", jobId: "job", sourceRoomId: "private", namespaceId: "namespace",
  requestorId: "user", humanActorId: "human", agentId: "agent", roomId: "target", requestId: "request" };
const bytes = () => new Uint8Array(32).fill(1);
const snapshot = (): DomainForegroundReadSnapshot => ({ policyRevision: 1, committerDeviceId: "device",
  committerDeviceSigningKeyGeneration: 1, committerDeviceSigningPublicKey: bytes(), hostAuthorizationRevision: 1,
  namespaceAuthority: { namespaceId: "namespace", namespaceAccessRevision: 1, namespaceKeyGeneration: 1,
    namespaceHeadDigest: bytes(), namespacePublicationDigest: bytes(), namespacePublicationSetDigest: bytes(),
    namespaceAudienceFingerprint: bytes(), domainId: "domain", domainKeyGeneration: 1, domainAuthorizationRevision: 1,
    domainHeadDigest: bytes(), bundleRevision: 1, bundleDigest: bytes() },
  domains: [{ domainId: "domain", sourceNamespaceId: "namespace", participantDigest: bytes(), participantCount: 1,
    keyClass: "ai", domainKeyGeneration: 1, authorizationRevision: authorizationRevision(1), headDigest: bytes(),
    activeNamespaceBindingSetDigest: bytes(), activeNamespaceBindingCount: 1 }] });

function fixture(plain = false) {
  let currentSession = true;
  let sourceRoomId = "private";
  let inspections = 0;
  let beforeReturn = () => {};
  const returned: DomainForegroundReadSnapshot[] = [];
  const inspect = createProtectedTaskExternalRequestAuthority({ db: {} as never, restricted: {} as never,
    crypto: new LatticeCrypto(), serverScope: "test", clientSessions: { inspect: input => {
      expect(input.actorId).toBe("human");
      return currentSession && input.clientActionSessionId === "session" ? { initiatingClientSurface: "workbench.browser" } : null;
    } }, owner: bindEncryptionDataOperationOwner({ policy: {
      resolve: async () => ({ policy: { mode: plain ? "plaintext_only" : "encrypted_only", shadowBehavior: "fallback" }, revalidationToken: 1 }),
      revalidate: async () => {},
    } }) }, { resolveSourceRoom: async (user, agent, namespace) => {
      expect([user, agent, namespace]).toEqual(["user", "agent", "namespace"]);
      return { roomId: sourceRoomId, namespaceId: "namespace" };
    }, inspect: async () => { inspections++; const value = snapshot(); returned.push(value); beforeReturn(); return value; } });
  return { inspect, returned, inspections: () => inspections,
    revokeSession: () => { currentSession = false; }, changeSource: () => { sourceRoomId = "other"; },
    beforeReturn: (callback: () => void) => { beforeReturn = callback; } };
}

test("current requester-private Room and admitted client session are rechecked on each inspection", async () => {
  const f = fixture();
  expect(await f.inspect(binding, identity)).toEqual(snapshot());
  f.changeSource();
  expect(await f.inspect(binding, identity)).toBeNull();
  expect(f.inspections()).toBe(1);
});

test("Plain mode never inspects protected Namespace or device metadata", async () => {
  const f = fixture(true);
  expect(await f.inspect(binding, identity)).toBeNull();
  expect(f.inspections()).toBe(0);
});

test("wrong requester or Human and unknown session cannot inspect private metadata", async () => {
  const f = fixture();
  expect(await f.inspect({ ...binding, userId: "other" }, identity)).toBeNull();
  expect(await f.inspect({ ...binding, humanActorId: "other" }, identity)).toBeNull();
  expect(await f.inspect({ ...binding, clientActionSessionId: "unknown" }, identity)).toBeNull();
  expect(f.inspections()).toBe(0);
});

test("session revocation while inspecting destroys the unreturned public snapshot", async () => {
  const f = fixture(); f.beforeReturn(f.revokeSession);
  expect(await f.inspect(binding, identity)).toBeNull();
  expect(f.returned).toHaveLength(1);
  expect(f.returned[0]!.committerDeviceSigningPublicKey.every(byte => byte === 0)).toBe(true);
  expect(f.returned[0]!.domains[0]!.headDigest.every(byte => byte === 0)).toBe(true);
});
