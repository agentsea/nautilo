import { describe, expect, test } from "bun:test";

import {
  backgroundAuthorizationResponseSigningBytesV1,
  createBackgroundAuthorizationResponseV1,
  decodeBackgroundAuthorizationResponseV1,
  encodeBackgroundAuthorizationResponseV1,
  verifyCurrentBackgroundAuthorizationResponseV1,
} from "../../src/background/background-authorization-response-v1.ts";
import {
  decodeProcessorCredentialV1,
  encodeProcessorCredentialV1,
  processorCredentialSigningBytesV1,
} from "../../src/background/processor-credential-v1.ts";
import {
  accessRevision,
  authorizationRevision,
  domainEpoch,
} from "../../src/v2-types/ids.ts";
import {
  createBackgroundAuthorizationResponseFixtureV1,
} from "../helpers/background-authorization-response-v1-fixture.ts";

describe("BackgroundAuthorizationResponseV1 adversarial rejection", () => {
  test("rejects response substitution across valid requests and generations", async () => {
    const first = await createBackgroundAuthorizationResponseFixtureV1(
      24_510,
    );
    const second = await createBackgroundAuthorizationResponseFixtureV1(
      24_511,
    );
    const substituted = encodeBackgroundAuthorizationResponseV1({
      ...second.response.response,
      signature: first.response.response.signature,
    });

    expect(verifyCurrentBackgroundAuthorizationResponseV1(
      second.crypto,
      {
        responseBytes: substituted,
        now: second.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: () =>
          second.issuer.publicKey,
      },
    )).rejects.toThrow("signature is invalid");
  });

  test("rejects credential, recipient, revision, and signature tampering", async () => {
    const state = await createBackgroundAuthorizationResponseFixtureV1(
      24_512,
    );
    const other = await createBackgroundAuthorizationResponseFixtureV1(
      24_513,
    );
    const verify = (responseBytes: Uint8Array) =>
      verifyCurrentBackgroundAuthorizationResponseV1(state.crypto, {
        responseBytes,
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      });

    expect(() =>
      encodeBackgroundAuthorizationResponseV1({
        ...state.response.response,
        credentialBytes: other.created.bytes,
        credentialHash: other.created.hash,
      })
    ).toThrow();

    for (const [index, mutated] of [
      {
        ...state.response.response,
        requestId: other.response.response.requestId,
      },
      {
        ...state.response.response,
        recipientGeneration:
          state.response.response.recipientGeneration + 1,
      },
      {
        ...state.response.response,
        recipientKeyId: `${state.response.response.recipientKeyId}-other`,
      },
      {
        ...state.response.response,
        recipientPublicKey: other.recipient.publicKey,
      },
      {
        ...state.response.response,
        issuingHumanId: other.response.response.issuingHumanId,
      },
      {
        ...state.response.response,
        issuingDeviceId: other.response.response.issuingDeviceId,
      },
      {
        ...state.response.response,
        issuingDeviceAuthorizationRevision:
          authorizationRevision(
            state.response.response.issuingDeviceAuthorizationRevision + 1,
          ),
      },
      {
        ...state.response.response,
        issuerSigningPublicKeyHash:
          other.response.response.issuerSigningPublicKeyHash,
      },
      {
        ...state.response.response,
        workDescriptorHash: other.response.response.workDescriptorHash,
      },
      {
        ...state.response.response,
        domainEpoch: domainEpoch(state.response.response.domainEpoch + 1),
      },
      {
        ...state.response.response,
        namespaceAccessRevision:
          accessRevision(
            state.response.response.namespaceAccessRevision + 1,
          ),
      },
      {
        ...state.response.response,
        policyRevision: authorizationRevision(
          state.response.response.policyRevision + 1,
        ),
      },
      {
        ...state.response.response,
        issuedAt: state.response.response.issuedAt + 1,
      },
      {
        ...state.response.response,
        notBefore: state.response.response.notBefore + 1,
      },
      {
        ...state.response.response,
        expiresAt: state.response.response.expiresAt + 1,
      },
    ].entries()) {
      expect(
        () => encodeBackgroundAuthorizationResponseV1(mutated),
        `substitution ${index}`,
      ).toThrow();
    }

    const signatureTampered =
      decodeBackgroundAuthorizationResponseV1(state.response.bytes);
    signatureTampered.signature[0] =
      signatureTampered.signature[0]! ^ 1;
    expect(verify(encodeBackgroundAuthorizationResponseV1(
      signatureTampered,
    ))).rejects.toThrow("signature is invalid");

    const wireTampered = state.response.bytes.slice();
    wireTampered[wireTampered.length - 1] =
      wireTampered[wireTampered.length - 1]! ^ 1;
    expect(verify(wireTampered)).rejects.toThrow();
  });

  test("rejects issuer-key substitution even when the response wire is intact", async () => {
    const state = await createBackgroundAuthorizationResponseFixtureV1(
      24_514,
    );
    const other = await createBackgroundAuthorizationResponseFixtureV1(
      24_515,
    );
    expect(verifyCurrentBackgroundAuthorizationResponseV1(state.crypto, {
      responseBytes: state.response.bytes,
      now: state.descriptor.notBefore,
      resolveCurrentIssuingDevicePublicKey: () =>
        other.issuer.publicKey,
    })).rejects.toThrow("does not match");
  });

  test("refuses to countersign a credential with an invalid issuer signature", async () => {
    const state = await createBackgroundAuthorizationResponseFixtureV1(
      24_516,
    );
    const credential =
      decodeProcessorCredentialV1(state.created.bytes);
    credential.signature[0] = credential.signature[0]! ^ 1;
    const tamperedCredential =
      encodeProcessorCredentialV1(credential);

    expect(() =>
      createBackgroundAuthorizationResponseV1(state.crypto, {
        credentialBytes: tamperedCredential,
        issuingDeviceSigningPublicKey: state.issuer.publicKey,
        issuingDeviceSigningPrivateKey: state.issuer.privateKey,
      })
    ).toThrow("credential signature is invalid");

    const {
      signature: _responseSignature,
      ...originalResponseUnsigned
    } = state.response.response;
    const invalidInnerUnsigned = {
      ...originalResponseUnsigned,
      credentialBytes: tamperedCredential,
      credentialHash: state.crypto.hash(tamperedCredential),
    };
    const responseSigningBytes =
      backgroundAuthorizationResponseSigningBytesV1(invalidInnerUnsigned);
    const invalidInnerResponse = encodeBackgroundAuthorizationResponseV1({
      ...invalidInnerUnsigned,
      signature: state.crypto.sign(
        state.issuer.privateKey,
        responseSigningBytes,
      ),
    });
    responseSigningBytes.fill(0);
    expect(verifyCurrentBackgroundAuthorizationResponseV1(
      state.crypto,
      {
        responseBytes: invalidInnerResponse,
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      },
    )).rejects.toThrow("credential signature is invalid");
  });

  test("rejects an issuer-signed credential whose signer key does not match its principal", async () => {
    const state = await createBackgroundAuthorizationResponseFixtureV1(
      24_517,
    );
    const other = await createBackgroundAuthorizationResponseFixtureV1(
      24_518,
    );
    const credential =
      decodeProcessorCredentialV1(state.created.bytes);
    const { signature: _signature, ...originalUnsigned } = credential;
    const inconsistentUnsigned = {
      ...originalUnsigned,
      signerPublicKey: other.created.credential.signerPublicKey,
    };
    const signingBytes =
      processorCredentialSigningBytesV1(inconsistentUnsigned);
    const inconsistentCredential = encodeProcessorCredentialV1({
      ...inconsistentUnsigned,
      signature: state.crypto.sign(
        state.issuer.privateKey,
        signingBytes,
      ),
    });
    signingBytes.fill(0);

    expect(() =>
      createBackgroundAuthorizationResponseV1(state.crypto, {
        credentialBytes: inconsistentCredential,
        issuingDeviceSigningPublicKey: state.issuer.publicKey,
        issuingDeviceSigningPrivateKey: state.issuer.privateKey,
      })
    ).toThrow("signer public key does not match");

    const {
      signature: _responseSignature,
      ...originalResponseUnsigned
    } = state.response.response;
    const inconsistentResponseUnsigned = {
      ...originalResponseUnsigned,
      credentialBytes: inconsistentCredential,
      credentialHash: state.crypto.hash(inconsistentCredential),
    };
    const responseSigningBytes =
      backgroundAuthorizationResponseSigningBytesV1(
        inconsistentResponseUnsigned,
      );
    const inconsistentResponse =
      encodeBackgroundAuthorizationResponseV1({
        ...inconsistentResponseUnsigned,
        signature: state.crypto.sign(
          state.issuer.privateKey,
          responseSigningBytes,
        ),
      });
    responseSigningBytes.fill(0);
    expect(verifyCurrentBackgroundAuthorizationResponseV1(
      state.crypto,
      {
        responseBytes: inconsistentResponse,
        now: state.descriptor.notBefore,
        resolveCurrentIssuingDevicePublicKey: () =>
          state.issuer.publicKey,
      },
    )).rejects.toThrow("signer public key does not match");
  });
});
