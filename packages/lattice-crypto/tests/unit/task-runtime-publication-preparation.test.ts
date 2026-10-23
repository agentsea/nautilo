import { describe, expect, test } from "bun:test";
import { withPublicationSigner, PUBLICATION_NAMESPACE, publicationBytes } from "../fixtures/task-publication-signer.ts";
import { prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1, assertAuthenticPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1 } from "../../src/object/agent-access-manifest.ts";
import { prepareDeviceWrappedAgentObjectAccessManifestGenesisSetV1, assertAuthenticPreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1 } from "../../src/object/device-wrapped-agent-access-manifest-set-v1.ts";
import { persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1, persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1 } from "../../src/object/agent-storage-coordinator.ts";
import { consumeAuthorizedObjectAccessWriteV2 } from "../../src/object/authorized-write.ts";
import { agentRuntimeObjectSignerKeyIdV1 } from "../../src/agent-runtime/object-signer-v1.ts";
import { verifyObjectAccessManifestV5 } from "../../src/format/object-access-manifest-v5.ts";
import { encodeNamespaceObjectEnvelopeV2 } from "../../src/format/object-v2.ts";
import { wrapObjectDekForNamespaceV2 } from "../../src/object/namespace-envelope.ts";
import { objectId, namespaceId, namespaceGeneration, accessRevision, authorizationRevision } from "../../src/v2-types/ids.ts";
import type { ObjectAccessStateCasStorageV2 } from "../../src/object/storage-coordinator.ts";

