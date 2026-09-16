import { describe, expect, test } from "bun:test";

import {
  deriveAgentRuntimeObjectSignerPublicV1,
} from "../../src/agent-runtime/object-signer-v1.ts";
import type { AgentRuntimeGenerationV2 } from
  "../../src/agent-runtime/types.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../../src/format/object-v2.ts";
import {
  prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1,
} from "../../src/object/agent-access-manifest.ts";
import {
  persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1,
} from "../../src/object/agent-storage-coordinator.ts";
import {
  wrapObjectDekForNamespaceV2,
} from "../../src/object/namespace-envelope.ts";
import { InMemoryV2Store } from "../../src/storage/v2-store.ts";
import { opaqueBytes } from "../../src/v2-types/opaque.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  grantId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

function fixture() {
  const crypto = new LatticeCrypto(seededRng(0x290_aa));
  const runtime: AgentRuntimeGenerationV2 = Object.freeze({
    agentId: agentId("agent-device-wrapped"),
    keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(3),
    key: new Uint8Array(32).fill(0x41),
  });
  const signer = deriveAgentRuntimeObjectSignerPublicV1(crypto, runtime);
  const payloadBytes = encodeEncryptedPayloadV2({
    formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
    context: {
      objectId: objectId("object-device-wrapped-agent"),
      keyClass: "ai",
      objectType: "conversation-message",
      createdAt: unixTimestamp(100),
    },
    ciphertext: new Uint8Array(64).fill(0x42),
  });
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespaceV2(
      crypto,
      new Uint8Array(32).fill(0x43),
      {
        objectId: objectId("object-device-wrapped-agent"),
        namespaceId: namespaceId("namespace-device-wrapped-agent"),
        keyClass: "ai",
        keyGeneration: namespaceGeneration(4),
        bindingRevisionAtWrap: accessRevision(7),
      },
      new Uint8Array(32).fill(0x44),
    ),
  );
  const prepared =
    prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1(
      crypto,
      {
        objectId: "object-device-wrapped-agent",
        payloadHash: crypto.hash(payloadBytes),
        envelopeBytes: [envelopeBytes],
        operationId: "operation-device-wrapped-agent",
        grant: {
          grantId: grantId("grant-device-wrapped-agent"),
          grantHash: new Uint8Array(32).fill(0x45),
          recipientKeyId: "recipient-device-wrapped-agent",
        },
        namespace: {
          namespaceId: "namespace-device-wrapped-agent",
          accessRevision: 7,
          keyGeneration: 4,
          headDigest: new Uint8Array(32).fill(0x46),
          publicationDigest: new Uint8Array(32).fill(0x47),
          publicationSetDigest: new Uint8Array(32).fill(0x48),
          audienceFingerprint: new Uint8Array(32).fill(0x49),
        },
        agentAuthorizationRevision: 9,
        runtime,
        signerKeyId: signer.principal.signerKeyId,
        signerPublicKey: signer.publicKey,
      },
    );
  const decision = (context = prepared.authority) => Object.freeze({
    context,
    grantAuthorized: true,
    namespaceAuthorized: true,
    agentAuthorized: true,
    hostAllowsOperation: true,
    currentRuntime: Object.freeze({
      agentId: runtime.agentId,
      authorizationRevision: authorizationRevision(9),
      runtimeGeneration: runtime.generation,
    }),
    signerPublicKey: signer.publicKey.slice(),
  });
  return { crypto, runtime, signer, payloadBytes, prepared, decision };
}

describe("device-wrapped live Shadow Agent object access", () => {
  test("persists the generic manifest under exact Namespace-head authority", async () => {
    const state = fixture();
    const storage = new InMemoryV2Store();
    await storage.putObject({
      objectId: state.prepared.authority.objectId,
      payloadBytes: opaqueBytes(
        "encrypted-payload",
        state.payloadBytes,
      ),
    });
    expect(await persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1({
      crypto: state.crypto,
      storage,
      prepared: state.prepared,
      resolveCurrentAuthorization: state.decision,
    })).toBe("applied");
    expect(await persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1({
      crypto: state.crypto,
      storage,
      prepared: state.prepared,
      resolveCurrentAuthorization: state.decision,
    })).toBe("duplicate");
    state.signer.publicKey.fill(0);
    state.runtime.key.fill(0);
  });

  test("rejects substituted current Namespace authority", async () => {
    const state = fixture();
    const storage = new InMemoryV2Store();
    await storage.putObject({
      objectId: state.prepared.authority.objectId,
      payloadBytes: opaqueBytes("encrypted-payload", state.payloadBytes),
    });
    const changedHead = state.prepared.authority.namespaceHeadDigest.slice();
    changedHead[0] = changedHead[0]! ^ 0xff;
    expect(await persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesisV1({
      crypto: state.crypto,
      storage,
      prepared: state.prepared,
      resolveCurrentAuthorization: (context) => state.decision({
        ...context,
        namespaceHeadDigest: changedHead,
      }),
    })).toBe("stale");
    state.signer.publicKey.fill(0);
    state.runtime.key.fill(0);
  });
});
