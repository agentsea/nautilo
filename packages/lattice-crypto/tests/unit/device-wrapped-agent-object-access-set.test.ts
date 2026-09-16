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
  prepareDeviceWrappedAgentObjectAccessManifestGenesisSetV1,
} from "../../src/object/device-wrapped-agent-access-manifest-set-v1.ts";
import {
  persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1,
} from "../../src/object/agent-storage-coordinator.ts";
import { wrapObjectDekForNamespaceV2 } from
  "../../src/object/namespace-envelope.ts";
import { InMemoryV2Store } from "../../src/storage/v2-store.ts";
import { opaqueBytes } from "../../src/v2-types/opaque.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

function fixture(namespaceIds: readonly string[] = ["namespace-a", "namespace-b"]) {
  const crypto = new LatticeCrypto(seededRng(0x311_aa));
  const runtime: AgentRuntimeGenerationV2 = Object.freeze({
    agentId: agentId("agent-device-wrapped-set"),
    keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(4),
    key: new Uint8Array(32).fill(0x31),
  });
  const signer = deriveAgentRuntimeObjectSignerPublicV1(crypto, runtime);
  const targetObjectId = objectId("object-device-wrapped-agent-set");
  const payloadBytes = encodeEncryptedPayloadV2({
    formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
    context: {
      objectId: targetObjectId,
      keyClass: "ai",
      objectType: "memory",
      createdAt: unixTimestamp(100),
    },
    ciphertext: new Uint8Array(64).fill(0x32),
  });
  const envelopeBytes = namespaceIds.map((id, index) =>
    encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespaceV2(
      crypto,
      new Uint8Array(32).fill(0x40 + index),
      {
        objectId: targetObjectId,
        namespaceId: namespaceId(id),
        keyClass: "ai",
        keyGeneration: namespaceGeneration(index + 2),
        bindingRevisionAtWrap: accessRevision(index + 5),
      },
      new Uint8Array(32).fill(0x50),
    ))
  );
  const prepared =
    prepareDeviceWrappedAgentObjectAccessManifestGenesisSetV1(crypto, {
      objectId: targetObjectId,
      payloadHash: crypto.hash(payloadBytes),
      envelopeBytes: [...envelopeBytes].reverse(),
      operationId: "operation-device-wrapped-agent-set",
      grant: {
        grantId: "grant-device-wrapped-agent-set",
        grantHash: new Uint8Array(32).fill(0x33),
        recipientKeyId: "recipient-device-wrapped-agent-set",
      },
      namespaces: namespaceIds.map((id, index) => ({
        namespaceId: id,
        accessRevision: index + 5,
        keyGeneration: index + 2,
        domainId: `domain-${index + 1}`,
        domainKeyGeneration: index + 7,
        domainAuthorizationRevision: 9,
        domainHeadDigest: new Uint8Array(32).fill(0x58 + index),
        headDigest: new Uint8Array(32).fill(0x60 + index),
        publicationDigest: new Uint8Array(32).fill(0x62 + index),
        publicationSetDigest: new Uint8Array(32).fill(0x64 + index),
        audienceFingerprint: new Uint8Array(32).fill(0x66 + index),
      })),
      agentAuthorizationRevision: 9,
      runtime,
      signerKeyId: signer.principal.signerKeyId,
      signerPublicKey: signer.publicKey,
    });
  const decision = (context = prepared.authority) => Object.freeze({
    context,
    grantAuthorized: true,
    namespacesAuthorized: true,
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

describe("device-wrapped live Shadow Agent object access set", () => {
  test("orders reversed envelopes by canonical code units, not locale collation", () => {
    const namespaceIds = ["namespace-B", "namespace-a"];
    const state = fixture(namespaceIds);
    expect(state.prepared.authority.envelopes.map((entry) => entry.namespaceId))
      .toEqual(namespaceIds);
    state.signer.publicKey.fill(0);
    state.runtime.key.fill(0);
  });

  test("persists and replays one exact two-Namespace common-v5 genesis", async () => {
    const state = fixture();
    const storage = new InMemoryV2Store();
    await storage.putObject({
      objectId: state.prepared.authority.objectId,
      payloadBytes: opaqueBytes("encrypted-payload", state.payloadBytes),
    });
    expect(
      await persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1({
        crypto: state.crypto,
        storage,
        prepared: state.prepared,
        resolveCurrentAuthorization: state.decision,
      }),
    ).toBe("applied");
    expect(
      await persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1({
        crypto: state.crypto,
        storage,
        prepared: state.prepared,
        resolveCurrentAuthorization: state.decision,
      }),
    ).toBe("duplicate");
    state.signer.publicKey.fill(0);
    state.runtime.key.fill(0);
  });

  test("rejects an incomplete current Namespace-set decision", async () => {
    const state = fixture();
    const storage = new InMemoryV2Store();
    await storage.putObject({
      objectId: state.prepared.authority.objectId,
      payloadBytes: opaqueBytes("encrypted-payload", state.payloadBytes),
    });
    expect(
      await persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSetV1({
        crypto: state.crypto,
        storage,
        prepared: state.prepared,
        resolveCurrentAuthorization: (context) => ({
          ...state.decision(context),
          namespacesAuthorized: false,
        }),
      }),
    ).toBe("stale");
    state.signer.publicKey.fill(0);
    state.runtime.key.fill(0);
  });
});