describe("certified Task wake common preparations", () => {
  for (const set of [false, true]) test(`${set ? "Namespace set" : "transcript"}: current write retains exact proof`, async () => {
    const history = await withPublicationSigner(async ({ crypto, signer, evidence, domain }) => {
      const target = objectId(set ? "memory:publication" : "message:publication");
      const payloadBytes = publicationBytes(0x41);
      const envelopeBytes = encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespaceV2(crypto, publicationBytes(0x42), {
        objectId: target, namespaceId: namespaceId(PUBLICATION_NAMESPACE), keyClass: "ai",
        keyGeneration: namespaceGeneration(3), bindingRevisionAtWrap: accessRevision(4),
      }, publicationBytes(0x43)));
      const namespace = { namespaceId: PUBLICATION_NAMESPACE, accessRevision: 4, keyGeneration: 3,
        domainId: domain.domainId, domainKeyGeneration: domain.domainKeyGeneration,
        domainAuthorizationRevision: domain.authorizationRevision, domainHeadDigest: domain.headDigest,
        headDigest: publicationBytes(0x44), publicationDigest: publicationBytes(0x45),
        publicationSetDigest: publicationBytes(0x46), audienceFingerprint: publicationBytes(0x47) };
      const input = { objectId: target, payloadHash: crypto.hash(payloadBytes), envelopeBytes: [envelopeBytes] as const,
        operationId: evidence.invocation.operationId,
        grant: { grantId: evidence.requestId, grantHash: evidence.authorizationDigest, recipientKeyId: evidence.recipientKeyId },
        runtime: signer.runtime, signerKeyId: agentRuntimeObjectSignerKeyIdV1(crypto, signer.signerPublicKey),
        signerPublicKey: signer.signerPublicKey, agentAuthorizationRevision: 0, taskRuntimeSigner: { evidence, signer } };
      const single = prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1(crypto, { ...input, namespace });
      const multiple = prepareDeviceWrappedAgentObjectAccessManifestGenesisSetV1(crypto, { ...input, namespaces: [namespace] });
      const prepared = set ? multiple : single;
      expect(prepared.manifest.formatVersion).toBe(5);
      expect(prepared.signerEvidence?.certificateBytes).toEqual(signer.certificateBytes);
      expect(prepared.manifest.hostAuthorizationRevision).toBe(authorizationRevision(5));
      expect(prepared.authority.signerAuthorizationHash).toEqual(crypto.hash(signer.certificateBytes));
      let writes = 0;
      const storage: ObjectAccessStateCasStorageV2 = { getObject: async () => ({ objectId: target, payloadBytes }),
        compareAndSwapObjectAccessState: async write => {
          const snapshot = consumeAuthorizedObjectAccessWriteV2(write);
          expect("signerEvidence" in snapshot.authorization && snapshot.authorization.signerEvidence?.certificateBytes).toEqual(signer.certificateBytes);
          writes++; return "applied";
        } };
      const decision = { grantAuthorized: true, agentAuthorized: true, hostAllowsOperation: true,
        signerPublicKey: signer.signerPublicKey,
        currentRuntime: { agentId: signer.runtime.agentId, runtimeGeneration: signer.runtime.generation, authorizationRevision: authorizationRevision(0) } };
      expect(set ? await persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1({ crypto, storage, prepared: multiple,
        resolveCurrentAuthorization: context => ({ ...decision, context, namespacesAuthorized: true }) })
        : await persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1({ crypto, storage, prepared: single,
          resolveCurrentAuthorization: context => ({ ...decision, context, namespaceAuthorized: true }) })).toBe("applied");
      expect(writes).toBe(1);
      // A valid old proof never overrides a denied or different current signer.
      expect(set ? await persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1({ crypto, storage, prepared: multiple,
        resolveCurrentAuthorization: () => null })
        : await persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1({ crypto, storage, prepared: single,
          resolveCurrentAuthorization: () => null })).toBe("stale");
      const wrongKey = publicationBytes(0x48);
      expect(set ? await persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1({ crypto, storage, prepared: multiple,
        resolveCurrentAuthorization: context => ({ ...decision, signerPublicKey: wrongKey, context, namespacesAuthorized: true }) })
        : await persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1({ crypto, storage, prepared: single,
          resolveCurrentAuthorization: context => ({ ...decision, signerPublicKey: wrongKey, context, namespaceAuthorized: true }) })).toBe("stale");
      expect(writes).toBe(1);
      const verified = verifyObjectAccessManifestV5(crypto, { manifestBytes: prepared.manifestBytes,
        resolveHistoricalHumanDeviceSigningPublicKey: () => null, resolveAgentRuntimeSignerPublicKey: () => null,
        resolveProcessorSignerAuthorizationBytes: () => null, resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
        resolveTaskRuntimeSignerAuthorizationBytes: () => prepared.signerEvidence!.certificateBytes,
        resolveHistoricalTaskRuntimeIssuer: () => prepared.signerEvidence!.issuerSigningPublicKey });
      expect(verified.manifest.objectId).toBe(target);
      const retained = { crypto, manifestBytes: prepared.manifestBytes.slice(),
        certificateBytes: prepared.signerEvidence!.certificateBytes.slice(),
        issuerPublicKey: prepared.signerEvidence!.issuerSigningPublicKey.slice(),
        borrowedPrivateKey: signer.runtime.key };
      prepared.signerEvidence!.certificateBytes[0] = prepared.signerEvidence!.certificateBytes[0]! ^ 1;
      expect(() => set ? assertAuthenticPreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1(multiple)
        : assertAuthenticPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1(single)).toThrow();
      for (const changed of [
        { ...input, operationId: "another-operation" },
        { ...input, grant: { ...input.grant, grantId: "another-grant" } },
        { ...input, grant: { ...input.grant, recipientKeyId: "another-recipient" } },
        { ...input, grant: { ...input.grant, grantHash: publicationBytes(0x49) } },
      ]) {
        expect(() => set ? prepareDeviceWrappedAgentObjectAccessManifestGenesisSetV1(crypto, { ...changed, namespaces: [namespace] })
          : prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1(crypto, { ...changed, namespace })).toThrow();
      }
      const unauthorizedNamespace = { ...namespace, namespaceId: "namespace:unauthorized" };
      const unauthorizedEnvelope = encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespaceV2(crypto, publicationBytes(0x42), {
        objectId: target, namespaceId: namespaceId(unauthorizedNamespace.namespaceId), keyClass: "ai",
        keyGeneration: namespaceGeneration(3), bindingRevisionAtWrap: accessRevision(4),
      }, publicationBytes(0x43)));
      const moved = { ...input, envelopeBytes: [unauthorizedEnvelope] as const };
      expect(() => set ? prepareDeviceWrappedAgentObjectAccessManifestGenesisSetV1(crypto, { ...moved, namespaces: [unauthorizedNamespace] })
        : prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1(crypto, { ...moved, namespace: unauthorizedNamespace })).toThrow();
      return retained;
    });
    expect(history.borrowedPrivateKey.every(byte => byte === 0)).toBe(true);
    const historical = verifyObjectAccessManifestV5(history.crypto, {
      manifestBytes: history.manifestBytes,
      resolveHistoricalHumanDeviceSigningPublicKey: () => null, resolveAgentRuntimeSignerPublicKey: () => null,
      resolveProcessorSignerAuthorizationBytes: () => null, resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
      resolveTaskRuntimeSignerAuthorizationBytes: () => history.certificateBytes,
      resolveHistoricalTaskRuntimeIssuer: () => history.issuerPublicKey,
    });
    expect(historical.manifest.signer.kind).toBe("agent_runtime");
  });
});
