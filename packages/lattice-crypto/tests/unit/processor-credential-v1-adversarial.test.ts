import { describe, expect, test } from "bun:test";

import {
  decodeProcessorCredentialV1,
  encodeProcessorCredentialV1,
  openProcessorCredentialV1,
  verifyProcessorCredentialV1,
} from "../../src/background/processor-credential-v1.ts";
import {
  GRANT_V2_FORMAT_VERSION,
  GRANT_V2_SCHEME,
  parseGrantV2,
  serializeGrantV2,
} from "../../src/format/grant-v2.ts";
import {
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
} from "../../src/v2-types/ids.ts";
import {
  PROCESSOR_CREDENTIAL_FIXTURE_NOW,
  createProcessorCredentialFixtureV1,
} from "../helpers/processor-credential-v1-fixture.ts";

describe("ProcessorCredentialV1 adversarial boundaries", () => {
  test("fails closed for wrong recipient, issuer, signer, and signed substitution", async () => {
    const state = await createProcessorCredentialFixtureV1(24_210);
    const wrongRecipient =
      await state.crypto.generateEncryptionKeyPair();

    expect(await openProcessorCredentialV1(state.crypto, {
      credentialBytes: state.created.bytes,
      recipientPrivateKey: wrongRecipient.privateKey,
      now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
      resolveCurrentIssuerPublicKey: () => state.issuer.publicKey,
    })).toBeNull();
    expect(verifyProcessorCredentialV1(state.crypto, {
      credentialBytes: state.created.bytes,
      now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
      resolveCurrentIssuerPublicKey: () => new Uint8Array(32).fill(0xff),
    })).rejects.toThrow("issuer");

    const substitutedSigner = encodeProcessorCredentialV1({
      ...state.created.credential,
      signerPublicKey: new Uint8Array(32).fill(0xee),
    });
    expect(verifyProcessorCredentialV1(state.crypto, {
      credentialBytes: substitutedSigner,
      now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
      resolveCurrentIssuerPublicKey: () => state.issuer.publicKey,
    })).rejects.toThrow();

    const substitutedSecret = state.created.credential.encryptedSecret.slice();
    const finalSecretByte = substitutedSecret.length - 1;
    substitutedSecret[finalSecretByte] =
      substitutedSecret[finalSecretByte]! ^ 1;
    const substitutedWire = encodeProcessorCredentialV1({
      ...state.created.credential,
      encryptedSecret: substitutedSecret,
    });
    expect(verifyProcessorCredentialV1(state.crypto, {
      credentialBytes: substitutedWire,
      now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
      resolveCurrentIssuerPublicKey: () => state.issuer.publicKey,
    })).rejects.toThrow("signature");
  });

  test("does not cross-parse or cross-use Agent GrantV2", async () => {
    const state = await createProcessorCredentialFixtureV1(24_211);
    const grantBytes = serializeGrantV2({
      formatVersion: GRANT_V2_FORMAT_VERSION,
      id: grantId("grant-cross-use"),
      issuingDeviceId: cryptoDeviceId("device-cross-use"),
      recipientAgentId: agentId("agent-cross-use"),
      recipientKeyId: "recipient-cross-use",
      scope: [humanId("human-cross-use")],
      operations: ["decrypt"],
      issuedAt: PROCESSOR_CREDENTIAL_FIXTURE_NOW,
      expiresAt: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 60_000,
      coveredDomains: [{
        domainId: cryptoDomainId("domain-cross-use"),
        domainEpoch: domainEpoch(1),
        agentAuthorizationRevision: authorizationRevision(1),
      }],
      encryptedSecret: new Uint8Array([1]),
      scheme: GRANT_V2_SCHEME,
      signature: new Uint8Array(64),
      singleUse: true,
      consumed: false,
    });

    expect(() => decodeProcessorCredentialV1(grantBytes)).toThrow("domain");
    expect(parseGrantV2(state.created.bytes)).toBeNull();
  });

  test("wipes owned sealed/opened secret temporaries while preserving caller buffers", async () => {
    const state = await createProcessorCredentialFixtureV1(24_212);
    const aiRootBefore = state.aiRoot.slice();
    const signerBefore = state.processorSigner.privateKey.slice();
    const originalOpen = state.crypto.openSealed.bind(state.crypto);
    let openedPlaintext: Uint8Array | null = null;
    state.crypto.openSealed = async (privateKey, sealed) => {
      openedPlaintext = await originalOpen(privateKey, sealed);
      return openedPlaintext;
    };

    const opened = await openProcessorCredentialV1(state.crypto, {
      credentialBytes: state.created.bytes,
      recipientPrivateKey: state.recipient.privateKey,
      now: PROCESSOR_CREDENTIAL_FIXTURE_NOW + 1,
      resolveCurrentIssuerPublicKey: () => state.issuer.publicKey,
    });

    expect(opened).not.toBeNull();
    expect(openedPlaintext).not.toBeNull();
    expect(openedPlaintext!.every((byte) => byte === 0)).toBe(true);
    expect(state.aiRoot).toEqual(aiRootBefore);
    expect(state.processorSigner.privateKey).toEqual(signerBefore);
    expect(opened?.aiRoot).toEqual(aiRootBefore);
    expect(opened?.processorSignerPrivateKey).toEqual(signerBefore);
  });
});
