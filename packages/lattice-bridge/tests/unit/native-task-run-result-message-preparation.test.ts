import { describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";

import { decryptObjectThroughNamespace, namespaceId, verifyCommonObjectAccessManifest } from "@nautilo/lattice-crypto";
import { decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2 } from "@nautilo/lattice-crypto/wire";

import { deriveMessageCryptoObjectIdV2 } from "../../src/message/conversation-repository.ts";
import { decodeMessagePayloadV2 } from "../../src/message/message-payload-v2.ts";

import { prepareNativeTaskRunResultMessage, readPreparedNativeTaskRunResultMessage } from "../../src/server/task/native-task-run-result-message-preparation.ts";

import { taskRunResultMessageFixture as fixture, NOW, TASK, RUN, DEST_NS, DEST_DOMAIN, ROOM, SESSION } from "../fixtures/task-run-result-message-fixture";
import { withCertifiedRunResultPublicationSigner } from
  "../fixtures/task-publication-signer.ts";

async function fails(operation: Promise<unknown>): Promise<void> {
  let failure: unknown;
  try { await operation; } catch (error: unknown) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
}

describe("native Task run result Message preparation", () => {
  test("uses a certified fresh signer and retains its historical proof", async () => {
    const value = await fixture();
    let expectedCertificate: Uint8Array | undefined;
    const prepared = await withCertifiedRunResultPublicationSigner<Awaited<
      ReturnType<typeof prepareNativeTaskRunResultMessage>
    >>({
      crypto: value.crypto,
      now: value.crypto.clock.now(),
      deviceSigner: value.issuer,
      requestId: value.evidenceInput.requestId,
      sessionId: SESSION,
      roomId: ROOM,
      requesterHumanId: value.evidenceInput.requesterHumanId,
      signerAgentId: value.evidenceInput.result.signerAgentId,
      policyRevision: value.evidenceInput.policyRevision,
      domains: value.domains,
      namespaceRequirements: value.namespaceRequirements,
      foregroundNamespaceRequirements: value.foregroundNamespaceRequirements,
      work: {
        kind: "task.deliver_result",
        taskId: TASK,
        taskRunId: RUN,
        contentRevision: 1,
        workIdentityHash: new Uint8Array(32).fill(0xb2),
      },
      result: value.evidenceInput.result,
      invocation: value.invocation,
    }, async ({ evidence, signer, certificateBytes }) => {
      expectedCertificate = certificateBytes.slice();
      return value.open<Awaited<ReturnType<
        typeof prepareNativeTaskRunResultMessage
      >>>(evidence, ({ prepare }) => prepare({
        runtime: signer.runtime,
        signerPublication: null,
        temporarySigner: signer,
        agentAuthorizationRevision: 0,
        resolveHistoricalSignerPublicationManager: () => {
          throw new Error("permanent output signer history must not be loaded");
        },
      }));
    });
    const snapshot = readPreparedNativeTaskRunResultMessage(prepared);
    expect(snapshot.signerEvidenceBytes).toEqual(expectedCertificate);
    expect(prepared.authority.signerAuthorizationHash).toBeDefined();
    const verified = verifyCommonObjectAccessManifest(value.crypto, {
      manifestBytes: snapshot.manifestBytes,
      resolveHistoricalHumanDeviceSigningPublicKey: () => null,
      resolveAgentRuntimeSignerPublicKey: () => {
        throw new Error("permanent output signer history must not be loaded");
      },
      resolveProcessorSignerAuthorizationBytes: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
      resolveTaskRuntimeSignerAuthorizationBytes: () =>
        snapshot.signerEvidenceBytes!,
      resolveHistoricalTaskRuntimeIssuer: () => value.issuer.publicKey,
    });
    expect(String(verified.manifest.objectId)).toBe(value.allocation.objectId);
    expectedCertificate?.fill(0);
  });

  test("prepares the exact assistant result under its independent foreground destination", async () => {
    const value = await fixture();
    let prepared: Awaited<ReturnType<typeof prepareNativeTaskRunResultMessage>> | undefined;
    await value.run(async ({ prepare }) => { prepared = await prepare(); });
    expect(prepared).toBeDefined();
    expect(prepared!.authority).toMatchObject({
      taskId: TASK, taskRunId: RUN, resultTerminalStatus: "completed",
      resultContentRevision: 1,
      resultObjectId: value.evidenceInput.result.objectId,
      resultGenesisManifestHash:
        bytesToHex(value.evidenceInput.result.genesisManifestHash),
      roomId: ROOM, sessionId: SESSION, namespaceId: DEST_NS,
      domainId: DEST_DOMAIN, publicationPolicyRevision: 7,
      requestId: `task-run-delivery-result-authorization:${RUN}`,
      claimId: "task-result-message-read-claim",
      authorizationExpiresAt: NOW + 40_000,
    });
    expect(value.checks).toHaveLength(2);
    const snapshot = readPreparedNativeTaskRunResultMessage(prepared!);
    expect(snapshot.signerEvidenceBytes).toBeUndefined();
    expect(prepared!.authority.signerAuthorizationHash).toBeUndefined();
    const plaintext = decryptObjectThroughNamespace(value.crypto,
      value.destinationGenerationKey,
      decodeNamespaceObjectEnvelopeV2(snapshot.envelopeBytes[0]),
      decodeEncryptedPayloadV2(snapshot.object.payloadBytes.ciphertext));
    expect(plaintext).not.toBeNull();
    expect(decodeMessagePayloadV2(plaintext!)).toEqual({
      role: "assistant", content: "A durable protected Task result",
    });
    plaintext?.fill(0);
    expect(() => readPreparedNativeTaskRunResultMessage({ ...prepared! }))
      .toThrow("not prepared");
  });

  test("rejects allocation, destination, current authority and forged source substitutions", async () => {
    const value = await fixture();
    await value.run(async ({ source, prepare }) => {
      await fails(prepare({ allocation: { ...value.allocation,
        objectId: deriveMessageCryptoObjectIdV2({ sessionId: SESSION,
          messageId: 24, revision: 0 }) } }));
      await fails(prepare({ allocation: { ...value.allocation,
        publicationPolicyRevision: 8 } }));
      await fails(prepare({ namespace: {
        ...value.destinationSource,
        current: { ...value.destinationSource.current,
          namespaceId: namespaceId("other-destination-namespace") },
      } }));
      await fails(prepare({ resolveCurrentAuthority: expected => Promise.resolve({
        ...expected, roomId: TASK,
      }) }));
      await fails(prepare({ agentAuthorizationRevision: 8 }));
      await fails(prepare({ signerPublication: null }));
      await fails(prepare({
        source: { ...source } as typeof source,
      }));
    });
  });

  test("rechecks live read authority around current resolution and encryption", async () => {
    const value = await fixture();
    await fails(value.run(({ prepare }) =>
      prepare({ resolveCurrentAuthority: expected => {
        value.expire();
        return Promise.resolve(expected);
      } })));

    const aborted = await fixture();
    await fails(aborted.run(({ prepare }) =>
      prepare({ resolveCurrentAuthority: expected => {
        aborted.controller.abort(new Error("delivery revoked"));
        return Promise.resolve(expected);
      } })));
  });
});
