import { expect, test } from "bun:test";
import { LatticeCrypto, authorizationRevision } from "@nautilo/lattice-crypto";
import { encodeTaskRuntimeBackgroundAuthorizationResponseV2 } from
  "@nautilo/lattice-crypto/background";
import { deriveMessageCryptoObjectIdV2 } from
  "../../src/message/conversation-repository.ts";
import { taskRuntimeAcceptedResponseIsCurrent } from
  "../../src/server/task/task-runtime-accepted-response-integrity.ts";
import { withCertifiedTerminalPublicationSigner } from
  "../fixtures/task-publication-signer.ts";

const NOW = 1_930_000_000_000;
const TASK = "10000000-0000-4000-8000-000000000401";
const RUN = "20000000-0000-4000-8000-000000000401";
const ROOM = "30000000-0000-4000-8000-000000000401";
const SESSION = "40000000-0000-4000-8000-000000000401";
const NS = "publication-response-namespace";
const DOMAIN = "publication-response-domain";
const bytes = (fill: number) => new Uint8Array(32).fill(fill);

async function withFixture<Value>(use: (value: Parameters<
  Parameters<typeof withCertifiedTerminalPublicationSigner<Value>>[1]
>[0] & { crypto: LatticeCrypto }) => Promise<Value>): Promise<Value> {
  const crypto = new LatticeCrypto();
  const deviceSigner = crypto.generateSigningKeyPair();
  const domainKey = bytes(0x31);
  const coordinate = { sessionId: SESSION, messageId: 17, revision: 0 };
  const message = {
    taskId: TASK, taskRunId: RUN, bindingId: `task-run-output:${RUN}`,
    messageOperationId: `task-run-delivery-message:${RUN}`, ...coordinate,
    objectId: deriveMessageCryptoObjectIdV2(coordinate), roomId: ROOM,
    namespaceId: NS, domainId: DOMAIN, mode: "encrypted_only" as const,
    acceptedPolicyRevision: 7, publicationPolicyRevision: 7,
    signerAgentId: "agent:publication-response", payloadDigest: bytes(0x32),
  };
  try {
    return await withCertifiedTerminalPublicationSigner({
      crypto, now: NOW, deviceSigner,
      requestId: `task-run-delivery-message-authorization:${RUN}`,
      sessionId: SESSION, roomId: ROOM, requesterHumanId: "human:publication-response",
      signerAgentId: message.signerAgentId, policyRevision: 7,
      domains: [{ domainId: DOMAIN, sourceNamespaceId: NS,
        participantDigest: bytes(0x33), participantCount: 1, keyClass: "ai",
        domainKeyGeneration: 4, authorizationRevision: authorizationRevision(9),
        headDigest: bytes(0x34), activeNamespaceBindingSetDigest: bytes(0x35),
        activeNamespaceBindingCount: 1, domainKey }],
      namespaceRequirements: [{ ordinal: 0, namespaceId: NS, domainId: DOMAIN,
        operations: ["encrypt"], expectedAccessRevision: 0, expectedPolicyRevision: 7 }],
      work: { kind: "task.deliver_message", taskId: TASK, taskRunId: RUN,
        contentRevision: 2, messageObjectId: message.objectId,
        workIdentityHash: bytes(0x36) }, message,
    }, value => use({ ...value, crypto }));
  } finally {
    deviceSigner.privateKey.fill(0);
    deviceSigner.publicKey.fill(0);
    domainKey.fill(0);
  }
}

test("accepted publication response binds wrapper, inner grant and active certificate", async () => {
  await withFixture(async ({ crypto, evidence, authorizationBytes, certificateBytes }) => {
    const encode = (grant = authorizationBytes, certificate = certificateBytes) =>
      encodeTaskRuntimeBackgroundAuthorizationResponseV2({
        authorizationBytes: grant, certificateBytes: certificate,
      });
    const response = encode();
    const check = (body: Uint8Array, hash = crypto.hash(body)) =>
      taskRuntimeAcceptedResponseIsCurrent({ crypto, evidence,
        acceptedResponseBytes: body, acceptedResponseHash: hash });
    try {
      // The wrapper hash deliberately differs from the grant digest.
      expect(crypto.hash(response)).not.toEqual(evidence.authorizationDigest);
      expect(await check(response)).toBe(true);
      expect(await check(response, bytes(0xff))).toBe(false);
      const grant = authorizationBytes.slice();
      grant[grant.length - 1]! ^= 1;
      const certificate = certificateBytes.slice();
      certificate[certificate.length - 1]! ^= 1;
      const changedGrant = encode(grant);
      const changedCertificate = encode(authorizationBytes, certificate);
      try {
        // Rehashing the wrapper cannot legitimize substituted contents.
        expect(await check(changedGrant)).toBe(false);
        expect(await check(changedCertificate)).toBe(false);
        expect(await check(authorizationBytes)).toBe(false);
        expect(await check(new Uint8Array([1, 2, 3]))).toBe(false);
      } finally {
        grant.fill(0); certificate.fill(0);
        changedGrant.fill(0); changedCertificate.fill(0);
      }
    } finally { response.fill(0); }
  });
});

test("a retained public response cannot replay after its signer callback closes", async () => {
  const retained = await withFixture(async ({ crypto, evidence,
    authorizationBytes, certificateBytes }) => {
    const acceptedResponseBytes = encodeTaskRuntimeBackgroundAuthorizationResponseV2({
      authorizationBytes, certificateBytes,
    });
    const value = { crypto, evidence, acceptedResponseBytes,
      acceptedResponseHash: crypto.hash(acceptedResponseBytes) };
    expect(await taskRuntimeAcceptedResponseIsCurrent(value)).toBe(true);
    return value;
  });
  try {
    expect(await taskRuntimeAcceptedResponseIsCurrent(retained)).toBe(false);
  } finally {
    retained.acceptedResponseBytes.fill(0);
    retained.acceptedResponseHash.fill(0);
  }
});
